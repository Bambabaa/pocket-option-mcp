#!/usr/bin/env python3
"""
directional_momentum.py — THE research question, made executable.

Can we predict the forward MOMENTUM STATE (gain / stable / decay) of price from
ALL the indicators, and turn that into a PROFITABLE directional bet?

Framing (per the project's research focus):
  - state is a FORWARD PRICE label (unknown at decision time -> must be predicted):
        s    = sign(close[t] - close[t-k])           recent trend direction (k bars)
        cont = s * (close[t+n] - close[t]) / ATR[t]   ATR-normed continuation
        terciles of cont (fit on TRAIN only):
            gain   = top    -> trend ACCELERATES  -> bet WITH trend   (side = s)
            decay  = bottom -> momentum REVERSES  -> bet AGAINST trend (side = -s)
            stable = middle -> flat               -> SKIP
  - ALL bounded indicators are the FEATURES the model predicts state from.
  - A multinomial logistic is trained with PURGED walk-forward; its out-of-fold
    predictions drive the betting rule; win-rate is scored vs the payout break-even.

Why this is the honest version of the prior (failed) gain/stable/decay study:
the label is a forward price move, not an indicator's own slope, and success is
defined as WR > break-even out-of-sample, not F1 on balanced terciles.

READ-ONLY (immutable=1). No model persisted (that's the freeze step, skill #4-export).

Usage:
  python directional_momentum.py --horizon 10
  python directional_momentum.py --horizon 5 --k 6 --min-prob 0.45 --folds 5
"""
from __future__ import annotations
import argparse, json, sys, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import (load, make_folds, engineer_families, family_cols, FAMILIES)  # schema-adaptive

def labels(df, k, n, bar_sec):
    """Per asset: recent-trend sign s, forward move sign, ATR-normed continuation.
    Returns columns: s, fwd_up (1/0/nan), cont (nan where window incomplete)."""
    df = df.copy()
    for c in ("s","fwd_dir","cont"):
        df[c] = np.nan
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts, atr = g["close"].astype(float), g["timestamp"], g["atr_14"].astype(float)
        s = np.sign(close - close.shift(k))
        move = close.shift(-n) - close
        contiguous_f = (ts.shift(-n) - ts == n * bar_sec)
        contiguous_b = (ts - ts.shift(k) == k * bar_sec)
        cont = (s * move / atr).where(contiguous_f & contiguous_b & (atr > 0))
        fwd_dir = np.sign(move).where(contiguous_f)
        df.loc[g.index, "s"] = s.values
        df.loc[g.index, "fwd_dir"] = fwd_dir.values
        df.loc[g.index, "cont"] = cont.values
    return df

def state_from_cont(cont, lo, hi):
    """0=decay (<=lo), 1=stable, 2=gain (>=hi)."""
    return np.where(cont <= lo, 0, np.where(cont >= hi, 2, 1))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--horizon", type=int, default=10, help="forward horizon (minutes)")
    ap.add_argument("--k", type=int, default=6, help="trend-direction lookback (bars)")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5)
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--min-prob", type=float, default=0.0,
                    help="only bet when predicted-state prob >= this (abstention); 0 = bet every non-stable")
    ap.add_argument("--min-coverage", type=float, default=0.10)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    bar_sec = args.bar_sec
    if bar_sec < 300: sys.exit("ERROR: --bar-sec below 300s floor.")
    if (args.horizon*60) % bar_sec: sys.exit("ERROR: horizon not a whole bar multiple.")
    n = (args.horizon*60)//bar_sec
    breakeven = 1.0/(1.0+args.payout)

    df = load(args.db)
    df = labels(df, args.k, n, bar_sec)
    valid = df["cont"].notna() & df["fwd_dir"].notna() & (df["s"] != 0)
    df = df[valid].copy()
    horizon_sec, emb_sec = args.horizon*60, args.embargo*bar_sec
    ts = df["timestamp"]
    Xall, registry = engineer_families(df)               # all 32 indicators -> family-tagged features

    def run(cols):
        """Purged walk-forward for one feature set -> (acc, cov, wr, n, per-state wr)."""
        X = Xall[cols].astype(float)
        oof_state = pd.Series(np.nan, index=df.index); oof_prob = pd.Series(np.nan, index=df.index)
        true_state = pd.Series(np.nan, index=df.index)
        for _, te_t in make_folds(ts.values, args.folds):
            te_start = te_t.min()
            tr = (ts < te_start) & (ts + horizon_sec < te_start - emb_sec)
            te = ts.isin(te_t)
            if tr.sum() < 100 or te.sum() < 30:
                continue
            lo, hi = df.loc[tr, "cont"].quantile([1/3, 2/3])      # terciles fit on TRAIN only
            ytr = state_from_cont(df.loc[tr, "cont"].values, lo, hi)
            true_state.loc[df.index[te]] = state_from_cont(df.loc[te, "cont"].values, lo, hi)
            med = X[tr].median()
            sc = StandardScaler().fit(X[tr].fillna(med))
            clf = LogisticRegression(penalty="l2", C=0.5, max_iter=2000, class_weight="balanced")
            clf.fit(sc.transform(X[tr].fillna(med)), ytr)
            P = clf.predict_proba(sc.transform(X[te].fillna(med)))
            cls = clf.classes_; pred_idx = P.argmax(1)
            oof_state.loc[df.index[te]] = cls[pred_idx]
            oof_prob.loc[df.index[te]]  = P[np.arange(len(P)), pred_idx]
        m = oof_state.notna()
        d = df[m].copy(); d["pred"] = oof_state[m]; d["pred_p"] = oof_prob[m]; d["true"] = true_state[m]
        acc = float((d["pred"] == d["true"]).mean()) if len(d) else np.nan
        bet = d[d["pred"] != 1]
        if args.min_prob > 0:
            bet = bet[bet["pred_p"] >= args.min_prob]
        side = np.where(bet["pred"] == 2, bet["s"], -bet["s"])
        win = (np.sign(bet["fwd_dir"]) == side)
        cov = len(bet)/len(d) if len(d) else 0.0
        wr = float(win.mean()) if len(bet) else np.nan
        per = {}
        for st, nm in [(2,"gain_with_trend"),(0,"decay_against_trend")]:
            sub = bet[bet["pred"]==st]
            if len(sub):
                sside = np.where(sub["pred"]==2, sub["s"], -sub["s"])
                per[nm] = (len(sub), float((np.sign(sub["fwd_dir"])==sside).mean()))
        return dict(n=len(d), acc=acc, cov=cov, wr=wr, per=per)

    print(f"\n# Directional-Momentum Edge — horizon {args.horizon}m, trend-k {args.k}b")
    print(f"all 32 indicators engineered into {len(registry)} family-tagged features   "
          f"break-even WR {breakeven*100:.1f}%")
    print("Sectioned by family (never a single indicator). Each family run standalone + all together.\n")

    # per-family ablation: each family alone, then all combined
    order = list(FAMILIES) + ["all"]
    res = {fam: run(family_cols(registry, fam)) for fam in order}

    print("| family | #feats | rows | state-acc (vs 33.3) | coverage | OOS WR | vs break-even |")
    print("|---|---|---|---|---|---|---|")
    for fam in order:
        r = res[fam]; nf = len(family_cols(registry, fam))
        wrs = "nan" if not np.isfinite(r["wr"]) else f"{r['wr']*100:.1f}%"
        clr = "✓" if (np.isfinite(r["wr"]) and r["wr"] > breakeven and r["cov"] >= args.min_coverage) else ""
        print(f"| {fam} | {nf} | {r['n']} | {r['acc']*100:.1f}% | {r['cov']*100:.1f}% | {wrs} | {clr} |")

    # per-state split for the combined model (which direction, if any, carries anything)
    rall = res["all"]
    if rall["per"]:
        print("\nall-families, by predicted state:")
        for nm,(n_,w_) in rall["per"].items():
            print(f"   {nm}: {n_} bets, WR {w_*100:.1f}%")

    # integrated verdict — requires a FAMILY (a group, not one indicator) to clear break-even
    winners = [f for f in order if np.isfinite(res[f]["wr"]) and res[f]["wr"] > breakeven
               and res[f]["cov"] >= args.min_coverage]
    best_acc = max((res[f]["acc"] for f in order if np.isfinite(res[f]["acc"])), default=np.nan)
    if winners:
        verdict = ("PROFITABLE — family/families clearing break-even OOS: "
                   + ", ".join(f"{f} (WR {res[f]['wr']*100:.1f}% @ {res[f]['cov']*100:.0f}%)" for f in winners)
                   + ". Confirm on another regime + cost detail, then freeze.")
    elif np.isfinite(best_acc) and best_acc > 0.36:
        verdict = (f"PREDICTABLE-BUT-UNPROFITABLE — best family state-acc {best_acc*100:.1f}% > 33.3%, "
                   "but no family clears break-even WR. Structure exists, too weak for the payout deficit.")
    else:
        verdict = (f"NO EDGE — no family predicts forward momentum state above chance "
                   f"(best acc {best_acc*100:.1f}% ≈ 33.3%) and none clears break-even. "
                   "H0 holds across trend, momentum, volatility AND breakout — not a single-indicator call.")
    print(f"\n## Verdict: {verdict}")
    print("\nFamily-sectioned + purged, but verify on a second regime before any freeze-export.")

    if args.json:
        with open(args.json,"w") as f:
            json.dump(dict(horizon=args.horizon, k=args.k, breakeven=breakeven,
                           families={f: {kk: res[f][kk] for kk in ("n","acc","cov","wr")} for f in order},
                           verdict=verdict), f, indent=2,
                      default=lambda o: None if isinstance(o,float) and not np.isfinite(o) else o)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
