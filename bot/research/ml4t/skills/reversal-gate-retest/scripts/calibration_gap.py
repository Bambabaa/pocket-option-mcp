#!/usr/bin/env python3
"""
calibration_gap.py — Method 2 (concept-drift) drift quantifier.

For every gate-fired bar, compares the model's predicted P(decay) (score) against the
REALIZED decay rate at that bar (close[t+3] reversed vs the 3-bar move) — measured
directly from candles, so it's direction-independent and uses ALL fires, not just the
ones that became trades. Tracks calibration_gap = mean(score) - realized_decay per day.

A widening gap = concept drift (inputs->outcome relationship moved): the model stays
confident while reality stops agreeing. This is the LAGGING confirmation of Method 1
(needs settled outcomes), and its slope sizes how fast edge crosses break-even.

Usage: python calibration_gap.py
"""
from __future__ import annotations
import json, os, sys
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", ".."))
P = json.load(open(os.path.join(HERE, "..", "ml_gate_params_deployed.json")))
GATE = P["thresholds"]["gate"]; FEATS = P["features"]; BAR, N = 300, 3
def R(p): return os.path.join(ROOT, p)
DBS = ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db",
       "data/trading_data_08220.db","data/trading_data.db"]

def tree_p(x):
    n = P["tree"]
    while not n["leaf"]:
        n = n["left"] if x[n["feature"]] <= n["threshold"] else n["right"]
    return n["proba"]
def logreg_p(x):
    lr = P["logreg"]
    z = (np.array(x) - lr["scaler_mean"]) / lr["scaler_scale"]
    return 1.0 / (1.0 + np.exp(-(np.dot(z, lr["coef"]) + lr["intercept"])))

def build():
    parts = [po_data.load(R(db)) for db in DBS]
    df = pd.concat(parts, ignore_index=True)
    rows = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close, ts = g["close"].astype(float), g["timestamp"]
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        g["BB_Deviation"]     = (close - g["bb_lower"]) / band
        g["CCI_Velocity"]     = g["cci_20"].diff(2) / 2.0
        g["Stoch_Divergence"] = (g["stoch_k"] - g["stoch_d"]).abs()
        g["STC_Momentum"]     = g["stc_value"].diff(1)
        recent = close - close.shift(N); fwd = close.shift(-N) - close
        contig = (ts.shift(-N) - ts == N*BAR) & (ts - ts.shift(N) == N*BAR)
        g["decay"] = ((np.sign(fwd) != np.sign(recent)) & contig & (recent != 0)).astype(float)
        g.loc[~(contig & (recent != 0)), "decay"] = np.nan
        g["day"] = pd.to_datetime(ts, unit="s").dt.strftime("%Y-%m-%d")
        rows.append(g)
    d = pd.concat(rows).dropna(subset=FEATS + ["decay"])
    X = d[FEATS].values
    d["p_tree"]   = [tree_p(x) for x in X]
    d["p_logreg"] = [logreg_p(x) for x in X]
    d["score"]    = d[["p_tree","p_logreg"]].max(axis=1)   # the arm that fired
    d["fired"]    = (d["p_tree"] >= GATE) | (d["p_logreg"] >= GATE)
    return d

def main():
    d = build(); f = d[d["fired"]]
    print(f"\n# Calibration gap by day — predicted P(decay) vs REALIZED decay at fired bars")
    print(f"gap = mean(score) - realized decay rate.  positive & widening = concept drift.\n")
    print("| day | fired n | mean score | realized decay | gap | over-confidence |")
    print("|---|---|---|---|---|---|")
    g = f.groupby("day")
    rows = []
    for day, sub in g:
        n = len(sub)
        if n < 5:
            print(f"| {day} | {n} | — | — | — | thin |"); continue
        ms, rd = sub["score"].mean(), sub["decay"].mean()
        gap = ms - rd
        rows.append((day, rd, gap))
        print(f"| {day} | {n} | {ms:.3f} | {rd:.3f} | {gap:+.3f} | {gap/ms*100:+.0f}% |")
    # slope of realized decay over days (the decay-rate-of-the-edge)
    if len(rows) >= 2:
        xs = np.arange(len(rows)); rd = np.array([r[1] for r in rows])
        slope = np.polyfit(xs, rd, 1)[0]
        print(f"\nRealized decay-at-fire: {rows[0][1]*100:.0f}% (day1) -> {rows[-1][1]*100:.0f}% "
              f"(day{len(rows)}), slope {slope*100:+.1f} pts/day.")
        print("Score stays ~constant (model is sure); realized decay falls => the score stops "
              "carrying information. break-even decay ~ 1/(1+payout); at ~69% payout ~ 0.59.")

if __name__ == "__main__":
    main()
