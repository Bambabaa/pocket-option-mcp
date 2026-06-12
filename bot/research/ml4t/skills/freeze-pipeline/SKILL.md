---
name: freeze-pipeline
description: >-
  Freeze a validated decay-onset signal into a deployable, runtime-Python-free JSON gate — a Two-Key
  static-decay-gate/v2: a data-driven heuristic indicator-threshold confluence (Key 1) plus an L2
  LogisticRegression p_decay gate (Key 2), with the onset mask, a `compute` formula per threshold,
  and parity test vectors. Use this skill WHENEVER you are ready to PRODUCTIONIZE / DEPLOY / FREEZE a
  researched edge, when asked to "export the model to JSON", "build ml_gate_params.json", "make a
  native/JS gate", "freeze the weights", "turn the model into indicator thresholds the bot can run",
  or to regenerate the gate from fresh onset CSVs. It is the LAST stage of the pipeline — it runs
  AFTER alpha-factor-eval → purged-walk-forward-cv → directional-momentum-edge (decay_onset) →
  surrogate-extraction have established the edge. Nothing is hardcoded: it discovers the feature
  confluence and thresholds, then emits a generic schema a JS bot parses blindly. Prefer this over
  hand-writing gate thresholds or shipping a pickled model.
---

# Freeze Pipeline (model → deployable JSON gate)

## Why this exists

The bot runs Node, and the project bans Python at runtime (it corrupts the live SQLite). So a
researched ML edge can only ship if it is **frozen to plain JSON** that a native JS gate evaluates —
the `ml-gate.js` pattern. This skill performs that freeze for the decay-onset consensus signal,
producing two artifacts and proving the math is portable to `<1e-9`.

It is also **fully data-driven** — it does not hardcode features (no "bb_width > X" written by hand).
It discovers the dominant feature confluence (shallow tree → top-3 by importance) and grid-searches
the thresholds, so the deployed rule reflects the data, not intuition.

## When to use

- An edge has passed the research stages and you want to deploy it.
- "Export / freeze / productionize the model", "build `ml_gate_params.json`", "make the JS gate".
- Re-freezing from fresh onset CSVs (drift refresh / new capture).

## What it produces

`scripts/freeze_pipeline.py` reads the onset `_full` CSVs (train = FXSB, OOS = June) and writes to
`bot/research/tests/`:

- **`ml_gate_params.json`** — schema `static-decay-gate/v2`:
  - `onset_mask` — the structural-exhaustion pre-condition (squeeze, |stretch| in ATR, decel), each
    with a `compute` formula. Determines candidates AND the side (stretch sign).
  - `heuristic_rule` (Key 1) — the discovered confluence: `[{feature, compute, operator, threshold,
    side_normalized, center}]`, found in a side-normalized frame so the rule is symmetric.
  - `oos_threshold` + `ml_model` (Key 2) — the 75th-pct `p_decay` gate, and the L2-logistic
    `features[36] / weights / bias / scaler{means, scales}` on the RAW features (parity-exact).
  - `direction` / `expiry_minutes` — fade the stretch, 10m default.
- **`parity_test_cases.json`** — 100 random OOS feature vectors + the Python `p_decay`, for the JS
  parity proof.

## How to run

```bash
python bot/research/ml4t/skills/freeze-pipeline/scripts/freeze_pipeline.py
```
No args — paths are resolved from the repo root (train/OOS CSVs in
`directional-momentum-edge/exports/`, output to `bot/research/tests/`). Edit the module constants to
retarget: `TRAIN_CSV` / `OOS_CSV`, `ML_PCT` (75), `MIN_Q1` (100), `STRETCH_ATR`/`SQUEEZE_MIN` (must
match the mask the CSVs were exported at), `EXPIRY_MIN` (10).

## How to read the output

Console summary prints: the **discovered onset mask**, the **discovered heuristic rule** (with the
`[×side]` fold marked), the **ML gate threshold**, the **Q1 consensus N + WR**, and a **self-parity**
line (`max |manual − sklearn|` must be ~0). Then it confirms the two JSON files were written.

The pieces of the gate, in firing order: a bar passes the **onset mask** (becomes a candidate, side
set by stretch sign) → **Key 1 heuristic** all pass → **Key 2** `p_decay ≥ oos_threshold` → fire the
**fade** at the expiry.

## After freezing — prove and deploy

The freeze is not trusted until the native gate is proven to reproduce it (see `bot/research/tests/`):

1. **Logistic parity** — `node test_parity.js` → 100/100 within `<1e-9`.
2. **Feature port** — `node test_db_runner.js` → JS `engineer_families` == Python (0 diff over the DB),
   onset set identical.
3. **OOS realized** — `node test_db_runner.js <oos.dbs> none` → captured signals' fade-WR vs break-even.

## Honest limitations (in the JSON `meta`, and enforced by this skill's discipline)

- **Grid-search-on-OOS** — the heuristic thresholds are tuned on the OOS set, so the reported Q1 WR is
  the in-sample-to-search ceiling, NOT forward-validated. Recorded in `meta.note`.
- **Mask provenance** — `STRETCH_ATR`/`SQUEEZE_MIN` here must equal the mask the CSVs were exported at,
  or the deployed mask won't match the training population.
- **Freeze ≠ proof of edge** — freezing makes a correct, portable artifact; the edge still owes forward
  shadow validation before sizing (the OOS sample is thin — see `bot/research/tests/TEST_REPORT.md`).

See `references/methodology.md` for the side-normalization fold, the grid-search, the JSON schema, and
the parity contract.
