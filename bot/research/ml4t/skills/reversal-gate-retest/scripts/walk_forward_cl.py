#!/usr/bin/env python3
"""
walk_forward_cl.py — Walk-Forward Analysis of the CONTINUOUS-LEARNING architecture.

Tests the LOOP, not a static model: retrain every day, predict the next, day-by-day
through agent.db. Compares the two lookback designs head-to-head:

  EXPANDING : train on ALL prior days (Day8 <- 1-7, Day9 <- 1-8, ...). Max data; best
              if structure is stable.
  ROLLING   : train on a FIXED window that slides (Day8 <- 1-7, Day9 <- 2-8, ...).
              Forgets the distant past; best if the regime is non-stationary.

Target-agnostic so the same rig serves the next experiment:
  reversal_15m   : did a stretched move reverse in 3 bars (the deployed gate's target)
  continuation_30m: did the 3-bar move keep going over 6 bars (different horizon)

Each day: refit logreg (C=10, balanced, standardized) on the window (PURGED: drop train
bars whose label horizon peeks into the test day), fire its top-SEL most-confident bars,
bet the target direction. Reports per-day WR (expanding vs rolling side by side), pooled
WR vs break-even, day-WR stability (std), and equity max-drawdown — because for a
learning loop, CONSISTENCY across days matters as much as the pooled number.

Usage: python walk_forward_cl.py [--window 5] [--sel 0.20] [--payout 0.69]
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)
BAR = 300

def build():
    d = po_data.load(R("agent/data/agent.db"))
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, ts = g["close"].astype(float), g["timestamp"]
        atr = g["atr_14"].replace(0, np.nan)
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        recent = c - c.shift(3); sign = np.sign(recent)
        # folded feature set (symmetric to the recent move)
        feat = {
            "rsi":     (g["rsi_14"], 50), "stoch_k": (g["stoch_k"], 50),
            "stoch_kd":(g["stoch_k"]-g["stoch_d"], 0), "cci": (g["cci_20"], 0),
            "stc":     (g["stc_value"], 50), "williams": (g["williams_14"], -50),
            "macd_hist":(g["macd_hist"], 0), "di_spread": (g["adx_plus_di"]-g["adx_minus_di"], 0),
            "close_sma50":((c-g["sma_50"])/atr, 0), "pctB": ((c-g["bb_lower"])/band, 0.5),
            "ema_spread":((g["ema_12"]-g["ema_26"])/atr, 0),
            "rsi_d":   (g["rsi_14"].diff(1), 0), "cci_v": (g["cci_20"].diff(2)/2, 0),
            "stc_d":   (g["stc_value"].diff(1), 0),
        }
        for n,(s,ctr) in feat.items():
            g["x_"+n] = ctr + sign*(s.astype(float)-ctr)
        g["x_adx"] = g["adx_14"]; g["x_atr"] = atr; g["x_bbw"] = g["bb_width_bps"]  # raw mags
        # targets
        fwd3 = c.shift(-3) - c; fwd6 = c.shift(-6) - c
        c3 = (ts.shift(-3)-ts == 3*BAR); c6 = (ts.shift(-6)-ts == 6*BAR)
        ok3 = c3 & (ts-ts.shift(3) == 3*BAR) & (recent != 0)
        g["reversal_15m"] = np.where(ok3, (np.sign(fwd3) != sign).astype(float), np.nan)
        ok6 = c6 & (ts-ts.shift(3) == 3*BAR) & (recent != 0)
        g["continuation_30m"] = np.where(ok6, (np.sign(fwd6) == sign).astype(float), np.nan)
        g["lab_h"] = 6  # max label horizon bars (for purge)
        rows.append(g)
    out = pd.concat(rows)
    out["day"] = pd.to_datetime(out["timestamp"], unit="s").dt.strftime("%Y-%m-%d")
    xcols = [col for col in out.columns if col.startswith("x_")]
    return out, xcols

def fit_predict(tr, te, xcols, target):
    Xtr = tr[xcols].values; ytr = tr[target].astype(int).values
    Xte = te[xcols].values
    if len(np.unique(ytr)) < 2: return None
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(C=10.0, class_weight="balanced", max_iter=500)
    lr.fit(sc.transform(Xtr), ytr)
    return lr.predict_proba(sc.transform(Xte))[:, 1]

def run(d, xcols, target, mode, W, sel):
    days = sorted(d["day"].unique())
    day_start = {dd: d[d["day"]==dd]["timestamp"].min() for dd in days}
    per_day = []; trades = []  # trades: 1=win 0=loss for equity
    start = W
    for i in range(start, len(days)):
        day = days[i]
        train_days = days[:i] if mode == "expanding" else days[max(0,i-W):i]
        tr = d[d["day"].isin(train_days)].dropna(subset=[target]+xcols).copy()
        # purge: label horizon bars (max 6) must not reach into test day
        tr = tr[tr["timestamp"] < day_start[day] - tr["lab_h"].max()*BAR]
        te = d[d["day"]==day].dropna(subset=[target]+xcols)
        if len(tr) < 200 or len(te) < 20: continue
        p = fit_predict(tr, te, xcols, target)
        if p is None: continue
        y = te[target].values
        k = max(5, int(len(p)*sel))
        idx = np.argsort(-p)[:k]
        wins = y[idx]
        per_day.append((day, wins.mean(), len(idx)))
        trades.extend(wins.tolist())
    return per_day, np.array(trades)

def stats(per_day, trades, payout, be):
    if not per_day: return None
    wrs = np.array([w for _,w,_ in per_day]); ns = np.array([n for *_,n in per_day])
    pooled = np.sum(wrs*ns)/np.sum(ns)
    eq = np.cumsum(np.where(trades>0, payout, -1.0))   # units
    peak = np.maximum.accumulate(np.concatenate([[0],eq]))
    dd = (peak[1:] - eq).max() if len(eq) else 0.0
    return dict(pooled=pooled, std=wrs.std(), dd=dd, final=eq[-1] if len(eq) else 0.0,
                ntr=len(trades), days=len(per_day), edge=pooled-be)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=5)
    ap.add_argument("--sel", type=float, default=0.20)
    ap.add_argument("--payout", type=float, default=0.69)
    a = ap.parse_args()
    be = 1/(1+a.payout)
    d, xcols = build()
    print(f"# Walk-forward continuous-learning test — agent.db ({len(xcols)} features, top-{a.sel:.0%} fired)")
    print(f"rolling window {a.window}d | payout {a.payout} -> break-even {be*100:.1f}% | logreg C=10 balanced\n")
    for target in ["reversal_15m", "continuation_30m"]:
        print(f"## Target: {target}   (base rate {d[target].mean()*100:.1f}%)")
        res = {}
        for mode in ["expanding", "rolling"]:
            pd_, tr = run(d, xcols, target, mode, a.window, a.sel)
            res[mode] = (pd_, stats(pd_, tr, a.payout, be))
        # per-day side by side
        days = sorted(set([x[0] for x in res["expanding"][0]] + [x[0] for x in res["rolling"][0]]))
        ex = {x[0]:x[1] for x in res["expanding"][0]}; ro = {x[0]:x[1] for x in res["rolling"][0]}
        print("| test day | expanding WR | rolling WR |")
        print("|---|---|---|")
        for dd in days:
            e = f"{ex[dd]*100:.0f}%" if dd in ex else "—"
            r = f"{ro[dd]*100:.0f}%" if dd in ro else "—"
            print(f"| {dd} | {e} | {r} |")
        print("\n| mode | pooled WR | edge vs be | day-WR std | max DD (units) | final (units) |")
        print("|---|---|---|---|---|---|")
        for mode in ["expanding","rolling"]:
            s = res[mode][1]
            if not s: print(f"| {mode} | — | — | — | — | — |"); continue
            print(f"| {mode} | {s['pooled']*100:.1f}% (n={s['ntr']}) | {s['edge']*100:+.1f}pts | "
                  f"{s['std']*100:.1f}pts | {s['dd']:.1f} | {s['final']:+.1f} |")
        print()
    print("Read: rolling>expanding => non-stationary, forgetting helps (our PSI prior). "
          "Both<break-even => no edge for the loop to adapt (architecture validated, signal absent). "
          "Lower day-WR std + smaller DD = a steadier loop.")

if __name__ == "__main__":
    main()
