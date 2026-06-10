# Methodology — Purged Walk-Forward CV

The protocol behind `scripts/purged_wf.py`. This is the de Prado purged/embargoed walk-forward,
adapted to the 5-minute, 15-pair, price-labelled binary-option setting. Companion to
`alpha-factor-eval` — same factor interface, same label.

## 1. Folds on unique timestamps

The cross-section (15 FX pairs) moves together each minute, so the atomic unit for splitting is a
**unique timestamp**, not a row. We take the sorted unique timestamps, reserve the first
`1/(folds+1)` as a minimum initial training window, and tile the remainder into `folds` sequential
**test blocks**. Training for each fold is every timestamp strictly before that block (expanding
window) — never after. This guarantees the model is only ever validated on the future.

## 2. Purge and embargo

A label at bar `t` is `close[t+n]/close[t] - 1`, with `n = horizon_min*60 / bar_sec` bars; it depends
on prices up to `t + horizon_sec`. A training row leaks if that window reaches the test segment.

```
horizon_sec = horizon_min * 60
emb_sec     = embargo_bars * bar_sec
purge_before = test_start - emb_sec
train row kept  iff  t < test_start  AND  t + horizon_sec < purge_before
```

- **Purge** is the `t + horizon_sec < ...` clause: a training label may not see test-period prices.
- **Embargo** (`emb_sec`) widens the forbidden zone *before* the test start, so serial correlation
  right at the boundary can't smuggle information across. Default 5 bars (25 min at 300s).

The per-fold `purged` count = (train rows before test) − (train rows surviving purge+embargo). It is
the amount of leakage the naive split would have contained.

## 3. Per-fold metrics

- **IC test** = Spearman(factor, forward return) on the test block. The headline.
- **IC train** = same on the (purged) train block — a sanity check that the in-sample sign holds.
- **p test** = Spearman p on the test block; thin per fold, so read the pattern not the cell.
- **extreme-WR** = directional win-rate of the top quintile, traded in the direction the *train* IC
  implies (train-IC > 0 → CALL the top quintile and count up-moves; train-IC < 0 → PUT it and count
  down-moves). Using the train sign keeps the trade decision causal (no peeking at test to pick side).

## 4. Summary statistics

```
mean_oos_ic      = mean(IC_test over folds)
sign_consistency = fraction of folds whose IC_test sign == sign(mean_oos_ic)
t                = mean_oos_ic / (std(IC_test)/sqrt(F))     # folds as samples
p                = two-sided t-test, dof = F-1
mean_extreme_wr  = mean(extreme-WR over folds)
break-even WR    = 1 / (1 + payout)
```

`sign_consistency` is the single most important number: an edge that is real but unstable will have a
respectable |mean IC| yet a sign_consistency near 0.5 — caught here, not by the magnitude alone.

## 5. Verdict logic — three gates

```
strong     = |mean_oos_ic| > 0.03  AND  p < 0.05
consistent = sign_consistency >= 0.8
tradeable  = mean_extreme_wr > break-even WR
```

| Verdict | Condition | Meaning |
|---|---|---|
| **STABLE & TRADEABLE** | strong ∧ consistent ∧ tradeable | earns a path to modeling |
| **STABLE-IC / SUB-BREAKEVEN** | strong ∧ consistent ∧ ¬tradeable | real edge, too weak to trade alone → meta-label input |
| **MODERATE** | consistent ∧ \|mean_ic\|>0.02 | under-powered; more data / cross-regime |
| **UNSTABLE** | otherwise | sign flips or ≈ 0 → not an edge |

The `tradeable` gate is what makes this binary-option-correct: in equities a stable IC is enough to
build a book around; in fixed-payout binaries a stable IC that wins only 52% loses money at 0.8
payout. Separating "statistically real" from "tradeable" prevents the most seductive false positive.

## 6. What this skill deliberately does NOT do

- It does not replicate across regimes — that is the next gate (re-run on May agent.db etc.).
- It does not net costs beyond the WR break-even proxy (no spread/skew model).
- It does not train or persist a model — confirmation only.

## References

- López de Prado, *Advances in Financial Machine Learning* — purged k-fold / embargo, walk-forward.
- Stefan Jansen, *Machine Learning for Trading* (2nd ed.) — Ch. 6–7 (CV pitfalls, time-series CV).
- Project: `bot/research/ml4t/RESEARCH_PROCEDURE.md` (purged TimeSeriesSplit + embargo ≥ n),
  `skills/alpha-factor-eval/` (the candidate-producing gate this skill confirms).
