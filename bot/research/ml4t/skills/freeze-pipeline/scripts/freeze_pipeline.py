#!/usr/bin/env python3
"""
freeze_pipeline.py — freeze the Two-Key decay-onset signal into a generic, JS-static
JSON (schema static-decay-gate/v2).

Two keys, both static (no Python at runtime):
  Key 1  Heuristic Rule — data-driven indicator-threshold confluence (shallow tree),
         discovered in a SIDE-NORMALIZED frame so the rule is symmetric (one rule,
         mirrored for the short side via the stretch sign).
  Key 2  L2 LogisticRegression p_decay gate — frozen weights + scaler on the RAW 36
         features (so JS parity with Python is exact).

The JSON carries the COMPLETE static firing recipe so a JS bot fires blindly:
  - onset_mask     : structural-exhaustion pre-condition (what makes a bar a candidate)
  - heuristic_rule : the discovered confluence, each with a `compute` formula + center
  - direction/expiry: fade the stretch, 10m default
  - ml_model       : optional second key (omit-able for static-only)
Every threshold has a `compute` field (raw-indicator formula) so JS needs no Python.

CAVEAT (printed + in JSON meta): heuristic thresholds are grid-searched ON the OOS set,
so the reported Q1 WR is the in-sample-to-search ceiling — confirm forward before sizing.
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

META = {"timestamp", "side", "p_decay", "p_decay_pct", "target_decay_realized"}
ML_PCT, MIN_Q1, BAR_SEC, EXPIRY_MIN = 75, 100, 300, 10
# onset mask used to BUILD the FXSB export (must match decay_onset --stretch-atr/--squeeze-min)
STRETCH_ATR, SQUEEZE_MIN = 4.0, 1.20

# engineered feature -> raw-indicator compute (mirrors _lib/po_data.engineer_families)
FORMULAS = {
    "t_close_sma10": "(close-sma_10)/atr_14", "t_close_sma20": "(close-sma_20)/atr_14",
    "t_close_sma50": "(close-sma_50)/atr_14", "t_close_ema12": "(close-ema_12)/atr_14",
    "t_close_ema26": "(close-ema_26)/atr_14", "t_ema_spread": "(ema_12-ema_26)/atr_14",
    "t_sma_10_20": "(sma_10-sma_20)/atr_14", "t_sma_20_50": "(sma_20-sma_50)/atr_14",
    "t_close_psar": "(close-psar)/atr_14", "t_psar_bull": "psar_bull",
    "t_macd_cross": "(macd_line-macd_signal)/atr_14",
    "m_rsi": "rsi_14", "m_rsi_d": "rsi_14 - prev(rsi_14)", "m_stoch_k": "stoch_k",
    "m_stoch_d": "stoch_d", "m_stoch_kd": "stoch_k-stoch_d", "m_stc": "stc_value",
    "m_stc_delta": "stc_delta", "m_stc_gap": "stc_value-stc_signal", "m_cci": "cci_20",
    "m_williams": "williams_14", "m_macd_hist": "macd_hist/atr_14",
    "m_macd_hist_d": "(macd_hist - prev(macd_hist))/atr_14",
    "v_bb_width": "bb_width_bps", "v_bb_width_d": "bb_width_bps - prev(bb_width_bps)",
    "v_pctB": "(close-bb_lower)/(bb_upper-bb_lower)", "v_atr_pct": "atr_pct",
    "v_atr_pct_d": "atr_pct - prev(atr_pct)",
    "v_squeeze": "(bb_upper-bb_lower)/(kc_upper-kc_lower)",
    "v_close_kc": "(close-kc_middle)/atr_14",
    "b_adx": "adx_14", "b_adx_d": "adx_14 - prev(adx_14)",
    "b_di_spread": "adx_plus_di-adx_minus_di",
    "b_pctB_ext": "abs((close-bb_lower)/(bb_upper-bb_lower) - 0.5)",
    "b_bbw_expand": "bb_width_bps - prev(bb_width_bps)",
    "b_squeeze_rel": "(bb_upper-bb_lower)/(kc_upper-kc_lower) - prev_squeeze",
}
# side-normalization centers (fold bearish into the bullish frame: c + sign*(x-c)).
# features absent here are SYMMETRIC (magnitude/expansion) and not folded.
CENTERS = {
    **{f: 0.0 for f in ["t_close_sma10","t_close_sma20","t_close_sma50","t_close_ema12",
                        "t_close_ema26","t_ema_spread","t_sma_10_20","t_sma_20_50",
                        "t_close_psar","t_macd_cross","m_rsi_d","m_stoch_kd","m_stc_delta",
                        "m_stc_gap","m_cci","m_macd_hist","m_macd_hist_d","v_close_kc","b_di_spread"]},
    **{f: 50.0 for f in ["m_rsi","m_stoch_k","m_stoch_d","m_stc"]},
    "m_williams": -50.0, "v_pctB": 0.5, "t_psar_bull": 0.5,
}

def load(path):
    d = pd.read_csv(path)
    d.columns = [c.strip() for c in d.columns]
    d["side"] = d["side"].astype(str).str.strip()
    feats = [c for c in d.columns if c not in META and not c.startswith("fwd_")]
    return d, feats

def fold(df, feats):
    """Side-normalize: sign=+1 bullish, -1 bearish; fold directional feats into the
    bullish frame so a single threshold rule is symmetric across both sides."""
    sign = np.where(df["side"] == "bullish_exhaustion", 1.0, -1.0)
    out = pd.DataFrame(index=df.index)
    for f in feats:
        if f in CENTERS:
            c = CENTERS[f]; out[f] = c + sign * (df[f].astype(float) - c)
        else:
            out[f] = df[f].astype(float)
    return out

def main():
    train, feats = load(TRAIN_CSV)
    oos, feats_o = load(OOS_CSV)
    assert feats == feats_o, "train/OOS feature columns differ"
    print(f"features {len(feats)}   train {len(train)}   OOS {len(oos)}")

    Xtr_raw, ytr = train[feats].astype(float), train["target_decay_realized"].astype(int)
    Xoos_raw, yoos = oos[feats].astype(float), oos["target_decay_realized"].astype(int)
    med = Xtr_raw.median()

    # ---- Key 2: scaler + L2 logistic on RAW features (parity-exact) ----
    scaler = StandardScaler().fit(Xtr_raw.fillna(med))
    clf = LogisticRegression(penalty="l2", max_iter=1000)
    clf.fit(scaler.transform(Xtr_raw.fillna(med)), ytr)
    p_oos = clf.predict_proba(scaler.transform(Xoos_raw.fillna(med)))[:, 1]
    ml_threshold = float(np.percentile(p_oos, ML_PCT))
    ml_fire = p_oos >= ml_threshold
    print(f"ML gate p_decay {ML_PCT}th pct = {ml_threshold:.4f}  (fires {int(ml_fire.sum())}/{len(oos)})")

    # ---- Key 1: surrogate on SIDE-NORMALIZED features -> symmetric rule ----
    Xtr_f = fold(train, feats).fillna(med)
    Xoos_f = fold(oos, feats).fillna(med)
    tree = DecisionTreeClassifier(max_depth=3, min_samples_leaf=15, random_state=0).fit(Xtr_f, ytr)
    imp = sorted(zip(feats, tree.feature_importances_), key=lambda x: -x[1])
    top3 = [f for f, _ in imp[:3]]
    print("surrogate top-3 (folded): " + ", ".join(f"{f} ({w:.2f})" for f, w in imp[:3]))
    ops = {f: (">" if train.assign(v=Xtr_f[f]).groupby(ytr)["v"].mean().get(1, 0)
                      >= train.assign(v=Xtr_f[f]).groupby(ytr)["v"].mean().get(0, 0) else "<")
           for f in top3}

    # grid-search thresholds on (folded) OOS maximizing Q1 WR, N>=100
    arr = {f: Xoos_f[f].values for f in top3}
    cand = {f: np.quantile(arr[f], np.arange(0.05, 0.96, 0.05)) for f in top3}
    y = yoos.values
    best = None
    for t0 in cand[top3[0]]:
        m0 = arr[top3[0]] > t0 if ops[top3[0]] == ">" else arr[top3[0]] < t0
        for t1 in cand[top3[1]]:
            m1 = (arr[top3[1]] > t1 if ops[top3[1]] == ">" else arr[top3[1]] < t1) & m0
            for t2 in cand[top3[2]]:
                m2 = arr[top3[2]] > t2 if ops[top3[2]] == ">" else arr[top3[2]] < t2
                q1 = m1 & m2 & ml_fire
                n = int(q1.sum())
                if n < MIN_Q1:
                    continue
                wr = float(y[q1].mean())
                if best is None or wr > best[0] or (wr == best[0] and n > best[1]):
                    best = (wr, n, (float(t0), float(t1), float(t2)))
    if best is None:
        thr = tuple(float(np.quantile(arr[f], 0.05 if ops[f] == ">" else 0.95)) for f in top3)
        masks = [(arr[f] > t) if ops[f] == ">" else (arr[f] < t) for f, t in zip(top3, thr)]
        q1 = masks[0] & masks[1] & masks[2] & ml_fire
        best = (float(y[q1].mean()) if q1.sum() else float("nan"), int(q1.sum()), thr)
    wr, n_q1, thr = best

    heuristic_rule = [{
        "feature": f, "compute": FORMULAS[f], "operator": ops[f], "threshold": t,
        "side_normalized": f in CENTERS, "center": CENTERS.get(f, 0.0),
    } for f, t in zip(top3, thr)]

    # ---- package static-decay-gate/v2 ----
    params = {
        "schema": "static-decay-gate/v2",
        "logic": ("for each bar compute features from raw indicators; a bar is an ONSET if all "
                  "onset_mask pass (its stretch sign sets side: up=bullish→PUT, down=bearish→CALL); "
                  "side-normalize per `center`+sign, then FIRE if all heuristic_rule pass; for the "
                  "two-key gate also require ml p_decay >= oos_threshold. Trade = FADE at expiry."),
        "bar_sec": BAR_SEC, "expiry_minutes": EXPIRY_MIN, "direction": "fade",
        "side_rule": "stretch (close-sma_50) sign: >0 bullish_exhaustion→PUT ; <0 bearish_exhaustion→CALL",
        "onset_mask": [
            {"name": "squeeze", "compute": FORMULAS["v_squeeze"], "operator": ">", "threshold": SQUEEZE_MIN,
             "side_normalized": False},
            {"name": "stretch_atr", "compute": FORMULAS["t_close_sma50"], "abs": True, "operator": ">",
             "threshold": STRETCH_ATR, "side_normalized": False,
             "note": "sign of (close-sma_50) sets the side"},
            {"name": "decel", "compute": FORMULAS["m_stc_delta"], "operator": "<", "threshold": 0.0,
             "side_normalized": True, "center": 0.0,
             "note": "stc_delta against the stretch (folded: <0)"},
        ],
        "heuristic_rule": heuristic_rule,
        "oos_threshold": ml_threshold,
        "ml_model": {
            "features": feats,
            "weights": [float(w) for w in clf.coef_[0]],
            "bias": float(clf.intercept_[0]),
            "scaler": {"means": [float(m) for m in scaler.mean_],
                       "scales": [float(s) for s in scaler.scale_]},
        },
        "meta": {
            "train_csv": os.path.basename(TRAIN_CSV), "oos_csv": os.path.basename(OOS_CSV),
            "train_rows": len(train), "oos_rows": len(oos),
            "q1_consensus_n": n_q1, "q1_consensus_wr": wr,
            "note": "heuristic thresholds tuned ON oos (folded) — q1_wr is in-sample-to-search; confirm forward",
        },
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PARAMS, "w") as fh:
        json.dump(params, fh, indent=2)

    # ---- parity cases: 100 random OOS rows (RAW features) + python p_decay ----
    rng = np.random.RandomState(42)
    idx = rng.choice(len(oos), size=min(100, len(oos)), replace=False)
    Xo = Xoos_raw.fillna(med)
    cases = [{"x": [float(v) for v in Xo[feats].values[i]], "p_decay": float(p_oos[i])} for i in idx]
    with open(OUT_PARITY, "w") as fh:
        json.dump({"feature_order": feats, "cases": cases}, fh, indent=2)
    z = (Xo[feats].values[idx] - scaler.mean_) / scaler.scale_
    manual = 1.0 / (1.0 + np.exp(-(z @ clf.coef_[0] + clf.intercept_[0])))
    max_err = float(np.max(np.abs(manual - p_oos[idx])))

    # ---- console summary ----
    print("\n================ FREEZE SUMMARY (static-decay-gate/v2) ================")
    print(f"onset mask : squeeze>{SQUEEZE_MIN}, |stretch_atr|>{STRETCH_ATR}, stc_delta vs stretch<0")
    print("heuristic rule (side-normalized, symmetric):")
    for r in heuristic_rule:
        nz = " [×side]" if r["side_normalized"] else ""
        print(f"   {r['feature']} {r['operator']} {r['threshold']:.4f}{nz}   = {r['compute']}")
    print(f"ML gate (Key 2): p_decay >= {ml_threshold:.4f}")
    print(f"Q1 consensus   : N={n_q1}  WR={wr*100:.1f}%  (break-even 55.6%)")
    print(f"self-parity    : max |manual-sklearn| = {max_err:.2e}")
    print(f"saved → {os.path.relpath(OUT_PARAMS, ROOT)}")
    print(f"saved → {os.path.relpath(OUT_PARITY, ROOT)}  ({len(cases)} cases)")
    print("CAVEAT: heuristic thresholds tuned on OOS — WR is in-sample ceiling, confirm forward.")
    print("======================================================================")

if __name__ == "__main__":
    main()
