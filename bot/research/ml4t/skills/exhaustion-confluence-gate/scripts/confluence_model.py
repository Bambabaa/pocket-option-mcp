#!/usr/bin/env python3
"""
confluence_model.py — faithful exhaustion-confluence features -> tree + logreg, trained
on agent_v1 (May 12-26) and tested on the clean zero-overlap OOS agent (May 29-Jun 12).

Fixes the deployed gate's failures:
  - replaces lossy |K-D| with SIGNED + LEVEL stoch features (cross event, overbought)
  - adds the BB tag-then-reject event, rejection wick, level+slope for STC/CCI
  - SIDE-FOLDS everything into one "exhaustion frame" so the BULLISH-floor (CALL) setup
    perfectly MIRRORS the BEARISH-ceiling (PUT) setup -> one model, both directions
  - reports WR vs BREAK-EVEN (not base rate), capture rate (rejects thin tails),
    logreg coefficient spread (catches single-feature collapse), and PUT vs CALL split

side = sign(close[t]-close[t-3]).  up-move  -> bearish frame, fade = PUT
                                   down-move-> bullish frame, fade = CALL
Folded so exhaustion always reads the same; bet direction recovers CALL/PUT.
Label = reversal_realized (fade win) at horizon H, purged at the period boundary.

Usage: python confluence_model.py [--horizon 3] [--C 1.0]
"""
from __future__ import annotations
import argparse, os, sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "_lib"))
import po_data
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", ".."))
def R(p): return os.path.join(ROOT, p)
BAR = 300
TRAIN_DB = "agent/data/agent_v1.db"   # May 12-26
OOS_DB   = "agent/data/agent.db"      # May 29-Jun 12 (zero overlap)
BE = 0.59

def engineer(db, H):
    d = po_data.load(R(db))
    rows = []
    for _, g in d.groupby("asset", sort=False):
        g = g.sort_values("timestamp").copy()
        c, o, hi, lo, ts = (g["close"].astype(float), g["open"].astype(float),
                            g["high"].astype(float), g["low"].astype(float), g["timestamp"])
        atr = g["atr_14"].replace(0, np.nan)
        k, dn = g["stoch_k"].astype(float), g["stoch_d"].astype(float)
        stc, cci = g["stc_value"].astype(float), g["cci_20"].astype(float)
        bbu, bbl, bbm = g["bb_upper"], g["bb_lower"], g["bb_middle"]
        ret3 = c - c.shift(3)
        side = np.sign(ret3)                      # +1 up(bearish/PUT)  -1 down(bullish/CALL)

        # per-side raw event flags (then fold-select by side)
        be_tag = (hi >= bbu) & (c < bbu); bu_tag = (lo <= bbl) & (c > bbl)
        kd = k - dn; kd_prev = kd.shift(1)
        be_cross = (k >= 80) & (kd < 0) & (kd_prev >= 0)
        bu_cross = (k <= 20) & (kd > 0) & (kd_prev <= 0)
        upper_wick = (hi - np.maximum(o, c)) / atr
        lower_wick = (np.minimum(o, c) - lo) / atr
        be_band3 = (hi >= bbu) & (c < bbu)
        be_stc3  = (stc >= 75) & (stc < stc.shift(1)); bu_stc3 = (stc <= 25) & (stc > stc.shift(1))
        be_cci3  = (cci > 100) & (cci < cci.shift(2)); bu_cci3 = (cci < -100) & (cci > cci.shift(2))

        f = pd.DataFrame(index=g.index)
        # --- folded into exhaustion frame (exhaustion reads the same for PUT & CALL) ---
        f["bbpos"]    = 0.5 + side*(((c - bbl)/(bbu - bbl)).replace([np.inf,-np.inf],np.nan) - 0.5)
        f["close_mid"]= side*((c - bbm)/atr)
        f["tag_rej"]  = np.where(side > 0, be_tag, bu_tag).astype(float)
        f["bb_width"] = g["bb_width_bps"].astype(float)
        f["bb_expand"]= (g["bb_width_bps"] > g["bb_width_bps"].shift(1)).astype(float)
        f["k_lvl"]    = 50 + side*(k - 50)
        f["kd"]       = side*kd
        f["kd_cross"] = np.where(side > 0, be_cross, bu_cross).astype(float)
        f["k_slope"]  = side*(k - k.shift(1))
        f["stc_lvl"]  = 50 + side*(stc - 50)
        f["stc_slope"]= side*(stc - stc.shift(1))
        f["cci"]      = side*cci
        f["cci_vel"]  = side*((cci - cci.shift(2))/2)
        f["body"]     = side*((c - o)/atr)
        f["rej_wick"] = np.where(side > 0, upper_wick, lower_wick)
        f["stretch"]  = side*ret3 / atr
        # confluence count (per side), level+direction aware
        bear_sc = be_band3.astype(int)+be_cross.astype(int)+be_stc3.astype(int)+be_cci3.astype(int)
        bull_sc = bu_tag.astype(int)+bu_cross.astype(int)+bu_stc3.astype(int)+bu_cci3.astype(int)
        f["confluence"] = np.where(side > 0, bear_sc, bull_sc).astype(float)

        # label: reversal realized over H (fade win), purged-contiguous
        fwd = c.shift(-H) - c; okH = (ts.shift(-H) - ts == H*BAR) & (ts - ts.shift(3) == 3*BAR) & (ret3 != 0)
        f["y"]    = np.where(okH, (np.sign(fwd) != side).astype(float), np.nan)
        f["bet"]  = np.where(side > 0, "PUT", "CALL")
        f["ts"]   = ts.values
        rows.append(f)
    out = pd.concat(rows)
    feats = ["bbpos","close_mid","tag_rej","bb_width","bb_expand","k_lvl","kd","kd_cross",
             "k_slope","stc_lvl","stc_slope","cci","cci_vel","body","rej_wick","stretch","confluence"]
    return out.dropna(subset=feats+["y"]), feats

def report_model(name, proba_oos, yoos, bet, coef_share=None):
    print(f"\n### {name}   OOS AUC {roc_auc_score(yoos, proba_oos):.3f}"
          + (f"  | top-feature weight {coef_share*100:.0f}%" if coef_share is not None else ""))
    print("| gate thr | capture | OOS WR vs BE59 | PUT WR | CALL WR |")
    print("|---|---|---|---|---|")
    for thr in [0.50,0.55,0.60,0.65,0.70]:
        m = proba_oos >= thr; n = int(m.sum())
        if n < 30:
            print(f"| {thr:.2f} | {n} | thin | — | — |"); continue
        wr = yoos[m].mean()*100
        pm = m & (bet=="PUT"); cm = m & (bet=="CALL")
        pw = yoos[pm].mean()*100 if pm.sum()>=15 else np.nan
        cw = yoos[cm].mean()*100 if cm.sum()>=15 else np.nan
        cap = n/len(proba_oos)*100; flag = "*" if wr>=BE*100 else ""
        pws = f"{pw:.0f}% (n={int(pm.sum())})" if np.isfinite(pw) else "—"
        cws = f"{cw:.0f}% (n={int(cm.sum())})" if np.isfinite(cw) else "—"
        print(f"| {thr:.2f} | {cap:.1f}% (n={n}) | {wr:.1f}%{flag} | {pws} | {cws} |")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--horizon", type=int, default=3)
    ap.add_argument("--C", type=float, default=1.0); a = ap.parse_args()
    tr, feats = engineer(TRAIN_DB, a.horizon)
    te, _     = engineer(OOS_DB,   a.horizon)
    Xtr, ytr = tr[feats].values, tr["y"].astype(int).values
    Xte, yte = te[feats].values, te["y"].astype(int).values
    bet = te["bet"].values
    print(f"# Confluence model — tree + logreg | horizon {a.horizon} bars ({a.horizon*5}m)")
    print(f"train agent_v1 n={len(tr)} (base {ytr.mean()*100:.1f}%) | OOS agent n={len(te)} "
          f"(base {yte.mean()*100:.1f}%) | break-even {BE*100:.0f}%")
    print(f"PUT/CALL split shown to confirm the mirror. * = clears break-even.")

    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(C=a.C, class_weight="balanced", max_iter=1000).fit(sc.transform(Xtr), ytr)
    p_lr = lr.predict_proba(sc.transform(Xte))[:,1]
    w = np.abs(lr.coef_[0]); share = w.max()/w.sum()
    top = feats[int(np.argmax(w))]
    report_model(f"L2 LogReg (C={a.C}, top={top})", p_lr, yte, bet, coef_share=share)

    tree = DecisionTreeClassifier(max_depth=4, min_samples_leaf=100, class_weight="balanced",
                                  random_state=42).fit(Xtr, ytr)
    p_tr = tree.predict_proba(Xte)[:,1]
    imp = dict(sorted(zip(feats, tree.feature_importances_), key=lambda x:-x[1])[:4])
    report_model("Constrained Tree (depth4, leaf100)", p_tr, yte, bet,
                 coef_share=max(tree.feature_importances_))
    print(f"\nTree top importances: " + ", ".join(f"{k} {v:.2f}" for k,v in imp.items()))
    print("\nRead: tradeable edge = OOS WR clears BE on BOTH PUT and CALL at capture >3% and no "
          "single feature >40%. Anything only in-sample is the old overfit.")

if __name__ == "__main__":
    main()
