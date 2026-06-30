"""Build ablation study visual report."""
import json, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
from matplotlib.lines import Line2D
import numpy as np

with open("/home/user/workspace/ml_output/ablation/ablation_results.json") as f:
    s = json.load(f)

rounds    = s["rounds"]
opt       = s["optimal_round"]
base_auc  = s["baseline_auc"]
auc_floor = s["auc_floor"]

ns     = [r["n_features"]        for r in rounds]
aucs   = [r["auc"]               for r in rounds]
aucp   = [r["auc_pct_baseline"]  for r in rounds]
trains = [r["train_sec"]         for r in rounds]
infers = [r["infer_ms"]          for r in rounds]
accs   = [r["acc"]               for r in rounds]
rids   = [r["round"]             for r in rounds]

# optimal round index
opt_idx = opt["round"]

# ── PALETTE ───────────────────────────────────────────────────
BG     = "#0d1117"; CARD  = "#161b22"; BORDER = "#30363d"
TEXT   = "#e6edf3"; SUB   = "#8b949e"
ACCENT = "#58a6ff"; GREEN = "#3fb950"; YELLOW = "#d29922"
RED    = "#f85149"; PURPLE= "#bc8cff"

fig = plt.figure(figsize=(20, 26), facecolor=BG)
fig.patch.set_facecolor(BG)

gs = GridSpec(4, 2, figure=fig, hspace=0.55, wspace=0.38,
              top=0.94, bottom=0.04, left=0.07, right=0.96)

ax_hdr   = fig.add_subplot(gs[0, :])
ax_auc   = fig.add_subplot(gs[1, :])
ax_train = fig.add_subplot(gs[2, 0])
ax_infer = fig.add_subplot(gs[2, 1])
ax_tbl   = fig.add_subplot(gs[3, :])

def sax(ax):
    ax.set_facecolor(CARD)
    for sp in ax.spines.values(): sp.set_edgecolor(BORDER)
    ax.tick_params(colors=SUB, labelsize=9)
    ax.grid(color=BORDER, linewidth=0.5, alpha=0.5)
    ax.set_axisbelow(True)

# ── HEADER ────────────────────────────────────────────────────
ax_hdr.set_facecolor(CARD)
for sp in ax_hdr.spines.values(): sp.set_edgecolor(BORDER)
ax_hdr.set_xticks([]); ax_hdr.set_yticks([])
ax_hdr.text(0.5, 0.78, "LightGBM Feature Ablation Study",
            transform=ax_hdr.transAxes, ha="center",
            color=TEXT, fontsize=18, fontweight="bold")
ax_hdr.text(0.5, 0.48,
    f"Strategy: iterative bottom-25th-percentile SHAP drop  |  "
    f"Baseline AUC = {base_auc:.5f}  |  "
    f"95% floor = {auc_floor:.5f}  |  "
    f"89 → {opt['n_features']} features over {len(rounds)} rounds",
    transform=ax_hdr.transAxes, ha="center", color=SUB, fontsize=10)

# compact-set stats
speedup_train = rounds[0]["train_sec"] / opt["train_sec"]
speedup_infer = rounds[0]["infer_ms"]  / opt["infer_ms"]
ax_hdr.text(0.5, 0.16,
    f"Optimal compact set: {opt['n_features']} features  |  "
    f"AUC {opt['auc']:.5f} ({opt['auc_pct_baseline']:.2f}% of baseline)  |  "
    f"Train speedup: {speedup_train:.1f}×  |  "
    f"Infer speedup: {speedup_infer:.2f}×",
    transform=ax_hdr.transAxes, ha="center", color=YELLOW, fontsize=10)

# ── AUC vs FEATURE COUNT ──────────────────────────────────────
sax(ax_auc)
ax_auc.set_title("AUC vs Feature Count — Ablation Rounds",
                 color=TEXT, fontsize=12, fontweight="bold", pad=10)
ax_auc.set_xlabel("Number of Features", color=SUB, fontsize=10)
ax_auc.set_ylabel("ROC-AUC", color=ACCENT, fontsize=10)

# floor shading
ax_auc.axhspan(0, auc_floor, alpha=0.08, color=RED, zorder=0)
ax_auc.axhline(auc_floor, color=RED, linewidth=1.4, linestyle="--",
               label=f"95% AUC floor ({auc_floor:.4f})", zorder=1)
ax_auc.axhline(base_auc, color=GREEN, linewidth=1.2, linestyle=":",
               label=f"Baseline AUC ({base_auc:.4f})", zorder=1)

# main line
ax_auc.plot(ns, aucs, color=ACCENT, linewidth=2.2, marker="o",
            markersize=8, markerfacecolor=TEXT, markeredgecolor=ACCENT,
            label="Round AUC", zorder=3)

# highlight optimal
ax_auc.scatter([opt["n_features"]], [opt["auc"]],
               color=YELLOW, s=160, zorder=5, label=f"Optimal ({opt['n_features']} feats)")
ax_auc.annotate(
    f"Optimal\n{opt['n_features']} features\nAUC {opt['auc']:.4f}",
    xy=(opt["n_features"], opt["auc"]),
    xytext=(opt["n_features"] + 4, opt["auc"] - 0.008),
    color=YELLOW, fontsize=9,
    arrowprops=dict(arrowstyle="->", color=YELLOW, lw=1.2),
    bbox=dict(boxstyle="round,pad=0.3", facecolor=CARD,
              edgecolor=YELLOW, alpha=0.9))

# annotate each round with feature count
for n, auc_v, rid in zip(ns, aucs, rids):
    ax_auc.annotate(f"R{rid}\n{n}f",
                    (n, auc_v), textcoords="offset points",
                    xytext=(0, 14), ha="center", color=SUB, fontsize=7.5)

ax_auc.set_xlim(max(ns)+3, min(ns)-3)   # right-to-left: more feats on left
ax_auc.set_ylim(min(aucs)-0.01, max(aucs)+0.012)
ax_auc.legend(facecolor=CARD, edgecolor=BORDER, labelcolor=TEXT,
              fontsize=9, loc="lower left")

# ── TRAINING TIME ─────────────────────────────────────────────
sax(ax_train)
ax_train.set_title("Training Time vs Feature Count",
                   color=TEXT, fontsize=11, fontweight="bold", pad=8)
ax_train.set_xlabel("Number of Features", color=SUB, fontsize=9)
ax_train.set_ylabel("Training Time (s)", color=GREEN, fontsize=9)
ax_train.plot(ns, trains, color=GREEN, linewidth=2, marker="s",
              markersize=7, markerfacecolor=TEXT, markeredgecolor=GREEN)
ax_train.scatter([opt["n_features"]], [opt["train_sec"]],
                 color=YELLOW, s=120, zorder=5)
ax_train.set_xlim(max(ns)+2, min(ns)-2)
for n, t in zip(ns, trains):
    ax_train.annotate(f"{t:.2f}s", (n, t), textcoords="offset points",
                      xytext=(0, 8), ha="center", color=TEXT, fontsize=7.5)

# ── INFERENCE LATENCY ─────────────────────────────────────────
sax(ax_infer)
ax_infer.set_title("Inference Latency vs Feature Count\n(single-row, 200-rep mean)",
                   color=TEXT, fontsize=11, fontweight="bold", pad=8)
ax_infer.set_xlabel("Number of Features", color=SUB, fontsize=9)
ax_infer.set_ylabel("Latency (ms / call)", color=PURPLE, fontsize=9)
ax_infer.plot(ns, infers, color=PURPLE, linewidth=2, marker="^",
              markersize=7, markerfacecolor=TEXT, markeredgecolor=PURPLE)
ax_infer.scatter([opt["n_features"]], [opt["infer_ms"]],
                 color=YELLOW, s=120, zorder=5)
ax_infer.set_xlim(max(ns)+2, min(ns)-2)
for n, v in zip(ns, infers):
    ax_infer.annotate(f"{v:.3f}", (n, v), textcoords="offset points",
                      xytext=(0, 8), ha="center", color=TEXT, fontsize=7.5)

# ── SUMMARY TABLE ────────────────────────────────────────────
ax_tbl.set_facecolor(CARD)
for sp in ax_tbl.spines.values(): sp.set_edgecolor(BORDER)
ax_tbl.set_xticks([]); ax_tbl.set_yticks([])
ax_tbl.set_title("Round-by-Round Summary",
                 color=TEXT, fontsize=11, fontweight="bold", pad=8)

cols  = ["Round","# Feats","AUC","% Baseline","Acc","F1","Train (s)","Infer (ms)"]
rows  = [[r["round"], r["n_features"],
          f"{r['auc']:.5f}", f"{r['auc_pct_baseline']:.2f}%",
          f"{r['acc']:.4f}", f"{r['f1']:.4f}",
          f"{r['train_sec']:.2f}", f"{r['infer_ms']:.3f}"]
         for r in rounds]

tbl = ax_tbl.table(cellText=rows, colLabels=cols,
                   cellLoc="center", loc="center",
                   bbox=[0.0, 0.0, 1.0, 1.0])
tbl.auto_set_font_size(False)
tbl.set_fontsize(9)

for (row, col), cell in tbl.get_celld().items():
    cell.set_facecolor(CARD)
    cell.set_edgecolor(BORDER)
    cell.set_text_props(color=TEXT)
    if row == 0:
        cell.set_facecolor("#1f2937")
        cell.set_text_props(color=ACCENT, fontweight="bold")
    # highlight optimal row
    if row > 0 and rows[row-1][0] == opt_idx:
        cell.set_facecolor("#1a2a1a")
        cell.set_text_props(color=YELLOW, fontweight="bold")
    # red background for below-floor rows
    if row > 0:
        try:
            pct = float(rows[row-1][3].replace("%",""))
            if pct < 95.0:
                cell.set_facecolor("#2a1a1a")
                cell.set_text_props(color=RED)
        except: pass

out = "/home/user/workspace/ml_output/ablation/ablation_report.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor=BG)
plt.close()
print(f"[SAVED] {out}")
