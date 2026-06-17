# Directional Edge — Procedure & Result

The reproducible path from "the deployed reversal gate is coin-flip" to "a robust 15-minute
directional edge that survives every leakage test." Generated 2026-06-16.

## Result (headline)

Clean cross-period OOS (train `agent_v1.db` May 12-26 → test `agent.db` May 29-Jun 12,
zero timestamp overlap), RandomForest, 15-min-ahead direction target:

| variant | removes | AUC | acc |
|---|---|---|---|
| RAW | nothing | 0.641 | 59.0% |
| per-asset z-norm | static level + drift | 0.631 | 59.4% |
| UNSEEN assets (train 5, test 5 other) | asset identity entirely | 0.624 | 57.7% |

The edge is NOT asset drift/identity/scale or time leakage. It is real within-asset 15m
directional timing signal — the first robust edge in the whole investigation.

---

## The procedure (each step is a script you can re-run)

### Phase 1 — disprove the deployed reversal gate
1. **Critique the deployed model** (`bot/ml-gate.js` + `bot/research/ml_gate_params.json`):
   found single-feature collapse (logreg coef 0.593 on Stoch_Divergence vs ~0; tree importance
   0.988), `|K-D|` discards direction+level, thin-tail overfit (gate fires <1% capture).
   → `reversal-gate-retest/TREE_DIRECTION_REPORT.md` (secs E), `reversal_gate_retest.py`.
2. **Find the training data & prove the deploy decision was made on the wrong metric.**
   `agent_v1.db` == the training set (49,515 rows, base rate 0.398 match the deployed meta to
   the digit). The training pipeline reports "uplift vs base rate," never vs break-even — a
   53% gated WR read as "+8pp" when break-even is 59%. → run `reversal_gate_pipeline_v2.py` on
   agent_v1 and agent merged CSVs.
3. **Confirm coin-flip OOS** at scale: feature scan max AUC 0.512 (n=42k), purged walk-forward
   47-53% (n=5,702), every window/direction. → `reversal-gate-retest/` Tests A/B + `feature_scan_agent.py`.

### Phase 2 — the pivots that mattered
4. **Faithful confluence encoding** (level+direction aware, side-folded so CALL mirrors PUT):
   recovered a little OOS-stable signal (bearish 15m 57%) but still sub-break-even for reversal.
   → `confluence_model.py`, `confluence_scan.py`.
5. **Change the TARGET to direction** (not reversal). Next-1-bar: AUC 0.527 OOS — weak.
   → `confluence_directional.py`, `fine_tune.py` (OOS-selected, gap-filtered; ceiling ~0.53).
6. **The unlock — `trading_ml_v2.py` (user-supplied):** two changes that broke it open —
   **(a) HORIZON=3 (predict direction 15 minutes ahead, not 1 bar)** and **(b) a broad raw-
   indicator feature set** (~46). In-period AUC jumped to 0.71-0.73.

### Phase 3 — the leakage gauntlet (why we trust it)
7. **Three-split comparison** (`leakage_check.py`): asset-ordered 0.715, time-ordered 0.734,
   clean v1→agent 0.641. (Corrected an earlier wrong assumption that the split was inflating —
   the honest time split was actually higher; the cross-period number is the real one.)
8. **Per-asset normalization + unseen-asset holdout** (`per_asset_normalize.py`): dropped the
   `asset_enc` feature, z-scored every feature within each asset, and tested on assets never
   seen in training. AUC held at 0.631 / 0.624. → edge confirmed real.

---

## The validation protocol that should gate every future model

A result is only trusted if it passes ALL of:
1. **Zero-overlap cross-period** — train one DB, test a later DB with 0 shared (asset,timestamp).
2. **Per-asset z-normalization** — kill static level + persistent drift; drop any asset-ID feature.
3. **Unseen-asset holdout** — train on a subset of pairs, test on entirely different pairs.
4. **WR vs BREAK-EVEN, not base rate** — `(1-WR)/WR = required payout`; the deploy failure was
   reporting uplift vs base rate.
5. **Capture-rate floor** — distrust any edge that only appears below ~3% capture (thin tail).

## Open work (do not deploy yet)
- Confidence-threshold WR-vs-break-even sweep on the unseen-asset split (tradeability at capture).
- Multi-period walk-forward (only one period-pair tested so far).
- CALL/PUT (up/down) asymmetry — earlier runs showed one direction stronger.
- Feature drivers AFTER normalization (pre-norm importance was volatility-heavy).
