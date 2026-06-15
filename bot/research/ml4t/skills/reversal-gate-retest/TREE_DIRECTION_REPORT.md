# Tree Direction Report — Reversal vs Continuation (broker-settled)

**Question:** Should the DecisionTree arm of the ML gate fire as REVERSAL (fade) or
CONTINUATION (follow)? Both arms predict `P(decay)` (directionless); direction is set by
the user/bot, so this is decidable only from realized trade outcomes.

**Source of truth:** `trades_ordered.result` / `profit_loss` (broker-settled). Stored
`exit_price` is unreliable (0.00000 on most rows, sub-pip divergence) — NOT used. Arm is
read from `signals.strategy_used` (`ML_REVERSAL_GATE_TREE` / `_LOGREG`).

Generated: 2026-06-15. DBs: data/trading_data_5-02, _5-03, 00, _08220 (tree=reversal era);
data/trading_data.db (live, tree=continuation era).

---

## A. Tree = REVERSAL era (pre-switch) — both arms fading

Pooled across `trading_data_5-02 / _5-03 / 00 / _08220`:

| Arm (fired as REVERSAL/fade) | Trades | W | L | WR | P/L |
|---|---|---|---|---|---|
| **TREE** | 25 | 6 | 19 | **24%** | **−$7,840** |
| **LOGREG** | 42 | 29 | 13 | **69%** | **+$2,695** |

Daily W/L by arm:

| Day | DB | LOGREG (fade) | TREE (fade) | book P/L |
|---|---|---|---|---|
| 06-02 | 5-02 | 1/1 = 100% | — | +280 |
| 06-03 | 5-03 | 11/12 = 92% | 1/4 = 25% | +2,200 |
| 06-04 | 00 | 3/5 = 60% | 1/3 = 33% | −995 |
| 06-05 | 00 | 10/17 = 59% | 4/15 = 27% | −5,255 |
| 06-08 | 08220 | 4/7 = 57% | 0/3 = 0% | −1,375 |

**TREE-as-reversal is 24% across 4 independent days — a stable, structural wrong-way
signal (not noise at n=25).** A predictor that loses 76% of the time as a fade WINS ~76%
as a follow. This is the data justification for flipping the tree to continuation.

---

## B. Tree = CONTINUATION era (live, post-switch) — `trading_data.db`

| Arm | Direction | Trades | W | L | WR | P/L |
|---|---|---|---|---|---|---|
| **TREE** | **follow/continuation** | 8 | 5 | 3 | **63%** | **+$135** |
| **LOGREG** | fade/reversal | 16 | 8 | 8 | **50%** | **−$1,220** |

Daily:

| Day | LOGREG (fade) | TREE (follow) | avg payout |
|---|---|---|---|
| 06-08 | 0/1 = 0% | — | 71% |
| 06-09 | 8/15 = 53% | 5/8 = 63% | TREE 58% / LOGREG 75% |

**Tree-as-continuation = 63% (n=8), P/L positive.** Same sign as the ~76% predicted by
inverting the 24% reversal rate — small n, but it confirms the direction. The switch was
correct.

---

## Verdict

| Arm | Correct direction | Evidence | Pooled WR |
|---|---|---|---|
| **TREE** | **CONTINUATION (follow)** | reversal=24% (n=25) → invert; live follow=63% (n=8) | ~63–76% |
| **LOGREG** | **REVERSAL (fade)** | fade=69% (n=42); live fade=50% (n=16) | ~50–69% |

- Tree-follow + logreg-fade is the right direction for **both** arms — confirmed in both eras.
- The live switch of the tree to continuation is **vindicated**, not a mistake.
- `required_payout = (1−WR)/WR`: tree-follow @63% needs ~59% payout; logreg-fade @50% needs
  100% — i.e. **logreg-fade is at/under break-even at live payouts (~69%)** and is the arm
  now dragging the book (−$1,220 live).

## Caveat — the edge is DECAYING, not stable

LOGREG-fade WR by day: 100% → 92% → 60% → 59% → 57% → 53% → 50%. Monotone decline toward
break-even (59% @ 69% payout). The live `trading_data.db` 50% is the continuation of that
slide, not a new regime. **Both arms' direction is right; the absolute edge is fading.**
This argues for recalibration cadence (continuous learning) over a one-time freeze, and for
a payout floor (the bot currently hardcodes 0.80 in `evaluateMLGate(...)`, defeating the
`payout_floor` config and admitting sub-60% trades like the 06-03 USDCHF 25%-payout win).

---

## C. Drift quantification — Method 1: feature PSI (covariate shift)

`scripts/feature_drift_psi.py`. Gate's 4 input features, gate-fired bars, good day
(06-03, 75% WR, n=24) vs bad day (06-05, 44% WR, n=42). PSI: <0.1 stable / 0.1–0.25
moderate / **>0.25 = retrain trigger**.

| feature | 06-03 mean | 06-05 mean | shift (train-σ) | PSI | verdict |
|---|---|---|---|---|---|
| BB_Deviation | 0.115 | −0.095 | −0.67 | **1.23** | SIGNIFICANT |
| CCI_Velocity | −76.5 | −39.4 | +0.99 | **1.08** | SIGNIFICANT |
| Stoch_Divergence | 20.3 | 17.8 | −0.36 | **1.88** | SIGNIFICANT |
| STC_Momentum | 1.06 | 0.41 | −0.09 | **0.63** | SIGNIFICANT |

All four PSI = 1.1–1.9, i.e. **4–7× over the 0.25 trip-wire in a 2-day gap.**

Bad-day fires vs the TRAINING baseline (where the model was fit):

| feature | train mean | 06-05 mean | distance |
|---|---|---|---|
| BB_Deviation | 0.508 | −0.095 | **−1.93 σ** |
| Stoch_Divergence | 6.60 | 17.81 | **+1.64 σ** |
| CCI_Velocity | 0.032 | −39.4 | **−1.06 σ** |

**On 06-05 the gate fired on bars ~2 training-σ from its training cloud — extrapolation,
not prediction.** This is why scores stayed 0.85–0.95 while realized decay collapsed.

**Implications:** (1) freeze life ≈ 1 day — the 4-feature distribution fully
destabilizes in ≤2 days; (2) PSI is computable LIVE with no outcome labels → usable as a
bot trip-wire (pause fires when PSI vs training reference > 0.25); (3) corroborates the WR
slide + payout migration — one root cause, fast covariate shift.

Caveat: n=24 vs 42 — PSI reliably calls "massive shift"; exact magnitudes are noisy.

---

## D. Drift quantification — Method 2: calibration gap (concept drift)

`scripts/calibration_gap.py`. For every gate-fired bar: predicted P(decay) (score) vs
REALIZED decay (close[t+3] reversed vs 3-bar move), from candles — direction-independent,
all fires. gap = mean(score) − realized decay. break-even decay ≈ 0.59 @ 69% payout.

| day | fired n | mean score | realized decay | gap | over-conf |
|---|---|---|---|---|---|
| 06-02 | 28 | 0.885 | 0.500 | +0.385 | +43% |
| 06-03 | 21 | 0.878 | 0.524 | +0.355 | +40% |
| 06-04 | 28 | 0.899 | 0.857 | +0.041 | +5% |
| 06-05 | 42 | 0.912 | 0.357 | +0.555 | +61% |
| 06-08 | 18 | 0.884 | 0.278 | +0.606 | +69% |
| 06-09 | 28 | 0.903 | 0.464 | +0.438 | +49% |
| 06-10 | 14 | 0.876 | 0.643 | +0.233 | +27% |

**Score is frozen ~0.88–0.91 every day; realized decay swings 28%→86%. No relationship.**
The model is equally sure whether reality is 86% (06-04) or 28% (06-08) decay — it cannot
tell the regimes apart. Systematic over-confidence +37pt avg, never under. Realized decay
clears break-even (0.59) on only **2 of 7 days** → fade gate under water 5/7.

**Sharper than "slow decay":** the failure is that `p_decay` is NON-INFORMATIVE
day-to-day, not a clean monotone fade (day-slope −1.0 pt/day is noise at this n). The score
itself can't be trusted as a sizing input — neither a fixed gate threshold nor Kelly-on-score
is safe.

### M1 + M2 combined
- M1 (PSI): inputs relocate ~2σ in 2 days — covariate shift, real-time-detectable, no labels.
- M2 (calibration): score→outcome map broken — confidence decoupled from realized decay,
  +37pt over-confident, 86%→28% reality at constant 0.89 score.
- Together: frozen model fires in an untrained distribution AND its probability output stopped
  meaning anything → continuous recalibration required; static freeze invalid within ~1 day.

---

## Method notes / limits

- All WR/P/L broker-settled from `trades_ordered`; stored prices ignored.
- Tree-reversal n=25 is enough to call the direction; tree-continuation n=8 is directionally
  confirming but thin. LOGREG-fade n=42+16 is the firmest.
- Price-based retest (`scripts/reversal_gate_retest.py`) said tree-FADE beats base on 3/4
  price-derived regimes — **contradicted by settlement (24%)**. Settlement wins; the retest's
  candle-close labels diverge from broker settlement.
