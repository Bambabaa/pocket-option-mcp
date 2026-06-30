#!/usr/bin/env python3
"""
leak_hunt.py — find the feature(s) driving the impossible agent-source 97% WR.

97% WR / AUC 0.74 on agent.db for a 15-min FX direction call is not real -> a feature is
non-causal (sees the future). Rank every feature by its SINGLE-feature AUC vs the target
(y = close[t+3] > close[t]) on agent.db. A causal indicator scores ~0.50-0.55; a leaker
scores ~0.9+. For the top suspects, also show the correlation of the raw feature with the
forward return, to confirm direction of the leak.

Usage: python leak_hunt.py
"""
from __future__ import annotations
import os, sys, importlib.util
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
spec = importlib.util.spec_from_file_location("tml", os.path.join(HERE, "trading_ml_v2.py"))
tml = importlib.util.module_from_spec(spec); spec.loader.exec_module(tml)
sys.path.insert(0, os.path.join(ROOT, "bot", "research", "ml4t", "skills", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
def R(p): return os.path.join(ROOT, p)

def prep(db):
    raw = po_data.load(R(db))
    df = tml.create_labels(tml.build_features(raw), horizon=tml.HORIZON)
    feats = [f for f in tml.select_features(df) if f != "asset_enc"]
    df = df.dropna(subset=feats + ["y", "future_ret"]).reset_index(drop=True)
    return df, feats

def auc1(y, x):
    m = ~np.isnan(x)
    if m.sum() < 200 or len(np.unique(y[m])) < 2: return np.nan
    a = roc_auc_score(y[m], x[m])
    return max(a, 1 - a)   # direction-agnostic separability

def main():
    for label, db in [("agent.db", "agent/data/agent.db"),
                      ("td_LIVE (control)", "data/trading_data_live.db")]:
        df, feats = prep(db)
        y = df["y"].astype(int).values
        rows = []
        for f in feats:
            a = auc1(y, df[f].astype(float).values)
            if np.isfinite(a): rows.append((f, a))
        rows.sort(key=lambda r: -r[1])
        print(f"\n# Single-feature |AUC| vs next-3-bar direction — {label}  (n={len(df)})")
        print("| rank | feature | sep-AUC | corr(feat, fwd_ret) |")
        print("|---|---|---|---|")
        for i, (f, a) in enumerate(rows[:12], 1):
            c = np.corrcoef(df[f].astype(float).values, df["future_ret"].values)[0,1]
            flag = "  <-- LEAK" if a > 0.80 else ("  <- suspicious" if a > 0.65 else "")
            print(f"| {i} | {f} | {a:.3f} | {c:+.3f} |{flag}")
    print("\n(Causal indicator ~0.50-0.55. >0.80 = the feature effectively sees close[t+3]. "
          "Compare agent.db leakers vs td_LIVE: a feature high on agent but ~0.5 on td_LIVE is "
          "the agent-harness non-causal artifact.)")

if __name__ == "__main__":
    main()
