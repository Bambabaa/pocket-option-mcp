"""
================================================================================
 ML SIGNAL GATING PIPELINE — HIGH-FREQUENCY REVERSAL ENGINE
================================================================================
 Predicts short-term directional decay (reversal realisation) on an
 event-driven indicator dataset, with strict time-series leakage controls.

 Stages
   1. Dataset synthesis  — generate_synthetic_trading_data(n_rows)
                          + load_real_data() adapter for the merged CSV
   2. Feature engineering — 4 isolated kinetic features (de-correlated)
   3. Purged TimeSeriesSplit with a 5-candle embargo
   4. Two regularised classifiers — L2 LogisticRegression + constrained DT
   5. Reporting — precision/recall/F1 for the reversal class, confusion
                  matrix, and win-rate uplift at an 80% probability gate

 Dependencies: pandas, numpy, scikit-learn
================================================================================
"""
from __future__ import annotations

import warnings
import numpy as np
import pandas as pd

from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.metrics import (classification_report, confusion_matrix,
                             precision_score, recall_score, f1_score,
                             roc_auc_score)

warnings.filterwarnings("ignore")
RNG = np.random.RandomState(42)


# ==============================================================================
#  STAGE 1 — DATASET SYNTHESIS (event-driven)
# ==============================================================================
def generate_synthetic_trading_data(n_rows: int = 5000) -> pd.DataFrame:
    """Simulate an event-driven dataset where a reversal strategy has already
    triggered on every row. Produces correlated, mean-reverting oscillators and
    a binary `Future_Decay_Realized` target whose probability depends on how
    stretched the oscillators are (so the ML task is learnable but noisy).

    Columns: Timestamp, Close, Upper_Band, Lower_Band, CCI, Stoch_K, Stoch_D,
             STC, Future_Decay_Realized
    """
    # ── price as a mild mean-reverting random walk (Ornstein-Uhlenbeck-ish) ──
    price = np.zeros(n_rows)
    price[0] = 100.0
    for t in range(1, n_rows):
        # pull toward 100, plus noise
        price[t] = price[t - 1] + 0.02 * (100.0 - price[t - 1]) + RNG.normal(0, 0.15)

    close = pd.Series(price)
    mid   = close.rolling(20, min_periods=1).mean()
    std   = close.rolling(20, min_periods=1).std().fillna(0.1).clip(lower=1e-6)
    upper = mid + 2 * std
    lower = mid - 2 * std

    # ── oscillators, partly driven by price stretch (so they co-move) ────────
    stretch = ((close - mid) / (2 * std)).clip(-1.5, 1.5)            # ~ %B centred
    cci   = (stretch * 180 + RNG.normal(0, 40, n_rows)).clip(-350, 350)
    stoch_k = (50 + stretch * 35 + RNG.normal(0, 8, n_rows)).clip(0, 100)
    stoch_d = pd.Series(stoch_k).rolling(3, min_periods=1).mean().values
    # STC oscillates 0..100, lags the stretch
    stc = (50 + 45 * np.sin(np.cumsum(RNG.normal(0, 0.18, n_rows)))
           + stretch * 10).clip(0, 100)

    # ── Target: did the running move reverse within a 3-bar expiry window? ───
    # Recent move that brought us here:
    recent = close.diff(3)
    forward = close.shift(-3) - close
    # reversal realised = forward move opposes the recent move, AND the bar was
    # stretched enough that a reversal was plausible. Add noise so it's < 100%.
    base_reversal = (np.sign(forward) != np.sign(recent)).astype(float)
    stretch_boost = (stretch.abs() > 0.6).astype(float)             # extreme bars
    noisy = base_reversal * (0.55 + 0.30 * stretch_boost) + RNG.uniform(0, 0.25, n_rows)
    target = (noisy > 0.6).astype(int)

    df = pd.DataFrame({
        "Timestamp":  np.arange(n_rows),
        "Close":      close.values,
        "Upper_Band": upper.values,
        "Lower_Band": lower.values,
        "CCI":        cci,
        "Stoch_K":    stoch_k,
        "Stoch_D":    stoch_d,
        "STC":        stc,
        "Future_Decay_Realized": target.values,
    })
    return df


def load_real_data(csv_path: str, expiry_bars: int = 3,
                   lookback_bars: int = 3) -> pd.DataFrame:
    """Adapter that maps the merged candles+indicators CSV onto the canonical
    schema and constructs an event-driven `Future_Decay_Realized` target.

    Reversal-realisation label (causal, no leakage):
        recent_move  = close[t]      - close[t-lookback]
        forward_move = close[t+expiry] - close[t]
        Future_Decay_Realized = 1  if sign(forward_move) != sign(recent_move)
                                   (the running move decayed / reversed)
                              = 0  if it continued running

    Features are computed per asset so diffs never cross instrument boundaries.
    Returns a pooled frame sorted by (timestamp, asset).
    """
    raw = pd.read_csv(csv_path)
    col = {
        "Close": "close", "Upper_Band": "bb_upper", "Lower_Band": "bb_lower",
        "CCI": "cci_20", "Stoch_K": "stoch_k", "Stoch_D": "stoch_d",
        "STC": "stc_value",
    }
    frames = []
    for asset, g in raw.groupby("asset", sort=False):
        d = g.sort_values("timestamp").reset_index(drop=True)
        out = pd.DataFrame({
            "Timestamp":  d["timestamp"].values,
            "asset":      asset,
            "Close":      d[col["Close"]].values,
            "Upper_Band": d[col["Upper_Band"]].values,
            "Lower_Band": d[col["Lower_Band"]].values,
            "CCI":        d[col["CCI"]].values,
            "Stoch_K":    d[col["Stoch_K"]].values,
            "Stoch_D":    d[col["Stoch_D"]].values,
            "STC":        d[col["STC"]].values,
        })
        close = out["Close"]
        recent  = close.diff(lookback_bars)
        forward = close.shift(-expiry_bars) - close
        out["Future_Decay_Realized"] = (
            (np.sign(forward) != np.sign(recent)) & forward.notna() & recent.notna()
        ).astype(int)
        # mark rows with undefined target (edges) for later drop
        out.loc[forward.isna() | recent.isna(), "Future_Decay_Realized"] = np.nan
        frames.append(out)
    pooled = pd.concat(frames, ignore_index=True)
    pooled = pooled.sort_values(["Timestamp", "asset"]).reset_index(drop=True)
    return pooled


# ==============================================================================
#  STAGE 2 — FEATURE ENGINEERING (isolated kinetic features)
# ==============================================================================
def engineer_features(df: pd.DataFrame, group_col: str | None = None) -> pd.DataFrame:
    """Build the four de-correlated kinetic features. When `group_col` is given
    (real multi-asset data), diffs are computed within each group so they don't
    leak across instruments.

        BB_Deviation     = (Close - Lower_Band) / (Upper_Band - Lower_Band)
        CCI_Velocity     = (CCI_t - CCI_{t-2}) / 2
        Stoch_Divergence = |Stoch_K - Stoch_D|
        STC_Momentum     = STC_t - STC_{t-1}
    """
    d = df.copy()

    # 1. Volatility Extension (Percent B) — purely contemporaneous, no diff
    band = (d["Upper_Band"] - d["Lower_Band"]).replace(0, np.nan)
    d["BB_Deviation"] = (d["Close"] - d["Lower_Band"]) / band

    # diff-based features (group-aware)
    if group_col and group_col in d.columns:
        g = d.groupby(group_col)
        d["CCI_Velocity"] = g["CCI"].diff(2) / 2.0
        d["STC_Momentum"] = g["STC"].diff(1)
    else:
        d["CCI_Velocity"] = d["CCI"].diff(2) / 2.0
        d["STC_Momentum"] = d["STC"].diff(1)

    # 3. Oscillator Spatial Divergence — contemporaneous
    d["Stoch_Divergence"] = (d["Stoch_K"] - d["Stoch_D"]).abs()

    # ── clean intermediate NaNs from diffs (drop rows with any NaN feature) ──
    feat_cols = ["BB_Deviation", "CCI_Velocity", "Stoch_Divergence", "STC_Momentum"]
    d = d.dropna(subset=feat_cols + ["Future_Decay_Realized"]).reset_index(drop=True)
    return d


FEATURES = ["BB_Deviation", "CCI_Velocity", "Stoch_Divergence", "STC_Momentum"]
TARGET   = "Future_Decay_Realized"


# ==============================================================================
#  STAGE 3 — PURGED TIME-SERIES VALIDATION (TimeSeriesSplit + 5-candle embargo)
# ==============================================================================
def purged_splits(n_samples: int, n_splits: int = 5, embargo: int = 5):
    """Yield (train_idx, val_idx) from a TimeSeriesSplit, then EMBARGO by
    dropping the first `embargo` rows of each validation fold (the candles that
    immediately follow the training window) so multi-candle momentum / decay
    targets cannot leak across the train→val boundary.
    """
    tss = TimeSeriesSplit(n_splits=n_splits)
    dummy = np.zeros((n_samples, 1))
    for train_idx, val_idx in tss.split(dummy):
        val_embargoed = val_idx[embargo:]          # drop first `embargo` candles
        if len(val_embargoed) == 0:
            continue
        yield train_idx, val_embargoed


# ==============================================================================
#  STAGE 4 + 5 — TRAINING, REGULARISATION, REPORTING, GATING
# ==============================================================================
class ReversalGateModel:
    """Wraps one classifier with its scaling policy and the 80% gating logic."""

    def __init__(self, name: str, kind: str):
        assert kind in ("logreg", "tree")
        self.name = name
        self.kind = kind
        self.scaler = None

    def _new_estimator(self):
        if self.kind == "logreg":
            # L2-regularised logistic regression
            return LogisticRegression(penalty="l2", C=0.5, max_iter=1000,
                                      class_weight="balanced", solver="lbfgs")
        # constrained tree: depth in [3,5] prevents memorising noise
        return DecisionTreeClassifier(max_depth=4, min_samples_leaf=50,
                                      class_weight="balanced", random_state=42)

    def fit_predict_fold(self, Xtr, ytr, Xval):
        est = self._new_estimator()
        if self.kind == "logreg":
            self.scaler = StandardScaler().fit(Xtr)
            est.fit(self.scaler.transform(Xtr), ytr)
            proba = est.predict_proba(self.scaler.transform(Xval))[:, 1]
        else:
            est.fit(Xtr, ytr)
            proba = est.predict_proba(Xval)[:, 1]
        return proba


def run_validation(df: pd.DataFrame, label: str, gate_threshold: float = 0.80,
                   n_splits: int = 5, embargo: int = 5) -> dict:
    """Full purged-CV evaluation of both models, with reporting + gating."""
    X = df[FEATURES].values
    y = df[TARGET].astype(int).values
    n = len(df)

    models = {
        "L2_LogisticRegression": ReversalGateModel("L2_LogisticRegression", "logreg"),
        "Constrained_DecisionTree": ReversalGateModel("Constrained_DecisionTree", "tree"),
    }

    out = {"label": label, "n_samples": n, "baseline_win_rate": float(y.mean()), "models": {}}

    for mname, model in models.items():
        oof_proba = np.full(n, np.nan)
        for train_idx, val_idx in purged_splits(n, n_splits, embargo):
            proba = model.fit_predict_fold(X[train_idx], y[train_idx], X[val_idx])
            oof_proba[val_idx] = proba

        mask = ~np.isnan(oof_proba)
        yv = y[mask]
        pv = oof_proba[mask]
        pred = (pv >= 0.5).astype(int)

        # ── gating: only execute trades where proba >= threshold ────────────
        gate = pv >= gate_threshold
        gated_n = int(gate.sum())
        gated_win_rate = float(yv[gate].mean()) if gated_n > 0 else float("nan")

        report = classification_report(yv, pred, output_dict=True, zero_division=0)
        cm = confusion_matrix(yv, pred)   # rows=true [0,1], cols=pred [0,1]

        out["models"][mname] = {
            "oos_n": int(mask.sum()),
            "auc": float(roc_auc_score(yv, pv)) if len(set(yv)) > 1 else float("nan"),
            "precision_rev": float(precision_score(yv, pred, pos_label=1, zero_division=0)),
            "recall_rev": float(recall_score(yv, pred, pos_label=1, zero_division=0)),
            "f1_rev": float(f1_score(yv, pred, pos_label=1, zero_division=0)),
            "confusion_matrix": cm.tolist(),
            "classification_report": report,
            "gate_threshold": gate_threshold,
            "gated_n": gated_n,
            "gated_coverage": gated_n / int(mask.sum()) if mask.sum() else 0.0,
            "gated_win_rate": gated_win_rate,
            "win_rate_uplift": (gated_win_rate - y.mean()) if gated_n > 0 else float("nan"),
        }
    return out


# ==============================================================================
#  PRESENTATION
# ==============================================================================
def print_report(res: dict):
    print("\n" + "=" * 74)
    print(f" DATASET: {res['label']}   (N={res['n_samples']:,} usable rows)")
    print(f" Baseline reversal win-rate (P[Y=1]): {res['baseline_win_rate']*100:.2f}%")
    print("=" * 74)
    for mname, m in res["models"].items():
        print(f"\n── {mname} ──────────────────────────────────")
        print(f"   OOS samples : {m['oos_n']:,}    ROC-AUC: {m['auc']:.4f}")
        print(f"   Reversal class (Y=1):  Precision={m['precision_rev']:.3f}  "
              f"Recall={m['recall_rev']:.3f}  F1={m['f1_rev']:.3f}")
        cm = m["confusion_matrix"]
        print(f"   Confusion matrix (rows=actual, cols=pred):")
        print(f"                 pred=0    pred=1")
        print(f"      actual=0   {cm[0][0]:>7}  {cm[0][1]:>7}   (FP = {cm[0][1]} losing trades slipped gate)")
        print(f"      actual=1   {cm[1][0]:>7}  {cm[1][1]:>7}   (TP = {cm[1][1]} winning trades approved)")
        print(f"   ── Gating @ proba >= {m['gate_threshold']:.0%} ──")
        print(f"      Trades approved : {m['gated_n']:,}  "
              f"({m['gated_coverage']*100:.1f}% of signals)")
        if m["gated_n"] > 0:
            print(f"      Gated win-rate  : {m['gated_win_rate']*100:.2f}%")
            print(f"      Baseline        : {res['baseline_win_rate']*100:.2f}%")
            print(f"      WIN-RATE UPLIFT : {m['win_rate_uplift']*100:+.2f} pp")
        else:
            print(f"      No trades cleared the {m['gate_threshold']:.0%} gate.")


# ==============================================================================
#  MAIN
# ==============================================================================
if __name__ == "__main__":
    import json, sys

    print("#" * 74)
    print("#  STAGE 1–5  REVERSAL SIGNAL GATING PIPELINE")
    print("#" * 74)

    # ---- (A) Synthetic dataset (spec compliance) ----
    print("\n>>> Running on SYNTHETIC data (spec Stage 1) ...")
    synth = generate_synthetic_trading_data(n_rows=5000)
    synth_feat = engineer_features(synth, group_col=None)
    res_synth = run_validation(synth_feat, "SYNTHETIC (5,000 rows)")
    print_report(res_synth)

    # ---- (B) Real merged dataset ----
    real_path = sys.argv[1] if len(sys.argv) > 1 else \
        "/mnt/user-data/uploads/merged-candles-indicators.csv"
    print(f"\n\n>>> Running on REAL data: {real_path} ...")
    real = load_real_data(real_path, expiry_bars=3, lookback_bars=3)
    real_feat = engineer_features(real, group_col="asset")
    res_real = run_validation(real_feat, "REAL merged-candles-indicators")
    print_report(res_real)

    # ---- save ----
    with open("/home/claude/outputs/reversal_gate_results.json", "w") as f:
        json.dump({"synthetic": res_synth, "real": res_real}, f, indent=2, default=str)
    print("\n\nSaved reversal_gate_results.json")
