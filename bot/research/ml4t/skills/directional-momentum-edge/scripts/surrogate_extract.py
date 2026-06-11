#!/usr/bin/env python3
"""
surrogate_extract.py — turn the validated (but opaque) decay-onset ML pocket into a
human-readable indicator confluence the live bot can run WITHOUT an ML runtime.

Operates on the onset CSVs exported by decay_onset.py. Three steps:

  STEP 1  EDA profile — feature medians for high-confidence WINNERS vs the rest,
          so you can see what the model keys on (quant version of the candle plots).
  STEP 2  Surrogate — a shallow DecisionTree (max_depth 2-3) on the exported
          features → target_decay_realized. Too shallow to overfit, so it is forced
          to print the 2-3 dominant conditions = your heuristic. Plus a per-feature
          winner/loser separation ranking (which indicators actually divide).
  STEP 3  Shootout — ML_Signal (p_decay_pct gate) vs Heuristic_Signal (the surrogate
          tree), evaluated OUT-OF-SAMPLE as a 2x2 disagreement matrix with win-rates.

Methodology guard: the surrogate is FIT on a temporal TRAIN slice and the matrix is
scored on a held-out TEST slice (default last 30% of timestamps), so the shootout is
not in-sample. A second CSV (--test-csv) is also scored as a cross-period check.

Directional features are SIDE-NORMALIZED (× the exhaustion sign) so the extracted
rule is symmetric — one confluence, mirrored for the short side, exactly how you'd
deploy it.

Usage:
  python surrogate_extract.py --csv exports/onsets_fxsb_4.0.csv \
         --test-csv exports/onsets_june_2.0.csv --depth 3 --ml-gate-pct 75
"""
from __future__ import annotations
import argparse, sys
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# symmetric features (magnitude / already directionless) used as-is
SYM = ["kc_bb_ratio", "bb_width_bps", "atr_pct"]
# directional features → multiplied by the exhaustion sign to make them symmetric
DIR = ["d_sma50", "ema_12_26_ratio", "stc_delta", "stoch_diff", "cci_20", "macd_hist_accel"]

def normalize(d: pd.DataFrame) -> pd.DataFrame:
    """Side-normalize so the rule is symmetric. sign=+1 bullish-exhaustion, -1 bearish.
    Names get a _dir suffix; psar_intact = trend not yet flipped against the stretch."""
    d = d.copy()
    d.columns = [c.strip() for c in d.columns]               # tolerate padded headers
    d["side"] = d["side"].astype(str).str.strip()
    sign = np.where(d["side"] == "bullish_exhaustion", 1.0, -1.0)
    out = pd.DataFrame(index=d.index)
    for c in SYM:
        out[c] = d[c]
    for c in DIR:
        # stretch & cci point WITH the stretch; stc/macd are counter-momentum.
        out[c + "_dir"] = sign * d[c]
    out["psar_intact"] = (((d["side"] == "bullish_exhaustion") & (d["psar_bull_flag"] == 1)) |
                          ((d["side"] == "bearish_exhaustion") & (d["psar_bull_flag"] == 0))).astype(int)
    out["target"] = d["target_decay_realized"].values
    out["p_decay_pct"] = d["p_decay_pct"].values
    out["timestamp"] = d["timestamp"].values
    return out

FEATS = SYM + [c + "_dir" for c in DIR] + ["psar_intact"]

META = {"timestamp", "side", "p_decay", "p_decay_pct", "target_decay_realized"}

def load_full(raw: pd.DataFrame):
    """Full 36-feature mode: use every engineered feature the MODEL saw, raw, plus a
    side_sign indicator (let the tree split on side itself). Fair surrogate test."""
    raw = raw.copy(); raw.columns = [c.strip() for c in raw.columns]
    raw["side"] = raw["side"].astype(str).str.strip()
    feats = [c for c in raw.columns if c not in META]
    out = raw[feats].copy()
    out["side_sign"] = np.where(raw["side"] == "bullish_exhaustion", 1.0, -1.0)
    out["target"] = raw["target_decay_realized"].values
    out["p_decay_pct"] = raw["p_decay_pct"].values
    out["timestamp"] = raw["timestamp"].values
    return out, feats + ["side_sign"]

def temporal_split(d, frac=0.7):
    cut = d["timestamp"].quantile(frac)
    return d[d["timestamp"] <= cut], d[d["timestamp"] > cut]

def matrix(d, heur, mlg, breakeven, title):
    ml = d["p_decay_pct"] >= mlg
    he = heur
    print(f"\n### Disagreement matrix — {title}  (n={len(d)}, base WR {d['target'].mean()*100:.1f}%)")
    print("| quadrant | n | win-rate | vs break-even |")
    print("|---|---|---|---|")
    for name, mask in [("Q1 consensus  (ML+ He+)", ml & he),
                       ("Q2 black-box  (ML+ He-)", ml & ~he),
                       ("Q3 trap       (ML- He+)", ~ml & he),
                       ("Q4 abstain    (ML- He-)", ~ml & ~he)]:
        n = int(mask.sum())
        wr = float(d.loc[mask, "target"].mean()) if n else np.nan
        mark = "✓" if (np.isfinite(wr) and wr > breakeven and n >= 20) else ""
        print(f"| {name} | {n} | {'—' if not np.isfinite(wr) else f'{wr*100:.1f}%'} | {mark} |")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="onset CSV to extract the surrogate from")
    ap.add_argument("--test-csv", default=None, help="second CSV for cross-period shootout")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--min-leaf", type=int, default=40)
    ap.add_argument("--train-frac", type=float, default=0.7)
    ap.add_argument("--ml-gate-pct", type=float, default=75, help="ML_Signal = p_decay_pct >= this")
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--full", action="store_true", help="use ALL engineered features (fair surrogate); CSV must be an --export-full file")
    args = ap.parse_args()
    breakeven = 1.0 / (1.0 + args.payout)

    global FEATS
    raw = pd.read_csv(args.csv)
    if args.full:
        d, FEATS = load_full(raw)
    else:
        d = normalize(raw)
    tr, te = temporal_split(d, args.train_frac)
    print(f"# Surrogate extraction — {args.csv}")
    print(f"rows {len(d)}  (train {len(tr)} / test {len(te)} by time)   base decay WR {d['target'].mean()*100:.1f}%"
          f"   break-even {breakeven*100:.1f}%")

    # ---- STEP 1: EDA profile ----
    win = d[(d["p_decay_pct"] >= args.ml_gate_pct) & (d["target"] == 1)]
    rest = d.drop(win.index)
    print(f"\n## STEP 1 — profile of high-confidence WINNERS (p_decay_pct≥{args.ml_gate_pct}, decay realized): "
          f"n={len(win)}")
    print("| feature | winners median | rest median | separation (single-feat AUC) |")
    print("|---|---|---|---|")
    seps = {}
    for f in FEATS:
        a, b = win[f].median(), rest[f].median()
        try:
            auc = roc_auc_score(d["target"], d[f]);  auc = max(auc, 1 - auc)   # |AUC-0.5| direction-free
        except Exception:
            auc = np.nan
        seps[f] = auc
        print(f"| {f} | {a:.3f} | {b:.3f} | {auc:.3f} |")
    top = sorted(seps, key=lambda k: -(seps[k] if np.isfinite(seps[k]) else 0))[:4]
    print(f"most separating features: {', '.join(top)}")

    # ---- STEP 2: shallow surrogate tree ----
    clf = DecisionTreeClassifier(max_depth=args.depth, min_samples_leaf=args.min_leaf,
                                 class_weight="balanced", random_state=0)
    clf.fit(tr[FEATS], tr["target"])
    print(f"\n## STEP 2 — surrogate tree (max_depth={args.depth}, fit on train slice)")
    print(export_text(clf, feature_names=FEATS).rstrip())
    imp = sorted(zip(FEATS, clf.feature_importances_), key=lambda x: -x[1])
    print("importance: " + ", ".join(f"{f} {w:.2f}" for f, w in imp if w > 0.01))

    # ---- STEP 3: shootout, out-of-sample ----
    heur_te = pd.Series(clf.predict(te[FEATS]) == 1, index=te.index)
    matrix(te, heur_te, args.ml_gate_pct, breakeven,
           f"{args.csv} held-out test slice (matched mask, OOS in time)")

    if args.test_csv:
        raw2 = pd.read_csv(args.test_csv)
        d2 = load_full(raw2)[0] if args.full else normalize(raw2)
        heur2 = pd.Series(clf.predict(d2[FEATS]) == 1, index=d2.index)
        matrix(d2, heur2, args.ml_gate_pct, breakeven,
               f"{args.test_csv} (CROSS-period / cross-mask generalization)")

    print("\nThe surrogate tree above IS the heuristic. If Q1 consensus WR spikes and Q3 "
          "(heuristic-yes, ML-no) stays low, the ML is filtering noise the rule alone can't — "
          "deploy the rule, keep the ML gate as the tie-breaker.")

if __name__ == "__main__":
    main()
