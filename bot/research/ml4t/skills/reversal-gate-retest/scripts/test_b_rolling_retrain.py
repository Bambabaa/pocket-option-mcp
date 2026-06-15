#!/usr/bin/env python3
"""
test_b_rolling_retrain.py — Test B: does rolling retrain restore an OOS edge?

Purged walk-forward on agent.db (15 assets, big n). For each test day D, refit on the
prior K days (purged: drop train bars whose t+3 label would peek into D), predict on D.
Each arm fires on its top-SEL fraction of that day's bars and bets its verdict direction:

  logreg-fade : fire high P(decay), bet FADE  -> WR = realized decay among fired
  tree-follow : fire high P(decay), bet FOLLOW -> WR = realized continuation (1-decay)

Compares FROZEN deployed gate vs ROLLING-retrained variants, with the two fixes from the
training-defect finding:
  - logreg: weak L2 (C=10) so it can't collapse to one feature (deployed C=0.5 -> univariate)
  - tree:   re-labeled as CONTINUATION (the broker-settled verdict)

Reports per-day + pooled OOS WR vs break-even (0.59 @ ~69% payout), and the rolling logreg's
top-feature weight share (does relaxing L2 spread the weights?).

Usage: python test_b_rolling_retrain.py [--window 5] [--sel 0.20]
"""
from __future__ import annotations
import argparse, json, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
P = json.load(open(os.path.join(HERE, "..", "ml_gate_params_deployed.json")))
GATE = P["thresholds"]["gate"]; FEATS = P["features"]; BAR, N = 300, 3
BREAKEVEN = 0.59
def R(p): return os.path.join(ROOT, p)
AGENT_DB = "agent/data/agent.db"

def frozen_tree_p(x):
    n = P["tree"]
    while not n["leaf"]:
        n = n["left"] if x[n["feature"]] <= n["threshold"] else n["right"]
    return n["proba"]
def frozen_logreg_p(x):
    lr = P["logreg"]
    z = (np.array(x) - lr["scaler_mean"]) / lr["scaler_scale"]
    return 1.0/(1.0+np.exp(-(np.dot(z, lr["coef"]) + lr["intercept"])))

def build():
    df = po_data.load(R(AGENT_DB))
    rows = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close, ts = g["close"].astype(float), g["timestamp"]
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        g["BB_Deviation"]     = (close - g["bb_lower"]) / band
        g["CCI_Velocity"]     = g["cci_20"].diff(2) / 2.0
        g["Stoch_Divergence"] = (g["stoch_k"] - g["stoch_d"]).abs()
        g["STC_Momentum"]     = g["stc_value"].diff(1)
        recent = close - close.shift(N); fwd = close.shift(-N) - close
        contig = (ts.shift(-N) - ts == N*BAR) & (ts - ts.shift(N) == N*BAR)
        g["decay"] = ((np.sign(fwd) != np.sign(recent)) & contig & (recent != 0)).astype(float)
        g.loc[~(contig & (recent != 0)), "decay"] = np.nan
        rows.append(g)
    d = pd.concat(rows).dropna(subset=FEATS + ["decay"])
    d["day"] = pd.to_datetime(d["timestamp"], unit="s").dt.strftime("%Y-%m-%d")
    return d

def wr_top(scores, decay, sel, follow=False):
    """WR among the top-sel fraction by score; follow -> bet continuation (1-decay)."""
    k = max(5, int(len(scores)*sel))
    idx = np.argsort(-scores)[:k]
    real = decay[idx]
    return (1-real).mean() if follow else real.mean(), len(idx)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=5)
    ap.add_argument("--sel", type=float, default=0.20)
    a = ap.parse_args()
    d = build()
    days = sorted(d["day"].unique())
    day_start = {day: d[d["day"]==day]["timestamp"].min() for day in days}

    print(f"# Test B — purged rolling retrain on agent.db (window {a.window}d, top-{a.sel:.0%} fired)")
    print(f"break-even {BREAKEVEN:.0%} | logreg=fade C=10 | tree=continuation(follow)\n")
    print("| test day | n | frozen LR-fade | frozen TR-follow | roll LR-fade | roll TR-follow | LR top-wt% |")
    print("|---|---|---|---|---|---|---|")
    agg = {k: [] for k in ["fL","fT","rL","rT"]}  # (wins,n) accumulators as (wr,n)
    pooled = {k: [0.0,0] for k in agg}
    for i, day in enumerate(days):
        if i < a.window:  # warmup
            continue
        train_days = days[i-a.window:i]
        tr = d[d["day"].isin(train_days)].copy()
        # purge: drop train bars whose t+N label peeks into test day
        tr = tr[tr["timestamp"] < day_start[day] - N*BAR]
        te = d[d["day"]==day]
        if len(tr) < 100 or len(te) < 10: continue
        Xtr, ytr = tr[FEATS].values, tr["decay"].astype(int).values
        Xte, yte = te[FEATS].values, te["decay"].values
        if len(np.unique(ytr)) < 2: continue
        # frozen
        fL = np.array([frozen_logreg_p(x) for x in Xte])
        fT = np.array([frozen_tree_p(x)   for x in Xte])
        # rolling logreg (weak L2, balanced) + tree (continuation handled at bet)
        sc = StandardScaler().fit(Xtr)
        lr = LogisticRegression(C=10.0, class_weight="balanced", max_iter=500).fit(sc.transform(Xtr), ytr)
        rL = lr.predict_proba(sc.transform(Xte))[:,1]
        tree = DecisionTreeClassifier(max_depth=5, min_samples_leaf=30, class_weight="balanced",
                                      random_state=42).fit(Xtr, ytr)
        rT = tree.predict_proba(Xte)[:,1]
        # top-weight share of rolling logreg (collapse check)
        w = np.abs(lr.coef_[0]); share = w.max()/w.sum()*100
        res = {}
        for name, sc_arr, follow in [("fL",fL,False),("fT",fT,True),("rL",rL,False),("rT",rT,True)]:
            wr, k = wr_top(sc_arr, yte, a.sel, follow=follow)
            res[name]=wr; pooled[name][0]+=wr*k; pooled[name][1]+=k
        cell = lambda v: f"{v*100:.0f}%"
        print(f"| {day} | {len(te)} | {cell(res['fL'])} | {cell(res['fT'])} | "
              f"{cell(res['rL'])} | {cell(res['rT'])} | {share:.0f}% |")
    print("\n## Pooled OOS WR (vs break-even 59%)")
    print("| variant | pooled WR | edge | verdict |")
    print("|---|---|---|---|")
    label={"fL":"FROZEN logreg-fade","fT":"FROZEN tree-follow",
           "rL":"ROLLING logreg-fade (C=10)","rT":"ROLLING tree-follow"}
    for k in ["fL","fT","rL","rT"]:
        s,n = pooled[k]; wr = s/n if n else float("nan")
        v = "ABOVE be" if wr>BREAKEVEN else "below be"
        print(f"| {label[k]} | {wr*100:.1f}% (n={n}) | {(wr-BREAKEVEN)*100:+.1f}pts | {v} |")
    print("\n(LR top-wt% = max|coef|/sum|coef| of the rolling logreg. Deployed frozen ~88% "
          "(collapsed to Stoch_Divergence). Lower = weights spread across features = fix worked.)")

if __name__ == "__main__":
    main()
