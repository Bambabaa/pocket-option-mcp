"""
Trading ML Pipeline — adapted to run on agent_v1.db (raw indicators only).
Signal-score features (_bull_score, _bear_score, etc.) are skipped gracefully.
"""

import os, sqlite3, warnings, json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, roc_auc_score, f1_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.calibration import CalibratedClassifierCV

warnings.filterwarnings("ignore")

DB_PATH       = "data/trading_data_live.db"
OUTPUT_DIR    = "bot/research/trading_ml/ml_output_real"
HORIZON       = 3
TRAIN_SPLIT   = 0.80
MIN_STREAK    = 2
CONF_THRESHOLD= 0.667
PROB_THRESHOLD= 0.55

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── 1. LOAD ───────────────────────────────────────────────────
conn = sqlite3.connect(DB_PATH)
candles    = pd.read_sql("SELECT * FROM candles",    conn)
indicators = pd.read_sql("SELECT * FROM indicators", conn)
conn.close()

candles.columns    = [c.lower() for c in candles.columns]
indicators.columns = [c.lower() for c in indicators.columns]

df = candles.merge(indicators, on=["asset","timestamp"], how="inner")
print(f"[DB] {len(df):,} rows | {df['asset'].nunique()} assets")

df = df.sort_values(["asset","timestamp"]).reset_index(drop=True)

# ── 2. FEATURE ENGINEERING (raw-indicator mode) ───────────────
# Candle body / wick
df["candle_body"]  = df["close"] - df["open"]
df["candle_range"] = df["high"]  - df["low"]
df["upper_wick"]   = df["high"]  - df[["close","open"]].max(axis=1)
df["lower_wick"]   = df[["close","open"]].min(axis=1) - df["low"]
df["body_ratio"]   = df["candle_body"] / (df["candle_range"] + 1e-9)
df["ret1"]  = df.groupby("asset")["close"].pct_change(1)
df["ret3"]  = df.groupby("asset")["close"].pct_change(3)
df["ret5"]  = df.groupby("asset")["close"].pct_change(5)

# Rolling stats on ret1
for w in [3, 5, 10]:
    df[f"ret1_r{w}"] = df.groupby("asset")["ret1"].transform(
        lambda x: x.shift(1).rolling(w).mean())

# Lag features on key indicators
lag_base = ["rsi_14", "macd_histogram", "stoch_k", "stc_value",
            "adx", "cci_20", "atr_14", "bb_width_bps", "williams_r"]
lag_base = [c for c in lag_base if c in df.columns]
for col in lag_base:
    for lag in [1, 2, 3]:
        df[f"{col}_lag{lag}"] = df.groupby("asset")[col].shift(lag)

# Rolling mean on key indicators
for col in ["rsi_14", "macd_histogram", "stoch_k", "adx"]:
    if col in df.columns:
        for w in [3, 5]:
            df[f"{col}_r{w}"] = df.groupby("asset")[col].transform(
                lambda x: x.shift(1).rolling(w).mean())

# Momentum: slope of rsi_14 over last 5 candles
if "rsi_14" in df.columns:
    df["rsi_mom5"] = df.groupby("asset")["rsi_14"].transform(
        lambda x: x.shift(1).rolling(5).apply(
            lambda w: np.polyfit(range(len(w)), w, 1)[0]
            if len(w) == 5 else np.nan, raw=True))

# MACD cross: macd_line crossing signal line
if "macd_line" in df.columns and "macd_signal" in df.columns:
    df["macd_cross"] = (df["macd_line"] > df["macd_signal"]).astype(int)
    df["macd_above_prev"] = df.groupby("asset")["macd_cross"].shift(1)
    df["macd_crossover"] = (df["macd_cross"] - df["macd_above_prev"]).fillna(0)

# Stochastic cross
if "stoch_k" in df.columns and "stoch_d" in df.columns:
    df["stoch_cross"] = (df["stoch_k"] > df["stoch_d"]).astype(int)

# BB position: where close sits within bands
if all(c in df.columns for c in ["bb_upper","bb_lower","close"]):
    df["bb_pos"] = (df["close"] - df["bb_lower"]) / (df["bb_upper"] - df["bb_lower"] + 1e-9)

# Keltner position
if all(c in df.columns for c in ["keltner_upper","keltner_lower","close"]):
    df["kc_pos"] = (df["close"] - df["keltner_lower"]) / (df["keltner_upper"] - df["keltner_lower"] + 1e-9)

# PSAR trend strength
if "psar_is_bullish" in df.columns:
    df["psar_streak"] = df.groupby("asset")["psar_is_bullish"].transform(
        lambda x: x.groupby((x != x.shift()).cumsum()).cumcount() + 1)

# ADX trend strength bucket
if "adx" in df.columns:
    df["adx_strong"] = (df["adx"] > 25).astype(int)

# Asset encoding
df["asset_enc"] = df["asset"].astype("category").cat.codes

# ── 3. LABELS ─────────────────────────────────────────────────
df["future_close"] = df.groupby("asset")["close"].shift(-HORIZON)
df["future_ret"]   = (df["future_close"] - df["close"]) / df["close"]
df["y"]            = (df["future_ret"] > 0).astype(int)

# ── 4. FEATURE SELECTION ──────────────────────────────────────
exclude = {"timestamp","asset","open","high","low","close","volume",
           "future_close","future_ret","y","macd_above_prev"}
feature_cols = [c for c in df.columns
                if c not in exclude
                and df[c].dtype in [np.float64, np.float32, np.int64, np.int32, float, int]]

df_ml = df.dropna(subset=feature_cols + ["y"]).copy().reset_index(drop=True)
print(f"[FEATURES] {len(feature_cols)} | [ML ROWS] {len(df_ml):,}")
print(f"[CLASS BALANCE] {df_ml['y'].value_counts().to_dict()}")

# ── 5. TRAIN / EVALUATE ───────────────────────────────────────
split  = int(len(df_ml) * TRAIN_SPLIT)
Xtr    = df_ml[feature_cols].iloc[:split]
ytr    = df_ml["y"].iloc[:split]
Xte    = df_ml[feature_cols].iloc[split:]
yte    = df_ml["y"].iloc[split:]

sc = StandardScaler()
Xtr_s = sc.fit_transform(Xtr)
Xte_s = sc.transform(Xte)

models = {
    "Logistic Regression": LogisticRegression(max_iter=1000, C=1.0),
    "Random Forest": RandomForestClassifier(
        n_estimators=300, max_depth=8, min_samples_leaf=20,
        n_jobs=-1, random_state=42),
    "HistGradBoost": HistGradientBoostingClassifier(
        max_iter=500, max_depth=6, learning_rate=0.04,
        min_samples_leaf=20, l2_regularization=1.0,
        early_stopping=True, n_iter_no_change=20,
        validation_fraction=0.1, random_state=42),
}

try:
    from xgboost import XGBClassifier
    models["XGBoost"] = XGBClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.7, min_child_weight=20,
        reg_alpha=0.1, reg_lambda=1.0, eval_metric="auc",
        random_state=42, verbosity=0, n_jobs=-1)
except ImportError:
    pass

try:
    from lightgbm import LGBMClassifier
    models["LightGBM"] = LGBMClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.7, min_child_samples=20,
        reg_alpha=0.1, reg_lambda=1.0, random_state=42,
        verbose=-1, n_jobs=-1)
except ImportError:
    pass

print(f"\n{'Model':<28} {'Acc':>8} {'AUC':>8} {'F1':>8}")
print("-" * 56)

trained, results = {}, {}
for name, model in models.items():
    model.fit(Xtr_s, ytr)
    pred = model.predict(Xte_s)
    prob = model.predict_proba(Xte_s)[:, 1]
    acc  = accuracy_score(yte, pred)
    auc  = roc_auc_score(yte, prob)
    f1   = f1_score(yte, pred, average="weighted")
    print(f"{name:<28} {acc:>8.4f} {auc:>8.4f} {f1:>8.4f}")
    trained[name] = {"model": model}
    results[name] = {"acc": acc, "auc": auc, "f1": f1}

best_name  = max(results, key=lambda k: results[k]["auc"])
best_model = trained[best_name]["model"]
print(f"\n[BEST MODEL] {best_name}  AUC={results[best_name]['auc']:.4f}")

# ── 6. SHAP ANALYSIS ─────────────────────────────────────────
print("\n[SHAP] Running analysis on best model...")
import shap

# Use TreeExplainer; sample 1000 rows for speed
sample_idx = np.random.RandomState(42).choice(len(Xte_s), min(1000, len(Xte_s)), replace=False)
Xte_sample = Xte_s[sample_idx]

explainer  = shap.TreeExplainer(best_model)
shap_vals  = explainer.shap_values(Xte_sample)

# For binary classifiers shap_values may return list (class 0, class 1)
if isinstance(shap_vals, list):
    shap_vals = shap_vals[1]

mean_abs_shap = np.abs(shap_vals).mean(axis=0)
shap_series   = pd.Series(mean_abs_shap, index=feature_cols).sort_values(ascending=False)

print("\n=== SHAP TOP 20 FEATURES ===")
print(shap_series.head(20).round(5).to_string())

# ── 7. WALK-FORWARD VALIDATION ────────────────────────────────
print("\n=== WALK-FORWARD VALIDATION (RandomForest, 5 folds) ===")
tscv = TimeSeriesSplit(n_splits=5)
X_all = df_ml[feature_cols].values
y_all = df_ml["y"].values
wf_results = []
for fold, (tr_i, te_i) in enumerate(tscv.split(X_all), 1):
    sc2 = StandardScaler()
    Xtr2 = sc2.fit_transform(X_all[tr_i])
    Xte2 = sc2.transform(X_all[te_i])
    rf = RandomForestClassifier(n_estimators=100, max_depth=8,
                                min_samples_leaf=20, n_jobs=-1, random_state=42)
    rf.fit(Xtr2, y_all[tr_i])
    prob2 = rf.predict_proba(Xte2)[:, 1]
    acc2  = accuracy_score(y_all[te_i], rf.predict(Xte2))
    auc2  = roc_auc_score(y_all[te_i], prob2)
    print(f"  Fold {fold}: Train={len(tr_i):>6} | Test={len(te_i):>5} | Acc={acc2:.4f} | AUC={auc2:.4f}")
    wf_results.append({"fold": fold, "acc": acc2, "auc": auc2})
wf_df = pd.DataFrame(wf_results)
print(f"  Mean AUC: {wf_df['auc'].mean():.4f} ± {wf_df['auc'].std():.4f}")
print(f"  Mean Acc: {wf_df['acc'].mean():.4f} ± {wf_df['acc'].std():.4f}")

# ── 8. SAVE OUTPUTS ───────────────────────────────────────────
pd.DataFrame(results).T.to_csv(f"{OUTPUT_DIR}/model_metrics.csv")
shap_series.head(20).reset_index().rename(
    columns={"index":"feature", 0:"shap_importance"}
).to_csv(f"{OUTPUT_DIR}/shap_importance.csv", index=False)
wf_df.to_csv(f"{OUTPUT_DIR}/walkforward_results.csv", index=False)

# Save structured summary for report generation
summary = {
    "model_results": results,
    "best_model": best_name,
    "shap_top5": shap_series.head(5).to_dict(),
    "shap_top20": shap_series.head(20).to_dict(),
    "walkforward": wf_results,
    "wf_mean_auc": round(float(wf_df['auc'].mean()), 4),
    "wf_std_auc":  round(float(wf_df['auc'].std()), 4),
    "wf_mean_acc": round(float(wf_df['acc'].mean()), 4),
    "wf_std_acc":  round(float(wf_df['acc'].std()), 4),
    "n_features": len(feature_cols),
    "n_rows": len(df_ml),
    "class_balance": df_ml['y'].value_counts().to_dict(),
    "horizon": HORIZON,
}
with open(f"{OUTPUT_DIR}/summary.json", "w") as f:
    json.dump(summary, f, indent=2, default=str)

print(f"\n[DONE] Outputs saved to {OUTPUT_DIR}/")
