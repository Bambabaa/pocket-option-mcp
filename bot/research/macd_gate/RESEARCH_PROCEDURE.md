# Reversal Gate — Research & Validation Procedure

A reproducible, step-by-step procedure for taking any candidate feature set or model
from idea → validated gate → production export → live shadow. This is the standard
operating procedure (SOP) distilled from the reversal-gate project. Follow it in order;
each step has explicit pass/fail criteria. **Do not skip steps** — most of them exist
because skipping them previously produced a false result.

---

## 0. Economic Constraint (the number everything is judged against)

- **Payout:** 0.85 (binary option).
- **Break-even win rate:** `WR_be = 1 / (1 + payout) = 1 / 1.85 = 54.05%`.
- **A gate is only worth deploying if its win rate clears 54.05% out-of-sample, after costs, with statistical confidence (Wilson lower bound, see Step 6).**
- Break-even payout for an observed WR: `payout_be = (1 - WR) / WR`. Report this for every operating point; it tells you how much payout compression the edge can survive.

> **Golden rule:** in-sample numbers prove nothing. Only an out-of-sample win rate whose
> Wilson 95% lower bound exceeds 54.05% justifies live capital.

---

## 1. Data Integrity & Setup

1. **Load OHLC per asset, ordered by `(asset, timestamp)`.** Never order by timestamp
   alone — that interleaves assets and silently corrupts any positional lookback
   (this caused a real direction bug: `rows[i-3]` subtracted a *different* asset's price).
2. **Confirm the asset universe.** Only the 13 trained non-OTC FX pairs:
   `AUDCAD AUDCHF AUDJPY CADCHF CADJPY CHFJPY EURAUD EURCHF EURJPY EURUSD USDCAD USDCHF USDJPY`.
   Tag anything else as **novel / out-of-distribution** and exclude it from validation.
3. **Record the date range and confirm holdout separation.** Training data and any
   holdout session must have **zero date overlap**.
4. **Note the base rate** of the target on this dataset (e.g., reversal base rate ≈ 0.398
   on the May population, ≈ 0.485 at the 15m horizon after dropping flats). The base rate
   is the "do-nothing" benchmark; features must beat it meaningfully.

**Environment:** single-threaded (`OMP_NUM_THREADS=1`), `setsid` for long runs.
sklearn ≥ 1.5 stores `tree_.value` as **probabilities, not counts** — use
`tree_.n_node_samples` for leaf size.

---

## 2. Target Definition

Use the validated **3-bar reversal** target (15-minute horizon = 3 × 5m bars):

```
recent  = close[t]   - close[t-3]
forward = close[t+3] - close[t]
Target_Reversal = 1  if  sign(forward) != sign(recent)   (the recent move reverses)
                = 0  otherwise
```

**Three-class labelling is mandatory.** Classify each bar as WIN / LOSS / **FLAT**:

- A **flat-close** bar (`forward == 0`, broker refunds) is **neither a win nor a loss**.
- Compute `WR = wins / (wins + losses)` — **exclude flats from the denominator.**
- *Why:* counting flat bars as wins previously inflated reported WRs by ~30 percentage
  points and produced fake 75–99% results. This single error invalidated an entire
  earlier round of "high-accuracy" models.

Drop rows where `recent` or `forward` is undefined (series edges).

---

## 3. Feature Engineering (per-asset, leak-safe)

1. **Group by asset.** Every rolling/diff/EMA calculation runs within a single asset's
   ordered series. Never let a window straddle two assets.
2. **Use positional indexing for lookbacks, not time arithmetic.** `series.iloc[i-3]`,
   not `timestamp - 900`. Time arithmetic breaks across weekend/session gaps.
3. **Drop NaN rows cleanly** after all features are computed (EMA/ATR warmup, rolling
   windows). Record how many rows survive.
4. **Cache** the engineered frame (`.pkl`) so probes and models read identical inputs.

Feature families tried and their verdicts (for reference):

| Family | Examples | Verdict |
|---|---|---|
| Oscillator/exhaustion | BB_Deviation, Stoch_Divergence, CCI_Velocity, STC_Momentum | **Works** — AUC ~0.636 |
| Trend strength | ADX_14, Vol_Ratio, Run_Length, MACD_Hist_Slope | **Dead** for reversal (MI ≈ 0.0007) |
| MACD/kinetic | Delta_Hist, Div_MACD, Prox_MACD, K_Decay, V_Exh, Z_ROC | **Below ceiling** (AUC 0.51–0.60) |
| Tick microstructure | Tick_Density, Wick_Rejection_Ratio | **Promising** (MI 2× higher) — needs more data |

---

## 4. Separability Probe (BEFORE training any model)

This cheap step decides whether a feature set is worth a full pipeline. **Never train a
model on features that fail the probe.**

1. **Mutual Information.** For each feature, discretize into deciles and compute
   `mutual_info_score(decile, target)` (convert to bits: `/ ln 2`). Compare to the
   reference: trend features maxed at **0.0007 bits**; a usable feature should be
   visibly higher (tick features hit ~0.0018).
2. **Decile win-rate spread.** Group by each feature's deciles, report reversal WR per
   decile. A flat profile (< ~3 pt spread) = no signal.
3. **Bivariate matrices.** Cross-tabulate two features by decile; fill cells with WR.
   Look for a *coherent cluster* (a contiguous region clearing 55–60%), not scattered
   high cells.
4. **Multiple-testing sanity.** Across N cells, estimate how many would clear the bar by
   chance (`P(cell ≥ threshold) × N` under the base rate). If the count of "winners" ≈
   the chance expectation, the cluster is noise. (MACD probe: 14 winners vs ~12 expected
   by chance → noise.)

**Pass criterion:** at least one feature with MI clearly above the prior ceiling **and**
a coherent bivariate cluster that survives the chance check. Otherwise **stop** — document
the negative result and move on (this saved a full continuation-model build).

---

## 5. Purged Cross-Validation Harness

1. **`TimeSeriesSplit(n_splits=5)`** — chronological, no shuffling.
2. **Embargo:** drop the first **5 rows** of every validation fold (prevents the 3-bar
   target from overlapping the train/test boundary).
3. **Scale inside the fold:** `StandardScaler` fit on train only, transform validation.
   Never fit the scaler on the full set (leakage).
4. **Out-of-fold predictions only.** Collect OOF probabilities; never evaluate on training
   rows.
5. **Models:** train with `class_weight='balanced'` where supported (LogReg yes;
   `GradientBoostingClassifier` does **not** accept it — note the exception).

Recommended candidate set: `logreg_l2 (C=0.5)`, `gb_stumps (max_depth=1–2, lr≤0.1)`,
`naive_bayes`, plus `tree_ref` as a known-overfit control.

---

## 6. Metrics & Threshold Sweep

For each model, on **OOF predictions only**, sweep thresholds `[0.60, 0.65, 0.70, 0.75, 0.80, 0.85]`
and report:

| Threshold | Approved (n) | Capture Rate | Gated WR | Wilson 95% CI | Break-even payout | BE @ CI-low |
|---|---|---|---|---|---|---|

- **ROC-AUC** is the honest headline. Current ceiling is **0.636**; treat any single
  model claiming much more (e.g., a depth-5 tree at 0.73) as **memorization** until proven.
- **Wilson 95% CI** (not normal approximation) on the gated WR. *Deployment requires the
  CI **lower bound** > 54.05%*, not just the point estimate.
- **Watch for the small-n / high-threshold trap:** a weak model (AUC ≈ 0.51) showing 81%
  WR on n=16 is noise. Symptoms: non-monotonic WR vs threshold, tiny capture, CI spanning
  the base rate. The AUC is the truth, not the gated WR.

---

## 7. Skew-Fragility Test (robustness to train/serve drift)

Live features never match training features to full precision. Test sensitivity:

1. Fit the model on full data; identify gate-clearing rows (`proba ≥ 0.85`).
2. Perturb one feature (e.g., `BB_Deviation += 0.01`).
3. Count how many gate-clearing rows **flip out of the gate**.

**Pass criterion:** < 5% flip. Reference results: **LogReg 0%** (smooth, robust) vs
**single tree 24%** (knife-edge thresholds). A model with high skew-fragility will
behave differently live than in backtest even if it generalizes — reject it.

Companion check: re-fit with `min_samples_leaf ∈ {30, 75, 150, 300}`. If a model's
high-confidence leaves **vanish** as leaf size grows, those leaves were memorized
slivers (the single tree's 0.85 leaves disappeared at min_leaf=150 → they were noise).

---

## 8. Direction Determination

The model predicts **whether** the recent move reverses, **not which way** (its dominant
feature, `Stoch_Divergence`, is an absolute value with zero directional content). Direction
is therefore **forced by the target definition**, not learned:

```
recentMove = close[t] - close[t-3]      (same asset, positional lookback)
direction  = PUT  if recentMove > 0     (fade an up-move → expect down)
           = CALL if recentMove < 0     (fade a down-move → expect up)
           = skip if recentMove == 0    (flat → ambiguous)
```

- **FADE, always, for every model trained on this target.** "Follow" is mathematically
  `1 − fade_WR` and is never correct for a decay model.
- **Verification test:** `P(trade wins | reversal happened)` must be ≈ 100% and
  `P(trade wins | no reversal)` ≈ 0%. Fade gives 100/0 (aligned); any indicator-based
  direction heuristic (BB position, STC level) leaks (e.g., 63/33) — reject it.
- **Implementation:** per-asset ordered array + position map; never fixed time offsets;
  guard asset boundaries (`i < 3` → skip).

---

## 9. Out-of-Sample Holdout Validation

The decisive test. Train on the population; validate on a **later, non-overlapping**
session.

1. Train production models on the full population (e.g., May 12–26).
2. Load a holdout session with **zero date overlap** (e.g., June 2–3).
3. Recompute features per-asset on the holdout, score, apply each model's gate.
4. Apply **fade** direction (Step 8), compute realized 15m WR.
5. Report: WR, Wilson CI, break-even payout, **train-asset vs novel-asset split**, and a
   **fade-vs-follow sanity column**.

**Interpreting results:**

- A model whose WR is stable across in-sample / CV / holdout (e.g., LogReg 62% / 61% / 64.7%)
  is **real** — deploy it.
- A model whose WR collapses train→holdout (e.g., tree 89% → 36% → 14%) **does not
  generalize** — retire it. A sign that won't stay put is noise.
- Models that fire too rarely on holdout to read (gb_stumps: 3 signals; consensus: 4) are
  **unproven**, not validated — need more data before any live use.

---

## 10. Production Export & Parity Testing (Python → JSON → Node.js)

Only after Step 9 passes. The deployed JS must reproduce the Python model bit-for-bit.

1. **Refit on full data** (the deployed model uses all data; CV was only for honest AUC).
2. **Export exact params to JSON** — the single source of truth:
   - `scaler {mean, scale}`, `logreg {coef, intercept}`,
   - for boosting: `{init_raw, learning_rate, stumps:[{feature, threshold, left, right}]}`
     — **reconstruct and assert** `init + lr·Σstumps == clf.decision_function` to 1e-9
     before trusting the export.
   - Stamp `status` and the honest `oos_auc` into the params so the numbers travel with
     the model.
3. **Dump fixtures:** 600 real feature vectors + their Python probabilities (score parity),
   plus one asset's full OHLC + computed features (feature parity).
4. **Write the JS gate:** stateful per-asset feature computation (recursive EMA, Wilder
   ATR, rolling windows), `scoreLogReg`, `scoreGBStumps`, `evaluateGate(bar, payout, opts)`.
5. **Parity test (`node test-*.mjs`):**
   - Score parity: JS vs Python ≤ **1e-9** (float epsilon).
   - Feature parity: JS recompute vs Python ≤ **1e-6** across full series.
   - **Live guard:** `approved` is `false` unless `{allowLive:true}` — research models
     ship as `RESEARCH_SHADOW` and cannot route capital by default.

**Pass criterion:** all parity checks green. Re-run after every retrain.

---

## 11. Live Deployment & Risk Controls

1. **Enforce the payout floor at execution time** — re-read live payout immediately before
   placing; **abort if below floor** (LogReg ≥ 78%). *This is the highest-ROI control;*
   9/16 live trades once filled below floor, including one at 25% (deeply −EV).
2. **Asset whitelist:** the 13 trained pairs only.
3. **Independence rule:** ≥ 3-bar (15-minute) gap between consecutive same-gate, same-asset
   signals.
4. **Circuit breakers (unattended):** daily loss cap; rolling-30-trade WR breaker (halt if
   it drops below break-even for the current payout); concurrent same-currency exposure cap
   (the 13 pairs are correlated — six EUR-cross positions are one bet).
5. **Shadow first:** new models log scores and would-be outcomes with `allowLive:false`
   until they accumulate enough live data to clear Step 9 on fresh sessions.
6. **Log real exit price and confirm 15m expiry** so real and paper outcomes are comparable.

---

## 12. Go / No-Go Decision Checklist

Deploy a gate to **live capital** only if **all** are true:

- [ ] Target uses 3-class labelling (flats excluded from WR).
- [ ] OOS (purged-CV) AUC is genuine and at/above the working ceiling.
- [ ] Gated WR Wilson **lower bound** > 54.05% at the operating threshold.
- [ ] Skew-fragility < 5%.
- [ ] High-confidence leaves survive larger `min_samples_leaf` (not memorized).
- [ ] Direction is **fade**, verified 100/0 on the alignment test.
- [ ] Holdout WR (fresh session, fade, trained assets) clears break-even with CI.
- [ ] JS↔Python parity ≤ 1e-9 (score) / 1e-6 (feature).
- [ ] Execution enforces payout floor + asset whitelist + independence rule.

If any box is unchecked → **shadow only**, keep collecting data.

---

## Appendix A — Standing Verdicts (current state)

- **LogReg @ 0.85, faded — VALIDATED.** In-sample 62%, CV 61%, holdout 64.7% (75% on
  trained assets). The production gate. Floor 78% payout.
- **Decision Tree — RETIRED.** Memorized 30–45 sample slivers (vanish at min_leaf=150),
  24% skew-fragility, WR collapses 89%→36%→14% train→live→holdout. Do not invert to
  "follow"; retire entirely.
- **gb_stumps — UNPROVEN.** Best CV AUC (0.637) but fires ~0 at 0.85 and only 3× on
  holdout. Needs more data; keep researching, don't deploy.
- **Naive Bayes / consensus — FAILED HOLDOUT.** NB collapses to ~48% OOS; consensus too
  rare. Abandoned.
- **MACD/kinetic gate — RESEARCH_SHADOW.** OOS AUC 0.51–0.60, below the 0.636 ceiling.
  Built, parity-clean, shadow-only.

## Appendix B — Confirmed Negative Results (don't re-litigate)

- **Continuation model:** trend features have ~0 MI on reversal; continuation base rate
  48.5%, not separable. (One exception: 1 PM Central is a continuation hour — watch, don't
  build.)
- **Momentum/MACD transforms:** all correlated, all trend-flavored, all below ceiling.
- **Follow direction:** mathematically `1 − fade_WR`; never correct for a decay model.

## Appendix C — The Open Frontier

The ceiling (AUC 0.636) is the **features**, not the algorithm. The only feature family
that has shown information above the ceiling is **tick microstructure** (Tick_Density,
Wick_Rejection_Ratio — 2× MI). The blocking issue is data: ticks exist only for 2 June
days, on the wrong (novel) assets.

**Highest-leverage next action:** turn on persistent, around-the-clock tick logging for the
13 trained assets (timestamps in UTC). In a few weeks, re-run Step 4 (separability probe)
on tick features across multiple regimes — that is the path to raising the ceiling, not
another model.
