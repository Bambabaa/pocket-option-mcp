#!/usr/bin/env python3
"""
expiry_sweep.py — fade-WR of the frozen Two-Key gate's onsets across EXPIRY
timeframes (5/10/15/20/25/30m), the full breakdown.

Loads an onset _full CSV (must be at the gate's mask) + the frozen
ml_gate_params.json, reproduces the gate's verdict per row (Q1 Consensus /
Model Abstention / Heuristic Trap) exactly like test_gate.js (NaN feature → 0
contribution; side-normalized heuristic fold), then tabulates fade win-rate at
each expiry, broken down by verdict, side, and onset driver.

fade win @ h: bullish_exhaustion → fwd_h < 0 ; bearish → fwd_h > 0.

Usage:
  python expiry_sweep.py --csv <onsets_*_4.0_full.csv> [--params <ml_gate_params.json>]
"""
from __future__ import annotations
import argparse, json, os, sys
import numpy as np
import pandas as pd

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
HORIZONS = [5, 10, 15, 20, 25, 30]
META = {"timestamp", "asset", "side", "p_decay", "p_decay_pct", "target_decay_realized"}

def load_csv(path):
    d = pd.read_csv(path)
    d.columns = [c.strip() for c in d.columns]
    d["side"] = d["side"].astype(str).str.strip()
    return d

def gate_verdict(d, P):
    """Reproduce test_gate.js per row → array of verdict strings."""
    feats = P["ml_model"]["features"]
    X = d[feats].astype(float).values
    mean = np.array(P["ml_model"]["scaler"]["means"]); scale = np.array(P["ml_model"]["scaler"]["scales"])
    w = np.array(P["ml_model"]["weights"]); b = P["ml_model"]["bias"]
    z = np.where(np.isnan(X), 0.0, (X - mean) / scale)      # NaN → 0 (matches JS gate)
    p_decay = 1.0 / (1.0 + np.exp(-(z @ w + b)))
    ml_pass = p_decay >= P["oos_threshold"]
    sign = np.where(d["side"].values == "bullish_exhaustion", 1.0, -1.0)
    heur = np.ones(len(d), bool)
    for r in P["heuristic_rule"]:
        v = d[r["feature"]].astype(float).values
        if r.get("side_normalized"):
            c = r.get("center", 0.0); v = c + sign * (v - c)
        heur &= (v > r["threshold"]) if r["operator"] == ">" else (v < r["threshold"])
    verdict = np.where(~heur, "Heuristic Trap", np.where(ml_pass, "Q1 Consensus", "Model Abstention"))
    return verdict, p_decay

def fade_win(d, h):
    bull = d["side"].values == "bullish_exhaustion"
    fwd = d[f"fwd_{h}m_ret"].values
    return np.where(bull, fwd < 0, fwd > 0).astype(float), ~np.isnan(fwd)

def row(d, mask, label, breakeven):
    sub = d[mask]
    cells, best = [], (None, -1)
    for h in HORIZONS:
        w, ok = fade_win(sub, h)
        valid = w[ok]
        wr = valid.mean() if len(valid) else np.nan
        mark = "✓" if (np.isfinite(wr) and wr > breakeven and len(valid) >= 20) else ""
        cells.append(f"{wr*100:.1f}{mark}" if np.isfinite(wr) else "—")
        if np.isfinite(wr) and len(valid) >= 20 and wr > best[1]:
            best = (h, wr)
    bests = f"**{best[0]}m {best[1]*100:.1f}%**" if best[0] else "—"
    print(f"| {label} | {int(mask.sum())} | " + " | ".join(cells) + f" | {bests} |")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--params", default=os.path.join(ROOT, "bot", "research", "tests", "ml_gate_params.json"))
    ap.add_argument("--payout", type=float, default=0.8)
    args = ap.parse_args()
    breakeven = 1.0 / (1.0 + args.payout)
    P = json.load(open(args.params))
    d = load_csv(args.csv)
    d["verdict"], d["p_decay_gate"] = gate_verdict(d, P)

    hcols = " | ".join(f"{h}m" for h in HORIZONS)
    print(f"\n# Expiry Sweep — {os.path.basename(args.csv)}   (gate {P['schema']}, break-even {breakeven*100:.1f}%)")
    counts = d["verdict"].value_counts().to_dict()
    print(f"onsets {len(d)}   verdict mix: " + ", ".join(f"{k} {counts.get(k,0)}"
          for k in ["Q1 Consensus","Model Abstention","Heuristic Trap"]))

    print(f"\n## Fade-WR by expiry × gate verdict")
    print(f"| segment | n | {hcols} | best |")
    print("|---|---|" + "---|"*len(HORIZONS) + "---|")
    row(d, pd.Series(True, index=d.index), "ALL onsets", breakeven)
    for v in ["Q1 Consensus", "Model Abstention", "Heuristic Trap"]:
        row(d, d["verdict"] == v, v, breakeven)

    q1 = d["verdict"] == "Q1 Consensus"
    print(f"\n## Q1 Consensus by side")
    print(f"| side | n | {hcols} | best |")
    print("|---|---|" + "---|"*len(HORIZONS) + "---|")
    for s in ["bullish_exhaustion", "bearish_exhaustion"]:
        row(d, q1 & (d["side"] == s), s.split("_")[0], breakeven)

    if q1.sum() >= 20 and "v_atr_pct_d" in d and "m_stoch_kd" in d:
        atr = d["v_atr_pct_d"].abs(); st = d["m_stoch_kd"].abs()
        fast = q1 & (atr.rank(pct=True) >= st.rank(pct=True))
        print(f"\n## Q1 Consensus by onset driver")
        print(f"| driver | n | {hcols} | best |")
        print("|---|---|" + "---|"*len(HORIZONS) + "---|")
        row(d, fast, "FAST (vol-shock)", breakeven)
        row(d, q1 & ~fast.reindex(d.index, fill_value=False), "SLOW (stoch grind)", breakeven)

    print("\n(WR cells are fade win-rate %; ✓ = clears break-even at n≥20. p_decay/heuristic reproduce "
          "test_gate.js exactly, so verdicts match the deployed native gate.)")

if __name__ == "__main__":
    main()
