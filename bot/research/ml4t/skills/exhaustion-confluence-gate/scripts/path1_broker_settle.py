#!/usr/bin/env python3
"""
path1_broker_settle.py — validate the model's candle-proxy WR against BROKER-SETTLED truth.

The bot trades 15-min expiry == our horizon=3. So each settled trades_ordered row gives the
broker's ground-truth 15m direction at that candle:
    winning_dir = trade.direction        if result == WIN
                = opposite(trade.direction) if result == LOSS
We score OUR model's prediction at that same candle against winning_dir -> a real
BROKER-SETTLED win rate (not the candle-close proxy).

Model trained on the 4 earlier trading_data DBs (per-asset-Z, asset_enc dropped); tested on
td_main + td_LIVE where the bot actually traded. Reports:
  A. all matched trades: model argmax (p>=0.5 -> CALL) broker-settled accuracy (max n)
  B. confident-slice broker WR by threshold + direction (small n -> directional evidence)
Caveat: the bot made only ~65 settled trades total, so n is small — this is a reality
anchor, not a powered test.

Usage: python path1_broker_settle.py
"""
from __future__ import annotations
import os, sys, importlib.util, sqlite3
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("rds", os.path.join(HERE, "real_data_search.py"))
rds = importlib.util.module_from_spec(spec); spec.loader.exec_module(rds)
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

def flip(d): return "PUT" if d == "CALL" else "CALL"

def load_trades(db):
    con = sqlite3.connect(f"file:{rds.R(db)}?mode=ro&immutable=1", uri=True)
    try:
        # candle ts via signal join; fall back to entry_timestamp floored to bar
        t = pd.read_sql_query("""
            SELECT t.asset, t.direction, t.result, t.entry_timestamp,
                   COALESCE(s.timestamp, (t.entry_timestamp/300)*300) AS cts
            FROM trades_ordered t LEFT JOIN signals s ON s.id = t.signal_id
            WHERE t.result IN ('WIN','LOSS')""", con)
    finally: con.close()
    t["win_dir"] = np.where(t["result"]=="WIN", t["direction"], t["direction"].map(flip))
    return t

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
    print("# Path 1 — broker-settled validation of the model's signals\n")
    for name, db in rds.TEST_DBS:
        df, _ = test_frames[name]
        dz = rds.per_asset_z(df, feats)
        dz["p"] = rf.predict_proba(sc.transform(dz[feats].values))[:,1]
        look = dz.set_index(["asset","timestamp"])["p"].to_dict()
        tr = load_trades(db)
        tr["p"] = [look.get((a, int(c)), np.nan) for a, c in zip(tr["asset"], tr["cts"])]
        m = tr.dropna(subset=["p"])
        print(f"## {name}: {len(tr)} settled trades, {len(m)} matched to a model candle "
              f"(bot raw WR {(tr['result']=='WIN').mean()*100:.0f}%)")
        if len(m) < 5:
            print("  (too few matches)\n"); continue
        # A. argmax accuracy
        m_bet = np.where(m["p"]>=0.5, "CALL", "PUT")
        accA = (m_bet == m["win_dir"]).mean()*100
        print(f"  A. model argmax (p>=0.5) broker-settled WR: {accA:.0f}%  (n={len(m)})")
        # B. confident slices
        print("  B. | thr | dir | n | broker WR |")
        print("     |---|---|---|---|")
        for thr in (0.55, 0.60, 0.65):
            for d, mask in (("CALL", m["p"]>=thr), ("PUT", m["p"]<=(1-thr))):
                sub = m[mask]; n=len(sub)
                if n < 4: print(f"     | {thr:.2f} | {d} | {n} | thin |"); continue
                wr = (np.where(sub["p"]>=0.5,"CALL","PUT") == sub["win_dir"]).mean()*100
                # direction-pure: our bet is d for the whole slice
                wr_d = (sub["win_dir"]==d).mean()*100
                print(f"     | {thr:.2f} | {d} | {n} | {wr_d:.0f}% |")
        print()
    print("(broker WR = our predicted direction matched the broker-settled winning direction. "
          "Small n — a reality anchor on the candle-proxy WR, not a powered test.)")

if __name__ == "__main__":
    main()
