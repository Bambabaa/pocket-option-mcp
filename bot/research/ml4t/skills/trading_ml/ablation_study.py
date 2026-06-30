"""
Feature Importance Ablation Study — LightGBM
=============================================
Strategy:
  Round 0  → baseline: all features, full SHAP ranking
  Round N  → drop features in bottom 25th percentile of SHAP importance
             from the PREVIOUS round, retrain, measure AUC + timing
  Stop when AUC < 0.95 * baseline_AUC  OR  fewer than 5 features remain.

Outputs (all to /home/user/workspace/ml_output/ablation/):
  ablation_results.json   — per-round metrics
  ablation_report.png     — visual summary
"""

import os, sqlite3, warnings, json, time
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score, f1_score
import shap

warnings.filterwarnings("ignore")

DB_PATH    = "/home/user/workspace/uploaded_attachments/9ea4a9b4720b4a6782c979e8bd9d0f2c/agent_v1.db"
OUT_DIR    = "/home/user/workspace/ml_output/ablation"
HORIZON    = 3
TRAIN_SPLIT= 0.80
AUC_RETAIN = 0.95      # must keep >= 95 % of baseline AUC
MIN_FEATS  = 5
SHAP_SAMPLE= 800       # rows for SHAP per round
INFER_REPS = 200       # repetitions for latency benchmark

os.makedirs(OUT_DIR, exist_ok=True)

# ── 1. DATA ───────────────────────────────────────────────────
print("Loading data...")
conn = sqlite3.connect(DB_PATH)
candles    = pd.read_sql("SELECT * FROM candles",    conn)
indicators = pd.read_sql("SELECT * FROM indicators", conn)
conn.close()
candles.columns    = [c.lower() for c in candles.columns]
indicators.columns = [c.lower() for c in indicators.columns]
df = candles.merge(indicators, on=["asset","timestamp"], how="inner")
df = df.sort_values(["asset","timestamp"]).reset_index(drop=True)

# ── 2. FEATURE ENGINEERING (same as pipeline) ─────────────────
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
    df["macd_cross"]    = (df["macd_line"] > df["macd_signal"]).astype(int)
    df["macd_crossover"]= (df["macd_cross"] -
                           df.groupby("asset")["macd_cross"].shift(1)).fillna(0)

if "stoch_k" in df.columns and "stoch_d" in df.columns:
    df["stoch_cross"] = (df["stoch_k"] > df["stoch_d"]).astype(int)

if all(c in df.columns for c in ["bb_upper","bb_lower","close"]):
    df["bb_pos"] = (df["close"]-df["bb_lower"]) / (df["bb_upper"]-df["bb_lower"]+1e-9)

if all(c in df.columns for c in ["keltner_upper","keltner_lower","close"]):
    df["kc_pos"] = (df["close"]-df["keltner_lower"]) / (df["keltner_upper"]-df["keltner_lower"]+1e-9)

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

# Feature pool
EXCLUDE = {"timestamp","asset","open","high","low","close","volume",
           "future_close","future_ret","y","macd_above_prev"}
ALL_FEATURES = [c for c in df.columns
                if c not in EXCLUDE
                and df[c].dtype in [np.float64,np.float32,
                                    np.int64,np.int32,float,int]]

df_ml = df.dropna(subset=ALL_FEATURES+["y"]).copy().reset_index(drop=True)
print(f"ML rows: {len(df_ml):,}  |  full feature pool: {len(ALL_FEATURES)}")

split = int(len(df_ml)*TRAIN_SPLIT)
ytr   = df_ml["y"].iloc[:split].values
yte   = df_ml["y"].iloc[split:].values

# ── 3. LightGBM factory ───────────────────────────────────────
def make_lgb():
    return LGBMClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.7, min_child_samples=20,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42,
        verbose=-1, n_jobs=-1)

def train_and_eval(feat_cols):
    """Train LightGBM on feat_cols, return (model, scaler, auc, acc, f1,
       train_sec, infer_ms_per_row, shap_importance_series)."""
    Xtr = df_ml[feat_cols].iloc[:split].values
    Xte = df_ml[feat_cols].iloc[split:].values

    sc = StandardScaler()
    Xtr_s = sc.fit_transform(Xtr)
    Xte_s = sc.transform(Xte)

    model = make_lgb()
    t0 = time.perf_counter()
    model.fit(Xtr_s, ytr)
    train_sec = time.perf_counter() - t0

    prob = model.predict_proba(Xte_s)[:,1]
    pred = model.predict(Xte_s)
    auc  = roc_auc_score(yte, prob)
    acc  = accuracy_score(yte, pred)
    f1   = f1_score(yte, pred, average="weighted")

    # Inference latency: single row repeated INFER_REPS times
    single = Xte_s[:1]
    t1 = time.perf_counter()
    for _ in range(INFER_REPS):
        model.predict_proba(single)
    infer_ms = (time.perf_counter()-t1) / INFER_REPS * 1000  # ms per call

    # SHAP on sample
    idx = np.random.RandomState(42).choice(len(Xte_s),
                                            min(SHAP_SAMPLE, len(Xte_s)),
                                            replace=False)
    explainer = shap.TreeExplainer(model)
    sv = explainer.shap_values(Xte_s[idx])
    if isinstance(sv, list): sv = sv[1]
    mean_abs = np.abs(sv).mean(axis=0)
    shap_imp = pd.Series(mean_abs, index=feat_cols).sort_values(ascending=False)

    return model, sc, auc, acc, f1, train_sec, infer_ms, shap_imp

# ── 4. ABLATION LOOP ─────────────────────────────────────────
print("\n" + "="*65)
print(" ABLATION STUDY — iterative bottom-25th-percentile drop")
print("="*65)

current_features = list(ALL_FEATURES)
rounds = []
baseline_auc = None
round_num = 0

while True:
    n_feat = len(current_features)
    print(f"\n[Round {round_num}]  features={n_feat}")

    model, sc, auc, acc, f1, train_sec, infer_ms, shap_imp = \
        train_and_eval(current_features)

    if round_num == 0:
        baseline_auc = auc
        print(f"  Baseline AUC = {auc:.5f}  (target floor: {baseline_auc*AUC_RETAIN:.5f})")

    auc_pct = auc / baseline_auc * 100
    print(f"  AUC={auc:.5f} ({auc_pct:.2f}% of baseline)  "
          f"Acc={acc:.4f}  F1={f1:.4f}  "
          f"Train={train_sec:.2f}s  Infer={infer_ms:.3f}ms/call")

    rounds.append({
        "round": round_num,
        "n_features": n_feat,
        "auc": round(auc, 6),
        "auc_pct_baseline": round(auc_pct, 3),
        "acc": round(acc, 6),
        "f1":  round(f1,  6),
        "train_sec": round(train_sec, 3),
        "infer_ms":  round(infer_ms,  4),
        "features": list(current_features),
        "shap_top10": shap_imp.head(10).round(6).to_dict(),
    })

    # Termination check
    if auc < baseline_auc * AUC_RETAIN:
        print(f"  *** AUC dropped below 95% floor — stopping. "
              f"Best set was Round {round_num-1}. ***")
        break
    if n_feat <= MIN_FEATS:
        print(f"  *** Reached minimum feature count ({MIN_FEATS}) — stopping. ***")
        break

    # Drop bottom 25th percentile by SHAP
    threshold = np.percentile(shap_imp.values, 25)
    to_drop   = shap_imp[shap_imp <= threshold].index.tolist()
    # Never drop all — guarantee at least MIN_FEATS remain
    keep_at_least = max(MIN_FEATS, n_feat - len(to_drop))
    if n_feat - len(to_drop) < MIN_FEATS:
        # trim to_drop so we keep MIN_FEATS
        to_drop = shap_imp.tail(n_feat - MIN_FEATS).index.tolist()

    print(f"  Dropping {len(to_drop)} features "
          f"(SHAP <= {threshold:.5f}): {to_drop[:8]}"
          f"{'...' if len(to_drop)>8 else ''}")

    current_features = [f for f in current_features if f not in to_drop]
    round_num += 1

# ── 5. FIND BEST COMPACT SET ─────────────────────────────────
# Last round that still met the 95% threshold
passing = [r for r in rounds if r["auc_pct_baseline"] >= 95.0]
best    = passing[-1] if passing else rounds[0]

print("\n" + "="*65)
print(f" OPTIMAL COMPACT SET: Round {best['round']}")
print(f"  Features : {best['n_features']}")
print(f"  AUC      : {best['auc']:.5f} ({best['auc_pct_baseline']:.2f}% of baseline)")
print(f"  Train    : {best['train_sec']:.2f}s")
print(f"  Infer    : {best['infer_ms']:.3f} ms/call")
print(f"  Features : {best['features']}")
print("="*65)

# Speedups vs baseline
baseline_train = rounds[0]["train_sec"]
baseline_infer = rounds[0]["infer_ms"]
best["train_speedup"] = round(baseline_train / best["train_sec"], 2)
best["infer_speedup"]  = round(baseline_infer / best["infer_ms"],  2)

# Save JSON
summary = {
    "baseline_auc": baseline_auc,
    "auc_floor":    round(baseline_auc * AUC_RETAIN, 6),
    "rounds":       rounds,
    "optimal_round": best,
}
with open(f"{OUT_DIR}/ablation_results.json","w") as f:
    json.dump(summary, f, indent=2, default=str)

print(f"\n[SAVED] {OUT_DIR}/ablation_results.json")
print("Run build_ablation_report.py next to generate the chart.")
