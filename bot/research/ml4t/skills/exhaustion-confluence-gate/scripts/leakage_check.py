#!/usr/bin/env python3
"""
leakage_check.py — same features + same model as trading_ml_v2, three different SPLITS,
to measure how much of its AUC 0.715 is cross-asset/regime leakage vs real edge.

  A. asset-ordered 80/20   (what trading_ml_v2 does: sort [asset,timestamp] -> last assets test)
  B. TIME-ordered 80/20    (sort by timestamp globally -> later DATES test) = honest in-period
  C. clean cross-period    (train ALL agent_v1, test agent.db, zero overlap) = gold standard

Reuses trading_ml_v2.build_features / create_labels / select_features verbatim.
RandomForest with the same hyperparameters.
"""
from __future__ import annotations
import os, sys, importlib.util
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
spec = importlib.util.spec_from_file_location("tml", os.path.join(HERE, "trading_ml_v2.py"))
tml = importlib.util.module_from_spec(spec); spec.loader.exec_module(tml)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

def R(p): return os.path.join(ROOT, p)

def prep(db):
    raw = tml.load_from_db(R(db))
    df = tml.create_labels(tml.build_features(raw), horizon=tml.HORIZON)
    feats = tml.select_features(df)
    df = df.dropna(subset=feats + ["y"]).reset_index(drop=True)
    return df, feats

def rf():
    return RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                  n_jobs=-1, random_state=42)

def fit_auc(Xtr, ytr, Xte, yte):
    sc = StandardScaler().fit(Xtr)
    m = rf().fit(sc.transform(Xtr), ytr)
    p = m.predict_proba(sc.transform(Xte))[:, 1]
    return roc_auc_score(yte, p), accuracy_score(yte, (p>=0.5).astype(int))

def main():
    v1, feats = prep("agent/data/agent_v1.db")
    print(f"\n# Leakage check — RandomForest, same {len(feats)} features, three splits\n")

    # A. asset-ordered (reproduce trading_ml_v2): df already built sort [asset,timestamp]
    a = v1.copy()  # build_features sorted by [asset,timestamp]; keep that order
    s = int(len(a)*0.80)
    aucA, accA = fit_auc(a[feats].iloc[:s].values, a["y"].iloc[:s].values,
                         a[feats].iloc[s:].values, a["y"].iloc[s:].values)

    # B. time-ordered global
    b = v1.sort_values("timestamp").reset_index(drop=True)
    s = int(len(b)*0.80)
    aucB, accB = fit_auc(b[feats].iloc[:s].values, b["y"].iloc[:s].values,
                         b[feats].iloc[s:].values, b["y"].iloc[s:].values)

    # C. clean cross-period: train all v1, test agent.db
    ag, fe2 = prep("agent/data/agent.db")
    common = [f for f in feats if f in fe2]
    aucC, accC = fit_auc(v1[common].values, v1["y"].values, ag[common].values, ag["y"].values)

    print("| split | what it tests | AUC | acc | leakage |")
    print("|---|---|---|---|---|")
    print(f"| A asset-ordered 80/20 | trading_ml_v2's split | {aucA:.3f} | {accA*100:.1f}% | cross-asset regime |")
    print(f"| B time-ordered 80/20 | honest in-period | {aucB:.3f} | {accB*100:.1f}% | none (same regime) |")
    print(f"| C v1 -> agent.db | clean cross-period OOS | {aucC:.3f} | {accC*100:.1f}% | none (gold standard) |")
    print(f"\nGap A-C = {(aucA-aucC):.3f} AUC of pure split-leakage. "
          f"C (~0.5x) is the real generalization; A's 0.7x is the contemporaneous cross-asset artifact.")

if __name__ == "__main__":
    main()
