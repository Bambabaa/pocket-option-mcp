#!/usr/bin/env python3
"""
reversal_gate_retest.py — Stage 1 retest of the DEPLOYED reversal gate, skill-only.

Runs the exact frozen tree + logreg (ml_gate_params_deployed.json, the 4 kinetic
features) over every DB and asks ONE question, payout removed:

  On the bars the gate FIRES (P_decay >= 0.85, no payout floor), does its selection
  beat the base rate — in either direction (fade / follow) — out-of-sample?

Label = the gate's own: decay = sign(close[t+3]) != sign(close[t]-close[t-3]) (15m).
  fade WR   = decay realized (bet AGAINST the 3-bar move) = the gate's training target
  follow WR = 1 - fade WR     (bet WITH the move = the bot's live TREE behavior)
Base rates per DB show what doing-nothing gets; the gate only has skill if FIRED WR
beats BASE WR. required_payout = (1-WR)/WR bridges to execution (reported, not gated).

Models reproduce ml-gate.js exactly (tree walk; logreg standardize+sigmoid).

Usage: python reversal_gate_retest.py
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
GATE = P["thresholds"]["gate"]
BAR, N = 300, 3   # 15m horizon = 3 bars
def R(p): return os.path.join(ROOT, p)
REGIMES = {
    "FXSB (Apr-May)":  ["agent/data/agent_FXSB.db"],
    "June pool":       ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db","data/trading_data.db"],
    "agent (forward)": ["agent/data/agent.db"],
    "live (Jun8-10)":  ["data/trading_data.db"],
}

def tree_p(x):
    n = P["tree"]
    while not n["leaf"]:
        n = n["left"] if x[n["feature"]] <= n["threshold"] else n["right"]
    return n["proba"]

def logreg_p(x):
    lr = P["logreg"]
    z = (np.array(x) - lr["scaler_mean"]) / lr["scaler_scale"]
    return 1.0 / (1.0 + np.exp(-(np.dot(z, lr["coef"]) + lr["intercept"])))

def build(dbs):
    parts = []
    for i, db in enumerate(dbs):
        d = po_data.load(R(db))
        if len(dbs) > 1: d["asset"] = d["asset"] + f"@{i}"
        parts.append(d)
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
        recent = close - close.shift(N)
        fwd    = close.shift(-N) - close
        contiguous = (ts.shift(-N) - ts == N*BAR) & (ts - ts.shift(N) == N*BAR)
        g["fade_win"] = ((np.sign(fwd) != np.sign(recent)) & contiguous & (recent != 0)).astype(float)
        g.loc[~(contiguous & (recent != 0)), "fade_win"] = np.nan
        rows.append(g)
    d = pd.concat(rows)
    feats = P["features"]
    d = d.dropna(subset=feats + ["fade_win"])
    X = d[feats].values
    d["p_tree"]   = [tree_p(x) for x in X]
    d["p_logreg"] = [logreg_p(x) for x in X]
    return d

def req_payout(wr):  # payout at which WR breaks even
    return (1-wr)/wr if wr > 0 else np.nan

def line(name, sub, base_fade):
    n = len(sub)
    if n < 10:
        return f"| {name} | {n} | — | — | — |"
    fade = sub["fade_win"].mean(); follow = 1 - fade
    rqf = req_payout(fade); rqo = req_payout(follow)
    up = fade - base_fade   # selection uplift on the fade(=decay) axis
    return (f"| {name} | {n} | {fade*100:.1f}% (need {rqf*100:.0f}%) | "
            f"{follow*100:.1f}% (need {rqo*100:.0f}%) | {up*100:+.1f}pts |")

def main():
    print(f"\n# Deployed reversal-gate retest — skill only (gate P_decay>={GATE}, NO payout floor)")
    print("fade = bet against 3-bar move (gate's target) | follow = bet with it (bot's live tree)\n")
    for reg, dbs in REGIMES.items():
        d = build(dbs)
        base_fade = d["fade_win"].mean()
        print(f"## {reg}   (bars {len(d)} | base: fade {base_fade*100:.1f}% / follow {(1-base_fade)*100:.1f}%)")
        print("| selection | n | fade WR (req payout) | follow WR (req payout) | fade uplift vs base |")
        print("|---|---|---|---|---|")
        print(line("ALL bars", d, base_fade))
        print(line(f"TREE fires (>={GATE})",   d[d["p_tree"]   >= GATE], base_fade))
        print(line(f"LOGREG fires (>={GATE})", d[d["p_logreg"] >= GATE], base_fade))
        # also a softer percentile gate (the honest-calibration view)
        for nm, col in [("TREE top-10%", "p_tree"), ("LOGREG top-10%", "p_logreg")]:
            thr = d[col].quantile(0.90)
            print(line(f"{nm} (>={thr:.2f})", d[d[col] >= thr], base_fade))
        print()
    print("Read: a model has SKILL only if FIRED fade-WR beats the base fade rate (uplift > 0). "
          "follow WR = 1-fade. 'need X%' = payout required to break even at that WR (execution layer).")

if __name__ == "__main__":
    main()
