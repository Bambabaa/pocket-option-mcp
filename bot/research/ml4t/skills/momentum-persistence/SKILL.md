---
name: momentum-persistence
description: >-
  Answer "when a momentum-gain is detected, how many candles until it falls back?" as a duration /
  survival problem graded on profit. Detects momentum-gain ONSETS via a multi-family confluence
  (trend + momentum + breakout agree — never a single indicator), measures the TRUE persistence
  (bars until price crosses back through entry), and trains per-expiry survival classifiers on all
  families to predict whether the move still holds at 5/10/15/20m — then scores follow-trend AND
  fade win-rates vs the binary-option break-even. Use this skill WHENEVER the question is about how
  long a move lasts, momentum persistence/decay timing, "does the trend continue or revert", choosing
  the right expiry, or whether a momentum/continuation (or mean-reversion) signal is tradeable. It is
  the skill that picks the EXPIRY to match a move's predicted duration, and that reveals whether a
  detected momentum-gain actually continues or is really a reversion signal.
---

# Momentum-Persistence

## Why this exists

A fixed-horizon classifier (`directional-momentum-edge`) asks "is it gain/decay/stable at exactly
+10m?" — it blurs a move that persists a *variable* number of bars. The tradeable question is
different: **once momentum is detected, how long does it hold, and which expiry should I trade?**
That's a duration/survival problem. This skill answers it, and in doing so reveals something a
fixed-horizon view hides: whether a detected momentum-gain *continues* (follow) or *reverts* (fade).

It also enforces your two rules: the onset is a **multi-family confluence** (never one indicator like
RSI, which fires false signals), and "fall-back" is **price crossing back through entry** — exactly
how a binary option settles.

## Two stages

**A. Characterize (price-based, descriptive).** From every onset, measure the true persistence:
the number of bars until price crosses back through entry. Reports the median time-to-fall-back, the
share that survive the window, and — per expiry — the **follow-trend WR** and the **fade WR**
(reversion). Model-free: this is what actually happens.

**B. Predict (tradeable).** For each expiry k, a per-horizon L2 logistic on **all family features**
predicts P(still beyond entry at +k) — a discrete-time survival model — under purged walk-forward.
Reports model AUC and the confidence-gated WR (trade only onsets the model is sure about).

## Onset = multi-family confluence (causal)

An onset is a bar where ≥ `--confluence` of these 5 trend-aligned conditions hold (default 4):
trend(price vs SMA20), momentum(MACD-hist sign), breakout(ADX rising), momentum(STC on trend side),
breakout(+DI/−DI agree). All known at bar close — tradeable, and spread across families so no single
indicator triggers it.

## How to run

```bash
python bot/research/ml4t/skills/momentum-persistence/scripts/momentum_persistence.py \
  [--db <path>] [--horizons 5,10,15,20] [--k 6] [--confluence 4] [--max-dur 12] \
  [--model logreg|tree] [--folds 5] [--embargo 5] [--payout 0.8] [--min-prob 0.60] [--json out.json]
```
Schema-adaptive (`trading_data.db` and `agent_*.db`). `--confluence 5` = stricter onsets (fewer,
purer). `--max-dur` caps the duration distribution. `--min-prob` is the predict-stage confidence gate.
`--model tree` swaps the stage-B survival classifier for a constrained DecisionTree (depth 5,
min-leaf 50, like the deployed reversal gate) to probe non-linear interactions; `logreg` is the
default and the project's repeated finding is that trees do not beat it here. Stage A is model-free
either way.

## How to read the output

- **median bars to fall-back** — the literal answer to "how many candles until it falls back." A
  median of 1 means detected gains reverse almost immediately (no continuation edge).
- **Stage A table** — per expiry, follow-trend WR vs fade WR vs the 55.6% break-even. **If follow WR
  is well under 50%, the confluence is a *reversion* signal**, and the `fade` column is the tradeable
  side. The `tradeable side` column flags which (if either) clears break-even.
- **Stage B table** — does a survival model, gated on confidence, lift the follow WR over break-even
  at usable coverage? AUC ≤ 0.52 = persistence is unpredictable beyond the base rate.

### Verdict tiers

- **PROFITABLE (raw, FADE)** — fading the confluence clears break-even at some expiry. (A momentum-gain
  confluence is then really a mean-reversion trigger — consistent with the mildly mean-reverting
  regime seen across the other skills.)
- **PROFITABLE (raw, follow)** — the move genuinely persists past break-even.
- **PROFITABLE (gated)** — only the confidence-gated survival model clears break-even.
- **PREDICTABLE-BUT-UNPROFITABLE** / **NO EDGE** — structure too weak, or none.

**Caution on thin margins:** a WR a hair over 55.6% (e.g. 55.7%) on one horizon is *not* a confirmed
edge — it is within noise and gross of any cost beyond the payout. Treat it as a lead to confirm
**cross-regime** (run on the other DB) and to pressure-test with stricter `--confluence`, never as a
ship signal on one dataset.

## Limits

- **Read-only / offline**, schema-adaptive, one regime per run — cross-regime confirmation is the gate.
- **Fade ≈ 1 − follow** assumes negligible exact-tie bars (true for 5m FX closes); the predict stage
  models the follow side, so a confirmed fade edge would get its own gated survival model before freeze.
- See `references/methodology.md` for the onset rule, the cross-back label, and the survival setup.
