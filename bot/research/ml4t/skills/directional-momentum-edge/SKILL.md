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

## Features — all 32 indicators, ENGINEERED and SECTIONED BY FAMILY

All 32 indicators contribute, but each is **engineered into stationary form** (ATR-normalized
distances/spreads, deltas, ratios) so the model can't just fit the raw price level — and each
engineered feature is **tagged with exactly one family**, so the study runs as a **per-family
ablation**. No single indicator can carry a verdict; a result must come from a family (a group).

| Family | What it captures | Built from |
|---|---|---|
| **trend** | where price sits vs its anchors, and how the anchors stack | (close−SMA10/20/50)/ATR, (close−EMA12/26)/ATR, EMA12−EMA26, SMA spreads, (close−PSAR)/ATR, PSAR-bull, MACD−signal |
| **momentum** | oscillators and their motion | RSI(+Δ), Stoch %K/%D/(K−D), STC value/Δ/(value−signal), CCI, Williams %R, MACD-hist(+Δ) |
| **volatility** | how wide / how stretched within the envelope | BB width(+Δ), %B, ATR%(+Δ), squeeze=BBwidth/KCwidth, (close−KC mid)/ATR |
| **breakout** | directional thrust / expansion starting | ADX(+Δ), +DI−−DI, %B extremes, BB-width expansion, squeeze-release |

The script runs each family **standalone** and then **all together**, so you see each family's own
edge and whether combining helps. Per fold: train-median imputation + train-fit standardization (causal).

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

The output is a **per-family table** — one row per family (trend / momentum / volatility / breakout)
plus an `all` row:

- **state-acc (vs 33.3)** — can that family's features predict the 3-class forward state above the
  random floor? If every family sits at ~33%, the indicators hold no momentum-state information and
  nothing downstream can be profitable. This is the most informative column.
- **coverage** — fraction of bars the betting rule trades (non-stable predictions).
- **OOS WR vs break-even** — the only profitability test. The ✓ column marks a family that clears
  break-even at ≥ min-coverage.

Then a per-state split for the combined model (gain→with-trend WR, decay→against-trend WR) so a
one-sided edge isn't hidden by averaging.

### Verdict tiers (integrated across families — never one indicator)

- **PROFITABLE** — at least one **family** clears break-even OOS at ≥ min-coverage. Names the
  family/families. Confirm on another regime and freeze.
- **PREDICTABLE-BUT-UNPROFITABLE** — best family state-acc meaningfully > 33.3% but no family clears
  break-even. Real structure, too weak for the payout deficit; try `--min-prob` abstention.
- **NO EDGE** — no family beats chance and none clears break-even. H0 holds **across all four
  families**, not as a single-indicator call. (Current result on `trading_data.db`: every family
  33.7–34.4% acc, WR 46–49%, all horizons.)

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
