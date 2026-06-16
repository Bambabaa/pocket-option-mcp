#!/usr/bin/env python3
"""
horizon_sweep.py — does ANY prediction timeframe carry edge on agent.db?

The deployed gate predicts a 3-bar (15m) reversal; we also tried 6-bar (30m) — both
coin flips. This sweeps the FORWARD HORIZON across 1..24 bars (5min..2h) and asks, at
each horizon, whether any 5m-indicator feature separates winners from losers, with the
within-sample lie detector (early-half vs late-half must agree, |AUC-0.5|>0.03).

Target at horizon H = continuation: did the recent 3-bar move keep going over H bars
(sign(close[t+H]-close[t]) == sign(close[t]-close[t-3]))? (reversal = complement, same AUC.)

Features are side-folded so bull/bear setups align. If max|AUC-0.5| stays ~0.51 at every
horizon -> no edge at any timeframe on this feature set -> the limit is the inputs.

Usage: python horizon_sweep.py
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
def R(p): return os.path.join(ROOT, p)
BAR = 300
HORIZONS = [3, 6, 12, 24, 36, 48, 72, 96]   # bars -> 15,30,60,120,180,240,360,480 min

def build():
    d = po_data.load(R("agent/data/agent.db"))
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, ts = g["close"].astype(float), g["timestamp"]
        atr = g["atr_14"].replace(0, np.nan); band = (g["bb_upper"]-g["bb_lower"]).replace(0, np.nan)
        recent = c - c.shift(3); sign = np.sign(recent)
        feat = {
            "rsi":(g["rsi_14"],50),"stoch_k":(g["stoch_k"],50),"stoch_kd":(g["stoch_k"]-g["stoch_d"],0),
            "cci":(g["cci_20"],0),"stc":(g["stc_value"],50),"williams":(g["williams_14"],-50),
            "macd_hist":(g["macd_hist"],0),"di_spread":(g["adx_plus_di"]-g["adx_minus_di"],0),
            "close_sma50":((c-g["sma_50"])/atr,0),"pctB":((c-g["bb_lower"])/band,0.5),
            "ema_spread":((g["ema_12"]-g["ema_26"])/atr,0),"rsi_d":(g["rsi_14"].diff(1),0),
            "cci_v":(g["cci_20"].diff(2)/2,0),"stc_d":(g["stc_value"].diff(1),0),
        }
        for n,(s,ctr) in feat.items(): g["x_"+n] = ctr + sign*(s.astype(float)-ctr)
        g["x_adx"]=g["adx_14"]; g["x_atr"]=atr; g["x_bbw"]=g["bb_width_bps"]
        g["_sign"]=sign; g["_recent_ok"]=(ts-ts.shift(3)==3*BAR)&(recent!=0)
        for H in HORIZONS:
            fwd = c.shift(-H)-c; okH=(ts.shift(-H)-ts==H*BAR)
            g[f"cont_{H}"]=np.where(okH & g["_recent_ok"], (np.sign(fwd)==sign).astype(float), np.nan)
        rows.append(g)
    out = pd.concat(rows)
    out["day"]=pd.to_datetime(out["timestamp"],unit="s").dt.strftime("%Y-%m-%d")
    return out, [c for c in out.columns if c.startswith("x_")]

def auc(y,x):
    m=~np.isnan(x) & ~np.isnan(y)
    if m.sum()<200 or len(np.unique(y[m]))<2: return np.nan
    try: return roc_auc_score(y[m],x[m])
    except Exception: return np.nan

def main():
    d,xcols=build(); days=sorted(d["day"].unique()); mid=days[len(days)//2]
    early=d[d["day"]<mid]; late=d[d["day"]>=mid]
    print(f"# Horizon sweep — agent.db ({len(xcols)} features). Edge at ANY timeframe?")
    print(f"bars {len(d)} | lie detector: early<{mid} vs late>= must agree, |AUC-0.5|>0.03\n")
    print("| horizon | min | base rate | best feature | best |AUC-.5| | top-20% WR | # surv |")
    print("|---|---|---|---|---|---|---|")
    for H in HORIZONS:
        tgt=f"cont_{H}"; base=d[tgt].mean()
        best_f, best_dev = None, 0.0; surv=0
        for f in xcols:
            aa=auc(d[tgt].values,d[f].values)
            ae=auc(early[tgt].values,early[f].values); al=auc(late[tgt].values,late[f].values)
            if any(np.isnan(v) for v in (aa,ae,al)): continue
            dev=abs(aa-0.5)
            if dev>best_dev: best_dev, best_f = dev, f
            if (ae-0.5)*(al-0.5)>0 and min(abs(ae-0.5),abs(al-0.5))>0.03: surv+=1
        # WR of betting continuation on the top-20% by the best feature (sign so higher->win)
        wr="—"
        if best_f:
            x=d[best_f].values; y=d[tgt].values; m=~np.isnan(x)&~np.isnan(y)
            xv,yv=x[m],y[m]
            aa=auc(yv,xv); s=1 if aa>=0.5 else -1
            k=max(50,int(len(xv)*0.20)); idx=np.argsort(-s*xv)[:k]
            wr=f"{yv[idx].mean()*100:.1f}%"
        print(f"| {H} | {H*5} | {base*100:.1f}% | {best_f[2:] if best_f else '—'} | {best_dev:.3f} | {wr} | {surv} |")
    print("\nRead: best |AUC-0.5| ~0.01-0.02 at every horizon AND 0 survivors => no single-feature "
          "edge at any timeframe 5min-2h. (Nonlinear interactions ruled out separately by Test B tree.)")

if __name__ == "__main__":
    main()
