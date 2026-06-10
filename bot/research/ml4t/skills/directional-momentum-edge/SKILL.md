---
name: directional-momentum-edge
description: >-
  Test the core research question — can the FORWARD momentum state (gain / stable / decay), defined
  from price, be predicted from ALL the indicators and turned into a PROFITABLE directional bet
  (gain → trade with the trend, decay → against it, stable → skip) with out-of-sample win-rate that
  clears the binary-option break-even? Multinomial logistic on the full bounded-indicator set,
  purged walk-forward, scored on directional WR vs break-even and 3-class state-prediction accuracy.
  Use this skill WHENEVER the goal is finding a profitable directional/momentum signal, when asked
  "is there a tradeable momentum edge", "can we predict gain/decay/stable", "do the indicators
  predict direction", "will trend continue or reverse", or to get a verdict on whether a momentum
  model is worth building at all before committing to it. It is the capstone study that answers
  "profitable signal: yes or no" and refuses to confuse predicting an indicator's slope with
  predicting price.
---

# Directional-Momentum Edge

## Why this exists

This is the project's central question in one runnable study: **is there a profitable directional
signal built on momentum gain/decay/stable, using all the indicators?** It is the honest successor to
the prior gain/stable/decay study, which failed for two reasons this skill fixes:

1. **The old label was an indicator's own slope** → it scored AUC 0.79–0.94 but was non-tradeable
   (you were predicting smoothing inertia). Here the label is a **forward price move**.
2. **The old target was magnitude, sign-collapsed** → it never had to predict up vs down. Here the
   bet is **directional** and graded on **WR vs break-even**, the only thing a CALL/PUT cares about.

## The label (forward price — unknown at decision time, so it must be predicted)

```
s    = sign(close[t] - close[t-k])              recent trend (k bars)
cont = s * (close[t+n] - close[t]) / ATR[t]      ATR-normed continuation
terciles of cont, fit on the TRAIN fold only:
   gain   (top)    -> trend accelerates -> bet WITH trend   (side = s)
   decay  (bottom) -> momentum reverses -> bet AGAINST trend (side = -s)
   stable (middle) -> flat              -> SKIP
```

Because `cont` uses `close[t+n]`, the state is **not known at bar t** — the model must *predict* it
from the indicators available at t. This is what makes a positive result tradeable and forecloses the
slope-of-its-own-indicator leakage that doomed the prior study.

## Features — all the indicators

The full bounded/stationary indicator set (oscillators, STC value/signal/delta, MACD hist, BB width,
ADX/DI, ATR%, psar_bull). Raw price levels (sma/ema/bb/kc/psar absolute) are excluded as
non-stationary. Per fold: train-median imputation + train-fit standardization (causal).

## How to run

```bash
python bot/research/ml4t/skills/directional-momentum-edge/scripts/directional_momentum.py \
  --horizon <minutes> [--k 6] [--folds 5] [--embargo 5] [--payout 0.8] \
  [--min-prob 0.0] [--bar-sec 300] [--json out.json]
```

- `--horizon` forward minutes (whole bar multiple). Sweep 5/10/15/20 — a real edge shouldn't vanish
  between adjacent horizons.
- `--k` trend-direction lookback in bars (default 6).
- `--min-prob` abstention: only bet when the predicted state's probability ≥ this (0 = bet every
  non-stable prediction). Raising it trades less for (hopefully) higher WR.

## How to read the output

1. **3-class state prediction accuracy vs 33.3% random** — the diagnostic. If this is ≈ 33%, the
   indicators cannot tell gain from decay from stable, and nothing downstream can be profitable. This
   is the single most informative line.
2. **Predicted mix** — sanity that the model isn't collapsing to one class.
3. **Betting rule line** — coverage (fraction not skipped) and OOS WR vs break-even. Plus a per-state
   split (gain→with-trend WR, decay→against-trend WR) so you can see if one direction carries any
   edge even when the blend doesn't.

### Verdict tiers

- **PROFITABLE** — OOS WR clears break-even at ≥ min-coverage. The signal exists; confirm cross-regime
  and freeze (export skill).
- **PREDICTABLE-BUT-UNPROFITABLE** — state accuracy meaningfully above chance (> ~36%) but WR below
  break-even. Real structure, too weak to pay the payout deficit; try `--min-prob` abstention or
  richer features before giving up.
- **NO EDGE** — accuracy ≈ random and WR below break-even. Forward momentum state is unpredictable
  from the indicators; H0 holds for this target. (This is the current result on `trading_data.db`:
  ~32–34% accuracy and 47–50% WR across all of 5/10/15/20m, holding under abstention.)

## What a NO EDGE result actually means (it's not a dead end)

A NO EDGE verdict is a *finding*, and a valuable one: it says the edge is **not in the standard
indicators at the 5-min bar**, so effort spent tuning thresholds or swapping models there is wasted.
The honest places to look next are different *inputs*, not different *models*:

- **Microstructure** from the 1.13M-row 1s tick stream (tick imbalance, run length, micro-volatility)
  — never touched by the indicator-based studies.
- **Cross-asset / lead-lag** structure between correlated pairs.
- A different label entirely (e.g. barrier-touch within the window rather than endpoint direction).

No model class (LSTM, RL, boosting) manufactures signal that isn't in the inputs — the prior studies
and this one agree the inputs are the bottleneck, not the architecture.

## Limits

- **Read-only / offline / one regime.** Even a PROFITABLE verdict owes cross-regime replication.
- **Linear model.** A logistic can't capture deep interactions; but the project's repeated finding is
  that trees/boosting don't beat linear here (no interaction structure), so linear is the honest,
  freeze-able default. If state accuracy is ≈ random, a fancier model won't help — verify inputs first.
- See `references/methodology.md` for label math, the betting rule, and verdict thresholds.
