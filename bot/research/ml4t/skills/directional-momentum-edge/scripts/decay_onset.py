#!/usr/bin/env python3
"""
decay_onset.py — Stage 4 repurposed: a strict conditional Decay Onset Evaluator.

Refactor (per spec): instead of "what happens next on every candle" (mapping
random-walk noise — the June failure mode), ask the conditional question:
"GIVEN the market is stretched to a structural extreme, what is P(the kinetic
energy decays within n bars)?"

1. PRE-CONDITION MASK — a candle enters the evaluation set only on exhaustion:
     bullish exhaustion (expect bearish decay):
        v_squeeze > squeeze_min        # BB width / KC width — variance overextended
        t_close_sma50 > stretch_atr    # price >= k ATR above the macro mean
        m_stc_delta < 0                # kinetic momentum decelerating against the stretch
     bearish exhaustion: mirrored.
   ~80-90% of meandering candles are purged before the model ever sees them.

2. TARGET — conditional binary decay relative to the stretch vector:
     Y=1 if bullish-exhaustion AND close[t+n] < close[t]
     Y=1 if bearish-exhaustion AND close[t+n] > close[t]
     Y=0 otherwise (the stretch kept breaking out)
   Betting Y is exactly the fade trade, so OOF precision == fade win-rate.

3. ABLATION — per-family models on the masked set. Pass criterion: the edge
   should live in VOLATILITY + MOMENTUM (snapback physics); trend-dominance
   means regime bleed, breakout-dominance means micro-tick overfit.

4. GATING — dynamic OOS threshold: per-fold we gate at the PERCENTILE of the
   fold's own OOF p̂ (default top 25%), not a fixed absolute cut — absolute
   probabilities don't transfer across training sizes (the 0.85-gate lesson).

Purged walk-forward, schema-adaptive, read-only. Stage 5 (momentum-persistence)
then owns the duration of the decay this stage detects.

Usage:
  python decay_onset.py --db agent/data/agent_FXSB.db
  python decay_onset.py --db "<june dbs,comma-sep>" --horizon 10
"""
from __future__ import annotations
import argparse, sys, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load, engineer_families, family_cols, make_folds, FAMILIES

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db", help="path or comma-separated paths")
    ap.add_argument("--horizon", type=int, default=10, help="decay horizon (minutes)")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--squeeze-min", type=float, default=1.05, help="BB/KC width ratio floor")
    ap.add_argument("--stretch-atr", type=float, default=2.0, help="|close-SMA50| in ATRs floor")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5)
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--gate-pct", type=float, default=75, help="per-fold OOF percentile gate (75 = top quartile)")
    args = ap.parse_args()
    if args.bar_sec < 300: sys.exit("ERROR: bar-sec below 300s floor.")
    n = (args.horizon * 60) // args.bar_sec
    breakeven = 1.0 / (1.0 + args.payout)

    frames = []
    for i, p in enumerate([q.strip() for q in args.db.split(",") if q.strip()]):
        d = load(p); d["asset"] = d["asset"] + f"@{i}"; frames.append(d)
    df = pd.concat(frames, ignore_index=True)
    X, registry = engineer_families(df)

    # forward move (contiguous bars only), per asset
    fwd = pd.Series(np.nan, index=df.index)
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        mv = np.sign(close.shift(-n) - close)
        fwd.loc[g.index] = mv.where(ts.shift(-n) - ts == n * args.bar_sec).values

    # 1. pre-condition mask
    bull_exh = ((X["v_squeeze"] > args.squeeze_min) &
                (X["t_close_sma50"] > args.stretch_atr) &
                (X["m_stc_delta"] < 0))
    bear_exh = ((X["v_squeeze"] > args.squeeze_min) &
                (X["t_close_sma50"] < -args.stretch_atr) &
                (X["m_stc_delta"] > 0))
    onset = (bull_exh | bear_exh) & fwd.notna()

    # 2. conditional decay target (Y=1 == the fade wins)
    y = pd.Series(np.nan, index=df.index)
    y[onset & bull_exh] = (fwd[onset & bull_exh] < 0).astype(float)
    y[onset & bear_exh] = (fwd[onset & bear_exh] > 0).astype(float)

    o = onset[onset].index
    Xo, yo, to = X.loc[o], y.loc[o], df.loc[o, "timestamp"]
    total = int(fwd.notna().sum())
    print(f"\n# Decay Onset Evaluator — stretch ≥{args.stretch_atr} ATR, squeeze >{args.squeeze_min}, "
          f"decay @ {args.horizon}m")
    print(f"bars {total} → onsets {len(o)} ({len(o)/max(total,1)*100:.1f}% kept; "
          f"{bull_exh.loc[o].sum()} bullish-exh / {bear_exh.loc[o].sum()} bearish-exh)")
    print(f"base decay rate (fade WR, no model): {yo.mean()*100:.1f}%   break-even {breakeven*100:.1f}%\n")
    if len(o) < 300:
        print("Too few onsets — loosen --stretch-atr / --squeeze-min."); return

    # 3+4. per-family ablation with per-fold percentile gating
    horizon_sec, emb = args.horizon * 60, args.embargo * args.bar_sec
    print(f"| features | AUC | gated (top {100-args.gate_pct:.0f}% conf) n | gated WR | clears? |")
    print("|---|---|---|---|---|")
    results = {}
    for fam in list(FAMILIES) + ["volatility+momentum", "all"]:
        if fam == "volatility+momentum":
            cols = family_cols(registry, "volatility") + family_cols(registry, "momentum")
        else:
            cols = family_cols(registry, fam)
        Xf = Xo[cols].astype(float)
        oof = pd.Series(np.nan, index=o); gated = pd.Series(False, index=o)
        for _, te_t in make_folds(to.values, args.folds):
            te_start = te_t.min()
            tr = (to < te_start) & (to + horizon_sec < te_start - emb)
            te = to.isin(te_t)
            if tr.sum() < 100 or te.sum() < 30 or yo[tr].nunique() < 2:
                continue
            med = Xf[tr].median()
            sc = StandardScaler().fit(Xf[tr].fillna(med))
            clf = LogisticRegression(penalty="l2", C=0.5, max_iter=1000, class_weight="balanced")
            clf.fit(sc.transform(Xf[tr].fillna(med)), yo[tr])
            p = clf.predict_proba(sc.transform(Xf[te].fillna(med)))[:, 1]
            oof.loc[Xf.index[te]] = p
            gated.loc[Xf.index[te]] = p >= np.percentile(p, args.gate_pct)   # dynamic per-fold gate
        m = oof.notna()
        auc = roc_auc_score(yo[m], oof[m]) if yo[m].nunique() > 1 else np.nan
        gm = gated & m
        gwr = float(yo[gm].mean()) if gm.sum() else np.nan
        ok = np.isfinite(gwr) and gwr > breakeven and gm.sum() >= 30
        print(f"| {fam} | {auc:.3f} | {int(gm.sum())} | "
              f"{'—' if not np.isfinite(gwr) else f'{gwr*100:.1f}%'} | {'✓' if ok else ''} |")
        results[fam] = dict(auc=auc, gated_n=int(gm.sum()), gated_wr=gwr, clears=ok)

    # verdict per the spec's pass criterion
    vm, al = results.get("volatility+momentum", {}), results.get("all", {})
    tr_d = results.get("trend", {})
    base = float(yo.mean())
    raw_clears = base > breakeven
    if raw_clears:
        print(f"\n## Verdict: ONSET ALONE CLEARS — the masked condition's base fade WR "
              f"{base*100:.1f}% > break-even before any model. Model gating is upside on top.")
    elif vm.get("clears") or al.get("clears"):
        which = "volatility+momentum" if vm.get("clears") else "all"
        r = results[which]
        print(f"\n## Verdict: PASSES — {which} gated WR {r['gated_wr']*100:.1f}% on {r['gated_n']} "
              f"> break-even. " +
              ("Edge lives in the snapback families — Stage 5 takes the onset. "
               if which == "volatility+momentum" else
               "Check family table: if trend dominates, regime-bleed warning. "))
    else:
        print(f"\n## Verdict: FAILS — no family configuration clears break-even on this dataset "
              f"(base {base*100:.1f}%). Tighten the mask (--stretch-atr/--squeeze-min) or the pocket "
              "is not present in this regime.")
    if np.isfinite(tr_d.get("auc", np.nan)) and np.isfinite(vm.get("auc", np.nan)) \
       and tr_d["auc"] > vm["auc"] + 0.01:
        print("⚠ trend family out-ranks volatility+momentum — regime-following bleed, treat with suspicion.")

if __name__ == "__main__":
    main()
