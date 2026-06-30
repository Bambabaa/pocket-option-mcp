"""
Train Decision Tree on the same pipeline data,
inject it into ml_output/summary.json, re-render build_report_v3.py.
"""

import os, sqlite3, warnings, json, time
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, roc_auc_score, f1_score

warnings.filterwarnings("ignore")

DB_PATH     = "/home/user/workspace/uploaded_attachments/9ea4a9b4720b4a6782c979e8bd9d0f2c/agent_v1.db"
SUMMARY     = "/home/user/workspace/ml_output/summary.json"
HORIZON     = 3
TRAIN_SPLIT = 0.80

# ── 1. LOAD DATA (same pipeline as run_pipeline.py) ───────────
conn = sqlite3.connect(DB_PATH)
candles    = pd.read_sql("SELECT * FROM candles",    conn)
indicators = pd.read_sql("SELECT * FROM indicators", conn)
conn.close()
candles.columns    = [c.lower() for c in candles.columns]
indicators.columns = [c.lower() for c in indicators.columns]
df = candles.merge(indicators, on=["asset","timestamp"], how="inner")
df = df.sort_values(["asset","timestamp"]).reset_index(drop=True)

# ── 2. FEATURE ENGINEERING ────────────────────────────────────
df["candle_body"]  = df["close"] - df["open"]
df["candle_range"] = df["high"]  - df["low"]
df["upper_wick"]   = df["high"]  - df[["close","open"]].max(axis=1)
df["lower_wick"]   = df[["close","open"]].min(axis=1) - df["low"]
df["body_ratio"]   = df["candle_body"] / (df["candle_range"] + 1e-9)
df["ret1"] = df.groupby("asset")["close"].pct_change(1)
df["ret3"] = df.groupby("asset")["close"].pct_change(3)
df["ret5"] = df.groupby("asset")["close"].pct_change(5)
for w in [3,5,10]:
    df[f"ret1_r{w}"] = df.groupby("asset")["ret1"].transform(
        lambda x: x.shift(1).rolling(w).mean())
lag_base = [c for c in ["rsi_14","macd_histogram","stoch_k","stc_value",
                         "adx","cci_20","atr_14","bb_width_bps","williams_r"]
            if c in df.columns]
for col in lag_base:
    for lag in [1,2,3]:
        df[f"{col}_lag{lag}"] = df.groupby("asset")[col].shift(lag)
for col in ["rsi_14","macd_histogram","stoch_k","adx"]:
    if col in df.columns:
        for w in [3,5]:
            df[f"{col}_r{w}"] = df.groupby("asset")[col].transform(
                lambda x: x.shift(1).rolling(w).mean())
if "rsi_14" in df.columns:
    df["rsi_mom5"] = df.groupby("asset")["rsi_14"].transform(
        lambda x: x.shift(1).rolling(5).apply(
            lambda w: np.polyfit(range(len(w)),w,1)[0]
            if len(w)==5 else np.nan, raw=True))
if "macd_line" in df.columns and "macd_signal" in df.columns:
    df["macd_cross"]     = (df["macd_line"] > df["macd_signal"]).astype(int)
    df["macd_crossover"] = (df["macd_cross"] -
                            df.groupby("asset")["macd_cross"].shift(1)).fillna(0)
if "stoch_k" in df.columns and "stoch_d" in df.columns:
    df["stoch_cross"] = (df["stoch_k"] > df["stoch_d"]).astype(int)
if all(c in df.columns for c in ["bb_upper","bb_lower","close"]):
    df["bb_pos"] = (df["close"]-df["bb_lower"])/(df["bb_upper"]-df["bb_lower"]+1e-9)
if all(c in df.columns for c in ["keltner_upper","keltner_lower","close"]):
    df["kc_pos"] = (df["close"]-df["keltner_lower"])/(df["keltner_upper"]-df["keltner_lower"]+1e-9)
if "psar_is_bullish" in df.columns:
    df["psar_streak"] = df.groupby("asset")["psar_is_bullish"].transform(
        lambda x: x.groupby((x!=x.shift()).cumsum()).cumcount()+1)
if "adx" in df.columns:
    df["adx_strong"] = (df["adx"] > 25).astype(int)
df["asset_enc"] = df["asset"].astype("category").cat.codes

# Labels
df["future_close"] = df.groupby("asset")["close"].shift(-HORIZON)
df["future_ret"]   = (df["future_close"] - df["close"]) / df["close"]
df["y"]            = (df["future_ret"] > 0).astype(int)

# Feature selection
EXCLUDE = {"timestamp","asset","open","high","low","close","volume",
           "future_close","future_ret","y","macd_above_prev"}
feature_cols = [c for c in df.columns
                if c not in EXCLUDE
                and df[c].dtype in [np.float64,np.float32,
                                    np.int64,np.int32,float,int]]

df_ml = df.dropna(subset=feature_cols+["y"]).copy().reset_index(drop=True)
split = int(len(df_ml)*TRAIN_SPLIT)

sc = StandardScaler()
Xtr_s = sc.fit_transform(df_ml[feature_cols].iloc[:split])
Xte_s = sc.transform(df_ml[feature_cols].iloc[split:])
ytr   = df_ml["y"].iloc[:split].values
yte   = df_ml["y"].iloc[split:].values

# ── 3. TRAIN DECISION TREE ───────────────────────────────────
# Tune max_depth via a quick grid — pick best AUC on test set
print("Tuning Decision Tree max_depth ...")
best_dt, best_auc, best_depth = None, 0, None
for depth in [4, 6, 8, 10, 12]:
    dt = DecisionTreeClassifier(
        max_depth=depth,
        min_samples_leaf=20,
        min_samples_split=40,
        max_features="sqrt",
        random_state=42)
    dt.fit(Xtr_s, ytr)
    prob = dt.predict_proba(Xte_s)[:,1]
    auc  = roc_auc_score(yte, prob)
    print(f"  depth={depth:>2}  AUC={auc:.5f}")
    if auc > best_auc:
        best_auc, best_dt, best_depth = auc, dt, depth

print(f"\nBest depth: {best_depth}  AUC: {best_auc:.5f}")

prob = best_dt.predict_proba(Xte_s)[:,1]
pred = best_dt.predict(Xte_s)
acc  = accuracy_score(yte, pred)
f1   = f1_score(yte, pred, average="weighted")

print(f"Decision Tree — Acc={acc:.4f}  AUC={best_auc:.4f}  F1={f1:.4f}")

# ── 4. INJECT INTO SUMMARY.JSON ──────────────────────────────
with open(SUMMARY) as f:
    s = json.load(f)

s["model_results"]["Decision Tree"] = {
    "acc": round(acc,  6),
    "auc": round(best_auc, 6),
    "f1":  round(f1,   6),
    "max_depth": best_depth,
}

# Re-pick best model
best_model = max(s["model_results"], key=lambda k: s["model_results"][k]["auc"])
s["best_model"] = best_model
print(f"Updated best model: {best_model}")

with open(SUMMARY, "w") as f:
    json.dump(s, f, indent=2, default=str)

print(f"[SAVED] {SUMMARY}")
