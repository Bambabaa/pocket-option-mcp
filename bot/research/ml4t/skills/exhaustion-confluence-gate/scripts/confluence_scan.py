#!/usr/bin/env python3
"""
confluence_scan.py — does the FAITHFUL exhaustion confluence carry edge the lossy
kinetic gate lost?

Encodes the human read LEVEL- and DIRECTION-aware, per side:
  bearish ceiling (fade -> PUT):
    band : high >= bb_upper AND close < bb_upper        (tagged then rejected)
    stoch: stoch_k >= 80 AND (k-d) < 0 AND (k-d) just crossed down
    stc  : stc >= 75 AND stc[t] < stc[t-1]
    cci  : cci > 100 AND cci[t] < cci[t-2]
  bullish floor (fade -> CALL): mirror (<=, oversold, below -100, turning up).

confluence_score = count of the 4 met. Bet fades the extreme; WIN = price closes against
the extreme over the horizon. Reports fade-WR by confluence_score, per side, on BOTH
agent_v1 (train period) and agent (clean OOS) — the two-period lie detector — at several
expiry horizons. Break-even ~59% @ 0.69 payout.

Usage: python confluence_scan.py [--horizons 3,6,12]   (bars; 5min each)
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
def R(p): return os.path.join(ROOT, p)
BAR = 300
PERIODS = {"agent_v1 (train)": "agent/data/agent_v1.db", "agent (OOS)": "agent/data/agent.db"}
BE = 0.59

def build(db, horizons):
    d = po_data.load(R(db))
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, o, hi, lo, ts = (g["close"].astype(float), g["open"].astype(float),
                            g["high"].astype(float), g["low"].astype(float), g["timestamp"])
        k, dd = g["stoch_k"].astype(float), g["stoch_d"].astype(float)
        stc, cci = g["stc_value"].astype(float), g["cci_20"].astype(float)
        kd = k - dd; kd_prev = kd.shift(1)
        # --- bearish ceiling conditions ---
        be_band  = (hi >= g["bb_upper"]) & (c < g["bb_upper"])
        be_stoch = (k >= 80) & (kd < 0) & (kd_prev >= 0)
        be_stc   = (stc >= 75) & (stc < stc.shift(1))
        be_cci   = (cci > 100) & (cci < cci.shift(2))
        # --- bullish floor conditions (mirror) ---
        bu_band  = (lo <= g["bb_lower"]) & (c > g["bb_lower"])
        bu_stoch = (k <= 20) & (kd > 0) & (kd_prev <= 0)
        bu_stc   = (stc <= 25) & (stc > stc.shift(1))
        bu_cci   = (cci < -100) & (cci > cci.shift(2))
        g["bear_score"] = be_band.astype(int)+be_stoch.astype(int)+be_stc.astype(int)+be_cci.astype(int)
        g["bull_score"] = bu_band.astype(int)+bu_stoch.astype(int)+bu_stc.astype(int)+bu_cci.astype(int)
        for H in horizons:
            fwd = c.shift(-H) - c; okH = (ts.shift(-H) - ts == H*BAR)
            # fade bearish -> win if price falls; fade bullish -> win if price rises
            g[f"bear_win_{H}"] = np.where(okH, (fwd < 0).astype(float), np.nan)
            g[f"bull_win_{H}"] = np.where(okH, (fwd > 0).astype(float), np.nan)
        rows.append(g)
    return pd.concat(rows)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--horizons", default="3,6,12")
    a = ap.parse_args(); hz = [int(x) for x in a.horizons.split(",")]
    data = {name: build(db, hz) for name, db in PERIODS.items()}
    print(f"# Faithful exhaustion-confluence scan — fade WR by confluence agreement")
    print(f"break-even {BE*100:.0f}% @ 0.69 payout | two-period lie detector (train vs clean OOS)\n")
    for H in hz:
        print(f"## Horizon {H} bars ({H*5} min)")
        for side in ["bear", "bull"]:
            label = "BEARISH ceiling -> PUT" if side=="bear" else "BULLISH floor -> CALL"
            print(f"\n### {label}")
            print("| confluence_score | " + " | ".join(data.keys()) + " |")
            print("|---|" + "---|"*len(data))
            for s in [1,2,3,4]:
                cells = []
                for name, d in data.items():
                    m = (d[f"{side}_score"] == s) & d[f"{side}_win_{H}"].notna()
                    n = int(m.sum())
                    if n >= 20:
                        wr = d.loc[m, f"{side}_win_{H}"].mean()*100
                        flag = "*" if wr >= BE*100 else ""
                        cells.append(f"{wr:.0f}%{flag} (n={n})")
                    else:
                        cells.append(f"thin (n={n})")
                print(f"| >={s} agree... =={s} | " + " | ".join(cells) + " |")
            # cumulative >=3
            cells = []
            for name, d in data.items():
                m = (d[f"{side}_score"] >= 3) & d[f"{side}_win_{H}"].notna()
                n=int(m.sum())
                if n>=20:
                    wr=d.loc[m,f"{side}_win_{H}"].mean()*100; flag="*" if wr>=BE*100 else ""
                    cells.append(f"{wr:.0f}%{flag} (n={n})")
                else: cells.append(f"thin (n={n})")
            print(f"| **>=3 agree** | " + " | ".join(cells) + " |")
        print()
    print("(* = clears break-even. Edge claim needs WR rising with score AND >=3 clearing BE on "
          "BOTH periods. One-period spikes are the overfit trap the kinetic gate fell into.)")

if __name__ == "__main__":
    main()
