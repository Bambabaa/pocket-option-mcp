# Methodology — Freeze Pipeline

The mechanics behind `scripts/freeze_pipeline.py`: how a validated decay-onset signal becomes a
deployable, runtime-Python-free JSON gate, and the contract the native JS gate must satisfy.

## 1. Inputs

Two onset `_full` CSVs from `decay_onset.py --export-full` (all 36 engineered family features + side
+ forward returns + target), at the **gate's mask** (default 4.0 ATR stretch / 1.20 squeeze):
- **Train** = `onsets_fxsb_4.0_full.csv` (Apr–May, the logistic's fit data).
- **OOS** = `onsets_june_2.0_full.csv` (used for the threshold + grid search).

`META = {timestamp, asset, side, p_decay, p_decay_pct, target_decay_realized}` and any `fwd_*` columns
are excluded; the remaining 36 are the features.

## 2. Key 2 — the logistic gate (RAW features, parity-exact)

```
scaler = StandardScaler().fit(train[features])        # train-fit
clf    = LogisticRegression(penalty="l2", max_iter=1000)   # default C, NO class_weight
clf.fit(scaler.transform(train[features]), train.target)
p_oos        = clf.predict_proba(scaler.transform(oos[features]))[:,1]
oos_threshold = percentile(p_oos, 75)                 # the ML gate
```

Plain (un-weighted) logistic on the **raw** features so the frozen `weights / bias / scaler` reproduce
exactly in JS via `sigmoid(Σ ((x-mean)/scale)·w + b)`. `class_weight="balanced"` is deliberately NOT
used — it compresses probabilities toward 0.5 and shifts the 75th percentile away from the expected
~0.57. NaN features contribute 0 at inference (matches `test_gate.js`).

## 3. Key 1 — the heuristic confluence (side-normalized, data-driven)

Discovery uses a **side-normalized** frame so the rule is symmetric (one rule, mirrored for the short
side). With `sign = +1` bullish / `−1` bearish, each directional feature is folded into the bullish
frame: `folded = center + sign·(x − center)`. Centers: 0 for signed features (trend distances, stc/macd
deltas, cci, di_spread, …), 50 for rsi/stoch/stc levels, −50 for williams, 0.5 for %B and psar_bull;
magnitude/expansion features (bb_width, atr_pct, squeeze, adx, …) are not folded.

```
tree  = DecisionTreeClassifier(max_depth=3, min_samples_leaf=15).fit(fold(train), target)
top3  = top-3 features by tree.feature_importances_     # nothing hardcoded
ops   = per feature, ">" if decays have the higher folded mean else "<"    # from train
```

**Threshold grid-search** over the folded OOS: for each of the top-3 features, candidate thresholds are
the 5th…95th percentiles; the combo maximizing the **Q1 consensus WR** (heuristic ∧ `p_decay ≥
oos_threshold`) subject to **N(Q1) ≥ 100** is chosen. (This tunes thresholds on OOS — the resulting WR
is an in-sample-to-search ceiling; recorded in `meta.note`.)

## 4. The JSON schema (`static-decay-gate/v2`)

```jsonc
{
  "schema": "static-decay-gate/v2",
  "bar_sec": 300, "expiry_minutes": 10, "direction": "fade",
  "side_rule": "stretch (close-sma_50) sign: >0 bullish→PUT ; <0 bearish→CALL",
  "onset_mask": [ {name, compute, operator, threshold, [abs], [side_normalized, center]} ],
  "heuristic_rule": [ {feature, compute, operator, threshold, side_normalized, center} ],
  "oos_threshold": <float>,
  "ml_model": { features[36], weights[36], bias, scaler:{means[36], scales[36]} },
  "meta": { train/oos rows, q1_consensus_n, q1_consensus_wr, note }
}
```

Every threshold carries a **`compute`** string (the raw-indicator formula, mirroring
`engineer_families`) so a JS bot can evaluate it without Python. `side_normalized` + `center` tell the
JS to fold by the stretch sign. This is generic: a downstream parser reads mask → heuristic → ml
blindly.

## 5. Parity contract

`parity_test_cases.json` = 100 random OOS rows: `{feature_order[36], cases:[{x[36], p_decay}]}` where
`p_decay` is the Python logistic output. The freeze self-checks that a manual
`sigmoid((x−mean)/scale · w + b)` reproduces `predict_proba` to ~0 before writing. The JS gate
(`test_gate.js`) must then reproduce every case to `<1e-9` (`test_parity.js`), and recompute the 36
features from raw candles identically (`test_db_runner.js`, 0 diff over the whole DB).

## 6. What this skill does NOT do

- It does not establish the edge — that is the prior stages (alpha-factor-eval → … → surrogate).
- It does not forward-validate — a frozen gate is correct and portable, but its OOS sample is thin;
  forward shadow validation precedes any sizing.
- It does not pick the expiry — `expiry_sweep.py` / `consensus_survival.py` do (10m default;
  vol-shock→10m, stoch-grind→15m).

## References

- Project: `bot/research/ml-gate.js` + `ml_gate_params.json` (the original freeze/parity pattern this
  generalizes), `bot/research/tests/TEST_REPORT.md` (the deployment & validation report),
  `bot/research/ml4t/skills/directional-momentum-edge/scripts/{decay_onset,surrogate_extract}.py`
  (the stages that feed this freeze).
