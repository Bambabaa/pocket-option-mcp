#!/usr/bin/env python3
"""
new_feature_scan.py — test THREE features the gate's logistic never saw, through the
triple-regime lie detector. These need DB re-extraction (not in the onset CSVs):

  1. stoch_dv      = side·(stoch_d − stoch_prev_d)   — is %D already decelerating
                     against the stretch at onset? (all 3 regimes)
  2. consec_stretch= run-length of consecutive bars beyond the 4-ATR stretch before
                     the onset — spike (1-2) vs grind (many). (all 3 regimes)
  3. vol_spike     = volume / rolling_median(volume,50) — capitulation participation.
                     FXSB has candle volume; June derives it from the 1s tick stream;
                     agent.db has NEITHER → volume is FXSB+June only.

Within the onset population (mask 4.0/1.20, fade @10m), reports each feature's
winner/loser AUC in FXSB / June / agent side by side. Survivor = same direction in
every regime it can be measured AND min|AUC−0.5| > 0.02.

Usage: python new_feature_scan.py
"""
from __future__ import annotations
import os, sys, sqlite3
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)
REGIMES = {
    "FXSB":  ["agent/data/agent_FXSB.db"],
    "June":  ["data/trading_data_5-02.db","data/trading_data_5-03.db","data/trading_data00.db","data/trading_data.db"],
    "agent": ["agent/data/agent.db"],
}
BAR=300; STRETCH=4.0; SQ=1.20; N=2  # 10m

def load_volume(db):
    con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
    try:
        cv = pd.read_sql_query("SELECT asset, timestamp, volume FROM candles", con)
        if cv["volume"].fillna(0).sum() > 0:
            return cv                                            # real candle volume
        n = con.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
        if n == 0:
            return None                                          # no volume source
        px = pd.read_sql_query("SELECT asset, timestamp FROM prices", con)
    finally:
        con.close()
    px["timestamp"] = (px["timestamp"] // BAR) * BAR
    return px.groupby(["asset","timestamp"]).size().reset_index(name="volume")   # derived from ticks

def regime_table(dbs):
    parts = []
    for i, db in enumerate(dbs):
        df = po_data.load(R(db))
        vol = load_volume(R(db))
        df = df.merge(vol, on=["asset","timestamp"], how="left") if vol is not None else df.assign(volume=np.nan)
        if len(dbs) > 1:
            df["asset"] = df["asset"] + f"@{i}"
        parts.append(df)
    df = pd.concat(parts, ignore_index=True)
    X, _ = po_data.engineer_families(df)
    df["v_squeeze"], df["t_close_sma50"], df["m_stc_delta"] = X["v_squeeze"], X["t_close_sma50"], X["m_stc_delta"]

    out = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        close, ts, atr = g["close"].astype(float), g["timestamp"], g["atr_14"].astype(float)
        stretched = (close - g["sma_50"]).abs() / atr > STRETCH
        # consecutive run of stretched bars ending at each bar (incl current)
        run = np.zeros(len(g), int); c = 0
        for k, s in enumerate(stretched.values):
            c = c + 1 if s else 0; run[k] = c
        g["consec_stretch"] = run
        g["stoch_dv_raw"] = g["stoch_d"].astype(float) - g["stoch_prev_d"].astype(float)
        med = g["volume"].rolling(50, min_periods=10).median()
        g["vol_spike"] = np.where((med > 0) & g["volume"].notna(), g["volume"] / med, np.nan)
        # mask + side + fade@10m
        bull = (g["v_squeeze"] > SQ) & (g["t_close_sma50"] > STRETCH) & (g["m_stc_delta"] < 0)
        bear = (g["v_squeeze"] > SQ) & (g["t_close_sma50"] < -STRETCH) & (g["m_stc_delta"] > 0)
        fwd_c, fwd_t = close.shift(-N), ts.shift(-N)
        contiguous = (fwd_t - ts == N*BAR)
        win = np.where(bull, fwd_c < close, fwd_c > close).astype(float)
        sign = np.where(bull, 1.0, -1.0)
        g["onset"] = (bull | bear) & contiguous
        g["win"], g["sign"] = np.where(contiguous, win, np.nan), sign
        out.append(g)
    d = pd.concat(out)
    d = d[d["onset"] & d["win"].notna()].copy()
    d["stoch_dv"] = d["sign"] * d["stoch_dv_raw"]                 # fold into the fade frame
    return d[["win","stoch_dv","consec_stretch","vol_spike"]]

def auc(d, f):
    v = d[f].values; m = ~np.isnan(v)
    if m.sum() < 40 or len(np.unique(d["win"].values[m])) < 2: return np.nan
    try: return roc_auc_score(d["win"].values[m], v[m])
    except Exception: return np.nan

def main():
    T = {name: regime_table(dbs) for name, dbs in REGIMES.items()}
    print(f"\n# New-feature scan (DB-extracted) — fade-winner AUC within onsets @10m")
    print("n: " + " | ".join(f"{k} {len(v)}" for k, v in T.items()) +
          "   (AUC>0.5 ⇒ higher value predicts a fade WIN)\n")
    print("| feature | FXSB AUC | June AUC | agent AUC | same dir? | min|dev| |")
    print("|---|---|---|---|---|---|")
    for f in ["stoch_dv", "consec_stretch", "vol_spike"]:
        a = {k: auc(T[k], f) for k in T}
        meas = [v for v in a.values() if np.isfinite(v)]
        dev = [v-0.5 for v in meas]
        same = len(dev) >= 2 and (all(x > 0 for x in dev) or all(x < 0 for x in dev))
        cons = min(abs(x) for x in dev) if same else 0.0
        flag = "✓ SURVIVES" if same and cons > 0.02 else ("aligned" if same else "")
        cell = lambda v: "—" if not np.isfinite(v) else f"{v:.3f}"
        print(f"| {f} | {cell(a['FXSB'])} | {cell(a['June'])} | {cell(a['agent'])} | "
              f"{'yes' if same else 'no'} | {cons:.3f} {flag} |")

    # band curves for any survivor / near-miss
    print("\n## Quintile-band fade-WR (low→high), per regime")
    for f in ["consec_stretch", "stoch_dv", "vol_spike"]:
        allv = np.concatenate([T[k][f].dropna().values for k in T if T[k][f].notna().any()])
        if len(allv) < 20: continue
        edges = np.unique(np.quantile(allv, np.linspace(0, 1, 6)))
        if len(edges) < 3: continue
        print(f"\n### {f}")
        print("| band | FXSB | June | agent |")
        print("|---|---|---|---|")
        for q in range(len(edges)-1):
            cells = []
            for k in T:
                v = T[k][f].values; m = (v >= edges[q]) & (v <= edges[q+1]) & T[k]["win"].notna()
                cells.append(f"{T[k]['win'].values[m].mean()*100:.0f}% (n={int(m.sum())})" if m.sum() >= 8 else "—")
            lo, hi = edges[q], edges[q+1]
            print(f"| [{lo:.2g},{hi:.2g}] | " + " | ".join(cells) + " |")
    print("\n(Survivor = same direction in every measurable regime AND min|AUC−0.5|>0.02. vol_spike is "
          "FXSB+June only — agent.db has no volume or ticks.)")

if __name__ == "__main__":
    main()
