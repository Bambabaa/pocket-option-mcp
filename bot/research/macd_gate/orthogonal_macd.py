"""
================================================================================
 ORTHOGONAL FEATURE PIPELINE — MACD Divergence & Kinetic Decay
================================================================================
 Tests whether structural MACD + momentum-deceleration features break the
 0.636 AUC ceiling of the original 4-feature oscillator stack, on the standard
 3-bar reversal target. Per-asset grouping throughout (no cross-asset leakage).
 Purged TimeSeriesSplit (5 folds) + 5-candle embargo at each validation start.
================================================================================
"""
import os, json, math, warnings
os.environ.setdefault("OMP_NUM_THREADS","1"); warnings.filterwarnings("ignore")
import numpy as np, pandas as pd, sqlite3
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score

FEATURES = ["Delta_Hist","Div_MACD","Prox_MACD","K_Decay","V_Exh","Z_ROC"]
EXPIRY, LOOKBACK = 3, 3
THRESHOLDS = [0.60,0.65,0.70,0.75,0.80,0.85]

# Portable paths (was hardcoded to /home/claude). Resolve relative to this file.
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
AGENT_DB = os.path.join(REPO, "data", "agent.db")
OUT = lambda f: os.path.join(HERE, f)

def wilson(k,n,z=1.96):
    if n==0: return (float("nan"),)*2
    p=k/n; d=1+z*z/n; c=(p+z*z/(2*n))/d
    h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (c-h,c+h)
def be_payout(wr): return (1-wr)/wr if wr and wr>0 else float("inf")

# ---- STEP 1+2: base indicators + 6 kinetic features, per asset ----
def engineer(g):
    d=g.sort_values("timestamp").reset_index(drop=True).copy()
    c,h,l=d.close,d.high,d.low
    ema12=c.ewm(span=12,adjust=False).mean(); ema26=c.ewm(span=26,adjust=False).mean()
    macd=ema12-ema26
    macd_sig=macd.ewm(span=9,adjust=False).mean()
    hist=macd-macd_sig
    # ATR14 (Wilder)
    pc=c.shift(1)
    tr=pd.concat([(h-l),(h-pc).abs(),(l-pc).abs()],axis=1).max(axis=1)
    atr14=tr.ewm(alpha=1/14,adjust=False).mean()
    roc3=(c-c.shift(3))/c.shift(3)*100
    # 6 features
    d["Delta_Hist"]=hist-hist.shift(1)
    d["Div_MACD"]=(c-c.shift(3))-(hist-hist.shift(3))
    d["Prox_MACD"]=hist/hist.rolling(20).std()
    d["K_Decay"]=roc3.abs()-roc3.abs().shift(1)
    d["V_Exh"]=(c-c.shift(3))/atr14
    roc_mean=roc3.rolling(20).mean(); roc_std=roc3.rolling(20).std()
    d["Z_ROC"]=(roc3-roc_mean)/roc_std
    # STEP 3: target
    recent=c-c.shift(LOOKBACK); forward=c.shift(-EXPIRY)-c
    d["Target_Reversal"]=((np.sign(forward)!=np.sign(recent))&forward.notna()&recent.notna()).astype(float)
    d.loc[forward.isna()|recent.isna(),"Target_Reversal"]=np.nan
    return d

# ---- STEP 4: purged splits with embargo ----
def purged_indices(n, n_splits=5, embargo=5):
    tscv=TimeSeriesSplit(n_splits=n_splits)
    idx=np.arange(n)
    for tr,te in tscv.split(idx):
        te=te[embargo:]            # drop first `embargo` rows of each validation fold
        if len(te): yield tr,te

def sweep(proba, y):
    rows=[]; total=len(y)
    for thr in THRESHOLDS:
        g=proba>=thr; n=int(g.sum())
        if n>0:
            wr=float(y[g].mean())
            rows.append((thr,n,n/total,wr,be_payout(wr)))
        else:
            rows.append((thr,0,0.0,None,None))
    return rows

def md_table(rows):
    out=["| Threshold | Approved (n) | Capture Rate | Gated Win Rate | Break-Even Payout |",
         "|---|---|---|---|---|"]
    for thr,n,cap,wr,be in rows:
        if wr is None: out.append(f"| {thr:.2f} | 0 | 0.0% | — | — |")
        else: out.append(f"| {thr:.2f} | {n} | {cap*100:.1f}% | {wr*100:.1f}% | {be*100:.0f}% |")
    return "\n".join(out)

def main():
    con=sqlite3.connect(f"file:{AGENT_DB}?mode=ro", uri=True)   # read-only: no SQLite write/corruption
    df=pd.read_sql("SELECT asset,timestamp,open,high,low,close FROM candles ORDER BY asset,timestamp",con); con.close()
    print(f"Loaded {len(df):,} bars, {df.asset.nunique()} assets")
    feat=pd.concat([engineer(g) for _,g in df.groupby("asset")],ignore_index=True)
    feat=feat.dropna(subset=FEATURES+["Target_Reversal"]).reset_index(drop=True)
    feat["Target_Reversal"]=feat.Target_Reversal.astype(int)
    n=len(feat); X=feat[FEATURES].values; y=feat.Target_Reversal.values
    print(f"Usable rows after NaN-drop: {n:,}  | reversal base rate {y.mean():.4f}\n")

    models={"LogReg_L2":("linear",LogisticRegression(penalty="l2",C=0.5,max_iter=1000,class_weight="balanced")),
            "GB_Stumps":("tree",GradientBoostingClassifier(n_estimators=100,max_depth=1,random_state=42))}
    results={}
    for name,(kind,_) in models.items():
        oof=np.full(n,np.nan)
        for tr,te in purged_indices(n):
            mk = (LogisticRegression(penalty="l2",C=0.5,max_iter=1000,class_weight="balanced")
                  if name=="LogReg_L2" else
                  GradientBoostingClassifier(n_estimators=100,max_depth=1,random_state=42))
            if kind=="linear":
                sc=StandardScaler().fit(X[tr]); mk.fit(sc.transform(X[tr]),y[tr])
                oof[te]=mk.predict_proba(sc.transform(X[te]))[:,1]
            else:
                # GB doesn't need scaling, but spec says scale; scaling is harmless for trees
                sc=StandardScaler().fit(X[tr]); mk.fit(sc.transform(X[tr]),y[tr])
                oof[te]=mk.predict_proba(sc.transform(X[te]))[:,1]
        mask=~np.isnan(oof); auc=roc_auc_score(y[mask],oof[mask])
        rows=sweep(oof[mask],y[mask])
        results[name]={"auc":auc,"sweep":rows,"oof_n":int(mask.sum())}
        print(f"=== {name}  OOS AUC = {auc:.4f}  (n={mask.sum():,}) ===")
        print(md_table(rows)); print()
    # ceiling comparison
    print("="*60)
    print(f"Previous oscillator-stack ceiling: AUC 0.636")
    for name in results:
        a=results[name]["auc"]; delta=a-0.636
        verdict="BREAKS ceiling" if delta>0.005 else ("matches" if abs(delta)<=0.005 else "below")
        print(f"  {name}: AUC {a:.4f}  (Δ {delta:+.4f} → {verdict})")
    json.dump(results,open(OUT("orthogonal_macd_results.json"),"w"),indent=2,default=str)
    feat[["asset","timestamp"]+FEATURES+["Target_Reversal"]].to_pickle(OUT("macd_kinetic_feat.pkl"))
    print("\nSaved orthogonal_macd_results.json + macd_kinetic_feat.pkl")
    return results, feat

if __name__=="__main__":
    main()
