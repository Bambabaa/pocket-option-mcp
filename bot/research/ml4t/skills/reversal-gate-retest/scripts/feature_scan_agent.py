#!/usr/bin/env python3
"""
feature_scan_agent.py — does ANY indicator carry a reversal/continuation edge on
agent.db (15 assets, big n), where the deployed 4 features did not?

Label = decay (15m, 3-bar reversal), direction-independent. Directional features are
side-folded (center + sign*(x-center), side = sign of the recent 3-bar move) so
"stretched up about to reverse" and "stretched down about to reverse" align; magnitude
features (atr/adx/bb_width) used raw. For every feature: AUC vs decay, plus a within-agent
lie detector — AUC on the EARLY half of days vs the LATE half. Survivor = same direction
both halves AND min|AUC-0.5| > 0.03. Band-WR curves for any survivor.

If nothing survives: the edge isn't in the indicator set at this timeframe -> concede.

Usage: python feature_scan_agent.py
"""
from __future__ import annotations
import os, sys
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
BAR, N, BE = 300, 3, 0.59
def R(p): return os.path.join(ROOT, p)

def build():
    d = po_data.load(R("agent/data/agent.db"))
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, ts = g["close"].astype(float), g["timestamp"]
        atr = g["atr_14"].replace(0, np.nan)
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        # ---- features (raw magnitude vs directional, folded later) ----
        F = {}
        # directional level/oscillator (center, fold)
        F["rsi"]        = (g["rsi_14"], 50)
        F["stoch_k"]    = (g["stoch_k"], 50)
        F["stoch_d"]    = (g["stoch_d"], 50)
        F["williams"]   = (g["williams_14"], -50)
        F["cci"]        = (g["cci_20"], 0)
        F["stc"]        = (g["stc_value"], 50)
        F["macd_hist"]  = (g["macd_hist"], 0)
        F["di_spread"]  = (g["adx_plus_di"] - g["adx_minus_di"], 0)
        F["stoch_kd"]   = (g["stoch_k"] - g["stoch_d"], 0)
        F["ema_spread"] = ((g["ema_12"] - g["ema_26"]) / atr, 0)
        F["sma_10_50"]  = ((g["sma_10"] - g["sma_50"]) / atr, 0)
        F["close_sma50"]= ((c - g["sma_50"]) / atr, 0)
        F["pctB"]       = ((c - g["bb_lower"]) / band, 0.5)
        F["close_kc"]   = ((c - g["kc_middle"]) / atr, 0)
        # velocities (center 0, fold)
        F["rsi_d"]      = (g["rsi_14"].diff(1), 0)
        F["cci_v"]      = (g["cci_20"].diff(2)/2, 0)
        F["stc_d"]      = (g["stc_value"].diff(1), 0)
        F["macd_hist_d"]= (g["macd_hist"].diff(1), 0)
        F["stoch_k_d"]  = (g["stoch_k"].diff(1), 0)
        # magnitudes (raw, not folded)
        MAG = {"adx": g["adx_14"], "atr": atr, "bb_width": g["bb_width_bps"],
               "kc_width": (g["kc_upper"]-g["kc_lower"])/atr,
               "cci_abs": g["cci_20"].abs(), "di_abs": (g["adx_plus_di"]-g["adx_minus_di"]).abs()}
        recent = c - c.shift(N); fwd = c.shift(-N) - c
        contig = (ts.shift(-N) - ts == N*BAR) & (ts - ts.shift(N) == N*BAR)
        g["decay"] = ((np.sign(fwd) != np.sign(recent)) & contig & (recent != 0)).astype(float)
        g.loc[~(contig & (recent != 0)), "decay"] = np.nan
        sign = np.sign(recent)
        for name,(series,center) in F.items():
            g["f_"+name] = center + sign*(series.astype(float) - center)
        for name,series in MAG.items():
            g["f_"+name] = series.astype(float)
        g["day"] = pd.to_datetime(ts, unit="s").dt.strftime("%Y-%m-%d")
        rows.append(g)
    out = pd.concat(rows)
    fcols = [c for c in out.columns if c.startswith("f_")]
    return out.dropna(subset=["decay"]), fcols

def auc(y, x):
    m = ~np.isnan(x)
    if m.sum() < 200 or len(np.unique(y[m])) < 2: return np.nan
    try: return roc_auc_score(y[m], x[m])
    except Exception: return np.nan

def main():
    d, fcols = build()
    days = sorted(d["day"].unique())
    mid = days[len(days)//2]
    early = d[d["day"] < mid]; late = d[d["day"] >= mid]
    print(f"# Feature scan on agent.db — single-feature reversal edge (AUC vs decay)")
    print(f"bars {len(d)} | early<{mid} n={len(early)} | late>= n={len(late)} | base decay {d['decay'].mean()*100:.1f}%")
    print(f"AUC>0.5 => higher folded value predicts decay (a fade WIN). Survivor: same dir both halves & min|dev|>0.03\n")
    rows = []
    for f in fcols:
        a_all = auc(d["decay"].values, d[f].values)
        a_e   = auc(early["decay"].values, early[f].values)
        a_l   = auc(late["decay"].values,  late[f].values)
        if any(np.isnan(v) for v in (a_all,a_e,a_l)): continue
        same = (a_e-0.5)*(a_l-0.5) > 0
        cons = min(abs(a_e-0.5), abs(a_l-0.5)) if same else 0.0
        rows.append((f[2:], a_all, a_e, a_l, same, cons))
    rows.sort(key=lambda r: -r[5])
    print("| feature | AUC all | AUC early | AUC late | same dir? | min|dev| |")
    print("|---|---|---|---|---|---|")
    for f,aa,ae,al,same,cons in rows:
        flag = "SURVIVES" if same and cons>0.03 else ("aligned" if same else "")
        print(f"| {f} | {aa:.3f} | {ae:.3f} | {al:.3f} | {'yes' if same else 'no'} | {cons:.3f} {flag} |")
    surv = [r for r in rows if r[4] and r[5]>0.03]
    print(f"\nmax |AUC-0.5| over all features (all-sample): {max(abs(r[1]-0.5) for r in rows):.3f}")
    if surv:
        print(f"\n## Band fade-WR for survivors (folded low->high)")
        for f,*_ in surv[:4]:
            col="f_"+f; v=d[col].values; ed=np.unique(np.quantile(v[~np.isnan(v)],np.linspace(0,1,6)))
            print(f"\n### {f}"); print("| band | WR | n |"); print("|---|---|---|")
            for q in range(len(ed)-1):
                m=(v>=ed[q])&(v<=ed[q+1])&d["decay"].notna()
                if m.sum()>=50: print(f"| [{ed[q]:.2g},{ed[q+1]:.2g}] | {d['decay'].values[m].mean()*100:.0f}% | {int(m.sum())} |")
    else:
        print("\nNo feature separates reversal winners from losers consistently across both halves.")
        print(f"=> the edge is NOT in the indicator set at 5m/15m. Concede or change timeframe/target.")

if __name__ == "__main__":
    main()
