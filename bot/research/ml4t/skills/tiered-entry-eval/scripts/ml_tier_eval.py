#!/usr/bin/env python3
"""
ml_tier_eval.py — empirical test of the Probability-Thresholded Monolithic Model.

Spec under test: one classifier estimates p̂ = P(close[t+n] > close[t] | X) on the
36 family-tagged stationary features; execution tiers gate on fixed thresholds
θ1=0.52 (20% vol), θ2=0.56 (50%), θ3=0.60 (30%). Direction: CALL if p̂>=θ,
mirrored PUT if (1-p̂)>=θ.

Measures, all OUT-OF-FOLD (purged walk-forward):
  - the distribution of honest p̂ (how often each θ is even reachable)
  - per-tier fire-rate and realized WR vs break-even
  - a calibration table (predicted bucket vs realized frequency)
Models: L2 logistic and HistGradientBoosting (the ensemble case the spec assumes).

Usage: python ml_tier_eval.py [--db path[,path,...]] [--horizon 10]
"""
from __future__ import annotations
import argparse, sys, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load, engineer_families, make_folds

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--horizon", type=int, default=10)
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5)
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--thetas", default="0.52,0.56,0.60")
    args = ap.parse_args()
    if args.bar_sec < 300: sys.exit("ERROR: bar-sec below 300s floor.")
    n = (args.horizon * 60) // args.bar_sec
    breakeven = 1.0 / (1.0 + args.payout)
    thetas = [float(t) for t in args.thetas.split(",")]

    frames = []
    for i, p in enumerate([q.strip() for q in args.db.split(",") if q.strip()]):
        d = load(p); d["asset"] = d["asset"] + f"@{i}"; frames.append(d)
    df = pd.concat(frames, ignore_index=True)

    # directional binary label Y = 1 if close[t+n] > close[t], contiguous bars only
    y = pd.Series(np.nan, index=df.index)
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        lab = (close.shift(-n) > close).astype(float)
        lab = lab.where(ts.shift(-n) - ts == n * args.bar_sec)
        y.loc[g.index] = lab.values
    X, _ = engineer_families(df)
    keep = y.notna() & X.notna().any(axis=1)
    Xk, yk, tk = X[keep], y[keep], df.loc[keep, "timestamp"]

    print(f"\n# ML Tier Architecture — P(up) @ {args.horizon}m on 36 family features")
    print(f"rows {len(yk)}   base P(up) {yk.mean()*100:.1f}%   break-even {breakeven*100:.1f}%   "
          f"thetas {thetas}\n")

    horizon_sec, emb = args.horizon * 60, args.embargo * args.bar_sec
    for name in ("logreg", "gbm"):
        oof = pd.Series(np.nan, index=yk.index)
        for _, te_t in make_folds(tk.values, args.folds):
            te_start = te_t.min()
            tr = (tk < te_start) & (tk + horizon_sec < te_start - emb)
            te = tk.isin(te_t)
            if tr.sum() < 200 or te.sum() < 50:
                continue
            med = Xk[tr].median()
            if name == "logreg":
                sc = StandardScaler().fit(Xk[tr].fillna(med))
                clf = LogisticRegression(penalty="l2", C=0.5, max_iter=1000)
                clf.fit(sc.transform(Xk[tr].fillna(med)), yk[tr])
                p = clf.predict_proba(sc.transform(Xk[te].fillna(med)))[:, 1]
            else:
                clf = HistGradientBoostingClassifier(max_depth=4, max_iter=150,
                                                     learning_rate=0.05, min_samples_leaf=50)
                clf.fit(Xk[tr].fillna(med), yk[tr])
                p = clf.predict_proba(Xk[te].fillna(med))[:, 1]
            oof.loc[yk.index[te]] = p
        m = oof.notna()
        ph, yt = oof[m], yk[m]
        auc = roc_auc_score(yt, ph) if yt.nunique() > 1 else np.nan
        q = ph.quantile([0.01, 0.25, 0.50, 0.75, 0.99])
        print(f"## {name}  (OOS AUC {auc:.3f})")
        print(f"p̂ distribution: 1% {q.iloc[0]:.3f} | 25% {q.iloc[1]:.3f} | median {q.iloc[2]:.3f} "
              f"| 75% {q.iloc[3]:.3f} | 99% {q.iloc[4]:.3f}")
        print("| tier θ | CALL fires | CALL WR | PUT fires | PUT WR | clears? |")
        print("|---|---|---|---|---|---|")
        for th in thetas:
            cm = ph >= th;  pm = (1 - ph) >= th
            cwr = float(yt[cm].mean()) if cm.sum() else np.nan
            pwr = float(1 - yt[pm].mean()) if pm.sum() else np.nan
            ok = any(np.isfinite(w) and w > breakeven and f >= 30
                     for w, f in ((cwr, cm.sum()), (pwr, pm.sum())))
            f1 = "—" if not cm.sum() else f"{cwr*100:.1f}%"
            f2 = "—" if not pm.sum() else f"{pwr*100:.1f}%"
            print(f"| {th:.2f} | {int(cm.sum())} | {f1} | {int(pm.sum())} | {f2} | {'✓' if ok else ''} |")
        # calibration: predicted bucket vs realized (symmetric distance from 0.5)
        print("calibration (|p̂−0.5| buckets → realized WR of the implied side):")
        conf = (ph - 0.5).abs()
        side_win = np.where(ph >= 0.5, yt, 1 - yt)
        buckets = pd.cut(conf, [0, 0.01, 0.02, 0.04, 0.06, 0.10, 1.0])
        tbl = pd.DataFrame({"b": buckets, "w": side_win}).groupby("b", observed=True)["w"].agg(["size", "mean"])
        for b, r in tbl.iterrows():
            print(f"   {str(b):14s} n={int(r['size']):7d}  realized {r['mean']*100:.1f}%")
        print()

if __name__ == "__main__":
    main()
