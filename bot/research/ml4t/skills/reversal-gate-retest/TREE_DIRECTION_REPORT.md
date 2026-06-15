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

## Method notes / limits

- All WR/P/L broker-settled from `trades_ordered`; stored prices ignored.
- Tree-reversal n=25 is enough to call the direction; tree-continuation n=8 is directionally
  confirming but thin. LOGREG-fade n=42+16 is the firmest.
- Price-based retest (`scripts/reversal_gate_retest.py`) said tree-FADE beats base on 3/4
  price-derived regimes — **contradicted by settlement (24%)**. Settlement wins; the retest's
  candle-close labels diverge from broker settlement.
