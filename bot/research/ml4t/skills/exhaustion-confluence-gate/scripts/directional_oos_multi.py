#!/usr/bin/env python3
"""
directional_oos_multi.py — train the directional model on agent_v1, test on ALL the
trading_data DBs (different data source + the LIVE one). The hardest generalization test:
different schema, different period, different bot/strategy era.

Schema alignment: load every DB through po_data (canonicalizes agent_* vs trading_data
names to one set), then reuse trading_ml_v2.build_features / create_labels (horizon=3,
15-min-ahead direction). Features = intersection across train + all tests, asset_enc dropped.

Reports per test DB: n, RAW AUC, PER-ASSET-Z AUC (the trustworthy one), and a confidence
WR sweep (bet UP if p>=thr, DOWN if p<=1-thr) vs break-even — the tradeability number.

Usage: python directional_oos_multi.py [--payout 0.69]
"""
from __future__ import annotations
import os, sys, importlib.util, argparse
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
spec = importlib.util.spec_from_file_location("tml", os.path.join(HERE, "trading_ml_v2.py"))
tml = importlib.util.module_from_spec(spec); spec.loader.exec_module(tml)
sys.path.insert(0, os.path.join(ROOT, "bot", "research", "ml4t", "skills", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
def R(p): return os.path.join(ROOT, p)

TRAIN = ["agent/data/agent_v1.db", "agent/data/agent.db"]   # pooled
TESTS = {
    "td_5-02":             "data/trading_data_5-02.db",
    "td_5-03":             "data/trading_data_5-03.db",
    "td_00":               "data/trading_data00.db",
    "td_08220":            "data/trading_data_08220.db",
    "td_main":             "data/trading_data.db",
    "td_LIVE":             "data/trading_data_live.db",
}

def prep(db):
    dbs = db if isinstance(db, list) else [db]
    parts = []
    for i, d in enumerate(dbs):
        raw = po_data.load(R(d))                           # canonical names, schema-aligned
        if len(dbs) > 1: raw["asset"] = raw["asset"] + f"@{i}"   # keep per-DB asset diffs apart
        parts.append(raw)
    raw = pd.concat(parts, ignore_index=True)
    df = tml.create_labels(tml.build_features(raw), horizon=tml.HORIZON)
    feats = [f for f in tml.select_features(df) if f != "asset_enc"]
    df = df.dropna(subset=feats + ["y"]).reset_index(drop=True)
    return df, feats

def per_asset_z(df, feats):
    g = df.groupby("asset")
    mean = g[feats].transform("mean"); std = g[feats].transform("std").replace(0, 1.0)
    out = df.copy(); out[feats] = (out[feats] - mean) / std
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--payout", type=float, default=0.69)
    a = ap.parse_args(); be = 1/(1+a.payout)
    tr, ftr = prep(TRAIN)
    tests = {}
    for name, db in TESTS.items():
        try: tests[name] = prep(db)
        except Exception as e: print(f"[skip {name}: {e}]")
    common = sorted(set(ftr).intersection(*[set(f) for _, f in tests.values()]))
    print(f"\n# Directional model: train agent_v1 -> test trading_data DBs (horizon 3 / 15m)")
    print(f"common features {len(common)} | break-even {be*100:.1f}% @ {a.payout} payout\n")

    sc = StandardScaler().fit(tr[common].values)
    rf = RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                n_jobs=-1, random_state=42).fit(sc.transform(tr[common].values),
                                                                tr["y"].astype(int).values)
    # per-asset-z model (train on normalized v1)
    trn = per_asset_z(tr, common); scn = StandardScaler().fit(trn[common].values)
    rfn = RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                 n_jobs=-1, random_state=42).fit(scn.transform(trn[common].values),
                                                                 trn["y"].astype(int).values)

    print("| test DB | n | RAW AUC | per-asset-Z AUC | acc | conf>=.55 WR (cap) | conf>=.60 WR (cap) |")
    print("|---|---|---|---|---|---|---|")
    for name, (df, _) in tests.items():
        y = df["y"].astype(int).values
        praw = rf.predict_proba(sc.transform(df[common].values))[:,1]
        dn = per_asset_z(df, common); pz = rfn.predict_proba(scn.transform(dn[common].values))[:,1]
        a_raw = roc_auc_score(y, praw); a_z = roc_auc_score(y, pz)
        acc = accuracy_score(y, (pz>=0.5).astype(int))
        cells=[]
        for thr in (0.55, 0.60):
            up=pz>=thr; dnm=pz<=(1-thr); n=int(up.sum()+dnm.sum())
            if n>=30:
                wins=np.concatenate([y[up], 1-y[dnm]]); wr=wins.mean()*100
                cap=n/len(pz)*100; flag="*" if wr>=be*100 else ""
                cells.append(f"{wr:.0f}%{flag} ({cap:.0f}%,n={n})")
            else: cells.append(f"thin(n={n})")
        print(f"| {name} | {len(df)} | {a_raw:.3f} | {a_z:.3f} | {acc*100:.0f}% | {cells[0]} | {cells[1]} |")
    print(f"\n(* clears break-even {be*100:.1f}%. per-asset-Z = the trustworthy AUC. "
          "td_* are a DIFFERENT data source + later periods than agent_v1 — the hardest OOS test.)")

if __name__ == "__main__":
    main()
