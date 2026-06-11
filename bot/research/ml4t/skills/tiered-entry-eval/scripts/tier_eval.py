#!/usr/bin/env python3
"""
tier_eval.py — empirical playout of the 3-tier scaling strategy on 5m binary options.

Encodes the user's tier rules exactly (long side; mirrored for short) and measures
each tier's standalone OOS win-rate at 5/10/15/20m vs the payout break-even.
Binary options can't scale into one position — each tier is a separate fixed-expiry
bet, so each must clear break-even on its own.

  Tier 1 — Anticipatory extreme (mean-reversion):
    williams_14 < -80 ; close < kc_lower ; close < bb_lower ; stoch K>D with D<20
  Tier 2 — Kinetic reversal (momentum pivot):
    stc_value > stc_signal AND stc_delta > 0 ; psar_bull ; macd_hist rising
  Tier 3 — Trend confirmation (latest entry):
    ema12 > ema26 ; +DI > -DI ; ADX rising ; BB width expanding

Direction: all tiers are LONG (CALL) in the listed form; the SHORT mirror flips
every comparison. WR = fraction of bets where price at expiry moved the bet's way.
Pure rule evaluation — no model, no fitting, so no purge needed (nothing trains);
every bar is "out-of-sample" for a fixed rule.

Usage: python tier_eval.py [--db path[,path2,...]] [--payout 0.8]
"""
from __future__ import annotations
import argparse, sys, os
import numpy as np
import pandas as pd

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load

def per_asset(df, bar_sec, horizons):
    out = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close, ts = g["close"].astype(float), g["timestamp"]
        d1 = lambda x: x - x.shift(1)
        # ---- tier conditions, long side ----
        g["t1_long"] = ((g["williams_14"] < -80) & (close < g["kc_lower"]) &
                        (close < g["bb_lower"]) & (g["stoch_k"] > g["stoch_d"]) &
                        (g["stoch_d"] < 20))
        g["t2_long"] = ((g["stc_value"] > g["stc_signal"]) & (g["stc_delta"] > 0) &
                        (g["psar_bull"] == 1) & (d1(g["macd_hist"]) > 0))
        g["t3_long"] = ((g["ema_12"] > g["ema_26"]) &
                        (g["adx_plus_di"] > g["adx_minus_di"]) &
                        (d1(g["adx_14"]) > 0) & (d1(g["bb_width_bps"]) > 0))
        # ---- mirrored short side ----
        g["t1_short"] = ((g["williams_14"] > -20) & (close > g["kc_upper"]) &
                         (close > g["bb_upper"]) & (g["stoch_k"] < g["stoch_d"]) &
                         (g["stoch_d"] > 80))
        g["t2_short"] = ((g["stc_value"] < g["stc_signal"]) & (g["stc_delta"] < 0) &
                         (g["psar_bull"] == 0) & (d1(g["macd_hist"]) < 0))
        g["t3_short"] = ((g["ema_12"] < g["ema_26"]) &
                         (g["adx_minus_di"] > g["adx_plus_di"]) &
                         (d1(g["adx_14"]) > 0) & (d1(g["bb_width_bps"]) > 0))
        for m in horizons:
            n = (m * 60) // bar_sec
            fwd = np.sign(close.shift(-n) - close)
            fwd = fwd.where(ts.shift(-n) - ts == n * bar_sec)
            g[f"fwd_{m}"] = fwd
        out.append(g)
    return pd.concat(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db", help="path or comma-separated paths")
    ap.add_argument("--horizons", default="5,10,15,20")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--payout", type=float, default=0.8)
    args = ap.parse_args()
    if args.bar_sec < 300: sys.exit("ERROR: bar-sec below 300s floor.")
    hz = [int(h) for h in args.horizons.split(",")]
    breakeven = 1.0 / (1.0 + args.payout)

    frames = []
    for i, p in enumerate([q.strip() for q in args.db.split(",") if q.strip()]):
        d = load(p); d["asset"] = d["asset"] + f"@{i}"
        frames.append(d)
    df = per_asset(pd.concat(frames, ignore_index=True), args.bar_sec, hz)

    print(f"\n# 3-Tier Scaling Strategy — empirical playout   rows {len(df)}   "
          f"break-even WR {breakeven*100:.1f}%\n")
    print("| tier (alloc) | side | fires | " + " | ".join(f"WR {h}m" for h in hz) + " |")
    print("|---|---|---|" + "---|" * len(hz))
    tiers = [("Tier1 extreme (20%)", "t1"), ("Tier2 pivot (50%)", "t2"), ("Tier3 trend (30%)", "t3")]
    summary = {}
    for label, t in tiers:
        for side, sgn in (("long", 1), ("short", -1)):
            mask = df[f"{t}_{side}"] == True   # noqa: E712
            n_fire = int(mask.sum())
            cells = []
            wrs = {}
            for h in hz:
                fwd = df.loc[mask, f"fwd_{h}"].dropna()
                wr = float((fwd == sgn).mean()) if len(fwd) else np.nan
                wrs[h] = wr
                mark = "✓" if np.isfinite(wr) and wr > breakeven else ""
                cells.append("—" if not np.isfinite(wr) else f"{wr*100:.1f}%{mark}")
            print(f"| {label} | {side} | {n_fire} | " + " | ".join(cells) + " |")
            summary[(t, side)] = (n_fire, wrs)

    # blended expectancy at 10m using the stated allocations
    h0 = 10 if 10 in hz else hz[0]
    alloc = {"t1": 0.20, "t2": 0.50, "t3": 0.30}
    print(f"\n## Blended expectancy @ {h0}m (per 1.0 stake split 20/50/30, payout {args.payout})")
    for side in ("long", "short"):
        ev = 0.0; parts = []
        for t in ("t1", "t2", "t3"):
            wr = summary[(t, side)][1].get(h0, np.nan)
            if not np.isfinite(wr): continue
            tev = alloc[t] * (wr * args.payout - (1 - wr))   # EV per unit on that tier
            ev += tev
            parts.append(f"{t} {wr*100:.0f}%→{tev:+.3f}")
        print(f"{side}: EV {ev:+.4f} per stake   ({', '.join(parts)})")

if __name__ == "__main__":
    main()
