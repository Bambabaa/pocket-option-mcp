#!/usr/bin/env python3
"""
real_data_search.py — the HONEST edge search, on real broker data only.

trading_data DBs (real broker, 5m FX, OTC-blocked) are the only trustworthy source
(agent.db is synthetic — see leak_hunt). This runs the 15-min-direction model on them
with every guard on:
  0. leak sanity: single-feature max AUC on pooled real data (should be ~0.55, no 0.73 tells)
  1. CONTIGUOUS labels (ts[t+3]-ts[t]==3*BAR) — real data has session gaps; no shift-across-gap
  2. per-asset z-normalization (own-DB stats), asset_enc dropped
  3. TIME-ORDERED cross-DB split: train earlier DBs, test later DBs (incl. live)
  4. confident-slice WR vs break-even by DIRECTION (up=CALL / down=PUT) at honest capture
  5. payout bridge: required_payout=(1-WR)/WR vs the test DB's actual median trade payout

Edge is only believed if a slice clears break-even across MULTIPLE test DBs at capture>3%.

Usage: python real_data_search.py [--payout 0.69]
"""
from __future__ import annotations
import os, sys, importlib.util, argparse, sqlite3
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
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
BAR = 300

# time order (earlier -> later)
TRAIN_DBS = [("td_5-02","data/trading_data_5-02.db"), ("td_5-03","data/trading_data_5-03.db"),
             ("td_00","data/trading_data00.db"), ("td_08220","data/trading_data_08220.db")]
TEST_DBS  = [("td_main","data/trading_data.db"), ("td_LIVE","data/trading_data_live.db")]

def engineer(db):
    raw = po_data.load(R(db))
    df = tml.build_features(raw)
    feats = [f for f in tml.select_features(df) if f not in ("asset_enc","y","future_close","future_ret")]
    rows = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, ts = g["close"].astype(float), g["timestamp"]
        contig = (ts.shift(-3) - ts == 3*BAR)
        g["y"] = np.where(contig, (c.shift(-3) > c).astype(float), np.nan)
        rows.append(g)
    df = pd.concat(rows)
    df = df.dropna(subset=feats + ["y"]).reset_index(drop=True)
    return df, feats

def per_asset_z(df, feats):
    g = df.groupby("asset"); mean = g[feats].transform("mean"); std = g[feats].transform("std").replace(0,1.0)
    out = df.copy(); out[feats] = (out[feats]-mean)/std; return out

def median_payout(db):
    try:
        con = sqlite3.connect(f"file:{R(db)}?mode=ro&immutable=1", uri=True)
        p = pd.read_sql_query("SELECT payout FROM trades_ordered WHERE result IN ('WIN','LOSS')", con)
        con.close()
        return float(p["payout"].median()) if len(p) else np.nan
    except Exception: return np.nan

def leak_sanity(frames, feats):
    df = pd.concat(frames, ignore_index=True); y = df["y"].astype(int).values
    best = []
    for f in feats:
        x = df[f].astype(float).values; m = ~np.isnan(x)
        if m.sum() < 200 or len(np.unique(y[m])) < 2: continue
        a = roc_auc_score(y[m], x[m]); best.append((f, max(a,1-a)))
    best.sort(key=lambda r:-r[1])
    print("## 0. Leak sanity (pooled real data) — single-feature max |AUC|")
    print("   " + ", ".join(f"{f} {a:.3f}" for f,a in best[:5]))
    print(f"   max {best[0][1]:.3f}  ->  {'CLEAN (no synthetic coupling)' if best[0][1] < 0.62 else 'CHECK — high'}")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--payout", type=float, default=0.69)
    a = ap.parse_args(); be = 1/(1+a.payout)

    train_frames = {n: engineer(db) for n, db in TRAIN_DBS}
    test_frames  = {n: engineer(db) for n, db in TEST_DBS}
    feats = sorted(set.intersection(*[set(f) for _, f in list(train_frames.values())+list(test_frames.values())]))

    print(f"\n# Real-data edge search — train {[n for n,_ in TRAIN_DBS]} -> test {[n for n,_ in TEST_DBS]}")
    print(f"horizon 3 (15m) | {len(feats)} feats | break-even {be*100:.1f}% @ {a.payout} payout\n")
    leak_sanity([per_asset_z(df, feats) for df,_ in train_frames.values()], feats)

    # train pooled (per-asset-Z within each DB)
    trn = pd.concat([per_asset_z(df, feats) for df,_ in train_frames.values()], ignore_index=True)
    sc = StandardScaler().fit(trn[feats].values)
    rf = RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                n_jobs=-1, random_state=42).fit(sc.transform(trn[feats].values),
                                                                trn["y"].astype(int).values)
    def reqp(wr): return (1-wr)/wr if wr>0 else np.nan

    print(f"\n## Cross-DB test (trained on the 4 earlier DBs)")
    for name, (df, _) in test_frames.items():
        dz = per_asset_z(df, feats); y = dz["y"].astype(int).values
        p = rf.predict_proba(sc.transform(dz[feats].values))[:,1]
        auc = roc_auc_score(y, p); mp = median_payout(dict(TEST_DBS)[name])
        print(f"\n### {name}  (n={len(df)} | AUC {auc:.3f} | median trade payout {mp*100:.0f}%)")
        print("| thr | dir | n | capture | WR | req payout | tradeable? |")
        print("|---|---|---|---|---|---|---|")
        for thr in (0.55, 0.60, 0.65):
            for lab, mask, win in (("CALL(up)", p>=thr, y), ("PUT(down)", p<=(1-thr), 1-y)):
                n = int(mask.sum())
                if n < 30: print(f"| {thr:.2f} | {lab} | {n} | — | thin | — | — |"); continue
                wr = win[mask].mean(); cap = n/len(p)*100; rq = reqp(wr)
                ok = "YES" if (wr>=be and cap>=3 and (np.isnan(mp) or rq<=mp)) else ""
                print(f"| {thr:.2f} | {lab} | {n} | {cap:.0f}% | {wr*100:.0f}% | {rq*100:.0f}% | {ok} |")
    print(f"\n(Believe a slice only if WR>=break-even AND capture>=3% AND req payout<=live payout, "
          "AND it repeats on BOTH test DBs. One-DB spikes = noise.)")

if __name__ == "__main__":
    main()
