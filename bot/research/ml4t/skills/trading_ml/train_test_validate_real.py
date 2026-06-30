#!/usr/bin/env python3
"""
train_test_validate_real.py — REAL broker data only, no agent DBs anywhere.

Pools all 6 trading_data DBs, dedupes (asset,timestamp) across DBs, sorts by time, and
does a TIME-ORDERED 60/20/20 train/test/validate split. Same report pipeline
(run_pipeline feature engineering via name-resolver, LogReg/RF/HistGB, global scaler).

This is the fully honest experiment: develop AND validate entirely on the data the bot
actually trades. The VALIDATE column (latest 20% in time) is the headline.
"""
from __future__ import annotations
import os, sys, importlib.util
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("tav", os.path.join(HERE, "train_agent_validate_live.py"))
tav = importlib.util.module_from_spec(spec); spec.loader.exec_module(tav)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

TD = ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db",
      "data/trading_data_08220.db","data/trading_data.db","data/trading_data_live.db"]

def main():
    df, feats = tav.prep(TD)
    before = len(df)
    df = df.drop_duplicates(subset=["asset","timestamp"], keep="first")
    df = df.sort_values("timestamp").reset_index(drop=True)
    n = len(df); i1, i2 = int(n*0.6), int(n*0.8)
    tr, te, va = df.iloc[:i1], df.iloc[i1:i2], df.iloc[i2:]
    Xtr,ytr = tr[feats].values, tr["y"].astype(int).values
    Xte,yte = te[feats].values, te["y"].astype(int).values
    Xva,yva = va[feats].values, va["y"].astype(int).values
    sc = StandardScaler().fit(Xtr)
    print(f"# REAL data only — all trading_data DBs (deduped {before}->{n} rows, {len(feats)} feats)")
    print(f"time-ordered 60/20/20 | train {len(tr)} | test {len(te)} | validate {len(va)}")
    print(f"base up-rate: train {ytr.mean()*100:.0f}% test {yte.mean()*100:.0f}% validate {yva.mean()*100:.0f}%\n")
    print("| model | TEST AUC | TEST acc | VALIDATE AUC | VALIDATE acc |")
    print("|---|---|---|---|---|")
    for name,m in [("LogReg",LogisticRegression(max_iter=1000,C=1.0)),
                   ("RandomForest",RandomForestClassifier(n_estimators=300,max_depth=8,min_samples_leaf=20,n_jobs=-1,random_state=42)),
                   ("HistGradBoost",HistGradientBoostingClassifier(max_iter=400,max_depth=6,learning_rate=0.04,min_samples_leaf=20,l2_regularization=1.0,early_stopping=True,random_state=42))]:
        m.fit(sc.transform(Xtr),ytr)
        pt=m.predict_proba(sc.transform(Xte))[:,1]; pv=m.predict_proba(sc.transform(Xva))[:,1]
        print(f"| {name} | {roc_auc_score(yte,pt):.3f} | {accuracy_score(yte,(pt>=.5).astype(int))*100:.0f}% | "
              f"{roc_auc_score(yva,pv):.3f} | {accuracy_score(yva,(pv>=.5).astype(int))*100:.0f}% |")
    print("\n(All real broker data, no agent DBs. VALIDATE = latest 20% in time = the headline.)")

if __name__=="__main__":
    main()
