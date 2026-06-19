#!/usr/bin/env python3
"""
real_data_wr.py — WR-only focus on real broker data. No payout. Push the confidence
threshold to find the win-rate ceiling per direction, and where it REPLICATES across
both held-out real DBs (td_main + td_LIVE).

Trained on the 4 earlier trading_data DBs (per-asset-Z, asset_enc dropped, contiguous
15m labels), same as real_data_search. Reports WR / n / capture by direction (CALL=up,
PUT=down) at thresholds 0.55..0.82, per test DB + pooled, plus the cross-DB MIN-WR
(the honest number — a slice is only as good as its worst DB).

Usage: python real_data_wr.py
"""
from __future__ import annotations
import os, sys, importlib.util
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("rds", os.path.join(HERE, "real_data_search.py"))
rds = importlib.util.module_from_spec(spec); spec.loader.exec_module(rds)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

THRS = [0.55, 0.60, 0.65, 0.70, 0.75, 0.82]

def main():
    train_frames = {n: rds.engineer(db) for n, db in rds.TRAIN_DBS}
    test_frames  = {n: rds.engineer(db) for n, db in rds.TEST_DBS}
    feats = sorted(set.intersection(*[set(f) for _, f in
                   list(train_frames.values())+list(test_frames.values())]))
    trn = pd.concat([rds.per_asset_z(df, feats) for df,_ in train_frames.values()], ignore_index=True)
    sc = StandardScaler().fit(trn[feats].values)
    rf = RandomForestClassifier(n_estimators=300, max_depth=8, min_samples_leaf=20,
                                n_jobs=-1, random_state=42).fit(sc.transform(trn[feats].values),
                                                                trn["y"].astype(int).values)
    # score each test DB
    P = {}
    for name, (df, _) in test_frames.items():
        dz = rds.per_asset_z(df, feats); y = dz["y"].astype(int).values
        p = rf.predict_proba(sc.transform(dz[feats].values))[:,1]
        P[name] = (p, y);
        print(f"[{name}] n={len(df)} AUC {roc_auc_score(y,p):.3f}")
    names = list(P.keys())

    def wr(name, thr, direction):
        p, y = P[name]
        mask = p>=thr if direction=="CALL" else p<=(1-thr)
        win = y if direction=="CALL" else 1-y
        n = int(mask.sum())
        return (win[mask].mean()*100 if n>=20 else np.nan, n, n/len(p)*100)

    print(f"\n# WR ceiling by confidence threshold (no payout) — cross-DB consistency")
    for direction in ("PUT", "CALL"):
        print(f"\n## {direction} ({'down' if direction=='PUT' else 'up'})")
        print("| thr | " + " | ".join(f"{n} WR (n,cap)" for n in names) + " | MIN-WR (both) |")
        print("|---|" + "---|"*(len(names)+1))
        for thr in THRS:
            cells=[]; wrs=[]
            for nm in names:
                w,n,cap = wr(nm, thr, direction)
                cells.append(f"{w:.0f}% ({n},{cap:.0f}%)" if np.isfinite(w) else f"thin({n})")
                wrs.append(w)
            mn = np.nanmin(wrs) if any(np.isfinite(x) for x in wrs) else np.nan
            both = f"**{mn:.0f}%**" if np.isfinite(mn) and all(np.isfinite(x) for x in wrs) else "—"
            print(f"| {thr:.2f} | " + " | ".join(cells) + f" | {both} |")
    print("\n(MIN-WR = the lower of the two DBs at that slice — the honest, replicated number. "
          "Higher threshold -> higher WR but smaller n; trust MIN-WR only where both n>=20.)")

if __name__ == "__main__":
    main()
