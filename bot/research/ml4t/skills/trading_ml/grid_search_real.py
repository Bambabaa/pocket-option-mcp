#!/usr/bin/env python3
"""
grid_search_real.py — hyperparameter grid search on REAL data only, selected by TEST,
reported on the held-out VALIDATE set (validate is NEVER used for selection).

Same pooled all-trading_data 60/20/20 time split as train_test_validate_real. Sweeps
LogReg / RandomForest / HistGradBoost. Ranks configs by TEST AUC, then shows their
VALIDATE AUC. Question: can tuning push real-data VALIDATE above coin (~0.50)?
"""
from __future__ import annotations
import os, sys, importlib.util
import numpy as np
import pandas as pd
from itertools import product
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("tav", os.path.join(HERE, "train_agent_validate_live.py"))
tav = importlib.util.module_from_spec(spec); spec.loader.exec_module(tav)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

TD = ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db",
      "data/trading_data_08220.db","data/trading_data.db","data/trading_data_live.db"]

def configs():
    g = []
    for C in [0.01,0.1,0.5,1,5]:
        for pen,sol in [("l2","lbfgs"),("l1","liblinear")]:
            g.append(("LogReg", dict(C=C,penalty=pen,solver=sol,max_iter=2000)))
    for ne in [200,400]:
        for md in [4,6,8,10]:
            for leaf in [20,50,100]:
                g.append(("RF", dict(n_estimators=ne,max_depth=md,min_samples_leaf=leaf,n_jobs=-1,random_state=42)))
    for md in [4,6,8]:
        for lr in [0.02,0.04,0.08]:
            for l2 in [0.0,1.0]:
                g.append(("HistGB", dict(max_depth=md,learning_rate=lr,l2_regularization=l2,
                                          max_iter=400,min_samples_leaf=20,early_stopping=True,random_state=42)))
    return g

def make(kind,p):
    return {"LogReg":LogisticRegression,"RF":RandomForestClassifier,"HistGB":HistGradientBoostingClassifier}[kind](**p)

def main():
    df, feats = tav.prep(TD)
    df = df.drop_duplicates(subset=["asset","timestamp"], keep="first").sort_values("timestamp").reset_index(drop=True)
    n=len(df); i1,i2=int(n*0.6),int(n*0.8)
    tr,te,va = df.iloc[:i1],df.iloc[i1:i2],df.iloc[i2:]
    sc=StandardScaler().fit(tr[feats].values)
    Xtr,ytr=sc.transform(tr[feats].values),tr["y"].astype(int).values
    Xte,yte=sc.transform(te[feats].values),te["y"].astype(int).values
    Xva,yva=sc.transform(va[feats].values),va["y"].astype(int).values
    print(f"# Grid search on REAL data — select by TEST, report VALIDATE")
    print(f"train {len(tr)} | test {len(te)} | validate {len(va)} | {len(feats)} feats\n")
    res=[]
    for kind,p in configs():
        m=make(kind,p).fit(Xtr,ytr)
        at=roc_auc_score(yte,m.predict_proba(Xte)[:,1]); av=roc_auc_score(yva,m.predict_proba(Xva)[:,1])
        res.append((kind,p,at,av))
    res.sort(key=lambda r:-r[2])
    print("## Top 12 configs by TEST AUC")
    print("| kind | params | TEST AUC | VALIDATE AUC |")
    print("|---|---|---|---|")
    for kind,p,at,av in res[:12]:
        ps=",".join(f"{k}={v}" for k,v in p.items() if k not in ("n_jobs","random_state","max_iter","solver","early_stopping"))
        print(f"| {kind} | {ps} | {at:.3f} | {av:.3f} |")
    best=res[0]
    bv=max(res,key=lambda r:r[3])
    print(f"\nbest-by-TEST: {best[0]} TEST {best[2]:.3f} -> VALIDATE {best[3]:.3f}")
    print(f"(for reference only) best-possible VALIDATE in grid: {bv[0]} VALIDATE {bv[3]:.3f} (TEST {bv[2]:.3f})")
    print("\n(Honest metric = VALIDATE of the best-by-TEST config. If it stays ~0.50, tuning "
          "cannot manufacture an edge that isn't in the real data.)")

if __name__=="__main__":
    main()
