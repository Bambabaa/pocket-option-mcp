#!/usr/bin/env python3
"""
purged_wf.py — Purged walk-forward confirmation for a candidate factor.

Skill #1 (alpha-factor-eval) asks "is there signal in this snapshot?". This skill
asks the harder, decisive question: "does that signal SURVIVE out-of-sample once
leakage is removed?" It splits the timeline into sequential folds, and for each
fold computes the factor's Information Coefficient on the *test* segment using a
model-free, purged protocol:

  - Split on UNIQUE TIMESTAMPS (the 15-asset cross-section moves together, so a
    timestamp is the atomic unit — never let the same minute straddle train/test).
  - PURGE: drop training rows whose forward-label window (n bars) reaches into the
    test segment — their label peeked at test-period prices.
  - EMBARGO: additionally drop training rows within `embargo` bars of the test
    start, to kill residual serial correlation across the boundary.

The verdict is about CONSISTENCY, not one lucky fold: an edge that flips sign
across folds (as the prior momentum study did between May and June) is not real.

READ-ONLY (immutable=1). No model trained or persisted. The factor interface
mirrors alpha-factor-eval exactly, so a candidate flows straight through.

Usage:
    python purged_wf.py --factor "rsi_14" --horizon 10
    python purged_wf.py --factor "abs(stoch_k - stoch_d)" --folds 5 --embargo 5
"""
from __future__ import annotations
import argparse, json, sys, sqlite3
import numpy as np
import pandas as pd
from scipy import stats

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── shared core (mirrors alpha-factor-eval; kept identical so a candidate flows through) ──
IND_COLS = [
    "sma_10","sma_20","sma_50","rsi_14","stoch_k","stoch_d","stoch_prev_d",
    "bb_upper","bb_middle","bb_lower","bb_width_bps","stc_value","stc_signal",
    "stc_prev","stc_delta","cci_20","ema_12","ema_26","macd_macd","macd_signal",
    "macd_hist","kc_upper","kc_middle","kc_lower","adx_14","adx_plus_di",
    "adx_minus_di","williams_14","atr_14","atr_pct","psar","psar_bull",
]

def load(db_path: str) -> pd.DataFrame:
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        cols = ",".join(f"i.{c}" for c in IND_COLS)
        df = pd.read_sql_query(
            f"""SELECT i.asset, i.timestamp, c.close, {cols}
                FROM indicators i JOIN candles c
                  ON c.asset=i.asset AND c.timestamp=i.timestamp
                ORDER BY i.asset, i.timestamp""", con)
    finally:
        con.close()
    return df

def build_factor(df: pd.DataFrame, expr: str) -> pd.Series:
    out = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        env = {c: g[c].astype(float) for c in IND_COLS if c in g}
        env["close"] = g["close"].astype(float)
        env["abs"], env["np"] = np.abs, np
        env["d"] = lambda col, k: col - col.shift(k)
        try:
            val = eval(expr, {"__builtins__": {}}, env)  # noqa: S307
        except Exception as e:
            sys.exit(f"ERROR evaluating factor '{expr}': {e}")
        out.append(pd.Series(np.asarray(val, dtype=float), index=g.index))
    return pd.concat(out).reindex(df.index)

def forward_return(df: pd.DataFrame, mins: int, bar_sec: int) -> pd.Series:
    """Single-horizon forward return over n contiguous bars, per asset, off close."""
    n = (mins * 60) // bar_sec
    fr = pd.Series(np.nan, index=df.index)
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        ret = close.shift(-n) / close - 1.0
        ret = ret.where(ts.shift(-n) - ts == n * bar_sec)
        fr.loc[g.index] = ret.values
    return fr

# ── purged walk-forward ──────────────────────────────────────────────────────
def make_folds(times: np.ndarray, n_folds: int):
    """Sequential expanding-train folds over UNIQUE sorted timestamps.
    Test blocks tile the back portion; train is everything strictly before."""
    uniq = np.unique(times)
    # reserve the first ~1/(n+1) of history as the minimum initial train window
    cut = len(uniq) // (n_folds + 1)
    test_blocks = np.array_split(uniq[cut:], n_folds)
    for tb in test_blocks:
        if len(tb) == 0:
            continue
        yield uniq[uniq < tb[0]], tb           # (train_times, test_times)

def run(df, factor, fwd, mins, bar_sec, n_folds, embargo):
    horizon_sec = (mins * 60)                   # label looks this far forward
    emb_sec = embargo * bar_sec
    kept = factor.notna() & fwd.notna()         # rows with both a factor and a label
    times = df.loc[kept, "timestamp"].values
    results = []
    for i, (tr_t, te_t) in enumerate(make_folds(times, n_folds), 1):
        te_start = te_t.min()
        # PURGE + EMBARGO: a train row at t leaks if its label window (t..t+horizon)
        # reaches the embargoed pre-test zone, i.e. t + horizon >= te_start - emb
        purge_before = te_start - emb_sec
        tr_mask = kept & (df["timestamp"] < te_start) & (df["timestamp"] + horizon_sec < purge_before)
        te_mask = kept & df["timestamp"].isin(te_t)
        n_tr_raw = int((kept & (df["timestamp"] < te_start)).sum())
        n_tr = int(tr_mask.sum()); n_te = int(te_mask.sum())
        purged = n_tr_raw - n_tr
        if n_te < 30:
            continue
        ic_te, p_te = stats.spearmanr(factor[te_mask], fwd[te_mask])
        ic_tr = (stats.spearmanr(factor[tr_mask], fwd[tr_mask])[0]
                 if n_tr >= 30 and factor[tr_mask].nunique() >= 3 else np.nan)
        # directional WR of the extreme quintile, in the direction train-IC implies
        wr = extreme_wr(factor[te_mask], fwd[te_mask], np.sign(ic_tr) if np.isfinite(ic_tr) else np.sign(ic_te))
        results.append(dict(fold=i, n_train=n_tr, purged=purged, n_test=n_te,
                            ic_train=ic_tr, ic_test=ic_te, p_test=p_te, wr_test=wr))
    return results

def extreme_wr(factor, fwd, direction):
    """Win-rate if we trade the top quintile as CALL (or bottom as PUT) per the
    sign of the (train) edge. direction>0: high factor -> up. <0: high factor -> down."""
    if not np.isfinite(direction) or direction == 0 or len(factor) < 25:
        return np.nan
    q = pd.qcut(factor.rank(method="first"), 5, labels=False)
    if direction > 0:                            # CALL on top quintile, expect up
        sub = fwd[q == 4]; return float((sub > 0).mean()) if len(sub) else np.nan
    else:                                        # PUT on top quintile, expect down
        sub = fwd[q == 4]; return float((sub < 0).mean()) if len(sub) else np.nan

def fmt(x, d=4):
    return "nan" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--factor", required=True)
    ap.add_argument("--name", default=None)
    ap.add_argument("--horizon", type=int, default=5, help="forward horizon in MINUTES (bar multiple)")
    ap.add_argument("--bar-sec", type=int, default=300, help="candle interval (sec); floored at 300")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5, help="embargo in BARS at each train/test boundary")
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    bar_sec = args.bar_sec
    if bar_sec < 300:
        sys.exit(f"ERROR: --bar-sec {bar_sec} below 300s floor.")
    if (args.horizon * 60) % bar_sec:
        sys.exit(f"ERROR: horizon {args.horizon}m is not a whole multiple of the {bar_sec}s bar.")
    name = args.name or args.factor
    breakeven = 1.0 / (1.0 + args.payout)

    df = load(args.db)
    factor = build_factor(df, args.factor)
    fwd = forward_return(df, args.horizon, bar_sec)
    res = run(df, factor, fwd, args.horizon, bar_sec, args.folds, args.embargo)

    print(f"\n# Purged Walk-Forward — {name}  @ {args.horizon}m")
    print(f"expr: `{args.factor}`   folds: {args.folds}   embargo: {args.embargo} bars"
          f"   break-even WR {breakeven*100:.1f}%\n")
    if not res:
        print("Insufficient data to form folds."); return

    print("| fold | n_train | purged | n_test | IC train | IC test | p test | extreme-WR |")
    print("|---|---|---|---|---|---|---|---|")
    for r in res:
        print(f"| {r['fold']} | {r['n_train']} | {r['purged']} | {r['n_test']} | "
              f"{fmt(r['ic_train'])} | {fmt(r['ic_test'])} | {fmt(r['p_test'],3)} | "
              f"{'' if not np.isfinite(r['wr_test']) else f'{r['wr_test']*100:.1f}%'} |")

    ic_te = np.array([r["ic_test"] for r in res if np.isfinite(r["ic_test"])])
    mean_ic = ic_te.mean() if len(ic_te) else np.nan
    sign_consistency = float(np.mean(np.sign(ic_te) == np.sign(mean_ic))) if len(ic_te) else np.nan
    if len(ic_te) >= 2:
        t = mean_ic / (ic_te.std(ddof=1) / np.sqrt(len(ic_te))) if ic_te.std(ddof=1) > 0 else np.nan
        p = 2 * stats.t.sf(abs(t), len(ic_te) - 1) if np.isfinite(t) else np.nan
    else:
        t = p = np.nan
    wr = np.array([r["wr_test"] for r in res if np.isfinite(r["wr_test"])])
    mean_wr = wr.mean() if len(wr) else np.nan

    # verdict: three gates — (1) sign consistency, (2) statistical strength of the
    # OOS IC, (3) TRADEABILITY = does the directional extreme-quintile WR clear the
    # payout break-even. A statistically real edge that fails (3) is the dangerous
    # false positive in binary options: it would lose money standalone.
    strong = np.isfinite(mean_ic) and abs(mean_ic) > 0.03 and np.isfinite(p) and p < 0.05
    consistent = np.isfinite(sign_consistency) and sign_consistency >= 0.8
    tradeable = np.isfinite(mean_wr) and mean_wr > breakeven
    if strong and consistent and tradeable:
        verdict = "STABLE & TRADEABLE — edge persists OOS, consistent sign, clears break-even WR"
    elif strong and consistent and not tradeable:
        verdict = ("STABLE-IC / SUB-BREAKEVEN — the edge is statistically real OOS but its WR "
                   f"({fmt(mean_wr*100,1)}%) does not clear break-even ({breakeven*100:.1f}%). "
                   "NOT viable as a standalone directional gate; only as one input to a stronger "
                   "combined model or an abstention/meta-label layer (skill #3).")
    elif consistent and (np.isfinite(mean_ic) and abs(mean_ic) > 0.02):
        verdict = "MODERATE — sign holds but weak/under-powered; needs more data + cross-regime"
    else:
        verdict = "UNSTABLE — sign flips or edge ≈ 0 across folds; NOT a real edge"

    print(f"\nmean OOS IC {fmt(mean_ic)}   sign-consistency {fmt(sign_consistency,2)}   "
          f"t {fmt(t,2)} (p {fmt(p,3)})   mean extreme-WR "
          f"{'' if not np.isfinite(mean_wr) else f'{mean_wr*100:.1f}%'} (break-even {breakeven*100:.1f}%)")
    print(f"\n## Verdict: {verdict}")
    print("\nA STABLE verdict still requires CROSS-REGIME replication (May agent.db / other snapshots) "
          "and cost-netting before modeling — one dataset, even purged, is one regime.")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(dict(factor=name, horizon=args.horizon, folds=res,
                           mean_oos_ic=mean_ic, sign_consistency=sign_consistency,
                           t=t, p=p, mean_extreme_wr=mean_wr, verdict=verdict), f, indent=2,
                      default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else o)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
