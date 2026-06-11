#!/usr/bin/env python3
"""
momentum_persistence.py — "when a momentum-gain is detected, how many candles
until it falls back?" — as a duration / survival problem, graded on profit.

Two stages (per the research design):

  A. CHARACTERIZE (price-based, descriptive): from every momentum-gain onset,
     measure the TRUE persistence = how many bars until price crosses back
     through entry. Reports the duration distribution and the per-expiry
     continuation base-rate. This says what actually happens, model-free.

  B. PREDICT (tradeable): onset is a causal MULTI-FAMILY CONFLUENCE (never one
     indicator) known at decision time. For each expiry k (5/10/15/20m) a
     per-horizon logistic on ALL family features predicts P(still beyond entry
     at +k) — a discrete-time survival model. We then trade the expiry whose
     predicted-confident win-rate clears the binary-option break-even.

Fall-back = price crosses back through entry (binary-option-native: matches how
an option settles at expiry). Bet is WITH the trend on a gain onset.

PURGED walk-forward, schema-adaptive (runs on trading_data.db and agent_*.db),
READ-ONLY. No model persisted.

Usage:
  python momentum_persistence.py --db agent/data/agent_FXSB.db
  python momentum_persistence.py --confluence 5 --k 6 --max-dur 12 --min-prob 0.6
"""
from __future__ import annotations
import argparse, json, sys, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

def fit_predict(model, Xtr, ytr, Xte):
    """Fit the chosen model on train, return P(persist) on test. Tree is constrained
    like the deployed reversal gate (depth/leaf caps) and needs no scaling; logistic
    is standardized. Both hand-port to ml_gate_params.json if an edge is confirmed."""
    med = Xtr.median()
    if model == "tree":
        clf = DecisionTreeClassifier(max_depth=5, min_samples_leaf=50, class_weight="balanced")
        clf.fit(Xtr.fillna(med), ytr)
        return clf.predict_proba(Xte.fillna(med))[:, 1]
    sc = StandardScaler().fit(Xtr.fillna(med))
    clf = LogisticRegression(penalty="l2", C=0.5, max_iter=1000, class_weight="balanced")
    clf.fit(sc.transform(Xtr.fillna(med)), ytr)
    return clf.predict_proba(sc.transform(Xte.fillna(med)))[:, 1]

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load, engineer_families, make_folds

def onset_and_labels(df, k, horizons_min, max_dur, bar_sec):
    """Per asset compute: trend s, confluence condition count, onset flag, the
    cross-back duration, and persist_<minutes> for each requested expiry. All
    causal at t except the persist_* / duration targets (forward, by design)."""
    df = df.copy()
    cols = ["s", "conf", "dur"] + [f"persist_{m}" for m in horizons_min]
    for c in cols:
        df[c] = np.nan
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp"); idx = g.index
        close, ts = g["close"].astype(float), g["timestamp"]
        s = np.sign(close - close.shift(k))
        # ── multi-family confluence (each term = trend-aligned agreement) ──
        c1 = (np.sign(close - g["sma_20"]) == s)                       # trend: price side of MA20
        c2 = (np.sign(g["macd_hist"]) == s)                            # momentum: MACD hist sign
        c3 = (g["adx_14"] > g["adx_14"].shift(1))                      # breakout: trend strengthening
        c4 = (np.sign(g["stc_value"] - 50) == s)                       # momentum: STC on trend side
        c5 = (((s > 0) & (g["adx_plus_di"] > g["adx_minus_di"])) |     # breakout: DI agrees
              ((s < 0) & (g["adx_minus_di"] > g["adx_plus_di"])))
        conf = (c1.astype(float) + c2.astype(float) + c3.astype(float)
                + c4.astype(float) + c5.astype(float))
        df.loc[idx, "s"] = s.values
        df.loc[idx, "conf"] = conf.values
        # ── forward cross-back duration (bars until price back through entry) ──
        dur = np.full(len(g), np.nan)
        cl = close.values; tsv = ts.values
        for i in range(len(g)):
            si = s.values[i]
            if not np.isfinite(si) or si == 0:
                continue
            d = np.nan
            for j in range(1, max_dur + 1):
                if i + j >= len(g) or tsv[i + j] - tsv[i] != j * bar_sec:
                    break                                              # ran off / gap
                if np.sign(cl[i + j] - cl[i]) != si:                   # crossed back
                    d = j; break
            else:
                d = max_dur + 1                                        # survived the window
            dur[i] = d
        df.loc[idx, "dur"] = dur
        # ── per-expiry persistence (still beyond entry in trend dir at +m minutes) ──
        for m in horizons_min:
            hb = (m * 60) // bar_sec
            fwd = np.sign(close.shift(-hb) - close)
            contiguous = (ts.shift(-hb) - ts == hb * bar_sec)
            persist = ((fwd == s) & contiguous).astype(float)
            persist[~contiguous] = np.nan
            df.loc[idx, f"persist_{m}"] = persist.values
    return df

def fmt(x, d=3):
    return "nan" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--horizons", default="5,10,15,20", help="candidate expiries (minutes)")
    ap.add_argument("--k", type=int, default=6, help="trend lookback (bars)")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--confluence", type=int, default=4, help="min family conditions (of 5) for an onset")
    ap.add_argument("--max-dur", type=int, default=12, help="cap (bars) for the duration distribution")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5)
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--model", choices=["logreg","tree"], default="logreg",
                    help="survival classifier for stage B (tree = constrained DecisionTree)")
    ap.add_argument("--min-prob", type=float, default=0.60, help="confidence gate for the predict stage")
    ap.add_argument("--min-coverage", type=float, default=0.10)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    bar_sec = args.bar_sec
    if bar_sec < 300: sys.exit("ERROR: --bar-sec below 300s floor.")
    hz = [int(h) for h in args.horizons.split(",")]
    for h in hz:
        if (h * 60) % bar_sec: sys.exit(f"ERROR: horizon {h}m not a whole bar multiple.")
    breakeven = 1.0 / (1.0 + args.payout)

    df = load(args.db)
    df = onset_and_labels(df, args.k, hz, args.max_dur, bar_sec)
    onset = (df["conf"] >= args.confluence) & (df["s"] != 0) & df["dur"].notna()
    o = df[onset].copy()

    print(f"\n# Momentum-Persistence — onset = ≥{args.confluence}/5 family confluence, trend-k {args.k}b")
    print(f"db rows {len(df)}   onsets {len(o)} ({len(o)/len(df)*100:.1f}% of bars)   "
          f"break-even WR {breakeven*100:.1f}%\n")
    if len(o) < 200:
        print("Too few onsets to analyze. Loosen --confluence."); return

    # ── A. CHARACTERIZE: how long do detected gains actually last? ──
    dur = o["dur"].values
    surv = dur > args.max_dur
    med = np.median(np.where(surv, args.max_dur + 1, dur))
    print("## A. True persistence (price-based, descriptive)")
    print(f"median bars to fall-back: {med:.0f}   survived >{args.max_dur} bars: {surv.mean()*100:.1f}%")
    print("| expiry | bars | continuation WR (follow trend) | reversion WR (FADE) | tradeable side |")
    print("|---|---|---|---|---|")
    base, fade = {}, {}
    for h in hz:
        b = (h * 60) // bar_sec
        pr = o[f"persist_{h}"].dropna()
        wr = float(pr.mean()) if len(pr) else np.nan        # follow-trend WR
        fw = 1.0 - wr if np.isfinite(wr) else np.nan         # fade WR (binary, ties negligible)
        base[h] = wr; fade[h] = fw
        side = ("FADE ✓" if np.isfinite(fw) and fw > breakeven else
                ("follow ✓" if np.isfinite(wr) and wr > breakeven else ""))
        print(f"| {h}m | {b} | {wr*100:.1f}% | {fw*100:.1f}% | {side} |")

    # ── B. PREDICT: per-expiry survival logistic on ALL families ──
    Xall, _ = engineer_families(df)
    X = Xall.loc[o.index]
    ts = o["timestamp"]
    print(f"\n## B. Predicted persistence (confluence onset → {args.model} survival model, purged WF)")
    print("| expiry | onsets | base WR | model AUC | conf-gated WR | coverage | clears? |")
    print("|---|---|---|---|---|---|---|")
    report_pred = {}
    for h in hz:
        y = o[f"persist_{h}"]
        keep = y.notna()
        yk = y[keep]; Xk = X[keep]; tk = ts[keep]
        oof = pd.Series(np.nan, index=yk.index)
        horizon_sec, emb = h * 60, args.embargo * bar_sec
        for _, te_t in make_folds(tk.values, args.folds):
            te_start = te_t.min()
            tr = (tk < te_start) & (tk + horizon_sec < te_start - emb)
            te = tk.isin(te_t)
            if tr.sum() < 100 or te.sum() < 30 or yk[tr].nunique() < 2:
                continue
            oof.loc[yk.index[te]] = fit_predict(args.model, Xk[tr], yk[tr], Xk[te])
        m = oof.notna()
        if m.sum() < 50:
            print(f"| {h}m | {int(keep.sum())} | {base[h]*100:.1f}% | — | — | — | |"); continue
        auc = roc_auc_score(yk[m], oof[m]) if yk[m].nunique() > 1 else np.nan
        take = oof[m] >= args.min_prob
        cov = float(take.mean())
        gwr = float(yk[m][take].mean()) if take.sum() else np.nan
        clears = np.isfinite(gwr) and gwr > breakeven and cov >= args.min_coverage
        print(f"| {h}m | {int(m.sum())} | {base[h]*100:.1f}% | {fmt(auc)} | "
              f"{'nan' if not np.isfinite(gwr) else f'{gwr*100:.1f}%'} | {cov*100:.1f}% | {'✓' if clears else ''} |")
        report_pred[h] = dict(base_wr=base[h], auc=auc, gated_wr=gwr, coverage=cov, clears=bool(clears))

    # ── verdict ── (check BOTH follow and fade — gains here tend to revert)
    base_win = [h for h in hz if np.isfinite(base[h]) and base[h] > breakeven]
    fade_win = [h for h in hz if np.isfinite(fade[h]) and fade[h] > breakeven]
    model_win = [h for h, r in report_pred.items() if r.get("clears")]
    if fade_win:
        verdict = ("PROFITABLE (raw, FADE) — a momentum-gain confluence is a REVERSION signal: fading it "
                   "(bet against the trend) clears break-even at: "
                   + ", ".join(f"{h}m {fade[h]*100:.1f}%" for h in fade_win)
                   + ". Confirm other regime + cost detail, then freeze.")
    elif base_win:
        verdict = ("PROFITABLE (raw, follow) — confluence onset persists past break-even at: "
                   + ", ".join(f"{h}m {base[h]*100:.1f}%" for h in base_win) + ". Confirm other regime, then freeze.")
    elif model_win:
        verdict = ("PROFITABLE (gated) — confidence-gated survival model clears break-even at: "
                   + ", ".join(f"{h}m {report_pred[h]['gated_wr']*100:.1f}% @ {report_pred[h]['coverage']*100:.0f}%"
                               for h in model_win) + ". Confirm other regime, then freeze.")
    elif any(np.isfinite(r.get("auc", np.nan)) and r["auc"] > 0.52 for r in report_pred.values()):
        verdict = ("PREDICTABLE-BUT-UNPROFITABLE — survival model ranks persistence above chance "
                   "(AUC>0.52) but no expiry clears break-even even gated. Structure exists, too weak for payout.")
    else:
        verdict = ("NO EDGE — detected momentum-gains do not persist beyond break-even at any expiry, "
                   "and persistence is ~unpredictable. Consistent with the mild mean-reversion seen elsewhere.")
    print(f"\n## Verdict: {verdict}")
    print("\nFamily-confluence + purged. Confirm on the other regime before any freeze-export.")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(dict(onsets=len(o), median_dur=float(med), base_wr=base,
                           predict=report_pred, verdict=verdict), f, indent=2,
                      default=lambda x: None if isinstance(x, float) and not np.isfinite(x) else x)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
