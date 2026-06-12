#!/usr/bin/env python3
"""
freeze_pipeline.py — freeze the Two-Key decay-onset signal into generic JSON.

Two keys: (1) a data-driven Heuristic Rule (shallow-tree-discovered feature
confluence) and (2) an L2 LogisticRegression p_decay gate. NOTHING is hardcoded:
the script discovers the dominant features and their threshold confluence, then
freezes both keys into a generic schema a JS bot can parse blindly.

Pipeline:
  1. Load FXSB onsets (Train) + June onsets (OOS); take all 36 engineered features.
  2. Fit StandardScaler + L2 LogisticRegression on Train.
  3. p_decay on OOS; ML gate = 75th percentile of OOS p_decay.
  4. Surrogate (Key 1): DecisionTree(max_depth=3, min_samples_leaf=15) on Train →
     top-3 features by importance; operators derived from Train class means; grid-
     search their thresholds on OOS to maximize Q1 consensus WR (heuristic ∧ ML),
     subject to N(Q1) >= 100.
  5. Package → bot/research/tests/ml_gate_params.json (oos_threshold, ml_model, heuristic_rule).
  6. 100 random OOS rows + their python p_decay → bot/research/tests/parity_test_cases.json.

CAVEAT (printed): step 4 tunes the heuristic thresholds ON the OOS set, so the
reported Q1 WR is optimized-on-June, not forward-validated. Treat as the freeze's
in-sample ceiling; confirm forward before sizing.
"""
from __future__ import annotations
import json, os, sys
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__),
                                    "..", "..", "..", "..", "..", ".."))  # scripts→…→bot→repo root
EXPORTS = os.path.join(ROOT, "bot", "research", "ml4t", "skills",
                       "directional-momentum-edge", "exports")
TRAIN_CSV = os.path.join(EXPORTS, "onsets_fxsb_4.0_full.csv")
OOS_CSV   = os.path.join(EXPORTS, "onsets_june_2.0_full.csv")
OUT_DIR    = os.path.join(ROOT, "bot", "research", "tests")
OUT_PARAMS = os.path.join(OUT_DIR, "ml_gate_params.json")
OUT_PARITY = os.path.join(OUT_DIR, "parity_test_cases.json")

META_PREFIXES = ("fwd_",)
META = {"timestamp", "side", "p_decay", "p_decay_pct", "target_decay_realized"}
ML_PCT = 75
MIN_Q1 = 100

def load(path):
    d = pd.read_csv(path)
    d.columns = [c.strip() for c in d.columns]
    feats = [c for c in d.columns if c not in META and not c.startswith(META_PREFIXES)]
    return d, feats

def main():
    train, feats = load(TRAIN_CSV)
    oos, feats_o = load(OOS_CSV)
    assert feats == feats_o, "train/OOS feature columns differ"
    print(f"features discovered: {len(feats)}   train rows {len(train)}   OOS rows {len(oos)}")

    Xtr, ytr = train[feats].astype(float), train["target_decay_realized"].astype(int)
    Xoos, yoos = oos[feats].astype(float), oos["target_decay_realized"].astype(int)
    med = Xtr.median()

    # --- Key 2: scaler + L2 logistic on Train ---
    scaler = StandardScaler().fit(Xtr.fillna(med))
    clf = LogisticRegression(penalty="l2", max_iter=1000)   # per spec; default C, no class weighting
    clf.fit(scaler.transform(Xtr.fillna(med)), ytr)
    p_oos = clf.predict_proba(scaler.transform(Xoos.fillna(med)))[:, 1]
    ml_threshold = float(np.percentile(p_oos, ML_PCT))
    ml_fire = p_oos >= ml_threshold
    print(f"ML gate (p_decay {ML_PCT}th pct of OOS): {ml_threshold:.4f}   fires {int(ml_fire.sum())}/{len(oos)}")

    # --- Key 1: surrogate tree → top-3 features (data-driven, no hardcoding) ---
    tree = DecisionTreeClassifier(max_depth=3, min_samples_leaf=15,
                                  random_state=0).fit(Xtr.fillna(med), ytr)  # per spec
    imp = sorted(zip(feats, tree.feature_importances_), key=lambda x: -x[1])
    top3 = [f for f, w in imp[:3]]
    print(f"surrogate top-3 features: " + ", ".join(f"{f} ({w:.2f})" for f, w in imp[:3]))

    # operators from TRAIN class means: decays have higher value → '>', else '<'
    ops = {}
    for f in top3:
        hi = train.loc[ytr == 1, f].mean() >= train.loc[ytr == 0, f].mean()
        ops[f] = ">" if hi else "<"

    # grid-search thresholds on OOS to maximize Q1 WR (N>=100)
    Xo = Xoos.fillna(med)
    cand = {f: np.quantile(Xo[f].values, np.arange(0.05, 0.96, 0.05)) for f in top3}
    arr = {f: Xo[f].values for f in top3}
    y = yoos.values
    best = None  # (wr, n, thresholds)
    for t0 in cand[top3[0]]:
        m0 = arr[top3[0]] > t0 if ops[top3[0]] == ">" else arr[top3[0]] < t0
        for t1 in cand[top3[1]]:
            m1 = arr[top3[1]] > t1 if ops[top3[1]] == ">" else arr[top3[1]] < t1
            m01 = m0 & m1
            for t2 in cand[top3[2]]:
                m2 = arr[top3[2]] > t2 if ops[top3[2]] == ">" else arr[top3[2]] < t2
                q1 = m01 & m2 & ml_fire
                n = int(q1.sum())
                if n < MIN_Q1:
                    continue
                wr = float(y[q1].mean())
                if best is None or wr > best[0] or (wr == best[0] and n > best[1]):
                    best = (wr, n, (float(t0), float(t1), float(t2)))
    if best is None:
        # relax: loosest thresholds, report what we get (still freeze something)
        print("⚠ no confluence reached N>=100; relaxing to loosest thresholds")
        thr = tuple(float(np.quantile(Xo[f].values, 0.05 if ops[f] == ">" else 0.95)) for f in top3)
        masks = [(arr[f] > t) if ops[f] == ">" else (arr[f] < t) for f, t in zip(top3, thr)]
        q1 = masks[0] & masks[1] & masks[2] & ml_fire
        best = (float(y[q1].mean()) if q1.sum() else float("nan"), int(q1.sum()), thr)

    wr, n_q1, thr = best
    heuristic_rule = [{"feature": f, "operator": ops[f], "threshold": t} for f, t in zip(top3, thr)]

    # --- package ml_gate_params.json (generic schema) ---
    params = {
        "schema": "two-key-decay-gate/v1",
        "logic": "fire when heuristic_rule ALL pass AND p_decay >= oos_threshold; then FADE the stretch",
        "oos_threshold": ml_threshold,
        "ml_model": {
            "features": feats,
            "weights": [float(w) for w in clf.coef_[0]],
            "bias": float(clf.intercept_[0]),
            "scaler": {"means": [float(m) for m in scaler.mean_],
                       "scales": [float(s) for s in scaler.scale_]},
        },
        "heuristic_rule": heuristic_rule,
        "meta": {
            "train_csv": os.path.basename(TRAIN_CSV), "oos_csv": os.path.basename(OOS_CSV),
            "train_rows": len(train), "oos_rows": len(oos),
            "q1_consensus_n": n_q1, "q1_consensus_wr": wr,
            "note": "heuristic thresholds tuned ON oos — q1_wr is in-sample-to-grid-search; confirm forward",
        },
    }
    os.makedirs(os.path.dirname(OUT_PARAMS), exist_ok=True)
    with open(OUT_PARAMS, "w") as fh:
        json.dump(params, fh, indent=2)

    # --- parity test cases: 100 random OOS rows + python p_decay ---
    rng = np.random.RandomState(42)
    idx = rng.choice(len(oos), size=min(100, len(oos)), replace=False)
    cases = [{"x": [float(v) for v in Xo[feats].values[i]], "p_decay": float(p_oos[i])} for i in idx]
    with open(OUT_PARITY, "w") as fh:
        json.dump({"feature_order": feats, "cases": cases}, fh, indent=2)

    # --- self parity check: manual sigmoid(scaler+dot) vs sklearn ---
    z = (Xo[feats].values[idx] - scaler.mean_) / scaler.scale_
    manual = 1.0 / (1.0 + np.exp(-(z @ clf.coef_[0] + clf.intercept_[0])))
    max_err = float(np.max(np.abs(manual - p_oos[idx])))

    # ---- console summary ----
    print("\n================ FREEZE SUMMARY ================")
    print("Discovered Heuristic Rule (Key 1):")
    for r in heuristic_rule:
        print(f"   {r['feature']} {r['operator']} {r['threshold']:.4f}")
    print(f"ML gate (Key 2): p_decay >= {ml_threshold:.4f}  (75th pct OOS)")
    print(f"Q1 Consensus  : N={n_q1}  WR={wr*100:.1f}%  (break-even 55.6%)")
    print(f"self-parity   : max |manual - sklearn| = {max_err:.2e}  (JS must match to <1e-9)")
    print(f"saved → {os.path.relpath(OUT_PARAMS, ROOT)}  ({len(feats)} features, {len(heuristic_rule)} rules)")
    print(f"saved → {os.path.relpath(OUT_PARITY, ROOT)}  ({len(cases)} parity cases)")
    print("CAVEAT: heuristic thresholds were tuned on OOS — WR is the in-sample ceiling, not forward.")
    print("===============================================")

if __name__ == "__main__":
    main()
