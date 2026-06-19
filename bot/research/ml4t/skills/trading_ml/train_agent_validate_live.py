#!/usr/bin/env python3
"""
train_agent_validate_live.py — proper train/test/validate protocol.

  TRAIN + TEST : agent DBs (agent_v1 + agent.db) — develop here, 80/20 time split
  VALIDATE     : data/trading_data_live.db — the REAL book, held out, never seen in dev

Uses run_pipeline.py's exact feature engineering behind a name-resolver so the identical
logical features build on the agent schema AND the trading_data canonical schema. Same
models (LogReg/RF/HistGB), same global StandardScaler as the report pipeline.

Reports agent-TEST AUC vs LIVE-VALIDATION AUC side by side. If the agent-developed model
holds on the live validation -> real edge. If it collapses -> agent-source artifact.
"""
from __future__ import annotations
import os, sys, sqlite3
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score, f1_score
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)
HOR = 3

def load(db):
    con = sqlite3.connect(f"file:{R(db)}?mode=ro&immutable=1", uri=True)
    c = pd.read_sql("SELECT * FROM candles", con); i = pd.read_sql("SELECT * FROM indicators", con); con.close()
    c.columns = [x.lower() for x in c.columns]; i.columns = [x.lower() for x in i.columns]
    return c.merge(i, on=["asset","timestamp"], how="inner", suffixes=("","_ind")).sort_values(["asset","timestamp"]).reset_index(drop=True)

def col(df, *names):
    for n in names:
        if n in df.columns: return df[n].astype(float)
    return pd.Series(np.nan, index=df.index)

RES = {"rsi_14":["rsi_14"],"macd_hist":["macd_histogram","macd_hist"],"macd_line":["macd_line","macd_macd"],
       "macd_signal":["macd_signal"],"stoch_k":["stoch_k"],"stoch_d":["stoch_d"],"stc_value":["stc_value"],
       "adx":["adx","adx_14"],"cci_20":["cci_20"],"atr_14":["atr_14"],"bb_width_bps":["bb_width_bps"],
       "williams_r":["williams_r","williams_14"],"plus_di":["plus_di","adx_plus_di"],
       "bb_upper":["bb_upper"],"bb_lower":["bb_lower"],
       "keltner_upper":["keltner_upper","kc_upper"],"keltner_lower":["keltner_lower","kc_lower"]}

def build(df):
    df = df.copy()
    df["candle_body"]=df["close"]-df["open"]; df["candle_range"]=df["high"]-df["low"]
    df["upper_wick"]=df["high"]-df[["close","open"]].max(axis=1); df["lower_wick"]=df[["close","open"]].min(axis=1)-df["low"]
    df["body_ratio"]=df["candle_body"]/(df["candle_range"]+1e-9)
    for n in (1,3,5): df[f"ret{n}"]=df.groupby("asset")["close"].pct_change(n)
    for w in (3,5,10): df[f"ret1_r{w}"]=df.groupby("asset")["ret1"].transform(lambda x:x.shift(1).rolling(w).mean())
    for k,v in RES.items(): df[k]=col(df,*v)
    for c_ in ["rsi_14","macd_hist","stoch_k","stc_value","adx","cci_20","atr_14","bb_width_bps","williams_r"]:
        for lg in (1,2,3): df[f"{c_}_lag{lg}"]=df.groupby("asset")[c_].shift(lg)
    for c_ in ["rsi_14","macd_hist","stoch_k","adx"]:
        for w in (3,5): df[f"{c_}_r{w}"]=df.groupby("asset")[c_].transform(lambda x:x.shift(1).rolling(w).mean())
    df["rsi_mom5"]=df.groupby("asset")["rsi_14"].transform(lambda x:x.shift(1).rolling(5).apply(lambda w:np.polyfit(range(len(w)),w,1)[0] if len(w)==5 else np.nan,raw=True))
    df["macd_cross"]=(df["macd_line"]>df["macd_signal"]).astype(float)
    df["macd_crossover"]=(df["macd_cross"]-df.groupby("asset")["macd_cross"].shift(1)).fillna(0)
    df["stoch_cross"]=(df["stoch_k"]>df["stoch_d"]).astype(float)
    df["bb_pos"]=(df["close"]-df["bb_lower"])/(df["bb_upper"]-df["bb_lower"]+1e-9)
    df["kc_pos"]=(df["close"]-df["keltner_lower"])/(df["keltner_upper"]-df["keltner_lower"]+1e-9)
    df["adx_strong"]=(df["adx"]>25).astype(float)
    df["future_close"]=df.groupby("asset")["close"].shift(-HOR)
    df["y"]=((df["future_close"]-df["close"])/df["close"]>0).astype(int)
    return df

FEATS=(["candle_body","candle_range","upper_wick","lower_wick","body_ratio","ret1","ret3","ret5","ret1_r3","ret1_r5","ret1_r10"]
       +list(RES.keys())
       +[f"{c}_lag{l}" for c in ["rsi_14","macd_hist","stoch_k","stc_value","adx","cci_20","atr_14","bb_width_bps","williams_r"] for l in (1,2,3)]
       +[f"{c}_r{w}" for c in ["rsi_14","macd_hist","stoch_k","adx"] for w in (3,5)]
       +["rsi_mom5","macd_cross","macd_crossover","stoch_cross","bb_pos","kc_pos","adx_strong"])

def prep(dbs):
    dbs=dbs if isinstance(dbs,list) else [dbs]
    df=pd.concat([build(load(d)) for d in dbs],ignore_index=True)
    feats=[f for f in FEATS if f in df.columns and df[f].notna().any()]
    return df.dropna(subset=feats+["y"]).reset_index(drop=True), feats

def main():
    agent,fa = prep(["agent/data/agent_v1.db","agent/data/agent.db"])
    live,fl  = prep("data/trading_data_live.db")
    feats=[f for f in fa if f in fl]
    agent=agent.sort_values("timestamp").reset_index(drop=True)
    s=int(len(agent)*0.8)
    Xtr,ytr=agent[feats].iloc[:s].values, agent["y"].iloc[:s].values
    Xte,yte=agent[feats].iloc[s:].values, agent["y"].iloc[s:].values
    Xva,yva=live[feats].values, live["y"].values
    sc=StandardScaler().fit(Xtr)
    print(f"# TRAIN+TEST on agent (n={len(agent)}, {len(feats)} feats) | VALIDATE on LIVE (n={len(live)})\n")
    print("| model | agent TEST AUC | agent TEST acc | LIVE VALID AUC | LIVE VALID acc |")
    print("|---|---|---|---|---|")
    for name,m in [("LogReg",LogisticRegression(max_iter=1000,C=1.0)),
                   ("RandomForest",RandomForestClassifier(n_estimators=300,max_depth=8,min_samples_leaf=20,n_jobs=-1,random_state=42)),
                   ("HistGradBoost",HistGradientBoostingClassifier(max_iter=400,max_depth=6,learning_rate=0.04,min_samples_leaf=20,l2_regularization=1.0,early_stopping=True,random_state=42))]:
        m.fit(sc.transform(Xtr),ytr)
        pt=m.predict_proba(sc.transform(Xte))[:,1]; pv=m.predict_proba(sc.transform(Xva))[:,1]
        print(f"| {name} | {roc_auc_score(yte,pt):.3f} | {accuracy_score(yte,(pt>=.5).astype(int))*100:.0f}% | "
              f"{roc_auc_score(yva,pv):.3f} | {accuracy_score(yva,(pv>=.5).astype(int))*100:.0f}% |")
    print("\n(agent TEST = same-source dev metric. LIVE VALID = real held-out book. "
          "Hold ~equal -> real edge. LIVE collapses -> agent-source artifact.)")

if __name__=="__main__":
    main()
