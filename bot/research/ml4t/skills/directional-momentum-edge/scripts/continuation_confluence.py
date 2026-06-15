#!/usr/bin/env python3
"""
continuation_confluence.py — apply the user's TREND-CONTINUATION confluence (MA
stack/cross + RSI + Stoch + candle direction, all agreeing → trade WITH the move)
to our 5m DB, abstracted from its M1/OTC calibration.

This is the OPPOSITE of the fade gate: no exhaustion stretch. The onset is "trend
igniting / aligned", direction is WITH it (continuation), and the label is whether
price CONTINUES in that direction over the expiry. Run triple-regime (FXSB / June /
agent) with WR vs break-even as the confluence strictness rises.

Caveat: our data is 5-minute REAL FX. The user's strategy is M1 OTC synthetic. This
tests whether the CONFLUENCE SHAPE has continuation edge in our market/timeframe —
not the user's exact setup.

Usage: python continuation_confluence.py [--horizons 5,10]
"""
from __future__ import annotations
import os, sys
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)
REGIMES = {
    "FXSB":  ["agent/data/agent_FXSB.db"],
    "June":  ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db","data/trading_data.db"],
    "agent": ["agent/data/agent.db"],
}
BAR = 300

def regime(dbs, horizons):
    parts = []
    for i, db in enumerate(dbs):
        d = po_data.load(R(db))
        if len(dbs) > 1: d["asset"] = d["asset"] + f"@{i}"
        parts.append(d)
    df = pd.concat(parts, ignore_index=True)
    out = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c = g["close"].astype(float); o = g["open"].astype(float); ts = g["timestamp"]
        rsi = g["rsi_14"].astype(float); rsi_d = rsi - rsi.shift(1)
        # --- confluence conditions (count how many agree, per direction) ---
        up = pd.DataFrame({
            "ma_fast": g["sma_10"] > g["sma_20"],
            "ma_slow": g["sma_20"] > g["sma_50"],
            "ema":     g["ema_12"] > g["ema_26"],
            "rsi":     (rsi > 50) & (rsi_d > 0),
            "stoch":   g["stoch_k"] > g["stoch_d"],
            "candle":  c > o,
        })
        dn = pd.DataFrame({
            "ma_fast": g["sma_10"] < g["sma_20"],
            "ma_slow": g["sma_20"] < g["sma_50"],
            "ema":     g["ema_12"] < g["ema_26"],
            "rsi":     (rsi < 50) & (rsi_d < 0),
            "stoch":   g["stoch_k"] < g["stoch_d"],
            "candle":  c < o,
        })
        g["up_score"] = up.sum(axis=1); g["dn_score"] = dn.sum(axis=1)
        # fresh 10/20 cross this bar (the "early entry")
        g["fresh_up"] = (g["sma_10"] > g["sma_20"]) & (g["sma_10"].shift(1) <= g["sma_20"].shift(1))
        g["fresh_dn"] = (g["sma_10"] < g["sma_20"]) & (g["sma_10"].shift(1) >= g["sma_20"].shift(1))
        for h in horizons:
            n = (h*60)//BAR
            fc, ft = c.shift(-n), ts.shift(-n)
            mv = np.sign(fc - c).where(ft - ts == n*BAR)
            g[f"fwd_dir_{h}"] = mv
        out.append(g)
    return pd.concat(out)

def wr_continuation(d, fire_up, fire_dn, h):
    """WR of betting WITH the direction (up→CALL, dn→PUT) over horizon h."""
    mv = d[f"fwd_dir_{h}"]
    up = fire_up & mv.notna(); dn = fire_dn & mv.notna()
    wins = pd.concat([(mv[up] > 0), (mv[dn] < 0)])
    return (wins.mean()*100, int(up.sum()+dn.sum())) if len(wins) else (np.nan, 0)

def main():
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument("--horizons", default="5,10")
    ap.add_argument("--payout", type=float, default=0.8); args = ap.parse_args()
    hz = [int(x) for x in args.horizons.split(",")]; be = 1/(1+args.payout)*100
    T = {k: regime(v, hz) for k, v in REGIMES.items()}

    print(f"\n# Trend-Continuation Confluence on 5m real-FX DB (bet WITH the move)")
    print(f"break-even {be:.1f}%   (caveat: 5m real FX, not the user's M1 OTC)\n")

    for h in hz:
        print(f"## Continuation WR @ {h}m  —  by confluence strictness (≥K of 6 conditions agree)")
        print("| setup | FXSB | June | agent |")
        print("|---|---|---|---|")
        for K in [3, 4, 5, 6]:
            cells = []
            for k in T:
                d = T[k]; w, n = wr_continuation(d, d["up_score"] >= K, d["dn_score"] >= K, h)
                cells.append(f"{w:.1f}% (n={n})" if np.isfinite(w) and n >= 20 else "—")
            print(f"| ≥{K}/6 agree | " + " | ".join(cells) + " |")
        # fresh-cross + full confluence (the "early entry" the user stresses)
        cells = []
        for k in T:
            d = T[k]
            fu = d["fresh_up"] & (d["up_score"] >= 5); fd = d["fresh_dn"] & (d["dn_score"] >= 5)
            w, n = wr_continuation(d, fu, fd, h)
            cells.append(f"{w:.1f}% (n={n})" if np.isfinite(w) and n >= 20 else f"thin(n={n})")
        print(f"| fresh-cross + ≥5/6 | " + " | ".join(cells) + " |")
        print()
    print(f"(WR = betting WITH the confluence direction. >{be:.1f}% = continuation pays. The fade gate "
          "needs the SAME bar to lose for it to fire the other way — these are opposite strategies.)")

if __name__ == "__main__":
    main()
