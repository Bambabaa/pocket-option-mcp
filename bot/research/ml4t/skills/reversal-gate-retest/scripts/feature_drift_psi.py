#!/usr/bin/env python3
"""
feature_drift_psi.py — Method 1 (covariate-shift) drift quantifier.

Compares the gate's 4 input features between a GOOD day and a BAD day, on the bars
where the gate actually FIRED (score>=0.85, either arm). Reports PSI + mean-shift in
training-std units per feature. PSI<0.1 stable | 0.1-0.25 moderate | >0.25 significant.

This is the REAL-TIME-usable drift signal: it needs only live indicator values, no
trade outcomes, so it can act as a bot trip-wire that pauses trading between recalibs.

Usage: python feature_drift_psi.py
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
GATE = P["thresholds"]["gate"]; FEATS = P["features"]; BAR = 300
def R(p): return os.path.join(ROOT, p)

# good day 06-03 lives in 5-03; bad day 06-05 lives in 00
DBS = ["data/trading_data_5-03.db", "data/trading_data00.db"]
GOOD, BAD = "2026-06-03", "2026-06-05"

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
    parts = []
    for db in DBS:
        d = po_data.load(R(db)); parts.append(d)
    df = pd.concat(parts, ignore_index=True)
    rows = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close = g["close"].astype(float)
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        g["BB_Deviation"]     = (close - g["bb_lower"]) / band
        g["CCI_Velocity"]     = g["cci_20"].diff(2) / 2.0
        g["Stoch_Divergence"] = (g["stoch_k"] - g["stoch_d"]).abs()
        g["STC_Momentum"]     = g["stc_value"].diff(1)
        g["day"] = pd.to_datetime(g["timestamp"], unit="s").dt.strftime("%Y-%m-%d")
        rows.append(g)
    d = pd.concat(rows).dropna(subset=FEATS)
    X = d[FEATS].values
    d["p_tree"]   = [tree_p(x) for x in X]
    d["p_logreg"] = [logreg_p(x) for x in X]
    d["fired"] = (d["p_tree"] >= GATE) | (d["p_logreg"] >= GATE)
    return d

def psi(ref, tgt, bins=10):
    # deciles of the reference; clip target into them; PSI = sum (t-r) ln(t/r)
    edges = np.quantile(ref, np.linspace(0, 1, bins + 1))
    edges[0], edges[-1] = -np.inf, np.inf
    edges = np.unique(edges)
    r = np.histogram(ref, edges)[0] / len(ref)
    t = np.histogram(tgt, edges)[0] / len(tgt)
    r = np.clip(r, 1e-4, None); t = np.clip(t, 1e-4, None)
    return float(np.sum((t - r) * np.log(t / r)))

def main():
    d = build()
    fired = d[d["fired"]]
    g = fired[fired["day"] == GOOD]; b = fired[fired["day"] == BAD]
    print(f"\n# Feature-drift PSI — gate-fired bars, {GOOD} (good) vs {BAD} (bad)")
    print(f"fired bars: {GOOD} n={len(g)} | {BAD} n={len(b)}   (gate score >= {GATE})\n")
    print("| feature | good mean | bad mean | shift (train-sd) | PSI | verdict |")
    print("|---|---|---|---|---|---|")
    sm = {f: m for f, m in zip(P["logreg"]["scaler_mean"], [None])} if False else None
    means = dict(zip(FEATS, P["logreg"]["scaler_mean"]))
    scales = dict(zip(FEATS, P["logreg"]["scaler_scale"]))
    for f in FEATS:
        gv, bv = g[f].values, b[f].values
        if len(gv) < 5 or len(bv) < 5:
            print(f"| {f} | — | — | — | — | thin n |"); continue
        shift = (bv.mean() - gv.mean()) / (scales[f] or 1)
        p = psi(gv, bv)
        v = "STABLE" if p < 0.1 else ("MODERATE" if p < 0.25 else "SIGNIFICANT")
        print(f"| {f} | {gv.mean():.3f} | {bv.mean():.3f} | {shift:+.2f} | {p:.3f} | {v} |")
    # also: drift vs TRAINING distribution (scaler mean), the absolute reference
    print(f"\n## vs TRAINING baseline (scaler mean +/- 1 sd), bad-day fired bars")
    print("| feature | train mean | bad mean | dist (train-sd) |")
    print("|---|---|---|---|")
    for f in FEATS:
        bv = b[f].values
        if len(bv) < 5: continue
        print(f"| {f} | {means[f]:.3f} | {bv.mean():.3f} | {(bv.mean()-means[f])/(scales[f] or 1):+.2f} |")
    print("\nPSI: <0.1 stable | 0.1-0.25 moderate | >0.25 significant (retrain trigger). "
          "Shift in training-std units = how far the live inputs moved from where the model was fit.")

if __name__ == "__main__":
    main()
