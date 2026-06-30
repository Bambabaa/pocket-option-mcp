"""Performance report v3 — clean layout, no annotation overlap, wider margins."""
import json, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
from matplotlib.gridspec import GridSpec

with open("/home/user/workspace/ml_output/summary.json") as f:
    s = json.load(f)

models_order = ["Logistic Regression","Random Forest","HistGradBoost","XGBoost","LightGBM","Decision Tree"]
models_order = [m for m in models_order if m in s["model_results"]]
short_names  = ["Log Reg", "Rand\nForest", "HistGB", "XGBoost", "LightGBM", "Dec\nTree"]

accs = [s["model_results"][m]["acc"] for m in models_order]
aucs = [s["model_results"][m]["auc"] for m in models_order]
f1s  = [s["model_results"][m]["f1"]  for m in models_order]

shap_top5 = list(s["shap_top5"].items())
shap_top5_sorted = sorted(shap_top5, key=lambda x: x[1])

wf       = s["walkforward"]
fold_ids  = [r["fold"] for r in wf]
fold_aucs = [r["auc"]  for r in wf]
fold_accs = [r["acc"]  for r in wf]

BG      = "#0d1117"
CARD    = "#161b22"
ACCENT  = "#58a6ff"
GREEN   = "#3fb950"
YELLOW  = "#d29922"
RED     = "#f85149"
TEXT    = "#e6edf3"
SUBTEXT = "#8b949e"
BORDER  = "#30363d"
PURPLE  = "#bc8cff"
SALMON  = "#ff9980"
TEAL       = "#39d0d8"
BAR_COLORS = [ACCENT, GREEN, YELLOW, PURPLE, SALMON, TEAL]
BEST_IDX   = models_order.index(s["best_model"])

fig = plt.figure(figsize=(22, 26), facecolor=BG)
fig.patch.set_facecolor(BG)

gs = GridSpec(4, 3, figure=fig, hspace=0.60, wspace=0.42,
              top=0.93, bottom=0.04, left=0.07, right=0.93)

ax_title = fig.add_subplot(gs[0, :])
ax_acc   = fig.add_subplot(gs[1, 0])
ax_auc   = fig.add_subplot(gs[1, 1])
ax_f1    = fig.add_subplot(gs[1, 2])
ax_shap  = fig.add_subplot(gs[2, :])
ax_wf    = fig.add_subplot(gs[3, :])

def style_ax(ax, title, xlabel="", ylabel=""):
    ax.set_facecolor(CARD)
    for spine in ax.spines.values(): spine.set_edgecolor(BORDER)
    ax.tick_params(colors=SUBTEXT, labelsize=9)
    ax.set_title(title, color=TEXT, fontsize=11, fontweight="bold", pad=10)
    if xlabel: ax.set_xlabel(xlabel, color=SUBTEXT, fontsize=9)
    if ylabel: ax.set_ylabel(ylabel, color=SUBTEXT, fontsize=9)
    ax.grid(axis="y", color=BORDER, linewidth=0.5, alpha=0.5)
    ax.set_axisbelow(True)

def bar_chart(ax, values, title, ylabel, ymin, ymax):
    style_ax(ax, title, ylabel=ylabel)
    bars = ax.bar(range(len(short_names)), values, color=BAR_COLORS[:len(models_order)],
                  edgecolor=BORDER, linewidth=0.8, width=0.55)
    bars[BEST_IDX].set_edgecolor(TEXT)
    bars[BEST_IDX].set_linewidth(2.2)
    ax.set_ylim(ymin, ymax)
    ax.set_xticks(range(len(short_names)))
    ax.set_xticklabels(short_names, color=TEXT, fontsize=8.5, rotation=0, ha="center")
    rng = ymax - ymin
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width()/2,
                bar.get_height() + rng * 0.013,
                f"{val:.4f}", ha="center", va="bottom",
                color=TEXT, fontsize=8, fontweight="bold")

# ── TITLE ─────────────────────────────────────────────────────
ax_title.set_facecolor(CARD)
for sp in ax_title.spines.values(): sp.set_edgecolor(BORDER)
ax_title.set_xticks([]); ax_title.set_yticks([])
ax_title.text(0.5, 0.76, "Trading ML Model v2 — Performance Report",
              transform=ax_title.transAxes, ha="center",
              color=TEXT, fontsize=18, fontweight="bold")
ax_title.text(0.5, 0.48,
    f"Dataset: agent_v1.db   |   13 Forex pairs   |   5-min bars   |   "
    f"{s['n_rows']:,} ML rows   |   {s['n_features']} engineered features   |   "
    f"Label horizon: {s['horizon']} candles forward (15 min)",
    transform=ax_title.transAxes, ha="center", color=SUBTEXT, fontsize=10)
ax_title.text(0.5, 0.20,
    f"Raw-indicator mode  (signal-score layer not yet populated)   |   "
    f"Best model: {s['best_model']}   AUC = {s['model_results'][s['best_model']]['auc']:.4f}",
    transform=ax_title.transAxes, ha="center", color=YELLOW, fontsize=10)

# ── BAR CHARTS ────────────────────────────────────────────────
bar_chart(ax_acc, accs, "Accuracy",           "Accuracy",       0.54, 0.73)
bar_chart(ax_auc, aucs, "ROC-AUC",            "AUC",            0.65, 0.74)
bar_chart(ax_f1,  f1s,  "F1 Score (weighted)", "F1 (weighted)", 0.50, 0.68)

# ── SHAP TOP 5 ────────────────────────────────────────────────
ax_shap.set_facecolor(CARD)
for sp in ax_shap.spines.values(): sp.set_edgecolor(BORDER)
ax_shap.set_title(
    f"SHAP — Top 5 Predictive Features   [{s['best_model']}, raw-indicator mode]",
    color=TEXT, fontsize=11, fontweight="bold", pad=10)
ax_shap.set_xlabel("Mean |SHAP| value  (average absolute contribution to prediction)",
                   color=SUBTEXT, fontsize=9)
ax_shap.grid(axis="x", color=BORDER, linewidth=0.5, alpha=0.5)
ax_shap.set_axisbelow(True)

feat_names = [f for f, _ in shap_top5_sorted]
feat_vals  = [v for _, v in shap_top5_sorted]
shap_colors = [GREEN if i == len(feat_names)-1 else ACCENT
               for i in range(len(feat_names))]

hbars = ax_shap.barh(feat_names, feat_vals,
                      color=shap_colors, edgecolor=BORDER, linewidth=0.8, height=0.45)
ax_shap.tick_params(colors=TEXT, labelsize=12, axis="y")
ax_shap.tick_params(colors=SUBTEXT, labelsize=9, axis="x")

max_v = max(feat_vals)
for bar, val in zip(hbars, feat_vals):
    ax_shap.text(val + max_v * 0.015,
                 bar.get_y() + bar.get_height() / 2,
                 f"{val:.4f}", va="center", color=TEXT,
                 fontsize=10, fontweight="bold")

# note placed BELOW the candle_range bar — no overlap
ax_shap.text(max_v * 0.35, -0.55,
             "candle_range dominates: ~3× stronger than the next feature",
             color=YELLOW, fontsize=9, style="italic",
             bbox=dict(boxstyle="round,pad=0.3", facecolor=CARD,
                       edgecolor=YELLOW, alpha=0.9))
ax_shap.set_xlim(0, max_v * 1.28)
ax_shap.set_ylim(-0.9, len(feat_names) - 0.3)

# ── WALK-FORWARD ──────────────────────────────────────────────
ax_wf.set_facecolor(CARD)
for sp in ax_wf.spines.values(): sp.set_edgecolor(BORDER)
ax_wf.set_title(
    "Walk-Forward Validation  (Random Forest, 5-fold TimeSeriesSplit)",
    color=TEXT, fontsize=11, fontweight="bold", pad=10)
ax_wf.set_xlabel("Fold", color=SUBTEXT, fontsize=9)
ax_wf.set_ylabel("ROC-AUC", color=ACCENT, fontsize=10)
ax_wf.tick_params(colors=SUBTEXT, labelsize=9)
ax_wf.grid(axis="y", color=BORDER, linewidth=0.5, alpha=0.5)
ax_wf.set_axisbelow(True)

ax_wf.plot(fold_ids, fold_aucs, color=ACCENT, linewidth=2.2, marker="o",
           markersize=9, markerfacecolor=TEXT, markeredgecolor=ACCENT,
           label="Fold AUC", zorder=3)
ax_wf.axhline(s["wf_mean_auc"], color=YELLOW, linewidth=1.8, linestyle="--",
              label=f"Mean AUC = {s['wf_mean_auc']:.4f} ± {s['wf_std_auc']:.4f}", zorder=2)
ax_wf.axhline(0.5, color=RED, linewidth=1.2, linestyle=":", alpha=0.85,
              label="Random baseline (0.50)", zorder=1)
ax_wf.set_xticks(fold_ids)
ax_wf.set_xticklabels([f"Fold {i}" for i in fold_ids], color=TEXT, fontsize=9)
ax_wf.set_ylim(0.44, 0.82)
ax_wf.legend(facecolor=CARD, edgecolor=BORDER, labelcolor=TEXT,
             fontsize=9, loc="upper left", framealpha=0.9)
for x, y in zip(fold_ids, fold_aucs):
    ax_wf.annotate(f"{y:.4f}", (x, y), textcoords="offset points",
                   xytext=(0, 12), ha="center", color=TEXT, fontsize=8.5)

# Secondary axis with extra right margin — no clipping
ax_wf2 = ax_wf.twinx()
ax_wf2.set_facecolor(CARD)
ax_wf2.plot(fold_ids, fold_accs, color=GREEN, linewidth=1.8, linestyle="--",
            marker="s", markersize=7, markerfacecolor=GREEN,
            alpha=0.95, label="Fold Accuracy", zorder=3)
ax_wf2.set_ylabel("Accuracy", color=GREEN, fontsize=10, labelpad=14)
ax_wf2.tick_params(colors=GREEN, labelsize=9, pad=6)
ax_wf2.set_ylim(0.44, 0.82)
ax_wf2.legend(facecolor=CARD, edgecolor=BORDER, labelcolor=TEXT,
              fontsize=9, loc="center right", framealpha=0.9)

out = "/home/user/workspace/ml_output/performance_report.png"
fig.savefig(out, dpi=150, bbox_inches="tight", facecolor=BG)
plt.close()
print(f"[SAVED] {out}")
