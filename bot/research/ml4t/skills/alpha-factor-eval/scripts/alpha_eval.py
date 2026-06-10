#!/usr/bin/env python3
"""
alpha_eval.py — ML4T alpha-factor evaluation for the pocket-option dataset.

Answers ONE question: does a candidate factor carry tradeable forward-return
signal? Reports Information Coefficient (IC), block t-stat / IR, quintile spread,
hit-rate vs binary-option break-even, and an IC decay curve across horizons.

READ-ONLY. Opens trading_data.db with SQLite immutable=1 (never writes, never
locks the bot). No model is trained or persisted — this is the "is there signal"
gate that runs BEFORE any modeling/freeze step.

Usage:
    python alpha_eval.py --factor "rsi_14"
    python alpha_eval.py --factor "abs(stoch_k - stoch_d)" --name Stoch_Divergence
    python alpha_eval.py --factor "d(cci_20, 2)" --horizons 60,120,180,300 --payout 0.8
    python alpha_eval.py --factor "stc_value" --json out.json

Factor expression: a pandas expression over indicator columns (+ `close`).
Helper available inside the expression:
    d(col, k)   -> col minus its k-bar-ago value, per asset (velocity/momentum)
Examples:
    "rsi_14"                      bare column
    "abs(stoch_k - stoch_d)"      Stoch divergence
    "(close - bb_lower)/(bb_upper - bb_lower)"   %B / BB deviation
    "d(stc_value, 1)"             STC momentum
    "d(cci_20, 2)/2"              CCI velocity
"""
from __future__ import annotations
import argparse, json, sys, os
import numpy as np
import pandas as pd
from scipy import stats

try:  # Windows consoles default to cp1252; the report uses unicode (→ ✓ ρ −)
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load, build_factor   # schema-adaptive across both DB layouts

def forward_returns(df: pd.DataFrame, bar_minutes, bar_sec: int):
    """Forward return over n bars on the 5m candle, per asset, off candle CLOSE —
    matching how predictions are validated (5/10/15/20-min timeframes = 1/2/3/4 bars).
    A bar is only counted if the candle n steps ahead is actually n*bar_sec later
    (guards against session gaps closing the n-step window over a long jump)."""
    df = df.copy()
    for mins in bar_minutes:
        df[f"fwd_ret_{mins}"] = np.nan
    for asset, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        for mins in bar_minutes:
            n = mins * 60 // bar_sec                      # bars ahead (5->1, 10->2, ...)
            fwd_close, fwd_ts = close.shift(-n), ts.shift(-n)
            ret = fwd_close / close - 1.0
            ret = ret.where(fwd_ts - ts == n * bar_sec)   # contiguous bars only
            df.loc[g.index, f"fwd_ret_{mins}"] = ret.values
    return df

def block_ic(factor: pd.Series, fwd: pd.Series, ts: pd.Series, block_sec: int):
    """IC computed within time blocks -> series of ICs -> IR & t-stat (causal,
    avoids one-big-pooled-corr inflating significance via autocorrelation)."""
    blk = (ts // block_sec)
    ics = []
    for _, idx in pd.DataFrame({"blk": blk}).groupby("blk").groups.items():
        f, r = factor.loc[idx], fwd.loc[idx]
        m = f.notna() & r.notna()
        if m.sum() < 20 or f[m].nunique() < 3:
            continue
        rho, _ = stats.spearmanr(f[m], r[m])
        if np.isfinite(rho):
            ics.append(rho)
    ics = np.array(ics)
    if len(ics) < 2:
        return dict(n_blocks=len(ics), mean_ic=np.nan, ir=np.nan, t=np.nan, p=np.nan)
    mean, sd = ics.mean(), ics.std(ddof=1)
    ir = mean / sd if sd > 0 else np.nan
    t = ir * np.sqrt(len(ics)) if np.isfinite(ir) else np.nan
    p = 2 * stats.t.sf(abs(t), len(ics) - 1) if np.isfinite(t) else np.nan
    return dict(n_blocks=len(ics), mean_ic=mean, ir=ir, t=t, p=p)

def quantile_table(factor: pd.Series, fwd: pd.Series, q: int):
    m = factor.notna() & fwd.notna()
    f, r = factor[m], fwd[m]
    try:
        buckets = pd.qcut(f.rank(method="first"), q, labels=False)
    except Exception:
        return None
    rows = []
    for b in range(q):
        rr = r[buckets == b]
        if len(rr) == 0:
            continue
        rows.append(dict(bucket=b+1, n=len(rr), mean_ret_bps=rr.mean()*1e4,
                         hit_rate=(rr > 0).mean()))
    tbl = pd.DataFrame(rows)
    # monotonicity: rank corr of bucket index vs mean return
    mono = stats.spearmanr(tbl.bucket, tbl.mean_ret_bps).correlation if len(tbl) > 2 else np.nan
    return tbl, mono

def fmt(x, d=4):
    return "nan" if x is None or (isinstance(x,float) and not np.isfinite(x)) else f"{x:.{d}f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--factor", required=True, help="pandas expression over indicator cols; d(col,k) for per-asset diff")
    ap.add_argument("--name", default=None, help="display name for the factor")
    ap.add_argument("--horizons", default="5,10,15,20", help="forward validation horizons in MINUTES (bar multiples)")
    ap.add_argument("--bar-sec", type=int, default=300, help="candle interval in SECONDS; cannot be below 300 (5m floor)")
    ap.add_argument("--quantiles", type=int, default=5)
    ap.add_argument("--block-sec", type=int, default=3600, help="IC time-block size (sec) for t-stat")
    ap.add_argument("--payout", type=float, default=0.8, help="broker win payout; break-even WR = 1/(1+payout)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    horizons = [int(h) for h in args.horizons.split(",")]   # minutes
    bar_sec = args.bar_sec
    if bar_sec < 300:                                        # 300s is the hard floor — no sub-5m bars exist
        sys.exit(f"ERROR: --bar-sec {bar_sec} is below the 300s floor (bars cannot be shorter than 5m).")
    if any((m * 60) % bar_sec for m in horizons):           # horizons must be whole bar multiples
        sys.exit(f"ERROR: horizons {horizons} (min) are not all whole multiples of the {bar_sec}s bar.")
    name = args.name or args.factor
    breakeven = 1.0 / (1.0 + args.payout)

    df = load(args.db)
    df["factor"] = build_factor(df, args.factor)
    df = forward_returns(df, horizons, bar_sec)

    report = dict(factor=name, expr=args.factor, n_rows=int(df["factor"].notna().sum()),
                  payout=args.payout, breakeven_wr=breakeven, horizons={})

    print(f"\n# Alpha-Factor Evaluation — {name}")
    print(f"expr: `{args.factor}`   rows: {report['n_rows']}   assets: {df.asset.nunique()}"
          f"   payout: {args.payout}  → break-even WR {breakeven*100:.1f}%\n")

    print("## IC decay (Spearman factor vs forward return)")
    print("| horizon | pooled IC | p | block mean-IC | IR | t | p | n_blocks | verdict |")
    print("|---|---|---|---|---|---|---|---|---|")
    for h in horizons:
        fwd = df[f"fwd_ret_{h}"]
        m = df["factor"].notna() & fwd.notna()
        if m.sum() < 30:
            print(f"| {h}m | — insufficient data — |"); continue
        rho, p = stats.spearmanr(df["factor"][m], fwd[m])
        b = block_ic(df["factor"], fwd, df["timestamp"], args.block_sec)
        tradeable = (np.isfinite(b["p"]) and b["p"] < 0.05 and abs(b["mean_ic"]) > 0.03)
        verdict = "signal?" if tradeable else "≈ noise"
        print(f"| {h}m | {fmt(rho)} | {fmt(p,3)} | {fmt(b['mean_ic'])} | {fmt(b['ir'],2)} "
              f"| {fmt(b['t'],2)} | {fmt(b['p'],3)} | {b['n_blocks']} | {verdict} |")
        report["horizons"][h] = dict(pooled_ic=rho, pooled_p=p, **b, n=int(m.sum()))

    # quantile detail at the primary (first) horizon
    h0 = horizons[0]
    res = quantile_table(df["factor"], df[f"fwd_ret_{h0}"], args.quantiles)
    if res:
        tbl, mono = res
        print(f"\n## Quantile spread @ {h0}m  (monotonicity ρ={fmt(mono,3)})")
        print("| bucket | n | mean ret (bps) | hit-rate | clears break-even? |")
        print("|---|---|---|---|---|")
        for _, r in tbl.iterrows():
            clears = "✓" if (r.hit_rate > breakeven or (1-r.hit_rate) > breakeven) else ""
            print(f"| Q{int(r.bucket)} | {int(r.n)} | {r.mean_ret_bps:+.2f} | {r.hit_rate*100:.1f}% | {clears} |")
        spread = tbl.mean_ret_bps.iloc[-1] - tbl.mean_ret_bps.iloc[0]
        print(f"\ntop−bottom spread: {spread:+.2f} bps")
        report["quantiles"] = dict(horizon=h0, monotonicity=mono, top_bottom_bps=spread,
                                   table=tbl.to_dict("records"))

    # headline verdict
    best = max((report["horizons"].get(h, {}).get("mean_ic", 0) or 0 for h in horizons),
               key=abs, default=0)
    any_sig = any(np.isfinite(v.get("p", np.nan)) and v["p"] < 0.05 and abs(v["mean_ic"]) > 0.03
                  for v in report["horizons"].values())
    print("\n## Verdict")
    if any_sig:
        print(f"**Candidate signal** — best block mean-IC {best:+.4f}, significant at some horizon. "
              "Confirm with purged walk-forward + cross-regime before modeling.")
    else:
        print(f"**No tradeable edge** — |IC| ≲ {abs(best):.3f}, not significant. "
              "Consistent with project-wide near-unpredictability; do not model this factor as-is.")
    report["verdict"] = "candidate" if any_sig else "noise"

    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=2, default=lambda o: None if isinstance(o,float) and not np.isfinite(o) else o)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
