#!/usr/bin/env python3
"""
decay_gate.py — faithful replication of the original decay-prediction setup
(the build behind ml-gate.js / ml_gate_params.json), graded honestly.

SPEC (reproduced exactly):
  label:    recent  = close[t] - close[t-3]          (3 bars / 15 min)
            forward = close[t+3] - close[t]
            decay   = 1 if sign(forward) != sign(recent) else 0
  features: BB_Deviation     = (close - bb_lower) / (bb_upper - bb_lower)
            CCI_Velocity     = (cci[t] - cci[t-2]) / 2
            Stoch_Divergence = |stoch_k - stoch_d|
            STC_Momentum     = stc[t] - stc[t-1]
            (per asset, positional lookbacks, scale-free)
  models:   LogisticRegression(l2, C=0.5, max_iter=1000, class_weight=balanced),
            features StandardScaler'd (fit on train only)
            DecisionTreeClassifier(max_depth=5, min_samples_leaf=30, class_weight=balanced)
  harness:  purged TimeSeriesSplit(5) + 5-bar embargo (3-bar label can't straddle)
  gate:     fire when P(decay) >= 0.85
  direction: fade the recent move (PUT if recent>0, CALL if recent<0)

GRADING (what the original build never reported):
  A fired signal WINS iff decay realizes (fading a move wins exactly when the
  forward move flips sign). So gated OOS precision == win-rate, compared to the
  binary-option break-even 1/(1+payout) = 55.6% at 0.8.
  Out-of-fold only — every signal scored by a model that never saw its period.

READ-ONLY, schema-adaptive (trading_data.db and agent_*.db).

Usage:
  python decay_gate.py [--db agent/data/agent_FXSB.db] [--gate 0.85] [--lookback 3]
"""
from __future__ import annotations
import argparse, json, sys, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
from po_data import load, make_folds

def kinetic_features_and_label(df, nb, bar_sec):
    """The four kinetic features + decay label, per asset, positional lookbacks.
    nb = label lookback/forward in bars (spec: 3). Rows with a session gap inside
    either window are dropped (positional shift would silently span the gap)."""
    parts = []
    for _, g in df.groupby("asset", sort=False):
        g = g.sort_values("timestamp")
        close, ts = g["close"].astype(float), g["timestamp"]
        band = (g["bb_upper"] - g["bb_lower"]).replace(0, np.nan)
        f = pd.DataFrame(index=g.index)
        f["BB_Deviation"]     = (close - g["bb_lower"]) / band
        f["CCI_Velocity"]     = (g["cci_20"] - g["cci_20"].shift(2)) / 2
        f["Stoch_Divergence"] = (g["stoch_k"] - g["stoch_d"]).abs()
        f["STC_Momentum"]     = g["stc_value"] - g["stc_value"].shift(1)
        recent  = close - close.shift(nb)
        forward = close.shift(-nb) - close
        ok = ((ts - ts.shift(nb) == nb * bar_sec) &           # contiguous backward
              (ts.shift(-nb) - ts == nb * bar_sec) &          # contiguous forward
              (recent != 0))                                   # sign defined
        f["decay"]  = ((np.sign(forward) != np.sign(recent)) & ok).astype(float)
        f.loc[~ok, "decay"] = np.nan
        f["recent"] = recent
        f["timestamp"] = ts
        parts.append(f)
    return pd.concat(parts).reindex(df.index)

FEATS = ["BB_Deviation", "CCI_Velocity", "Stoch_Divergence", "STC_Momentum"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/trading_data.db")
    ap.add_argument("--lookback", type=int, default=3, help="label window in bars (spec: 3 = 15min)")
    ap.add_argument("--bar-sec", type=int, default=300)
    ap.add_argument("--gate", type=float, default=0.85, help="P(decay) firing threshold (spec: 0.85)")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--embargo", type=int, default=5, help="embargo bars (spec: 5)")
    ap.add_argument("--payout", type=float, default=0.8)
    ap.add_argument("--inspect", action="store_true", help="break down fired signals by asset/day/features")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    bar_sec = args.bar_sec
    if bar_sec < 300: sys.exit("ERROR: --bar-sec below 300s floor.")
    nb = args.lookback
    breakeven = 1.0 / (1.0 + args.payout)

    # --db accepts a comma-separated list; frames are concatenated (assets stay
    # per-file independent for feature lookbacks since groupby('asset') is per-frame
    # — to be safe across files that share asset names, suffix the asset per file)
    dbs = [p.strip() for p in args.db.split(",") if p.strip()]
    frames = []
    for i, p in enumerate(dbs):
        d = load(p)
        if len(dbs) > 1:
            d["asset"] = d["asset"] + f"@{i}"   # avoid cross-file series stitching
        frames.append(d)
    df = pd.concat(frames, ignore_index=True)
    F = kinetic_features_and_label(df, nb, bar_sec)
    keep = F["decay"].notna() & F[FEATS].notna().all(axis=1)
    F = F[keep]
    F["asset"] = df.loc[F.index, "asset"]
    X, y, ts = F[FEATS], F["decay"], F["timestamp"]
    base = float(y.mean())

    print(f"\n# Decay-Gate Replication — label ±{nb} bars ({nb*bar_sec//60}min), gate {args.gate}")
    print(f"rows {len(F)}   decay base-rate {base*100:.1f}%   break-even WR {breakeven*100:.1f}%  "
          f"(fade direction: PUT if recent>0 else CALL)\n")

    horizon_sec, emb = nb * bar_sec, args.embargo * bar_sec
    results, oof_by_model = {}, {}
    print("| model | OOS AUC | fired | fire-rate | OOS WR (precision) | vs break-even |")
    print("|---|---|---|---|---|---|")
    for name in ("logreg", "tree"):
        oof = pd.Series(np.nan, index=F.index)
        for _, te_t in make_folds(ts.values, args.folds):
            te_start = te_t.min()
            tr = (ts < te_start) & (ts + horizon_sec < te_start - emb)   # purge + embargo
            te = ts.isin(te_t)
            if tr.sum() < 200 or te.sum() < 50 or y[tr].nunique() < 2:
                continue
            med = X[tr].median()
            if name == "logreg":
                sc = StandardScaler().fit(X[tr].fillna(med))
                clf = LogisticRegression(penalty="l2", C=0.5, max_iter=1000, class_weight="balanced")
                clf.fit(sc.transform(X[tr].fillna(med)), y[tr])
                p = clf.predict_proba(sc.transform(X[te].fillna(med)))[:, 1]
            else:
                clf = DecisionTreeClassifier(max_depth=5, min_samples_leaf=30, class_weight="balanced")
                clf.fit(X[tr].fillna(med), y[tr])
                p = clf.predict_proba(X[te].fillna(med))[:, 1]
            oof.loc[F.index[te]] = p
        m = oof.notna()
        auc = roc_auc_score(y[m], oof[m]) if y[m].nunique() > 1 else np.nan
        fired = oof[m] >= args.gate
        n_fired = int(fired.sum())
        wr = float(y[m][fired].mean()) if n_fired else np.nan     # win iff decay realized
        rate = n_fired / int(m.sum()) if m.sum() else 0.0
        clears = np.isfinite(wr) and wr > breakeven and n_fired >= 30
        wrs = "—" if not np.isfinite(wr) else f"{wr*100:.1f}%"
        print(f"| {name} | {auc:.3f} | {n_fired} | {rate*100:.2f}% | {wrs} | {'✓' if clears else ''} |")
        results[name] = dict(auc=auc, fired=n_fired, fire_rate=rate, wr=wr, clears=bool(clears))
        oof_by_model[name] = oof[m]

    winners = [k for k, r in results.items() if r["clears"]]
    if winners:
        verdict = ("FIRES & CLEARS — " + ", ".join(
            f"{k}: OOS WR {results[k]['wr']*100:.1f}% on {results[k]['fired']} signals" for k in winners)
            + f" > break-even {breakeven*100:.1f}%. Confirm on the other regime before any freeze.")
    elif any(r["fired"] > 0 for r in results.values()):
        verdict = ("FIRES BUT FAILS — the 0.85 gate fires, but OOS precision does not clear break-even "
                   "(or n too small). The in-sample leaf probabilities (e.g. 0.97) were optimistic; "
                   "out-of-fold the gate does not hold its claimed precision.")
    else:
        verdict = ("NEVER FIRES — out-of-fold P(decay) never reaches the 0.85 gate. The original "
                   "high-confidence leaves were artifacts of in-sample fitting; honest OOS confidence "
                   "tops out lower. Try a lower --gate to see the achievable precision/coverage curve.")
    print(f"\n## Verdict: {verdict}")

    # achievable precision/coverage curve (context regardless of verdict)
    print("\n## OOS precision vs gate")
    print("| gate | logreg fired / WR | tree fired / WR |")
    print("|---|---|---|")
    for thr in (0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90):
        cells = []
        for name in ("logreg", "tree"):
            po = oof_by_model.get(name)
            if po is None:
                cells.append("—"); continue
            fired = po >= thr
            n_ = int(fired.sum())
            w_ = float(y.loc[po.index][fired].mean()) if n_ else np.nan
            cells.append(f"{n_} / {'—' if not np.isfinite(w_) else f'{w_*100:.1f}%'}")
        print(f"| {thr:.2f} | {cells[0]} | {cells[1]} |")
    print(f"(break-even {breakeven*100:.1f}%; precision == fade win-rate by construction)")

    # ── inspection: WHO are the fired signals? concentration kills effective n ──
    if args.inspect:
        for name in ("logreg", "tree"):
            po = oof_by_model.get(name)
            if po is None: continue
            fired_idx = po.index[po >= args.gate]
            if len(fired_idx) == 0:
                print(f"\n### inspect {name}: nothing fired at {args.gate}"); continue
            sub = F.loc[fired_idx]
            wins = y.loc[fired_idx]
            print(f"\n### inspect {name} @ gate {args.gate} — {len(sub)} fired, WR {wins.mean()*100:.1f}%")
            by_a = sub.groupby("asset").agg(n=("decay","size"), wr=("decay","mean")).sort_values("n", ascending=False)
            print(f"assets: {len(by_a)} | top: " + ", ".join(
                f"{a} n={r.n} wr={r.wr*100:.0f}%" for a, r in by_a.head(6).iterrows()))
            days = pd.to_datetime(sub["timestamp"], unit="s").dt.date
            by_d = days.value_counts().sort_index()
            print(f"days spanned: {len(by_d)} | busiest: " + ", ".join(f"{d} n={n}" for d, n in by_d.nlargest(5).items()))
            uniq_ts = sub["timestamp"].nunique()
            print(f"unique timestamps: {uniq_ts} / {len(sub)}  (cross-asset duplication factor {len(sub)/max(uniq_ts,1):.1f}x)")
            print("feature profile of fired signals (median):")
            print(sub[FEATS].median().round(3).to_string())
    if args.json:
        with open(args.json, "w") as f:
            json.dump(dict(rows=len(F), base_rate=base, gate=args.gate,
                           results=results, verdict=verdict), f, indent=2,
                      default=lambda x: None if isinstance(x, float) and not np.isfinite(x) else x)
        print(f"\nJSON → {args.json}")

if __name__ == "__main__":
    main()
