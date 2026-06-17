#!/usr/bin/env python3
"""
per_asset_normalize.py — isolate REAL timing edge from asset-drift memorization in the
trading_ml_v2 config (horizon=3 direction, 46 raw features, clean v1->agent OOS = AUC 0.641).

The suspicion: top features are absolute-scale (atr, bb_width, price levels) + the feature
set literally includes asset_enc (the asset ID). So the model can ride each asset's
persistent drift instead of timing direction. Three variants of the clean cross-period test:

  1. RAW            — trading_ml_v2 as-is (baseline 0.641)
  2. PER-ASSET Z    — z-score every feature WITHIN each asset (own-period stats), drop asset_enc
                      -> removes static asset level + drift baseline, keeps within-asset timing
  3. UNSEEN ASSETS  — train v1 on half the assets, test agent.db on the OTHER half (unseen
                      asset AND unseen period) -> kills asset memorization entirely

If AUC survives 2 and 3 -> real 15m directional timing edge. If it craters to ~0.53 -> it was
asset drift / identity, not timing.
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
    df = tml.create_labels(tml.build_features(tml.load_from_db(R(db))), horizon=tml.HORIZON)
    feats = [f for f in tml.select_features(df) if f != "asset_enc"]   # drop the asset-ID feature
    df = df.dropna(subset=feats + ["y"]).reset_index(drop=True)
    return df, feats

def per_asset_z(df, feats):
    """z-score each feature within its asset, using that frame's own per-asset stats."""
    out = df.copy()
    g = out.groupby("asset")
    mean = g[feats].transform("mean"); std = g[feats].transform("std").replace(0, 1.0)
    out[feats] = (out[feats] - mean) / std
    return out

def fit_auc(Xtr, ytr, Xte, yte):
    sc = StandardScaler().fit(Xtr)
    m = RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                               n_jobs=-1, random_state=42).fit(sc.transform(Xtr), ytr)
    p = m.predict_proba(sc.transform(Xte))[:, 1]
    return roc_auc_score(yte, p), accuracy_score(yte, (p>=0.5).astype(int))

def main():
    v1, feats = prep("agent/data/agent_v1.db")
    ag, fe2   = prep("agent/data/agent.db")
    common = [f for f in feats if f in fe2]
    print(f"\n# Per-asset normalization test — clean v1->agent OOS (RF, {len(common)} feats, asset_enc dropped)\n")
    print("| variant | what it removes | AUC | acc |")
    print("|---|---|---|---|")

    # 1. RAW (asset_enc already dropped here, so slightly below the 0.641 with it)
    a,ac = fit_auc(v1[common].values, v1["y"].values, ag[common].values, ag["y"].values)
    print(f"| 1 RAW (no asset_enc) | nothing | {a:.3f} | {ac*100:.1f}% |")

    # 2. PER-ASSET Z (own-period stats)
    v1n, agn = per_asset_z(v1, common), per_asset_z(ag, common)
    a,ac = fit_auc(v1n[common].values, v1n["y"].values, agn[common].values, agn["y"].values)
    print(f"| 2 PER-ASSET Z | static level + drift | {a:.3f} | {ac*100:.1f}% |")

    # 3. UNSEEN ASSETS: train v1 on half the assets, test agent on the other half (+ per-asset Z)
    assets = sorted(set(v1["asset"]) & set(ag["asset"]))
    half = assets[::2]; other = [x for x in assets if x not in half]
    tr = v1n[v1n["asset"].isin(half)]; te = agn[agn["asset"].isin(other)]
    a,ac = fit_auc(tr[common].values, tr["y"].values, te[common].values, te["y"].values)
    print(f"| 3 UNSEEN ASSETS+Z | asset identity entirely | {a:.3f} | {ac*100:.1f}% |")
    print(f"   (train assets: {half}  -> test assets: {other})")

    print("\nRead: variant 1 ~ raw baseline. If 2 & 3 hold ~0.6 -> real within-asset 15m timing edge. "
          "If they fall to ~0.53 -> the 0.641 was asset drift/identity, not timing.")

if __name__ == "__main__":
    main()
