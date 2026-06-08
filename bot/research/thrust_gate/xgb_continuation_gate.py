"""
XGBoost Continuation Gate — Squeeze-Conditioned Thrust  (Phase-2 attempt)

Trains XGBoost on Thrust_dir + F_macro, ONLY on Squeeze_Release rows, targeting the
3-bar continuation event. Purged TimeSeriesSplit(5) + 5-candle embargo.

NOTE (read RESEARCH_PROCEDURE.md): the Step-4 probe found this lead FAILED cross-regime
(Thrust_dir p: June 0.020 -> May 0.700; squeeze continuation: June 56.6% -> May 47.7%).
This script runs the model anyway, on BOTH regimes, so the "safely > 60%" question is
answered out-of-sample, not just on the regime where the artifact appeared.

Run:  python xgb_continuation_gate.py [agent|snapshots|both]   (default both)
Read-only.
"""
import os, sys, math, sqlite3, warnings
warnings.filterwarnings("ignore")
import numpy as np, pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, precision_score
from xgboost import XGBClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data"))
SNAPSHOTS = ["trading_data_5-02.db", "trading_data_5-03.db", "trading_data_5-04_6.db"]
TRAINED = {"AUDCAD","AUDCHF","AUDJPY","CADCHF","CADJPY","CHFJPY",
           "EURAUD","EURCHF","EURJPY","EURUSD","USDCAD","USDCHF","USDJPY"}
FEATURES = ["Thrust_dir", "F_macro"]
THRESHOLDS = [0.55, 0.60, 0.65, 0.70]

# canonical SQL per source (maps old agent.db names -> canonical)
_SQL_AGENT = """SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.keltner_upper AS kc_upper, i.keltner_lower AS kc_lower, i.keltner_middle AS kc_middle,
  i.plus_di, i.minus_di, i.williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
  ORDER BY c.asset,c.timestamp"""
_SQL_SNAP = """SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.kc_upper, i.kc_lower, i.kc_middle,
  i.adx_plus_di AS plus_di, i.adx_minus_di AS minus_di, i.williams_14 AS williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
  ORDER BY c.asset,c.timestamp"""

def engineer(g):
    d = g.sort_values("timestamp").reset_index(drop=True).copy()
    c = d.close
    sq_on = (d.bb_upper - d.bb_lower) < (d.kc_upper - d.kc_lower)
    d["Squeeze_On"] = sq_on
    d["Squeeze_Release"] = sq_on.shift(1).fillna(False) & (~sq_on)
    d["Thrust_dir"] = (d.plus_di - d.minus_di).abs() * d.williams_r
    d["F_macro"] = (c - d.kc_middle) / d.atr_14
    direction = np.sign(c - c.shift(1)); forward = c.shift(-3) - c
    d["Target_Continuation"] = (np.sign(forward) == direction).astype(float)
    d.loc[(forward == 0) | (direction == 0) | forward.isna(), "Target_Continuation"] = np.nan
    return d

def load(source):
    files = [("agent.db", _SQL_AGENT)] if source == "agent" else [(s, _SQL_SNAP) for s in SNAPSHOTS]
    frames = []
    for fname, sql in files:
        con = sqlite3.connect(f"file:{os.path.join(DATA, fname)}?mode=ro", uri=True)
        df = pd.read_sql(sql, con); con.close()
        for a, g in df.groupby("asset"):
            if a not in TRAINED: continue
            frames.append(engineer(g))
    allbars = pd.concat(frames, ignore_index=True)
    allbars[FEATURES] = allbars[FEATURES].replace([np.inf, -np.inf], np.nan)
    return allbars

def purged(n, n_splits=5, embargo=5):
    for tr, te in TimeSeriesSplit(n_splits=n_splits).split(np.arange(n)):
        te = te[embargo:]
        if len(te): yield tr, te

def run(source):
    allbars = load(source)
    # STEP 3 — Vacuum Trap: ONLY squeeze-release rows
    sq = allbars[allbars.Squeeze_Release].dropna(subset=FEATURES + ["Target_Continuation"])
    sq = sq.sort_values("timestamp").reset_index(drop=True)
    sq["Target_Continuation"] = sq.Target_Continuation.astype(int)
    X = sq[FEATURES].values; y = sq.Target_Continuation.values; n = len(X)
    base = y.mean()
    print(f"\n################  SOURCE = {source}  ################")
    print(f"squeeze-release rows: n={n}   baseline continuation rate={base*100:.1f}%")
    if n < 50:
        print("  (too few rows to model)"); return

    oof = np.full(n, np.nan)
    for tr, te in purged(n):
        m = XGBClassifier(max_depth=3, n_estimators=100, learning_rate=0.05,
                          eval_metric="logloss", random_state=42, n_jobs=1)
        m.fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
    msk = ~np.isnan(oof)
    auc = roc_auc_score(y[msk], oof[msk]) if len(np.unique(y[msk])) > 1 else float("nan")
    prec = precision_score(y[msk], (oof[msk] >= 0.5).astype(int), zero_division=0)
    print(f"OOS AUC = {auc:.4f}   precision@0.5 = {prec:.4f}   (OOF n={msk.sum()})")

    print(f"\n| Threshold | Approved Trades (n) | Gated Win Rate | Break-Even Payout Required |")
    print(f"|---|---|---|---|")
    yo = y[msk]; po = oof[msk]
    for thr in THRESHOLDS:
        ap = po >= thr; na = int(ap.sum())
        if na == 0:
            print(f"| {thr:.2f} | 0 | — | — |"); continue
        wr = yo[ap].mean(); be = (1 - wr) / wr if wr > 0 else float("inf")
        print(f"| {thr:.2f} | {na} | {wr*100:.1f}% | {be*100:.0f}% |")

def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "both"
    for src in (["agent", "snapshots"] if arg == "both" else [arg]):
        run(src)

if __name__ == "__main__":
    main()
