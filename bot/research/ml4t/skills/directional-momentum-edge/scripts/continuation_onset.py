#!/usr/bin/env python3
"""
continuation_onset.py — port a CONTINUATION onset CSV (the inverse of decay_onset)
so an ML model can DISCOVER the confluence thresholds, instead of us hand-picking them.

Population = the user's own structural filter: the 3 MAs stacked (sma_10>sma_20>sma_50
= uptrend, reverse = downtrend) — "all three moving averages aligned". Side = the
trend direction (bet WITH it = continuation). Label = did price continue in that
direction over the horizon. Features = the 36 engineered families, exported so
freeze/surrogate can find which RSI/stoch/candle/etc. thresholds pick the WINNERS.

This sets NO thresholds beyond the MA stack (their stated rule). Everything else is
left for the ML to detect. Then run alpha-factor-eval / a logistic+surrogate pass on
the CSV, triple-regime (FXSB/June/agent), same as the fade pipeline.

Usage:
  python continuation_onset.py --db agent/data/agent_FXSB.db --export <out.csv>
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
BAR = 300

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="path(s), comma-separated, repo-relative ok")
    ap.add_argument("--horizon", type=int, default=10, help="continuation horizon (min) for the target")
    ap.add_argument("--export", required=True)
    args = ap.parse_args()
    dbs = [d.strip() for d in args.db.split(",") if d.strip()]

    parts = []
    for i, db in enumerate(dbs):
        p = db if os.path.isabs(db) else os.path.join(ROOT, db)
        d = po_data.load(p)
        if len(dbs) > 1: d["asset"] = d["asset"] + f"@{i}"
        parts.append(d)
    df = pd.concat(parts, ignore_index=True)
    X, _ = po_data.engineer_families(df)

    rows = []
    for _, g in df.groupby("asset", sort=False):
        idx = g.index
        gg = g.sort_values("timestamp")
        s10, s20, s50 = gg["sma_10"], gg["sma_20"], gg["sma_50"]
        up = (s10 > s20) & (s20 > s50)
        dn = (s10 < s20) & (s20 < s50)
        close, ts = gg["close"].astype(float), gg["timestamp"]
        n = (args.horizon*60)//BAR
        fwd = np.sign(close.shift(-n) - close).where(ts.shift(-n) - ts == n*BAR)
        side = np.where(up, "uptrend", np.where(dn, "downtrend", None))
        cont = np.where(up, fwd > 0, np.where(dn, fwd < 0, np.nan)).astype(float)
        cont = np.where((up | dn) & fwd.notna(), cont, np.nan)
        m = (up | dn) & fwd.notna()
        sub = pd.DataFrame(index=gg.index[m])
        sub["timestamp"] = gg.loc[m, "timestamp"].values
        sub["asset"] = gg.loc[m, "asset"].str.replace(r"@\d+$", "", regex=True).values
        sub["side"] = side[m.values]
        for c in X.columns:
            sub[c] = X.loc[sub.index, c].values
        for hh in (5, 10, 15):
            nn = (hh*60)//BAR
            fc, ft = close.shift(-nn), ts.shift(-nn)
            sub[f"fwd_{hh}m_ret"] = (fc/close - 1).where(ft - ts == nn*BAR).loc[sub.index].values
        sub["target_continuation"] = cont[m.values]
        rows.append(sub)
    out = pd.concat(rows, ignore_index=True)
    base = out["target_continuation"].mean()
    outp = args.export if os.path.isabs(args.export) else os.path.join(ROOT, args.export)
    out.to_csv(outp, index=False)
    print(f"continuation onsets {len(out)} ({out['side'].value_counts().to_dict()})  "
          f"base continuation rate {base*100:.1f}%  → {os.path.relpath(outp, ROOT)} ({out.shape[1]} cols)")

if __name__ == "__main__":
    main()
