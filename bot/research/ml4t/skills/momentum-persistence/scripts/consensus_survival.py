#!/usr/bin/env python3
"""
consensus_survival.py — Stage 5 for the decay-onset consensus events.

Surrogate extraction (Stage S) found the high-conviction signal: Q1 CONSENSUS =
the rows where the shallow heuristic AND the ML p_decay gate both fire (~62% OOP).
This script answers the last open question — the TRADE DURATION:

  - For those exact consensus events, what is the fade win-rate at each candidate
    expiry (5/10/15m)? = the survival curve. Which fixed expiry is best?
  - Does the optimal expiry depend on WHAT drove the onset? Split the consensus set
    by driver:
        FAST  = volatility-shock onsets  (high |atr_pct_d|)   -> expect a quick snap
        SLOW  = stoch-divergence grinds   (high |stoch_kd|)    -> expect a slow turn
    and compare their survival curves.

Reproduces the Q1 set exactly: surrogate fit on a temporal train slice of --csv
(all 36 features, depth 3), applied to --test-csv; Q1 = heuristic AND p_decay_pct
>= gate. Fade win at horizon h: price moved AGAINST the stretch at +h bars
(bullish-exhaustion -> fwd_h < 0 ; bearish -> fwd_h > 0). READ-ONLY (csv only).

Usage:
  python consensus_survival.py \
    --csv  ../../directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv \
    --test-csv ../../directional-momentum-edge/exports/onsets_june_2.0_full.csv
"""
from __future__ import annotations
import argparse, sys
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

META = {"timestamp", "side", "p_decay", "p_decay_pct", "target_decay_realized"}
HORIZONS = [5, 10, 15]            # the export carries fwd_5m/10m/15m_ret

def load_full(path):
    d = pd.read_csv(path)
    d.columns = [c.strip() for c in d.columns]
    d["side"] = d["side"].astype(str).str.strip()
    feats = [c for c in d.columns if c not in META and not c.startswith("fwd_")]
    return d, feats

def fade_win(d, h):
    """1 if the fade (reversion) is winning at +h minutes, per side."""
    col = f"fwd_{h}m_ret"
    bull = d["side"] == "bullish_exhaustion"
    return ((bull & (d[col] < 0)) | (~bull & (d[col] > 0))).astype(float)

def survival_row(sub, breakeven, label):
    cells = []
    best = (None, -1)
    for h in HORIZONS:
        wr = fade_win(sub, h).mean() if len(sub) else np.nan
        cells.append(f"{wr*100:.1f}%" + ("✓" if np.isfinite(wr) and wr > breakeven else ""))
        if np.isfinite(wr) and wr > best[1]:
            best = (h, wr)
    print(f"| {label} | {len(sub)} | " + " | ".join(cells) +
          f" | **{best[0]}m ({best[1]*100:.1f}%)** |")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="onset _full CSV to fit the surrogate on")
    ap.add_argument("--test-csv", required=True, help="onset _full CSV to map consensus survival on")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--min-leaf", type=int, default=40)
    ap.add_argument("--train-frac", type=float, default=0.7)
    ap.add_argument("--ml-gate-pct", type=float, default=75)
    ap.add_argument("--payout", type=float, default=0.8)
    args = ap.parse_args()
    breakeven = 1.0 / (1.0 + args.payout)

    tr_all, feats = load_full(args.csv)
    cut = tr_all["timestamp"].quantile(args.train_frac)
    tr = tr_all[tr_all["timestamp"] <= cut]
    clf = DecisionTreeClassifier(max_depth=args.depth, min_samples_leaf=args.min_leaf,
                                 class_weight="balanced", random_state=0)
    clf.fit(tr[feats], tr["target_decay_realized"])

    te, _ = load_full(args.test_csv)
    heur = clf.predict(te[feats]) == 1
    ml = te["p_decay_pct"] >= args.ml_gate_pct
    q1 = te[heur & ml].copy()

    print(f"\n# Consensus Survival — Q1 (heuristic ∧ p_decay≥{args.ml_gate_pct}pct) on {args.test_csv}")
    print(f"consensus events: {len(q1)}   break-even {breakeven*100:.1f}%\n")
    if len(q1) < 30:
        print("Too few consensus events to map a survival curve."); return

    print("## Fade win-rate by expiry (the survival curve)")
    print("| group | n | 5m | 10m | 15m | best expiry |")
    print("|---|---|---|---|---|---|")
    survival_row(q1, breakeven, "ALL consensus")

    # ---- stratify by onset driver ----
    # FAST = volatility shock (|atr_pct_d| high) ; SLOW = stoch-divergence grind (|stoch_kd| high)
    atr = q1["v_atr_pct_d"].abs() if "v_atr_pct_d" in q1 else pd.Series(np.nan, index=q1.index)
    stoch = q1["m_stoch_kd"].abs() if "m_stoch_kd" in q1 else pd.Series(np.nan, index=q1.index)
    # rank each driver within the consensus set; classify by which is more extreme
    fast = atr.rank(pct=True) >= stoch.rank(pct=True)
    print("\n## Stratified by dominant onset driver")
    print("| group | n | 5m | 10m | 15m | best expiry |")
    print("|---|---|---|---|---|---|")
    survival_row(q1[fast],  breakeven, "FAST  (vol-shock, atr_pct_d)")
    survival_row(q1[~fast], breakeven, "SLOW  (stoch grind, stoch_kd)")
    # also a clean median split on each raw driver for cross-check
    for name, s in (("atr_pct_d high", atr >= atr.median()),
                    ("stoch_kd  high", stoch >= stoch.median())):
        survival_row(q1[s], breakeven, name)

    # ---- conditional survival: does an early snap hold, or revert back? ----
    print("\n## Conditional hold — of events fading at 5m, fraction still fading later")
    win5 = fade_win(q1, 5).astype(bool)
    base = win5.sum()
    if base:
        for h in (10, 15):
            still = (win5 & fade_win(q1, h).astype(bool)).sum()
            print(f"  fade@5m → still fading @{h}m: {still}/{base} = {still/base*100:.1f}%")
    print("\nReading: pick the expiry that maximizes fade WR for each driver. A FAST onset that peaks "
          "at 5m and decays by 15m wants a short expiry; a SLOW grind that only clears at 15m wants a "
          "long one. The 'conditional hold' shows whether the reversal sticks or round-trips.")

if __name__ == "__main__":
    main()
