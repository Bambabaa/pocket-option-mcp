#!/usr/bin/env python3
"""
indicator_scan.py — hunt for a THIRD KEY: an indicator dimension (beyond the gate's
mask + heuristic + logistic) whose threshold band correlates with WINNING fades,
and does so CONSISTENTLY across all three regimes (the triple lie detector).

Within the onset population (not Q1 — too small to mine), for every engineered
feature it computes the side-folded single-feature separation of fade winners vs
losers (AUC) in FXSB / June / agent side by side, ranks by cross-regime consistency,
then prints quintile-band fade-WR curves for the survivors. Accept a band only if the
same direction repeats in all three columns.

Directional features are folded into the fade frame (center + sign·(x−center)) so
bullish/bearish onsets are comparable; magnitude features are used as-is. A few derived
magnitudes (|cci|, |di_spread|) are added.

Usage: python indicator_scan.py [--horizon 10]
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
EXP  = os.path.join(ROOT, "bot", "research", "ml4t", "skills", "directional-momentum-edge", "exports")
META = {"timestamp", "asset", "side", "p_decay", "p_decay_pct", "target_decay_realized"}
SETS = [("FXSB", "onsets_fxsb_4.0_full.csv"), ("June", "onsets_june_4.0_full.csv"),
        ("agent", "onsets_agent_4.0_full.csv")]
# side-normalization centers (fold directional features into the bullish/fade frame)
CENTERS = {
    **{f: 0.0 for f in ["t_close_sma10","t_close_sma20","t_close_sma50","t_close_ema12","t_close_ema26",
                        "t_ema_spread","t_sma_10_20","t_sma_20_50","t_close_psar","t_macd_cross",
                        "m_rsi_d","m_stoch_kd","m_stc_delta","m_stc_gap","m_cci","m_macd_hist",
                        "m_macd_hist_d","v_close_kc","b_di_spread"]},
    **{f: 50.0 for f in ["m_rsi","m_stoch_k","m_stoch_d","m_stc"]},
    "m_williams": -50.0, "v_pctB": 0.5, "t_psar_bull": 0.5,
}

def load(path, h):
    d = pd.read_csv(path); d.columns = [c.strip() for c in d.columns]
    d["side"] = d["side"].astype(str).str.strip()
    bull = d["side"].values == "bullish_exhaustion"; fwd = d[f"fwd_{h}m_ret"].values
    d["win"] = np.where(np.isnan(fwd), np.nan, np.where(bull, fwd < 0, fwd > 0).astype(float))
    d["sign"] = np.where(bull, 1.0, -1.0)
    return d[d["win"].notna()].copy()

def folded(d, f):
    x = d[f].astype(float).values
    if f in CENTERS:
        c = CENTERS[f]; return c + d["sign"].values * (x - c)
    return x

def auc(d, vals):
    m = ~np.isnan(vals)
    if m.sum() < 50 or len(np.unique(d["win"].values[m])) < 2:
        return np.nan
    try:
        return roc_auc_score(d["win"].values[m], vals[m])   # >0.5: higher value → win
    except Exception:
        return np.nan

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--horizon", type=int, default=10)
    ap.add_argument("--payout", type=float, default=0.8); args = ap.parse_args()
    be = 1/(1+args.payout)*100
    dfs = {name: load(os.path.join(EXP, fn), args.horizon) for name, fn in SETS}
    feats = [c for c in dfs["FXSB"].columns if c not in META and not c.startswith("fwd_")
             and c not in ("win", "sign")]
    # derived magnitudes
    for name, d in dfs.items():
        d["_cci_abs"] = d["m_cci"].abs(); d["_di_abs"] = d["b_di_spread"].abs()
    feats += ["_cci_abs", "_di_abs"]

    print(f"\n# Indicator scan — fade-winner separation within onsets (@ {args.horizon}m), 3 regimes")
    print(f"n: FXSB {len(dfs['FXSB'])} | June {len(dfs['June'])} | agent {len(dfs['agent'])}   "
          f"break-even {be:.1f}%   (AUC>0.5 ⇒ higher folded value predicts a WIN)\n")

    rows = []
    for f in feats:
        a = {name: auc(d, folded(d, f)) for name, d in dfs.items()}
        if any(np.isnan(v) for v in a.values()):
            continue
        dev = [v - 0.5 for v in a.values()]
        same = all(x > 0 for x in dev) or all(x < 0 for x in dev)     # same direction in all 3
        consistency = min(abs(x) for x in dev) if same else 0.0       # weakest-link if aligned, else 0
        rows.append((f, a["FXSB"], a["June"], a["agent"], same, consistency))
    rows.sort(key=lambda r: -r[5])

    print("| feature | FXSB AUC | June AUC | agent AUC | same dir? | min|dev| |")
    print("|---|---|---|---|---|---|")
    for f, fx, ju, ag, same, cons in rows:
        flag = "✓" if same and cons > 0.02 else ("aligned" if same else "")
        print(f"| {f} | {fx:.3f} | {ju:.3f} | {ag:.3f} | {'yes' if same else 'no'} | {cons:.3f} {flag} |")

    # band curves for the top cross-regime-consistent survivors
    survivors = [r for r in rows if r[4] and r[5] > 0.02][:5]
    if survivors:
        print(f"\n## Quintile-band fade-WR for survivors (folded feature low→high; WR% per regime)")
        for f, fx, ju, ag, *_ in survivors:
            print(f"\n### {f}")
            print("| quintile | FXSB | June | agent |")
            print("|---|---|---|---|")
            edges = np.quantile(folded(dfs["FXSB"], f), np.linspace(0, 1, 6))
            for q in range(5):
                cells = []
                for name, d in dfs.items():
                    v = folded(d, f); m = (v >= edges[q]) & (v <= edges[q+1]) & d["win"].notna()
                    cells.append(f"{d.loc[m,'win'].mean()*100:.0f}% (n={int(m.sum())})" if m.sum() >= 8 else "—")
                print(f"| Q{q+1} | " + " | ".join(cells) + " |")
    else:
        print("\nNo feature separates winners from losers consistently across all three regimes.")
    print(f"\n(Survivor = same direction in all 3 regimes AND min|AUC−0.5| > 0.02. A band only counts "
          f"if its WR lift repeats across FXSB/June/agent — one-regime spikes are the mining trap.)")

if __name__ == "__main__":
    main()
