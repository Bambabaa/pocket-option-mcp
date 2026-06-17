#!/usr/bin/env python3
"""
fine_tune.py — hyperparameter tuning for the directional next-bar model, selected by
OUT-OF-SAMPLE performance (the thing the original gate skipped).

Protocol (no look-ahead, no random CV on time series):
  - engineer agent_v1, time-ordered. Tune on v1: train (first 70%) -> select on v1-val (last 30%).
  - grid-search LogReg / DecisionTree / RandomForest; rank by val AUC, REJECT configs whose
    train-val overfit gap > GAP_MAX (kills the thin-tail overfit failure mode).
  - take the best surviving config, retrain on ALL of v1, evaluate on agent.db (clean zero-overlap
    OOS): AUC + a confidence-threshold WR sweep vs break-even (is the confident slice tradeable?).

Usage: python fine_tune.py [--gap-max 0.02] [--payout 0.69]
"""
from __future__ import annotations
import argparse, os, sys, importlib.util
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("cdir", os.path.join(HERE, "confluence_directional.py"))
cdir = importlib.util.module_from_spec(spec); spec.loader.exec_module(cdir)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

def auc(model, X, y, sc=None):
    Xt = sc.transform(X) if sc is not None else X
    return roc_auc_score(y, model.predict_proba(Xt)[:,1])

def grids():
    g = []
    for C in [0.05,0.1,0.5,1,5,10]:
        for pen,sol in [("l2","lbfgs"),("l1","liblinear")]:
            g.append(("LogReg", dict(C=C,penalty=pen,solver=sol,class_weight="balanced",max_iter=2000), True))
    for dpth in [3,4,5,6,8]:
        for leaf in [50,100,200,500]:
            g.append(("DTree", dict(max_depth=dpth,min_samples_leaf=leaf,class_weight="balanced",random_state=42), False))
    for ntree in [200,400]:
        for dpth in [4,6,8]:
            for leaf in [50,100,200]:
                g.append(("RForest", dict(n_estimators=ntree,max_depth=dpth,min_samples_leaf=leaf,
                                          class_weight="balanced",random_state=42,n_jobs=-1), False))
    return g

def make(kind, p):
    return {"LogReg":LogisticRegression,"DTree":DecisionTreeClassifier,"RForest":RandomForestClassifier}[kind](**p)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--gap-max",type=float,default=0.02)
    ap.add_argument("--payout",type=float,default=0.69); a=ap.parse_args()
    be=1/(1+a.payout)
    v1,feats=cdir.engineer("agent/data/agent_v1.db"); v1=v1.sort_values("timestamp").reset_index(drop=True)
    cut=int(len(v1)*0.70)
    tr,va=v1.iloc[:cut],v1.iloc[cut:]
    Xtr,ytr=tr[feats].values,tr["target"].astype(int).values
    Xva,yva=va[feats].values,va["target"].astype(int).values
    scv=StandardScaler().fit(Xtr)

    print(f"# Fine-tune directional model (select by OOS, reject overfit gap > {a.gap_max})")
    print(f"v1 tune: train {len(tr)} / val {len(va)} | break-even {be*100:.1f}%\n")
    res=[]
    for kind,p,needs in grids():
        m=make(kind,p); m.fit(scv.transform(Xtr) if needs else Xtr, ytr)
        a_tr=auc(m,Xtr,ytr,scv if needs else None); a_va=auc(m,Xva,yva,scv if needs else None)
        gap=a_tr-a_va; res.append((kind,p,needs,a_tr,a_va,gap))
    # leaderboard: survivors (gap<=max) ranked by val AUC
    surv=[r for r in res if r[5]<=a.gap_max]
    surv.sort(key=lambda r:-r[4])
    print("## Top configs surviving the overfit-gap filter (ranked by val AUC)")
    print("| kind | params | train AUC | val AUC | gap |")
    print("|---|---|---|---|---|")
    for kind,p,needs,atr,ava,gap in surv[:8]:
        ps=",".join(f"{k}={v}" for k,v in p.items() if k not in("random_state","n_jobs","class_weight","max_iter","solver"))
        print(f"| {kind} | {ps} | {atr:.3f} | {ava:.3f} | {gap:+.3f} |")
    if not surv:
        print("| — none survived the gap filter — | | | | |"); return

    # best -> retrain on ALL v1, evaluate on agent.db OOS
    kind,p,needs,_,_,_=surv[0]
    Xall,yall=v1[feats].values,v1["target"].astype(int).values
    sca=StandardScaler().fit(Xall); best=make(kind,p); best.fit(sca.transform(Xall) if needs else Xall, yall)
    oos,_=cdir.engineer("agent/data/agent.db"); oos=oos.sort_values("timestamp")
    Xo,yo=oos[feats].values, oos["target"].astype(int).values
    po=best.predict_proba(sca.transform(Xo) if needs else Xo)[:,1]
    print(f"\n## Best config: {kind} {p}")
    print(f"retrained on ALL v1 -> agent.db OOS AUC: {roc_auc_score(yo,po):.3f}  (OOS base up-rate {yo.mean()*100:.1f}%)")
    print("\n### Confidence-threshold WR sweep on OOS (bet UP if p>=thr, DOWN if p<=1-thr)")
    print("| conf thr | capture | WR vs BE | up WR | down WR |")
    print("|---|---|---|---|---|")
    for thr in [0.50,0.55,0.60,0.65,0.70]:
        up=po>=thr; dn=po<=(1-thr)
        nu,nd=int(up.sum()),int(dn.sum()); n=nu+nd
        if n<50: print(f"| {thr:.2f} | {n} | thin | — | — |"); continue
        wins=np.concatenate([yo[up], 1-yo[dn]]); wr=wins.mean()*100
        uw=yo[up].mean()*100 if nu>=20 else np.nan; dw=(1-yo[dn]).mean()*100 if nd>=20 else np.nan
        cap=n/len(po)*100; flag="*" if wr>=be*100 else ""
        print(f"| {thr:.2f} | {cap:.1f}% (n={n}) | {wr:.1f}%{flag} | "
              f"{uw:.0f}% (n={nu}) | {dw:.0f}% (n={nd}) |")
    print(f"\n(* clears break-even {be*100:.1f}%. Tuning is honest only because selection used v1-val "
          "and the headline is agent.db OOS. In-period gains that vanish OOS = the old trap.)")

if __name__=="__main__":
    main()
