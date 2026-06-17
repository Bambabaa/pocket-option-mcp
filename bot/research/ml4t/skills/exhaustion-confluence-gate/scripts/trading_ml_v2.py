"""
=============================================================
 TRADING ML MODEL v2 — Full Pipeline
 Supports: agent_v1.db (candles + indicators tables)
           OR signals_ALL.csv (pre-computed signals)
=============================================================
 Features:  50 engineered features (candle, score, lags,
            rolling, streak) + raw indicator columns
 Models:    XGBoost, LightGBM, Random Forest, LogReg
 Filters:   Streak >= 2, High-confidence, Prob threshold
 Output:    Trained model, per-candle predictions, report
=============================================================
"""

# ── INSTALL DEPENDENCIES (run once) ──────────────────────────
# pip install xgboost lightgbm scikit-learn pandas numpy shap

import os
import sqlite3
import warnings
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (accuracy_score, roc_auc_score,
                              f1_score, classification_report)
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import TimeSeriesSplit

warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────────────────────
# 0.  CONFIGURATION  — edit these paths
# ─────────────────────────────────────────────────────────────
DB_PATH          = "agent/data/agent_v1.db"   # SQLite database
SIGNALS_CSV      = "signals_ALL.csv"      # fallback if no DB
OUTPUT_DIR       = "bot/research/ml4t/skills/exhaustion-confluence-gate/model_output"
HORIZON          = 3                      # forward candles to predict
TRAIN_SPLIT      = 0.80                   # 80/20 time split
MIN_STREAK       = 2                      # streak filter threshold
CONF_THRESHOLD   = 0.667                  # confidence filter
PROB_THRESHOLD   = 0.55                   # probability filter
USE_XGB          = True                   # requires xgboost
USE_LGB          = True                   # requires lightgbm

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ─────────────────────────────────────────────────────────────
# 1.  DATA LOADING
# ─────────────────────────────────────────────────────────────

def load_from_db(db_path: str) -> pd.DataFrame:
    """Load candles + indicators from SQLite, join on asset+timestamp."""
    conn = sqlite3.connect(db_path)
    candles    = pd.read_sql("SELECT * FROM candles",    conn)
    indicators = pd.read_sql("SELECT * FROM indicators", conn)
    conn.close()

    # Normalise column names to lowercase
    candles.columns    = [c.lower() for c in candles.columns]
    indicators.columns = [c.lower() for c in indicators.columns]

    # Merge — adjust key columns if your schema differs
    join_keys = ["asset", "timestamp"]
    df = candles.merge(indicators, on=join_keys, how="inner", suffixes=("", "_ind"))
    print(f"[DB]  Loaded {len(df):,} rows | {df['asset'].nunique()} assets")
    return df


def load_from_csv(csv_path: str) -> pd.DataFrame:
    """Load pre-computed signals CSV as fallback."""
    df = pd.read_csv(csv_path)
    df.columns = [c.lower() for c in df.columns]
    print(f"[CSV] Loaded {len(df):,} rows | {df['asset'].nunique()} assets")
    return df


def load_data() -> pd.DataFrame:
    if Path(DB_PATH).exists():
        return load_from_db(DB_PATH)
    elif Path(SIGNALS_CSV).exists():
        print(f"[WARN] DB not found. Falling back to {SIGNALS_CSV}")
        return load_from_csv(SIGNALS_CSV)
    else:
        raise FileNotFoundError(f"Neither {DB_PATH} nor {SIGNALS_CSV} found.")


# ─────────────────────────────────────────────────────────────
# 2.  FEATURE ENGINEERING
# ─────────────────────────────────────────────────────────────

def encode_signals(df: pd.DataFrame) -> pd.DataFrame:
    """Encode categorical signal columns to numeric."""
    if "signal" in df.columns:
        df["signal_enc"] = df["signal"].map({"LONG": 1, "FLAT": 0, "SHORT": -1}).fillna(0)
    if "setup_quality" in df.columns:
        df["quality_enc"] = df["setup_quality"].map({"high": 2, "medium": 1, "low": 0}).fillna(0)
    if "confluence_label" in df.columns:
        conf_map = {
            "bullish_reversal": 2, "bullish_bias": 1, "chop": 0,
            "bearish_bias": -1, "bearish_reversal": -2,
            "momentum_fade": -1, "trend_continuation": 1,
        }
        df["confluence_enc"] = df["confluence_label"].map(conf_map).fillna(0)
    return df


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build all engineered features. Assumes df is sorted by [asset, timestamp]."""

    df = df.sort_values(["asset", "timestamp"]).reset_index(drop=True)
    df = encode_signals(df)

    # ── Candle body / wick features ──────────────────────────
    if all(c in df.columns for c in ["open", "high", "low", "close"]):
        df["candle_body"]  = df["close"] - df["open"]
        df["candle_range"] = df["high"] - df["low"]
        df["upper_wick"]   = df["high"] - df[["close", "open"]].max(axis=1)
        df["lower_wick"]   = df[["close", "open"]].min(axis=1) - df["low"]
        df["body_ratio"]   = df["candle_body"] / (df["candle_range"] + 1e-9)
        df["ret1"]  = df.groupby("asset")["close"].pct_change(1)
        df["ret3"]  = df.groupby("asset")["close"].pct_change(3)
        df["ret5"]  = df.groupby("asset")["close"].pct_change(5)

    # ── Score / confidence features ──────────────────────────
    if "_bull_score" in df.columns and "_bear_score" in df.columns:
        df["score_diff"]  = df["_bull_score"] - df["_bear_score"]
        df["score_total"] = df["_bull_score"] + df["_bear_score"]
        df["score_pct"]   = df["_bull_score"] / (df["score_total"] + 1e-3)
        df["score_ratio"] = df["_bull_score"] / (df["_bear_score"] + 1e-3)

    # ── Lag features (t-1 … t-5) ────────────────────────────
    lag_cols = [c for c in ["_bull_score", "_bear_score", "score_diff",
                             "signal_enc", "confidence"] if c in df.columns]
    for col in lag_cols:
        for lag in range(1, 6):
            df[f"{col}_lag{lag}"] = df.groupby("asset")[col].shift(lag)

    # ── Rolling statistics ────────────────────────────────────
    roll_cols = [c for c in ["score_diff", "_bull_score", "_bear_score", "ret1"]
                 if c in df.columns]
    for col in roll_cols:
        for w in [3, 5, 10]:
            df[f"{col}_r{w}"] = df.groupby("asset")[col].transform(
                lambda x: x.shift(1).rolling(w).mean())

    # ── Score momentum (linear slope over 5 candles) ────────
    if "score_diff" in df.columns:
        df["score_mom"] = df.groupby("asset")["score_diff"].transform(
            lambda x: x.shift(1).rolling(5).apply(
                lambda w: np.polyfit(range(len(w)), w, 1)[0]
                if len(w) == 5 else np.nan, raw=True))

    # ── Signal streak ─────────────────────────────────────────
    def streak_fn(s):
        out, c, p = [], 0, None
        for v in s:
            c = c + 1 if v == p else 1
            out.append(c)
            p = v
        return out

    if "signal_enc" in df.columns:
        df["sig_streak"] = df.groupby("asset")["signal_enc"].transform(
            lambda x: streak_fn(x.values))

    # ── Asset encoding ────────────────────────────────────────
    df["asset_enc"] = df["asset"].astype("category").cat.codes

    # ── Raw indicator columns (from agent_v1.db) ─────────────
    # These are included automatically if they exist in the loaded data.
    # Common indicator column names to expect:
    #   bb_upper, bb_lower, bb_mid, bb_width, bbpos, close_mid
    #   stoch_k, stoch_d, kd, stc, cci
    #   atr, rsi, macd, macd_signal, psar
    # No manual mapping needed — they're picked up by AUTO_INDICATOR_COLS below.

    return df


def select_features(df: pd.DataFrame) -> list:
    """
    Automatically collect all usable numeric feature columns.
    Excludes raw OHLCV, metadata, target, and string columns.
    """
    exclude = {
        "timestamp", "asset", "open", "high", "low", "close", "volume",
        "signal", "setup_quality", "confluence_label", "main_drivers",
        "invalidation", "horizon_candles", "future_close", "future_ret",
        "y", "asset_cat"
    }
    feature_cols = []
    for col in df.columns:
        if col in exclude:
            continue
        if df[col].dtype in [np.float64, np.float32, np.int64, np.int32, float, int]:
            feature_cols.append(col)
    return feature_cols


# ─────────────────────────────────────────────────────────────
# 3.  LABEL CREATION
# ─────────────────────────────────────────────────────────────

def create_labels(df: pd.DataFrame, horizon: int = HORIZON) -> pd.DataFrame:
    """y = 1 if close N candles forward > current close, else 0."""
    df["future_close"] = df.groupby("asset")["close"].shift(-horizon)
    df["future_ret"]   = (df["future_close"] - df["close"]) / df["close"]
    df["y"]            = (df["future_ret"] > 0).astype(int)
    return df


# ─────────────────────────────────────────────────────────────
# 4.  MODEL DEFINITIONS
# ─────────────────────────────────────────────────────────────

def get_models(use_xgb: bool = USE_XGB, use_lgb: bool = USE_LGB) -> dict:
    models = {
        "Logistic Regression": LogisticRegression(max_iter=1000, C=1.0),
        "Random Forest": RandomForestClassifier(
            n_estimators=300, max_depth=8,
            min_samples_leaf=20, n_jobs=-1, random_state=42),
        "HistGradBoost (sklearn≈XGB)": HistGradientBoostingClassifier(
            max_iter=500, max_depth=6, learning_rate=0.04,
            min_samples_leaf=20, l2_regularization=1.0,
            early_stopping=True, n_iter_no_change=20,
            validation_fraction=0.1, random_state=42),
    }

    if use_xgb:
        try:
            from xgboost import XGBClassifier
            models["XGBoost"] = XGBClassifier(
                n_estimators=500, max_depth=5, learning_rate=0.03,
                subsample=0.8, colsample_bytree=0.7,
                min_child_weight=20, reg_alpha=0.1, reg_lambda=1.0,
                eval_metric="auc", use_label_encoder=False,
                random_state=42, verbosity=0, n_jobs=-1)
        except ImportError:
            print("[WARN] xgboost not installed. Skipping XGBoost.")

    if use_lgb:
        try:
            from lightgbm import LGBMClassifier
            models["LightGBM"] = LGBMClassifier(
                n_estimators=500, max_depth=5, learning_rate=0.03,
                subsample=0.8, colsample_bytree=0.7,
                min_child_samples=20, reg_alpha=0.1, reg_lambda=1.0,
                random_state=42, verbose=-1, n_jobs=-1)
        except ImportError:
            print("[WARN] lightgbm not installed. Skipping LightGBM.")

    return models


# ─────────────────────────────────────────────────────────────
# 5.  TRAINING & EVALUATION
# ─────────────────────────────────────────────────────────────

def train_evaluate(df_ml: pd.DataFrame, feature_cols: list) -> dict:
    """Time-ordered 80/20 split, train all models, return results."""
    split = int(len(df_ml) * TRAIN_SPLIT)
    Xtr = df_ml[feature_cols].iloc[:split]
    ytr = df_ml["y"].iloc[:split]
    Xte = df_ml[feature_cols].iloc[split:]
    yte = df_ml["y"].iloc[split:]

    sc = StandardScaler()
    Xtr_s = sc.fit_transform(Xtr)
    Xte_s = sc.transform(Xte)

    trained   = {}
    results   = {}
    models    = get_models()

    print(f"\n{'Model':<30} {'Acc':>8} {'AUC':>8} {'F1':>8}")
    print("-" * 58)

    for name, model in models.items():
        model.fit(Xtr_s, ytr)
        pred  = model.predict(Xte_s)
        prob  = model.predict_proba(Xte_s)[:, 1]
        acc   = accuracy_score(yte, pred)
        auc   = roc_auc_score(yte, prob)
        f1    = f1_score(yte, pred, average="weighted")
        print(f"{name:<30} {acc:>8.4f} {auc:>8.4f} {f1:>8.4f}")
        trained[name] = {"model": model, "scaler": sc}
        results[name] = {"acc": acc, "auc": auc, "f1": f1}

    # Store test set for filter analysis
    best_name = max(results, key=lambda k: results[k]["auc"])
    best_model = trained[best_name]["model"]
    df_test = df_ml.iloc[split:].copy()
    df_test["prob"]  = best_model.predict_proba(Xte_s)[:, 1]
    df_test["pred"]  = best_model.predict(Xte_s)

    return trained, results, df_test, sc, best_name


# ─────────────────────────────────────────────────────────────
# 6.  SIGNAL FILTERS
# ─────────────────────────────────────────────────────────────

def apply_filters(df_test: pd.DataFrame) -> pd.DataFrame:
    """Evaluate accuracy under 4 filtering strategies."""
    rows = []

    # No filter
    rows.append({
        "Filter": "No filter (all signals)",
        "N": len(df_test),
        "Accuracy": accuracy_score(df_test["y"], df_test["pred"]),
        "AUC": roc_auc_score(df_test["y"], df_test["prob"]),
    })

    # Streak >= MIN_STREAK
    if "sig_streak" in df_test.columns:
        m = df_test["sig_streak"] >= MIN_STREAK
        sub = df_test[m]
        if len(sub) > 50:
            rows.append({
                "Filter": f"Streak >= {MIN_STREAK}",
                "N": len(sub),
                "Accuracy": accuracy_score(sub["y"], sub["pred"]),
                "AUC": roc_auc_score(sub["y"], sub["prob"]),
            })

    # High confidence + high quality
    m2 = (df_test.get("quality_enc", pd.Series(0, index=df_test.index)) == 2) & \
         (df_test.get("confidence",  pd.Series(0, index=df_test.index)) >= CONF_THRESHOLD)
    sub2 = df_test[m2]
    if len(sub2) > 50:
        rows.append({
            "Filter": f"Quality=high & Conf>={CONF_THRESHOLD}",
            "N": len(sub2),
            "Accuracy": accuracy_score(sub2["y"], sub2["pred"]),
            "AUC": roc_auc_score(sub2["y"], sub2["prob"]),
        })

    # Prob threshold
    m3 = df_test["prob"] >= PROB_THRESHOLD
    sub3 = df_test[m3]
    if len(sub3) > 50:
        rows.append({
            "Filter": f"Prob >= {PROB_THRESHOLD}",
            "N": len(sub3),
            "Accuracy": accuracy_score(sub3["y"], sub3["pred"]),
            "AUC": roc_auc_score(sub3["y"], sub3["prob"]),
        })

    # Streak + prob combined
    if "sig_streak" in df_test.columns:
        m4 = (df_test["sig_streak"] >= MIN_STREAK) & (df_test["prob"] >= PROB_THRESHOLD)
        sub4 = df_test[m4]
        if len(sub4) > 50:
            rows.append({
                "Filter": f"Streak>={MIN_STREAK} + Prob>={PROB_THRESHOLD}",
                "N": len(sub4),
                "Accuracy": accuracy_score(sub4["y"], sub4["pred"]),
                "AUC": roc_auc_score(sub4["y"], sub4["prob"]),
            })

    result_df = pd.DataFrame(rows)
    print("\n=== SIGNAL FILTER ANALYSIS ===")
    print(result_df.to_string(index=False))
    return result_df


# ─────────────────────────────────────────────────────────────
# 7.  FEATURE IMPORTANCE
# ─────────────────────────────────────────────────────────────

def feature_importance(model, feature_cols: list, top_n: int = 20) -> pd.DataFrame:
    """Extract feature importance if model supports it."""
    if hasattr(model, "feature_importances_"):
        imp = pd.Series(model.feature_importances_, index=feature_cols)
        imp = imp.sort_values(ascending=False).head(top_n)
        print(f"\n=== TOP {top_n} FEATURES ===")
        print(imp.round(4).to_string())
        return imp.reset_index()
    return pd.DataFrame()


def shap_analysis(model, Xte_s: np.ndarray, feature_cols: list):
    """Run SHAP feature analysis if available."""
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        shap_vals = explainer.shap_values(Xte_s[:500])
        mean_abs  = np.abs(shap_vals).mean(axis=0)
        shap_imp  = pd.Series(mean_abs, index=feature_cols).sort_values(ascending=False)
        print("\n=== SHAP TOP 15 ===")
        print(shap_imp.head(15).round(4).to_string())
        return shap_imp
    except ImportError:
        print("[INFO] shap not installed — skipping SHAP analysis.")
        return None


# ─────────────────────────────────────────────────────────────
# 8.  WALK-FORWARD VALIDATION
# ─────────────────────────────────────────────────────────────

def walk_forward_validation(df_ml: pd.DataFrame, feature_cols: list,
                             n_splits: int = 5) -> pd.DataFrame:
    """TimeSeriesSplit walk-forward validation with Random Forest."""
    tscv = TimeSeriesSplit(n_splits=n_splits)
    X = df_ml[feature_cols].values
    y = df_ml["y"].values
    sc = StandardScaler()

    fold_results = []
    print("\n=== WALK-FORWARD VALIDATION (RandomForest) ===")
    for fold, (tr_idx, te_idx) in enumerate(tscv.split(X), 1):
        Xtr_s = sc.fit_transform(X[tr_idx])
        Xte_s = sc.transform(X[te_idx])
        m = RandomForestClassifier(n_estimators=100, max_depth=8,
                                    min_samples_leaf=20, n_jobs=-1, random_state=42)
        m.fit(Xtr_s, y[tr_idx])
        prob = m.predict_proba(Xte_s)[:, 1]
        auc  = roc_auc_score(y[te_idx], prob)
        acc  = accuracy_score(y[te_idx], m.predict(Xte_s))
        print(f"  Fold {fold}: Train={len(tr_idx):>6} | Test={len(te_idx):>5} | Acc={acc:.4f} | AUC={auc:.4f}")
        fold_results.append({"fold": fold, "acc": acc, "auc": auc,
                              "train_size": len(tr_idx), "test_size": len(te_idx)})

    wf_df = pd.DataFrame(fold_results)
    print(f"  Mean AUC: {wf_df['auc'].mean():.4f} ± {wf_df['auc'].std():.4f}")
    return wf_df


# ─────────────────────────────────────────────────────────────
# 9.  LIVE PREDICTION ON LATEST ROW
# ─────────────────────────────────────────────────────────────

def predict_latest(df: pd.DataFrame, model, scaler: StandardScaler,
                   feature_cols: list) -> dict:
    """
    Run prediction on the most recent candle per asset.
    Returns a dict of {asset: {signal, probability, bias, top_features}}.
    """
    latest = df.sort_values("timestamp").groupby("asset").tail(1).copy()
    latest_clean = latest.dropna(subset=feature_cols)

    if latest_clean.empty:
        print("[WARN] No clean latest rows found.")
        return {}

    X_live = scaler.transform(latest_clean[feature_cols])
    probs  = model.predict_proba(X_live)[:, 1]

    output = {}
    for i, (_, row) in enumerate(latest_clean.iterrows()):
        prob = probs[i]
        signal = "LONG" if prob >= 0.55 else "SHORT" if prob <= 0.45 else "FLAT"
        output[row["asset"]] = {
            "timestamp":   row["timestamp"],
            "close":       row["close"],
            "signal":      signal,
            "probability": round(float(prob), 4),
            "bias":        "bullish" if prob > 0.5 else "bearish",
            "confidence":  "high" if abs(prob - 0.5) > 0.15 else
                           "medium" if abs(prob - 0.5) > 0.07 else "low",
        }

    print("\n=== LATEST CANDLE PREDICTIONS ===")
    for asset, pred in output.items():
        print(f"  {asset:<10} {pred['signal']:<6}  prob={pred['probability']:.3f}"
              f"  conf={pred['confidence']}")

    return output


# ─────────────────────────────────────────────────────────────
# 10. SAVE OUTPUTS
# ─────────────────────────────────────────────────────────────

def save_outputs(results: dict, filter_df: pd.DataFrame,
                 wf_df: pd.DataFrame, live_preds: dict,
                 imp_df: pd.DataFrame, output_dir: str):
    """Save all results to OUTPUT_DIR."""
    # Model metrics
    pd.DataFrame(results).T.to_csv(f"{output_dir}/model_metrics.csv")

    # Filter analysis
    filter_df.to_csv(f"{output_dir}/filter_analysis.csv", index=False)

    # Walk-forward
    wf_df.to_csv(f"{output_dir}/walkforward_results.csv", index=False)

    # Live predictions
    with open(f"{output_dir}/live_predictions.json", "w") as f:
        json.dump(live_preds, f, indent=2, default=str)

    # Feature importance
    if not imp_df.empty:
        imp_df.to_csv(f"{output_dir}/feature_importance.csv", index=False)

    print(f"\n[DONE] Results saved to ./{output_dir}/")


# ─────────────────────────────────────────────────────────────
# 11. MAIN
# ─────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print(" TRADING ML MODEL v2 — Starting Pipeline")
    print("=" * 60)

    # 1. Load
    df_raw = load_data()

    # 2. Feature engineering
    df = build_features(df_raw)

    # 3. Labels
    df = create_labels(df, horizon=HORIZON)

    # 4. Select features
    feature_cols = select_features(df)
    print(f"\n[FEATURES] {len(feature_cols)} features selected")

    # 5. Drop NaN rows
    df_ml = df.dropna(subset=feature_cols + ["y"]).copy().reset_index(drop=True)
    print(f"[ML ROWS] {len(df_ml):,} | class balance: {df_ml['y'].value_counts().to_dict()}")

    # 6. Train / evaluate
    trained, results, df_test, scaler, best_name = train_evaluate(df_ml, feature_cols)
    print(f"\n[BEST MODEL] {best_name} with AUC={results[best_name]['auc']:.4f}")

    # 7. Filter analysis
    filter_df = apply_filters(df_test)

    # 8. Feature importance
    best_model = trained[best_name]["model"]
    imp_df = feature_importance(best_model, feature_cols, top_n=20)

    # 9. SHAP (if installed)
    split = int(len(df_ml) * TRAIN_SPLIT)
    Xte_s = scaler.transform(df_ml[feature_cols].iloc[split:])
    shap_analysis(best_model, Xte_s, feature_cols)

    # 10. Walk-forward validation
    wf_df = walk_forward_validation(df_ml, feature_cols, n_splits=5)

    # 11. Live prediction on latest candle
    live_preds = predict_latest(df, best_model, scaler, feature_cols)

    # 12. Save everything
    save_outputs(results, filter_df, wf_df, live_preds, imp_df, OUTPUT_DIR)

    print("\n[PIPELINE COMPLETE]")


if __name__ == "__main__":
    main()
