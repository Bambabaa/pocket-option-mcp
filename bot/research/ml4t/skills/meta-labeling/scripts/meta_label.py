#!/usr/bin/env python3
"""
meta_label.py — Meta-labeling (abstention layer) for a binary-option primary signal.

López de Prado meta-labeling: a PRIMARY model decides the SIDE (CALL/PUT); a
SECONDARY ("meta") model decides whether to BET or SKIP. You trade only the bars
where the meta-model is confident the primary will win. This is the right tool for
a "STABLE-IC / SUB-BREAKEVEN" factor (skill #2): the directional edge is real but
its raw win-rate can't clear the payout deficit — so instead of trading every
signal, trade only the subset where WR > break-even, accepting lower coverage.

PRIMARY is configurable:
  --primary "<factor expr>"   directional rule: side = top-side if factor>neutral
                              else bottom-side. Causal (neutral is a constant).
                              e.g. rsi_14 mean-reversion: --neutral 50 --top-side put
  --primary signals           use the bot's signals table (asset,timestamp,direction)

SECONDARY is an L2 LogisticRegression on standardized indicator features, validated
with PURGED walk-forward (same purge/embargo as skill #2) so the abstention rule is
judged out-of-sample. Linear on purpose: it hand-ports to ml_gate_params.json (skill #4).

READ-ONLY (immutable=1). No model persisted — this measures whether abstention CAN
lift WR over break-even; freezing a chosen model is skill #4.

Usage:
  python meta_label.py --primary "rsi_14" --neutral 50 --top-side put --horizon 10
  python meta_label.py --primary signals --horizon 10
"""
from __future__ import annotations
import argparse, json, sys, sqlite3
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

IND_COLS = [
    "sma_10","sma_20","sma_50","rsi_14","stoch_k","stoch_d","stoch_prev_d",
    "bb_upper","bb_middle","bb_lower","bb_width_bps","stc_value","stc_signal",
    "stc_prev","stc_delta","cci_20","ema_12","ema_26","macd_macd","macd_signal",
    "macd_hist","kc_upper","kc_middle","kc_lower","adx_14","adx_plus_di",
    "adx_minus_di","williams_14","atr_14","atr_pct","psar","psar_bull",
]
# features the meta-model sees (levels like sma/ema/bb/kc/psar are non-stationary
# price -> excluded; keep bounded oscillators / widths / normalized quantities)
META_FEATS = ["rsi_14","stoch_k","stoch_d","stoch_prev_d","bb_width_bps","stc_value",
              "stc_signal","stc_prev","stc_delta","cci_20","macd_hist","adx_14",
              "adx_plus_di","adx_minus_di","williams_14","atr_pct","psar_bull"]

def load(db_path: str):
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        cols = ",".join(f"i.{c}" for c in IND_COLS)
        df = pd.read_sql_query(
            f"""SELECT i.asset, i.timestamp, c.close, {cols}
                FROM indicators i JOIN candles c
                  ON c.asset=i.asset AND c.timestamp=i.timestamp
                ORDER BY i.asset, i.timestamp""", con)
        try:
            sig = pd.read_sql_query("SELECT asset, timestamp, direction FROM signals", con)
        except Exception:
            sig = pd.DataFrame(columns=["asset","timestamp","direction"])
    finally:
        con.close()
    return df, sig

def build_factor(df, expr):
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

def forward_return(df, mins, bar_sec):
    n = (mins * 60) // bar_sec
    fr = pd.Series(np.nan, index=df.index)
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        ret = close.shift(-n) / close - 1.0
        fr.loc[g.index] = ret.where(ts.shift(-n) - ts == n * bar_sec).values
    return fr

def make_folds(times, n_folds):
    uniq = np.unique(times)
    cut = len(uniq) // (n_folds + 1)
    for tb in np.array_split(uniq[cut:], n_folds):
        if len(tb):
            yield uniq[uniq < tb[0]], tb

def primary_events(df, sig, args, bar_sec):
    """Return a frame of primary signals: index, side ('call'/'put'). One row per bar
    the primary fires."""
    if args.primary == "signals":
        if sig.empty:
            sys.exit("ERROR: signals table is empty — no primary to meta-label.")
        key = df.set_index(["asset","timestamp"])
        ev = []
        for _, s in sig.iterrows():
            try:
                idx = key.index.get_loc((s.asset, int(s.timestamp)))
            except KeyError:
                continue
            ev.append((df.index[idx], str(s.direction).lower()))
        e = pd.DataFrame(ev, columns=["idx","side"]).set_index("idx")
        return e
    # factor rule: fire on every bar where the factor is defined
    f = build_factor(df, args.primary)
    side = np.where(f > args.neutral, args.top_side,
                    np.where(f < args.neutral, _opp(args.top_side), None))
    e = pd.DataFrame({"side": side}, index=df.index)
    return e[e.side.notna()]

def _opp(s): return "put" if s == "call" else "call"

def meta_label(side: pd.Series, fwd: pd.Series):
    """1 if the primary side would WIN over the horizon, else 0. NaN fwd -> drop."""
    win = ((side == "call") & (fwd > 0)) | ((side == "put") & (fwd < 0))
    y = win.astype(float)
    y[fwd.isna()] = np.nan
    return y

def run(df, ev, fwd, bar_sec, mins, n_folds, embargo):
    horizon_sec, emb_sec = mins * 60, embargo * bar_sec
    side = ev["side"]
    y = meta_label(side, fwd.loc[ev.index])
    keep = y.notna()
    ev, side, y = ev[keep], side[keep], y[keep]
    X_all = df.loc[ev.index, META_FEATS].astype(float)
    ts_all = df.loc[ev.index, "timestamp"]

    oof_p = pd.Series(np.nan, index=ev.index)   # out-of-fold meta probabilities
    for tr_t, te_t in make_folds(ts_all.values, n_folds):
        te_start = te_t.min()
        tr = (ts_all < te_start) & (ts_all + horizon_sec < te_start - emb_sec)
        te = ts_all.isin(te_t)
        if tr.sum() < 50 or te.sum() < 20 or y[tr].nunique() < 2:
            continue
        Xtr = X_all[tr]; med = Xtr.median()
        sc = StandardScaler().fit(Xtr.fillna(med))
        clf = LogisticRegression(penalty="l2", C=0.5, max_iter=1000, class_weight="balanced")
        clf.fit(sc.transform(Xtr.fillna(med)), y[tr])
        p = clf.predict_proba(sc.transform(X_all[te].fillna(med)))[:, 1]
        oof_p.loc[ev.index[te]] = p

    m = oof_p.notna()
    return dict(y=y[m], p=oof_p[m], side=side[m], n=int(m.sum()),
                base_wr=float(y[m].mean()))

def fmt(x, d=4):
    return "nan" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--primary", required=True, help='factor expression, or the literal "signals"')
    ap.add_argument("--neutral", type=float, default=50.0, help="factor-rule split point (side flips here)")
    ap.add_argument("--top-side", choices=["call","put"], default="put",
                    help="side when factor > neutral (default put = mean-reversion on an oscillator)")
    ap.add_argument("--horizon", type=int, default=10, help="forward horizon in MINUTES")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5)
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--min-coverage", type=float, default=0.10, help="min fraction of signals taken to call it usable")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    bar_sec = args.bar_sec
    if bar_sec < 300: sys.exit(f"ERROR: --bar-sec {bar_sec} below 300s floor.")
    if (args.horizon * 60) % bar_sec: sys.exit(f"ERROR: horizon {args.horizon}m not a whole bar multiple.")
    breakeven = 1.0 / (1.0 + args.payout)

    df, sig = load(args.db)
    fwd = forward_return(df, args.horizon, bar_sec)
    ev = primary_events(df, sig, args, bar_sec)
    pname = "bot signals" if args.primary == "signals" else f"`{args.primary}` (>{args.neutral}→{args.top_side})"

    print(f"\n# Meta-Labeling — primary: {pname}  @ {args.horizon}m")
    print(f"primary signals: {len(ev)}   break-even WR {breakeven*100:.1f}%\n")
    if len(ev) < 100:
        print(f"⚠ Only {len(ev)} primary signals — too few to train/validate a meta-model. "
              "Use a factor primary (fires on every bar) or a larger snapshot.")
        if args.primary == "signals":
            return

    r = run(df, ev, fwd, bar_sec, args.horizon, args.folds, args.embargo)
    if r["n"] < 100:
        print(f"Insufficient out-of-fold predictions ({r['n']}). Stop."); return

    y, p = r["y"].values, r["p"].values
    auc = roc_auc_score(y, p) if len(np.unique(y)) > 1 else np.nan
    print(f"primary base WR (take all): {r['base_wr']*100:.1f}%   meta-model OOS AUC: {fmt(auc,3)}   "
          f"out-of-fold n: {r['n']}\n")

    print("## Abstention curve — trade only when meta P(win) ≥ threshold")
    print("| threshold | taken | coverage | OOS WR | clears break-even? |")
    print("|---|---|---|---|---|")
    best = None
    for thr in [0.50,0.55,0.60,0.65,0.70,0.75,0.80]:
        take = p >= thr
        n_take = int(take.sum())
        if n_take == 0:
            print(f"| {thr:.2f} | 0 | 0.0% | — | |"); continue
        wr = float(y[take].mean()); cov = n_take / len(y)
        clears = wr > breakeven and cov >= args.min_coverage
        print(f"| {thr:.2f} | {n_take} | {cov*100:.1f}% | {wr*100:.1f}% | {'✓' if clears else ''} |")
        if clears and (best is None or wr > best[2]):
            best = (thr, cov, wr, n_take)

    print()
    if np.isfinite(auc) and auc <= 0.52:
        verdict = (f"NO LIFT — meta-model can't separate primary wins from losses (AUC {fmt(auc,3)}). "
                   "Abstention won't rescue this primary; the features carry no win/loss information.")
    elif best:
        verdict = (f"WORKS — at P≥{best[0]:.2f}, OOS WR {best[2]*100:.1f}% (> break-even {breakeven*100:.1f}%) "
                   f"on {best[1]*100:.1f}% of signals (n={best[3]}). Abstention converts a sub-break-even "
                   "primary into a tradeable subset. Confirm cross-regime, then freeze (skill #4).")
    else:
        verdict = (f"PARTIAL — meta-model separates somewhat (AUC {fmt(auc,3)}) but no threshold clears "
                   f"break-even at ≥{args.min_coverage*100:.0f}% coverage. Not tradeable yet; needs a "
                   "stronger primary or more/again-cross-regime data.")
    print(f"## Verdict: {verdict}")
    print("\nMeta-labeling is validated OOF/purged here but on ONE regime — cross-regime replication "
          "is still required before any freeze-export.")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(dict(primary=pname, horizon=args.horizon, n_signals=len(ev),
                           base_wr=r["base_wr"], meta_auc=auc, verdict=verdict,
                           best=None if not best else dict(threshold=best[0], coverage=best[1], wr=best[2], n=best[3])),
                      f, indent=2, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else o)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
