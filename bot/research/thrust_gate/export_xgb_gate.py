"""
EXPORT — XGBoost Squeeze-Conditioned Thrust Continuation gate (Python -> JSON, SOP Step 10).

Full-data fit on agent.db squeeze-release rows (RESEARCH only — this model is a confirmed
single-regime overfit; see xgb_continuation_gate.py. We build the export/parity kit, not a
live gate). Dumps the exact tree ensemble + base margin so the JS port reproduces
predict_proba to float32 precision, plus fixtures for the parity test.
"""
import os, json, math, sqlite3, warnings
warnings.filterwarnings("ignore")
import numpy as np, pandas as pd, xgboost as xgb
from xgboost import XGBClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", "..", "..", "data"))
AGENT = os.path.join(DATA, "agent.db")
TRAINED = {"AUDCAD","AUDCHF","AUDJPY","CADCHF","CADJPY","CHFJPY",
           "EURAUD","EURCHF","EURJPY","EURUSD","USDCAD","USDCHF","USDJPY"}
FEATURES = ["Thrust_dir", "F_macro"]

def engineer(g):
    d = g.sort_values("timestamp").reset_index(drop=True).copy()
    c = d.close
    sq_on = (d.bb_upper - d.bb_lower) < (d.keltner_upper - d.keltner_lower)
    d["Squeeze_Release"] = sq_on.shift(1).fillna(False) & (~sq_on)
    d["Thrust_dir"] = (d.plus_di - d.minus_di).abs() * d.williams_r
    d["F_macro"] = (c - d.keltner_middle) / d.atr_14
    direction = np.sign(c - c.shift(1)); forward = c.shift(-3) - c
    d["Target_Continuation"] = (np.sign(forward) == direction).astype(float)
    d.loc[(forward == 0) | (direction == 0) | forward.isna(), "Target_Continuation"] = np.nan
    return d

# ── parse one XGBoost json-dumped tree into a compact nested node ───────────────
def parse_tree(node):
    if "leaf" in node:
        return {"leaf": float(node["leaf"])}
    ch = {c["nodeid"]: c for c in node["children"]}
    return {
        "f": int(node["split"][1:]),               # 'f0' -> 0
        "t": float(node["split_condition"]),         # go LEFT (yes) if x[f] < t
        "d": "l" if node["missing"] == node["yes"] else "r",  # missing default
        "l": parse_tree(ch[node["yes"]]),
        "r": parse_tree(ch[node["no"]]),
    }

def walk(node, x):
    while "leaf" not in node:
        v = x[node["f"]]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            node = node["l"] if node["d"] == "l" else node["r"]
        else:
            node = node["l"] if v < node["t"] else node["r"]
    return node["leaf"]

def main():
    con = sqlite3.connect(f"file:{AGENT}?mode=ro", uri=True)
    df = pd.read_sql("""SELECT c.timestamp,c.asset,c.close,i.bb_upper,i.bb_lower,
        i.keltner_upper,i.keltner_lower,i.keltner_middle,i.plus_di,i.minus_di,i.williams_r,i.atr_14
        FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        ORDER BY c.asset,c.timestamp""", con); con.close()
    feat = pd.concat([engineer(g) for a, g in df.groupby("asset") if a in TRAINED], ignore_index=True)
    sq = feat[feat.Squeeze_Release].replace([np.inf,-np.inf], np.nan).dropna(subset=FEATURES+["Target_Continuation"]).reset_index(drop=True)
    X = sq[FEATURES].values.astype(np.float32); y = sq.Target_Continuation.astype(int).values
    print(f"Training on {len(X)} squeeze-release rows, base rate {y.mean():.4f}")

    model = XGBClassifier(max_depth=3, n_estimators=100, learning_rate=0.05,
                          eval_metric="logloss", random_state=42, n_jobs=1)
    model.fit(X, y)
    booster = model.get_booster()

    trees = [parse_tree(json.loads(s)) for s in booster.get_dump(dump_format="json")]

    # derive the constant base margin: margin = base + sum(tree leaves)
    margin = booster.predict(xgb.DMatrix(X), output_margin=True)
    sum_leaves = np.array([sum(walk(t, X[i]) for t in trees) for i in range(len(X))])
    base_candidates = margin - sum_leaves
    base = float(np.median(base_candidates))
    assert np.allclose(base_candidates, base, atol=1e-5), f"base not constant! spread={base_candidates.ptp():.2e}"

    # verify reconstruction == predict_proba (float32 tolerance)
    proba_py = model.predict_proba(X)[:, 1]
    proba_recon = 1 / (1 + np.exp(-(base + sum_leaves)))
    err = np.abs(proba_recon - proba_py).max()
    assert err < 1e-5, f"reconstruction mismatch {err:.2e}"
    print(f"  reconstruction verified to {err:.1e} ({len(trees)} trees, base={base:.6f})")

    params = {
        "model": "thrust_xgb_continuation_gate",
        "status": "RESEARCH_SHADOW",
        "note": "single-regime overfit (June 65% / May 45%) — export/parity demo, NOT for live",
        "features": FEATURES,
        "objective": "binary:logistic",
        "base": base,
        "n_trees": len(trees),
        "trees": trees,
    }
    json.dump(params, open(os.path.join(HERE, "thrust_xgb_params.json"), "w"))

    idx = np.linspace(0, len(X) - 1, min(600, len(X))).astype(int)
    fixtures = [{"features": {f: float(X[i][j]) for j, f in enumerate(FEATURES)},
                 "proba": float(proba_py[i])} for i in idx]
    json.dump(fixtures, open(os.path.join(HERE, "thrust_xgb_fixtures.json"), "w"))
    print(f"  exported thrust_xgb_params.json + {len(fixtures)} fixtures")

if __name__ == "__main__":
    main()
