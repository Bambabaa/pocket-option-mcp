# Methodology — Meta-Labeling

The protocol behind `scripts/meta_label.py`. López de Prado meta-labeling adapted to fixed-payout
binary options. Companion to `alpha-factor-eval` (factor engine) and `purged-walk-forward-cv` (purge).

## 1. Primary signal (the SIDE)

Two configurable sources, both producing a per-event side ∈ {call, put}:

- **factor rule**: `side = top_side if factor > neutral else opposite(top_side)`. `neutral` is a
  constant (e.g. RSI 50), so the rule is fully causal and fires on every bar where the factor exists.
  Mean-reversion on an oscillator → `--top-side put` (high oscillator ⇒ expect down).
- **signals table**: the bot's actual emitted signals (`asset, timestamp, direction`), joined to the
  indicator row at that bar.

The primary deliberately does NOT decide whether to trade — only which way. Filtering is the meta
model's job. This separation is the whole point: it lets precision rise as coverage falls.

## 2. Meta-label (the TARGET)

For a primary event with side `s` at bar `t`, over horizon `n` bars:

```
win = (s == call AND fwd_ret > 0) OR (s == put AND fwd_ret < 0)
y   = 1 if win else 0        (drop events whose forward window is incomplete)
```

This is a genuine forward-price outcome — the same price label discipline as the other skills. The
meta model never sees an indicator's own slope as a target; it predicts a real win/loss.

## 3. Secondary model (the BET/SKIP)

L2 `LogisticRegression(C=0.5, class_weight="balanced")` on standardized features. Linear on purpose:
its coefficients + scaler hand-port to `ml_gate_params.json` for `ml-gate.js` (skill #4), exactly
like the existing reversal gate.

**Features (`META_FEATS`)** are the bounded / stationary indicators — oscillators (rsi, stoch,
williams, cci), STC value/signal/delta, MACD histogram, BB width, ADX/DI, ATR%, psar_bull. Raw price
levels (sma/ema/bb/kc/psar absolute) are excluded: they are non-stationary and would let the model
fit the price level rather than the state. Missing values are imputed with the **train-fold** median
(causal), then standardized with a **train-fold** scaler.

## 4. Purged walk-forward → out-of-fold probabilities

Folds are sequential over unique timestamps (skill #2's `make_folds`). For each fold the model is fit
on the purged+embargoed train events and predicts P(win) on the test events. Collecting these gives an
**out-of-fold** P(win) for (almost) every signal — no signal is scored by a model that trained on its
own period. The abstention curve is computed on these OOF probabilities, so it is leakage-controlled.

## 5. Abstention curve and verdict

For thresholds θ ∈ {0.50 … 0.80}: take signals with P(win) ≥ θ, report coverage = taken/total and
OOS WR on the taken set.

```
break-even WR = 1 / (1 + payout)
usable threshold:  WR > break-even  AND  coverage >= min_coverage
```

| Verdict | Condition | Meaning |
|---|---|---|
| **WORKS** | some usable θ exists | abstention turns the primary tradeable on a subset |
| **NO LIFT** | meta OOS AUC ≤ 0.52 | features hold no win/loss info; filtering can't help |
| **PARTIAL** | AUC > 0.52 but no usable θ | slight separation, not enough to clear break-even at coverage |

**Read AUC first.** If the meta model can't rank wins above losses (AUC ≈ 0.5), any threshold that
appears to clear break-even is small-sample noise — which is why the verdict gates on AUC and on
`min_coverage`, not on the single best-looking row.

## 6. Why coverage is not free

Lowering coverage to chase WR has two costs the verdict guards against: (a) tiny-n thresholds are
statistically meaningless, and (b) a model that only "works" on 1–2% of bars is usually overfitting a
handful of lucky events. A real abstention edge clears break-even on a *non-trivial* slice and holds
across regimes.

## 7. What this skill does NOT do

- It does not persist a model — that is `model-freeze-export` (skill #4), which takes a WORKS verdict
  and emits the logistic's coef/scaler as a parity-tested `*_params.json`.
- It does not replicate across regimes — a WORKS result still owes the May/other-snapshot check.

## References

- López de Prado, *Advances in Financial Machine Learning* — Ch. 3 (meta-labeling, sample weights).
- Project: `bot/research/ml-gate.js`, `ml_gate_params.json` (the freeze/parity target),
  `skills/purged-walk-forward-cv/` (the purge protocol reused here).
