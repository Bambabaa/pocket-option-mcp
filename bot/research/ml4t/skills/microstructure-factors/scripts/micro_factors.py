#!/usr/bin/env python3
"""
micro_factors.py — extract TICK-microstructure features per 5-min bar from the
prices table and run them through the alpha-factor-eval IC gauntlet.

The whole project's recurring conclusion is that the 32 indicators at 5-min bars
carry ~no forward signal (AUC ~0.5). The 1s `prices` tick stream is the one
information source never touched. This script tests whether sub-bar microstructure
— order-flow imbalance, run-length, micro-volatility, the within-bar path/wick —
predicts the NEXT bar's move where the bar-close indicators cannot.

Per (asset, 5-min bar) it computes causal tick features (known at bar close), joins
the forward bar return, and reports each feature's Information Coefficient (pooled +
honest block t-stat), exactly like alpha-factor-eval. Tick data exists only in the
June DBs (agent_* has none).

Usage:
  python micro_factors.py --db data/trading_data00.db
  python micro_factors.py --db "data/trading_data_5-02.db,...,data/trading_data.db" --horizons 5,10,15
"""
from __future__ import annotations
import argparse, sqlite3, sys
import numpy as np
import pandas as pd
from scipy import stats

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

def load(db, bar_sec):
    con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
    try:
        px = pd.read_sql_query("SELECT asset, timestamp, price FROM prices ORDER BY asset, timestamp", con)
        cd = pd.read_sql_query("SELECT asset, timestamp, close FROM candles ORDER BY asset, timestamp", con)
    finally:
        con.close()
    px["bar"] = (px["timestamp"] // bar_sec) * bar_sec
    return px, cd

def bar_features(g):
    """Causal microstructure features from the ticks within one 5-min bar."""
    p = g["price"].values
    if len(p) < 10:
        return None
    d = np.diff(p)
    s = np.sign(d); s = s[s != 0]
    rng = p.max() - p.min()
    # longest same-direction run (normalized)
    run = mx = 1
    for i in range(1, len(s)):
        run = run + 1 if s[i] == s[i-1] else 1
        mx = max(mx, run)
    net = (p[-1] - p[0]) / p[0]
    return pd.Series({
        "n_ticks":      len(p),
        "net_ret":      net,                                   # bar's own tick return (directional)
        "imbalance":    s.mean() if len(s) else 0.0,           # up/down tick balance (directional)
        "max_run":      mx / len(p),                           # trend persistence within bar
        "micro_vol":    np.std(d / p[:-1]) if len(d) else 0.0, # tick-return vol (magnitude)
        "range_bps":    rng / p[0] * 1e4,                      # within-bar range (magnitude)
        "close_pos":    (p[-1] - p.min()) / rng - 0.5 if rng > 0 else 0.0,  # where it closed (signed: + high)
        "spike_revert": (1 - abs(p[-1] - p[0]) / rng) if rng > 0 else 0.0,  # wick / round-trip (magnitude)
    })

FEATS = ["n_ticks","net_ret","imbalance","max_run","micro_vol","range_bps","close_pos","spike_revert"]

def block_ic(f, r, ts, block_sec=3600):
    blk = ts // block_sec
    ics = []
    for _, idx in pd.DataFrame({"b": blk}).groupby("b").groups.items():
        a, b = f.loc[idx], r.loc[idx]
        m = a.notna() & b.notna()
        if m.sum() < 20 or a[m].nunique() < 3:
            continue
        rho, _ = stats.spearmanr(a[m], b[m])
        if np.isfinite(rho): ics.append(rho)
    ics = np.array(ics)
    if len(ics) < 2: return np.nan, np.nan, len(ics)
    mean, sd = ics.mean(), ics.std(ddof=1)
    t = mean/(sd/np.sqrt(len(ics))) if sd > 0 else np.nan
    p = 2*stats.t.sf(abs(t), len(ics)-1) if np.isfinite(t) else np.nan
    return mean, p, len(ics)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="June tick DB(s), comma-separated")
    ap.add_argument("--horizons", default="5,10,15")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--min-ticks", type=int, default=10)
    args = ap.parse_args()
    hz = [int(h) for h in args.horizons.split(",")]

    rows = []
    for i, db in enumerate([d.strip() for d in args.db.split(",") if d.strip()]):
        px, cd = load(db, args.bar_sec)
        feats = px.groupby(["asset","bar"]).apply(bar_features, include_groups=False).dropna(how="all")
        feats = feats.reset_index()
        cd = cd.rename(columns={"timestamp":"bar"})
        m = feats.merge(cd, on=["asset","bar"], how="inner")
        # forward bar returns (contiguous)
        m = m.sort_values(["asset","bar"])
        for h in hz:
            n = (h*60)//args.bar_sec
            fc = m.groupby("asset")["close"].shift(-n)
            fb = m.groupby("asset")["bar"].shift(-n)
            ret = fc/m["close"] - 1.0
            m[f"fwd_{h}"] = ret.where(fb - m["bar"] == n*args.bar_sec)
        m["asset"] = m["asset"] + f"@{i}"
        rows.append(m)
    d = pd.concat(rows, ignore_index=True)

    print(f"\n# Microstructure factors — {d['asset'].nunique()} asset-series, "
          f"{len(d)} bars (≥{args.min_ticks} ticks)\n")
    print("| feature | horizon | pooled IC | block mean-IC | block p | n_blk | verdict |")
    print("|---|---|---|---|---|---|---|")
    leads = []
    for f in FEATS:
        for h in hz:
            r = d[f"fwd_{h}"]; mask = d[f].notna() & r.notna()
            if mask.sum() < 200: continue
            rho, _ = stats.spearmanr(d[f][mask], r[mask])
            bic, bp, nb = block_ic(d[f], r, d["bar"])
            sig = np.isfinite(bp) and bp < 0.05 and abs(bic) > 0.03
            v = "SIGNAL?" if sig else "noise"
            if sig: leads.append((f, h, bic, bp))
            print(f"| {f} | {h}m | {rho:+.4f} | {bic:+.4f} | {bp:.3f} | {nb} | {v} |")
    print()
    if leads:
        print("## Candidate microstructure factors (block |IC|>0.03, p<0.05):")
        for f,h,bic,bp in leads:
            print(f"  {f} @ {h}m: block IC {bic:+.4f} (p={bp:.3f}) — confirm via alpha-factor-eval/purged-WF")
    else:
        print("## No microstructure factor clears block-IC significance — ticks no better than bars here.")

if __name__ == "__main__":
    main()
