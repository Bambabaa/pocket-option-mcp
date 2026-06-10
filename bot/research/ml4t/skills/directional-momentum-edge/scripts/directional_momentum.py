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
from po_data import load, FEATS, make_folds   # schema-adaptive across both DB layouts

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

    X = df[FEATS].astype(float); ts = df["timestamp"]
    oof_state = pd.Series(np.nan, index=df.index)   # predicted state
    oof_prob  = pd.Series(np.nan, index=df.index)   # prob of predicted state
    true_state = pd.Series(np.nan, index=df.index)  # realized state (train terciles applied to test)

    for tr_t, te_t in make_folds(ts.values, args.folds):
        te_start = te_t.min()
        tr = (ts < te_start) & (ts + horizon_sec < te_start - emb_sec)
        te = ts.isin(te_t)
        if tr.sum() < 100 or te.sum() < 30:
            continue
        lo, hi = df.loc[tr, "cont"].quantile([1/3, 2/3])     # terciles fit on TRAIN only
        ytr = state_from_cont(df.loc[tr, "cont"].values, lo, hi)
        true_state.loc[df.index[te]] = state_from_cont(df.loc[te, "cont"].values, lo, hi)
        med = X[tr].median()
        sc = StandardScaler().fit(X[tr].fillna(med))
        clf = LogisticRegression(penalty="l2", C=0.5, max_iter=2000,
                                 class_weight="balanced")  # multinomial is the lbfgs default
        clf.fit(sc.transform(X[tr].fillna(med)), ytr)
        P = clf.predict_proba(sc.transform(X[te].fillna(med)))
        # align to classes present in train
        cls = clf.classes_
        pred_idx = P.argmax(1)
        oof_state.loc[df.index[te]] = cls[pred_idx]
        oof_prob.loc[df.index[te]]  = P[np.arange(len(P)), pred_idx]

    m = oof_state.notna()
    d = df[m].copy()
    d["pred"] = oof_state[m]; d["pred_p"] = oof_prob[m]; d["true"] = true_state[m]

    print(f"\n# Directional-Momentum Edge — horizon {args.horizon}m, trend-k {args.k}b")
    print(f"features: {len(FEATS)} indicators   rows scored OOF: {len(d)}   "
          f"break-even WR {breakeven*100:.1f}%\n")

    # diagnostic: can the model predict state at all?
    acc = float((d["pred"] == d["true"]).mean())
    print(f"3-class state prediction accuracy: {acc*100:.1f}%  (random = 33.3%)")
    # confusion-lite: predicted-state distribution
    dist = d["pred"].value_counts(normalize=True).reindex([0,1,2]).fillna(0)
    print(f"predicted mix — decay {dist[0]*100:.0f}% / stable {dist[1]*100:.0f}% / gain {dist[2]*100:.0f}%\n")

    # betting rule: gain(2)->with trend(side=s); decay(0)->against(side=-s); stable(1)->skip
    bet = d[d["pred"] != 1].copy()
    if args.min_prob > 0:
        bet = bet[bet["pred_p"] >= args.min_prob]
    side = np.where(bet["pred"] == 2, bet["s"], -bet["s"])          # +1 call, -1 put
    win = (np.sign(bet["fwd_dir"]) == side).astype(float)
    cov = len(bet)/len(d) if len(d) else 0.0
    wr = float(win.mean()) if len(bet) else np.nan

    print("## Betting rule: predicted gain→with-trend, decay→against-trend, stable→skip")
    print(f"taken {len(bet)} / {len(d)}  (coverage {cov*100:.1f}%)   OOS WR {('nan' if not np.isfinite(wr) else f'{wr*100:.1f}%')}"
          f"   break-even {breakeven*100:.1f}%")

    # WR split by predicted state
    for st, nm in [(2,"gain→CALL/with-trend"),(0,"decay→against-trend")]:
        sub = bet[bet["pred"]==st]
        if len(sub):
            sside = np.where(sub["pred"]==2, sub["s"], -sub["s"])
            swr = float((np.sign(sub["fwd_dir"])==sside).mean())
            print(f"   {nm}: {len(sub)} bets, WR {swr*100:.1f}%")

    profitable = np.isfinite(wr) and wr > breakeven and cov >= args.min_coverage
    if profitable:
        verdict = (f"PROFITABLE — predicted-momentum betting clears break-even OOS "
                   f"(WR {wr*100:.1f}% > {breakeven*100:.1f}% on {cov*100:.1f}% coverage). "
                   "Confirm cross-regime + cost detail, then freeze.")
    elif acc > 0.36:
        verdict = (f"PREDICTABLE-BUT-UNPROFITABLE — state predicted slightly above chance "
                   f"({acc*100:.1f}%) but WR {('nan' if not np.isfinite(wr) else f'{wr*100:.1f}%')} "
                   f"does not clear break-even. The momentum structure exists but is too weak to pay "
                   "the payout deficit; revisit with abstention (--min-prob) or stronger features.")
    else:
        verdict = (f"NO EDGE — forward momentum state is ~unpredictable from the indicators "
                   f"(accuracy {acc*100:.1f}% ≈ random) and WR does not clear break-even. "
                   "Consistent with the project-wide near-unpredictability; H0 holds for this target.")
    print(f"\n## Verdict: {verdict}")
    print("\nOne-regime result — even PROFITABLE owes cross-regime replication (May agent.db / other "
          "snapshots) before any freeze-export.")

    if args.json:
        with open(args.json,"w") as f:
            json.dump(dict(horizon=args.horizon, k=args.k, n_scored=len(d), state_acc=acc,
                           coverage=cov, wr=wr, breakeven=breakeven, verdict=verdict), f, indent=2,
                      default=lambda o: None if isinstance(o,float) and not np.isfinite(o) else o)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
