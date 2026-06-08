"""
================================================================================
 TRAIN + EXPORT — MACD Divergence & Kinetic Decay gate
================================================================================
 Fits the production models on the FULL population (full-data fit = deployed
 model), then exports exact parameters to macd_gate_params.json so the Node.js
 gate reproduces them bit-for-bit. Also dumps a fixtures file (feature vectors
 + model probabilities) so the JS test can verify scoring parity to 1e-9.

 Honest OOS AUC (from purged CV, orthogonal_macd.py): LogReg 0.513, GB 0.598
 — recorded in the params so the deployment can't pretend these beat 0.636.
================================================================================
"""
import os, json, math, warnings
os.environ.setdefault("OMP_NUM_THREADS","1"); warnings.filterwarnings("ignore")
import numpy as np, pandas as pd, sqlite3
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from scipy.special import expit

FEATURES = ["Delta_Hist","Div_MACD","Prox_MACD","K_Decay","V_Exh","Z_ROC"]
EXPIRY, LOOKBACK = 3, 3
OOS_AUC = {"logreg": 0.5133, "gb_stumps": 0.5321}   # from purged CV (orthogonal_macd.py, re-run 2026-06-07)
GATE = 0.65   # default research gate (0.85 produced ~0 fires for these features)

# Portable paths (was hardcoded to /home/claude). Resolve relative to this file.
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
AGENT_DB = os.path.join(REPO, "data", "agent.db")
OUT = lambda f: os.path.join(HERE, f)

def engineer(g):
    d=g.sort_values("timestamp").reset_index(drop=True).copy()
    c,h,l=d.close,d.high,d.low
    ema12=c.ewm(span=12,adjust=False).mean(); ema26=c.ewm(span=26,adjust=False).mean()
    macd=ema12-ema26; hist=macd-macd.ewm(span=9,adjust=False).mean()
    pc=c.shift(1); tr=pd.concat([(h-l),(h-pc).abs(),(l-pc).abs()],axis=1).max(axis=1)
    atr14=tr.ewm(alpha=1/14,adjust=False).mean()
    roc3=(c-c.shift(3))/c.shift(3)*100
    d["Delta_Hist"]=hist-hist.shift(1)
    d["Div_MACD"]=(c-c.shift(3))-(hist-hist.shift(3))
    d["Prox_MACD"]=hist/hist.rolling(20).std()
    d["K_Decay"]=roc3.abs()-roc3.abs().shift(1)
    d["V_Exh"]=(c-c.shift(3))/atr14
    d["Z_ROC"]=(roc3-roc3.rolling(20).mean())/roc3.rolling(20).std()
    recent=c-c.shift(LOOKBACK); forward=c.shift(-EXPIRY)-c
    d["Target_Reversal"]=((np.sign(forward)!=np.sign(recent))&forward.notna()&recent.notna()).astype(float)
    d.loc[forward.isna()|recent.isna(),"Target_Reversal"]=np.nan
    return d

def main():
    con=sqlite3.connect(f"file:{AGENT_DB}?mode=ro", uri=True)   # read-only: no SQLite write/corruption
    df=pd.read_sql("SELECT asset,timestamp,open,high,low,close FROM candles ORDER BY asset,timestamp",con); con.close()
    feat=pd.concat([engineer(g) for _,g in df.groupby("asset")],ignore_index=True)
    feat=feat.dropna(subset=FEATURES+["Target_Reversal"]).reset_index(drop=True)
    feat["Target_Reversal"]=feat.Target_Reversal.astype(int)
    X=feat[FEATURES].values; y=feat.Target_Reversal.values
    print(f"Training on {len(X):,} rows, base rate {y.mean():.4f}")

    # full-data fit (deployed model)
    scaler=StandardScaler().fit(X); Xs=scaler.transform(X)
    logreg=LogisticRegression(penalty="l2",C=0.5,max_iter=1000,class_weight="balanced").fit(Xs,y)
    gb=GradientBoostingClassifier(n_estimators=100,max_depth=1,random_state=42).fit(Xs,y)

    # ---- extract GB stumps to plain dicts ----
    lr_rate=gb.learning_rate
    stumps=[]
    for est in gb.estimators_[:,0]:
        t=est.tree_
        stumps.append({"feature":int(t.feature[0]),"threshold":float(t.threshold[0]),
                       "left":float(t.value[1][0][0]),"right":float(t.value[2][0][0])})
    # derive constant init raw score: decision_function = init + lr*sum(stumps)
    def gb_raw_reconstruct(xs_row):
        s=0.0
        for st in stumps:
            s += st["left"] if xs_row[st["feature"]]<=st["threshold"] else st["right"]
        return lr_rate*s
    df_sk=gb.decision_function(Xs)              # sklearn raw
    recon0=np.array([gb_raw_reconstruct(r) for r in Xs[:200]])
    init_candidates = df_sk[:200]-recon0
    init_raw=float(np.median(init_candidates))
    assert np.allclose(init_candidates, init_raw, atol=1e-9), "GB init not constant!"
    # verify full reconstruction parity
    recon_all=init_raw+np.array([gb_raw_reconstruct(r) for r in Xs])
    assert np.allclose(recon_all, df_sk, atol=1e-9), "GB reconstruction mismatch!"
    proba_recon=expit(recon_all)
    assert np.allclose(proba_recon, gb.predict_proba(Xs)[:,1], atol=1e-9), "GB proba mismatch!"
    print(f"  GB stump reconstruction verified to 1e-9 ({len(stumps)} stumps, lr={lr_rate})")

    params={
        "model":"macd_kinetic_reversal_gate",
        "features":FEATURES,
        "horizon_bars":EXPIRY, "lookback_bars":LOOKBACK,
        "scaler":{"mean":scaler.mean_.tolist(),"scale":scaler.scale_.tolist()},
        "logreg":{"coef":logreg.coef_[0].tolist(),"intercept":float(logreg.intercept_[0])},
        "gb_stumps":{"init_raw":init_raw,"learning_rate":float(lr_rate),"stumps":stumps},
        "thresholds":{"gate":GATE},
        "oos_auc":OOS_AUC,
        "status":"RESEARCH_SHADOW",   # not validated for live; OOS AUC below 0.636 ceiling
        "note":"OOS AUC below oscillator-stack ceiling (0.636). Shadow/log only."
    }
    json.dump(params,open(OUT("macd_gate_params.json"),"w"),indent=2)

    # ---- fixtures for JS parity (real feature vectors + model probas) ----
    idx=np.linspace(0,len(X)-1,600).astype(int)
    fixtures=[]
    proba_lr=logreg.predict_proba(Xs)[:,1]; proba_gb=gb.predict_proba(Xs)[:,1]
    for i in idx:
        fixtures.append({"features":{f:float(feat.iloc[i][f]) for f in FEATURES},
                         "logreg":float(proba_lr[i]),"gb":float(proba_gb[i])})
    json.dump(fixtures,open(OUT("macd_gate_fixtures.json"),"w"))
    # also a feature-parity fixture: full per-asset OHLC for one asset + its computed features
    a="EURUSD"; one=df[df.asset==a].sort_values("timestamp").reset_index(drop=True)
    fe=engineer(one)
    feat_fix={"asset":a,
              "bars":one[["timestamp","open","high","low","close"]].to_dict("records"),
              "expected":fe.dropna(subset=FEATURES)[["timestamp"]+FEATURES].to_dict("records")}
    json.dump(feat_fix,open(OUT("macd_feature_fixtures.json"),"w"))
    print(f"  exported params + {len(fixtures)} score fixtures + feature fixtures ({a})")
    print("Saved macd_gate_params.json")

if __name__=="__main__":
    main()
