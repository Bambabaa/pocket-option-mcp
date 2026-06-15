#!/usr/bin/env python3
"""
calibration_analysis.py — does trading the high-confidence tail of p_decay lift the
win-rate, OUT-OF-SAMPLE? The safe narrowing lever, with the overfitting lie-detector.

p_decay is the frozen gate's dimensional reduction of the 36 features. If the model is
calibrated, fade-WR should rise monotonically with p_decay — and crucially, it must do so
on JUNE (out-of-sample), not just FXSB (in-sample, the logistic's own training data).

Always prints FXSB and June side-by-side. A lift that shows on FXSB but not June is the
overfitting surface — read both columns, never one.

Usage:
  python calibration_analysis.py
  python calibration_analysis.py --fxsb <fxsb_4.0_full.csv> --june <june_4.0_full.csv>
"""
from __future__ import annotations
import argparse, json, os, sys
import numpy as np
import pandas as pd
from scipy import stats

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
EXP  = os.path.join(ROOT, "bot", "research", "ml4t", "skills", "directional-momentum-edge", "exports")
META = {"timestamp", "asset", "side", "p_decay", "p_decay_pct", "target_decay_realized"}

def p_decay(d, P):
    feats = P["ml_model"]["features"]
    X = d[feats].astype(float).values
    mean = np.array(P["ml_model"]["scaler"]["means"]); scale = np.array(P["ml_model"]["scaler"]["scales"])
    w = np.array(P["ml_model"]["weights"]); b = P["ml_model"]["bias"]
    z = np.where(np.isnan(X), 0.0, (X - mean) / scale)
    return 1.0 / (1.0 + np.exp(-(z @ w + b)))

def fade_win(d, h=10):
    bull = d["side"].values == "bullish_exhaustion"
    fwd = d[f"fwd_{h}m_ret"].values
    w = np.where(bull, fwd < 0, fwd > 0).astype(float)
    return pd.Series(np.where(np.isnan(fwd), np.nan, w), index=d.index)

def load(path, P):
    d = pd.read_csv(path); d.columns = [c.strip() for c in d.columns]
    d["side"] = d["side"].astype(str).str.strip()
    d["pdg"] = p_decay(d, P)
    d["win"] = fade_win(d, 10)
    return d[d["win"].notna()].copy()

def wr(sub):
    return (sub["win"].mean()*100, len(sub)) if len(sub) else (np.nan, 0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fxsb", default=os.path.join(EXP, "onsets_fxsb_4.0_full.csv"))
    ap.add_argument("--june", default=os.path.join(EXP, "onsets_june_4.0_full.csv"))
    ap.add_argument("--params", default=os.path.join(ROOT, "bot", "research", "tests", "ml_gate_params.json"))
    ap.add_argument("--payout", type=float, default=0.8)
    args = ap.parse_args()
    be = 1.0/(1.0+args.payout)
    P = json.load(open(args.params))
    F = load(args.fxsb, P); J = load(args.june, P)

    print(f"\n# p_decay Calibration — FXSB (in-sample) vs June (OOS)   break-even {be*100:.1f}%")
    print(f"FXSB onsets {len(F)} | June onsets {len(J)}   (fade-WR @ {P['expiry_minutes']}m)\n")

    # ---- calibration curve: WR by p_decay decile (rank within each set) ----
    print("## Calibration curve — fade-WR by p_decay decile (D1 low → D10 high)")
    print("| decile | FXSB n | FXSB WR | June n | June WR |")
    print("|---|---|---|---|---|")
    fwrs, jwrs = [], []
    for q in range(10):
        fcut = (F["pdg"].rank(pct=True) > q/10) & (F["pdg"].rank(pct=True) <= (q+1)/10)
        jcut = (J["pdg"].rank(pct=True) > q/10) & (J["pdg"].rank(pct=True) <= (q+1)/10)
        fw, fn = wr(F[fcut]); jw, jn = wr(J[jcut])
        fwrs.append(fw); jwrs.append(jw)
        print(f"| D{q+1} | {fn} | {fw:.1f}% | {jn} | {'—' if not np.isfinite(jw) else f'{jw:.1f}%'} |")
    # monotonicity (the lie detector): does WR rise with decile, in EACH regime?
    fm = stats.spearmanr(range(10), fwrs).correlation
    jv = [x for x in jwrs if np.isfinite(x)]
    jm = stats.spearmanr(range(len(jv)), jv).correlation if len(jv) > 2 else np.nan
    print(f"\nmonotonicity (decile→WR rank-corr):  FXSB {fm:+.2f}   June {jm:+.2f}   "
          f"(both → +1 = calibrated OOS; June flat/negative = overfit)")

    # ---- actionable: trade the top X% of p_decay ----
    print("\n## Trade the top-X% by p_decay  (coverage / WR, both regimes)")
    print("| cut | FXSB cov | FXSB WR | June cov | June WR | OOS clears? |")
    print("|---|---|---|---|---|---|")
    for top in [50, 25, 20, 15, 10, 5]:
        ft = F[F["pdg"].rank(pct=True) > 1 - top/100]
        jt = J[J["pdg"].rank(pct=True) > 1 - top/100]
        fw, fn = wr(ft); jw, jn = wr(jt)
        fc, jc = fn/len(F)*100, jn/len(J)*100
        clears = "✓" if (np.isfinite(jw) and jw/100 > be and jn >= 15) else ("(thin)" if jn < 15 else "")
        print(f"| top {top}% | {fc:.0f}% | {fw:.1f}% | {jc:.0f}% | "
              f"{'—' if not np.isfinite(jw) else f'{jw:.1f}%'} (n={jn}) | {clears} |")

    print("\nRead the JUNE column. If June WR rises smoothly toward the top and the top-10% clears "
          "break-even with non-trivial n, the p_decay tail is a real, safe narrowing lever. If June "
          "is flat or zigzags while FXSB rises, the model is over-confident in-sample — the lie detector.")

if __name__ == "__main__":
    main()
