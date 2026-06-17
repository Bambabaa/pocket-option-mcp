#!/usr/bin/env python3
"""
confluence_directional.py — directional next-bar classifier per the user's spec.

Pipeline:
  1. load agent_v1 (source), sort ascending by time
  3. per-row candle / BB / Stoch / STC / CCI features
  4. confluence features: overbought_stack, bearish_reversal, momentum_fade, trend_continuation
  5. target = 1 if next candle closes HIGHER than current, else 0
  6. drop lookback NaNs
  7. time-ordered split train / val / test (earlier / later / most-recent)
  9. train logreg + decision tree + random forest
 10. validate (accuracy, AUC, F1) + overfit gap (train AUC - val AUC)
 11. if acceptable -> retrain on train+val, evaluate on test
 12-14. predict the latest row -> class, probability, signal bias, top features,
        confluence summary, invalidation condition

Honest note: next-5m-bar direction on real FX is near 50/50 (prior studies AUC ~0.5).
This builds the full pipeline + live-inference block; read AUC/accuracy on the TEST split,
not val, and watch the train-val overfit gap.

Usage: python confluence_directional.py [--db agent/data/agent_v1.db]
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, f1_score, accuracy_score

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)

FEATURES = [
    "body","rej_wick","stretch",
    "bbpos","close_mid","tag_rej","bb_width","bb_expand",
    "k_lvl","d_lvl","kd","kd_cross","k_slope","d_slope",
    "stc_lvl","stc_slope","stc_cross",
    "cci","cci_zone","cci_vel",
    "overbought_stack","bearish_reversal","momentum_fade","trend_continuation",
]

def engineer(db):
    d = po_data.load(R(db)).sort_values(["asset","timestamp"])
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        o,h,l,c = (g[x].astype(float) for x in ("open","high","low","close"))
        atr = g["atr_14"].replace(0, np.nan)
        bbu,bbl,bbm = g["bb_upper"],g["bb_lower"],g["bb_middle"]
        k,dd = g["stoch_k"].astype(float), g["stoch_d"].astype(float)
        stc,stcsig = g["stc_value"].astype(float), g["stc_signal"].astype(float)
        cci = g["cci_20"].astype(float)
        pdi,mdi = g["adx_plus_di"].astype(float), g["adx_minus_di"].astype(float)

        f = pd.DataFrame(index=g.index)
        f["asset"]=g["asset"].values; f["timestamp"]=g["timestamp"].values
        # 3.1 candle
        f["body"]     = (c-o)/atr
        f["rej_wick"] = ((h-np.maximum(o,c)) - (np.minimum(o,c)-l))/atr   # +upper rejection
        f["stretch"]  = (c-g["sma_50"])/atr
        # 3.2 bollinger
        f["bbpos"]    = ((c-bbl)/(bbu-bbl)).replace([np.inf,-np.inf],np.nan)
        f["close_mid"]= (c-bbm)/atr
        f["tag_rej"]  = np.where((h>=bbu)&(c<bbu),-1.0, np.where((l<=bbl)&(c>bbl),1.0,0.0))
        f["bb_width"] = g["bb_width_bps"].astype(float)
        f["bb_expand"]= (g["bb_width_bps"]>g["bb_width_bps"].shift(1)).astype(float)
        # 3.3 stochastic
        f["k_lvl"]=k; f["d_lvl"]=dd; f["kd"]=k-dd
        kd=k-dd; f["kd_cross"]=np.where((kd>0)&(kd.shift(1)<=0),1.0, np.where((kd<0)&(kd.shift(1)>=0),-1.0,0.0))
        f["k_slope"]=k-k.shift(1); f["d_slope"]=dd-dd.shift(1)
        # 3.4 stc
        f["stc_lvl"]=stc; f["stc_slope"]=stc-stc.shift(1)
        sc=stc-stcsig; f["stc_cross"]=np.where((sc>0)&(sc.shift(1)<=0),1.0, np.where((sc<0)&(sc.shift(1)>=0),-1.0,0.0))
        # 3.5 cci
        f["cci"]=cci; f["cci_zone"]=np.where(cci>100,1.0,np.where(cci<-100,-1.0,0.0)); f["cci_vel"]=(cci-cci.shift(2))/2
        # 4 confluence
        f["overbought_stack"] = ((k>80).astype(int)+(dd>80).astype(int)+(stc>75).astype(int)
                                 +(cci>100).astype(int)+(c>bbu).astype(int)).astype(float)
        f["bearish_reversal"] = (((f["overbought_stack"]>=3) & (f["k_slope"]<0) & (f["cci_vel"]<0))).astype(float)
        f["momentum_fade"]    = ((f["k_slope"]<0).astype(int)+(f["stc_slope"]<0).astype(int)+(f["cci_vel"]<0).astype(int)).astype(float)
        f["trend_continuation"]=((g["ema_12"]>g["ema_26"]).astype(int)+(g["sma_10"]>g["sma_50"]).astype(int)
                                 +(pdi>mdi).astype(int)+(c>o).astype(int)).astype(float)
        # 5 target: next candle closes higher
        f["target"]=(c.shift(-1)>c).astype(float)
        f.loc[c.shift(-1).isna(),"target"]=np.nan
        rows.append(f)
    out=pd.concat(rows)
    return out.dropna(subset=FEATURES+["target"]).reset_index(drop=True), FEATURES

def evalset(model, X, y, scaler=None):
    Xt = scaler.transform(X) if scaler is not None else X
    p = model.predict_proba(Xt)[:,1]; pred=(p>=0.5).astype(int)
    return dict(acc=accuracy_score(y,pred), auc=roc_auc_score(y,p) if len(set(y))>1 else float("nan"),
                f1=f1_score(y,pred,zero_division=0))

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--db",default="agent/data/agent_v1.db")
    a=ap.parse_args()
    df,feats=engineer(a.db)
    df=df.sort_values("timestamp").reset_index(drop=True)            # 2 + global time order
    n=len(df); i1,i2=int(n*0.6),int(n*0.8)                           # 7 split 60/20/20
    tr,va,te=df.iloc[:i1],df.iloc[i1:i2],df.iloc[i2:]
    Xtr,ytr=tr[feats].values,tr["target"].astype(int).values
    Xva,yva=va[feats].values,va["target"].astype(int).values
    Xte,yte=te[feats].values,te["target"].astype(int).values
    sc=StandardScaler().fit(Xtr)                                     # 8 scale (logreg only)

    print(f"# Directional next-bar model — agent_v1  (target: next candle closes higher)")
    print(f"rows {n} | train {len(tr)} val {len(va)} test {len(te)} | base up-rate {df['target'].mean()*100:.1f}%\n")

    models={
        "LogReg":      (LogisticRegression(C=1.0,class_weight="balanced",max_iter=1000), True),
        "DecisionTree":(DecisionTreeClassifier(max_depth=4,min_samples_leaf=200,class_weight="balanced",random_state=42), False),
        "RandomForest":(RandomForestClassifier(n_estimators=300,max_depth=6,min_samples_leaf=100,
                                               class_weight="balanced",random_state=42,n_jobs=-1), False),
    }
    print("| model | train AUC | val AUC | overfit gap | val acc | val F1 |")
    print("|---|---|---|---|---|---|")
    fitted={}
    for name,(m,needs_scale) in models.items():
        s = sc if needs_scale else None
        m.fit(sc.transform(Xtr) if needs_scale else Xtr, ytr)
        tr_m=evalset(m,Xtr,ytr,s); va_m=evalset(m,Xva,yva,s)
        gap=tr_m["auc"]-va_m["auc"]
        fitted[name]=(m,needs_scale,va_m,gap)
        print(f"| {name} | {tr_m['auc']:.3f} | {va_m['auc']:.3f} | {gap:+.3f} | {va_m['acc']*100:.1f}% | {va_m['f1']:.3f} |")

    # 11 pick best by val AUC with small overfit gap, retrain on train+val, eval on test
    best=max(fitted, key=lambda k: fitted[k][2]["auc"]-abs(fitted[k][3]))
    m,needs_scale,_,_=fitted[best]
    Xtv=np.vstack([Xtr,Xva]); ytv=np.concatenate([ytr,yva])
    sc2=StandardScaler().fit(Xtv)
    m.fit(sc2.transform(Xtv) if needs_scale else Xtv, ytv)
    te_m=evalset(m,Xte,yte, sc2 if needs_scale else None)
    print(f"\nBest model: {best} -> retrained on train+val, TEST: "
          f"acc {te_m['acc']*100:.1f}% | AUC {te_m['auc']:.3f} | F1 {te_m['f1']:.3f}  "
          f"(test base up-rate {yte.mean()*100:.1f}%)")

    # 12-14 predict the latest row + interpretation
    last=df.iloc[[-1]]; xl=last[feats].values
    p_up=float(m.predict_proba(sc2.transform(xl) if needs_scale else xl)[0,1])
    cls=int(p_up>=0.5)
    bias = "bullish" if p_up>=0.58 else ("bearish" if p_up<=0.42 else "neutral")
    # top contributing features (logreg: |z*coef|; tree/forest: importance*|z|)
    z=(xl[0]-sc2.mean_)/sc2.scale_
    if best=="LogReg": contrib=np.abs(z*m.coef_[0])
    else: contrib=np.abs(z)*m.feature_importances_
    top=[feats[i] for i in np.argsort(-contrib)[:5]]
    inval = ("close back below band-mid / oversold loses (bullish thesis dies on a lower low)"
             if bias=="bullish" else
             "reclaim of upper band / fresh higher high invalidates (bearish thesis dies)"
             if bias=="bearish" else "no setup — wait for confluence")
    L=last.iloc[0]
    print("\n## Latest-row prediction")
    print(f"- timestamp: {pd.to_datetime(L['timestamp'],unit='s')}  ({L['asset']})")
    print(f"- predicted class: {cls} ({'UP' if cls else 'DOWN'})")
    print(f"- probability(up): {p_up:.3f}")
    print(f"- signal_bias: {bias}")
    print(f"- top contributing features: {', '.join(top)}")
    print(f"- confluence summary: OB_stack={L['overbought_stack']:.0f} bear_rev={L['bearish_reversal']:.0f} "
          f"mom_fade={L['momentum_fade']:.0f} trend_cont={L['trend_continuation']:.0f}")
    print(f"- invalidation: {inval}")
    print("\n(Read AUC on TEST, not val. AUC~0.50 = no directional edge; the pipeline+inference are "
          "correct regardless. Build is per spec; honesty layer per the project's edge methodology.)")

if __name__=="__main__":
    main()
