---
name: alpha-factor-eval
description: >-
  Evaluate whether a candidate trading factor/feature carries tradeable forward-return signal,
  using the ML4T alpha-research methodology — Information Coefficient (IC), block t-stat / IR,
  quantile (quintile/decile) spread, hit-rate vs binary-option break-even, and an IC decay curve
  across the 5/10/15/20-minute validation horizons. Use this skill WHENEVER you are about to test,
  propose, add, or model a new indicator/feature/factor for the pocket-option trading bot, or when
  asked "does this feature predict anything", "is there signal in X", "what's the IC of Y", "should
  we add Z as a gate", or before any model-training / gate-tuning / freeze-export step. It is the
  mandatory "is there an edge at all" gate that runs BEFORE modeling — cheap, read-only, and it stops
  you from training models on noise. Prefer this over ad-hoc win-rate poking or jumping straight to a
  model.
---

# Alpha-Factor Evaluation (ML4T)

## Why this exists

In this project, price is near-unpredictable: prior studies found indicator features score
AUC ≈ 0.49–0.54 against tradeable forward-price targets (H0 held). The expensive failure mode is
training a model — or wiring a live gate — on a factor that was always noise. A decision tree once
put **0.988** of its importance on `Stoch_Divergence`; this skill shows that same factor has
**block IC ≈ −0.03, not significant** — i.e. the model was confidently splitting on nothing.

So before *any* modeling, answer one question in the field's standard language: **does the factor's
rank correlate with the forward return (IC), consistently across time (t-stat), with a monotonic
quantile spread, and a hit-rate that clears the binary-option break-even?** A "no" here saves the
whole downstream pipeline. A "yes" earns the right to proceed to purged walk-forward + cross-regime.

This replaces F1/AUC framing with IC/quantile framing — the same yardstick Alphalens uses — which
is both more standard and more honest about thin, low-signal financial data.

## Dataset shape (matters for reading results)

- Candles are **5-minute** bars. Predictions are validated at **5/10/15/20-minute** horizons, i.e.
  **1/2/3/4 bars ahead**. The skill computes forward returns off **candle close shifted n bars**,
  which is exactly how the bot validates — no sub-bar tick games, no timestamp-alignment ambiguity.
- The default snapshot (`trading_data.db`) is ~2 days × 15 FX pairs — **one regime**. Good for a
  read, not for a verdict. A positive here is a lead to confirm cross-regime, never a green light.

## When to use

- About to add/test/propose any indicator, feature, or gate → run this first.
- "Is there signal in X?" / "What's the IC of Y?" / "Does Z predict the next move?"
- Before `model-freeze-export`, gate-tuning, or any sklearn training in `ml4t/`.
- Comparing several candidate factors to decide which (if any) deserves modeling.

## How to run

The work is done by `scripts/alpha_eval.py` — deterministic, read-only, no model persisted.
It opens `data/trading_data.db` with `immutable=1` (cannot lock or corrupt the bot's DB).

```bash
python bot/research/ml4t/skills/alpha-factor-eval/scripts/alpha_eval.py \
  --factor "<expression>" [--name NAME] [--horizons 5,10,15,20] \
  [--quantiles 5] [--payout 0.8] [--block-sec 3600] [--json out.json]
```

`--horizons` are in **minutes** and must be whole multiples of the bar. `--bar-sec` is the candle
interval in seconds (default 300); it is **floored at 300s** — sub-5m bars don't exist in this
market, and the script rejects anything below it.

**`--factor` is a pandas expression over indicator columns plus `close`.** A helper `d(col, k)`
gives the per-asset k-bar difference (velocity/momentum). Examples:

| Intent | `--factor` |
|---|---|
| bare indicator | `"rsi_14"` |
| Stoch divergence | `"abs(stoch_k - stoch_d)"` |
| %B / BB deviation | `"(close - bb_lower)/(bb_upper - bb_lower)"` |
| STC momentum | `"d(stc_value, 1)"` |
| CCI velocity | `"d(cci_20, 2)/2"` |
| MACD histogram slope | `"d(macd_hist, 1)"` |

Available columns: all of `indicators` (rsi_14, stoch_k/d, bb_*, stc_*, cci_20, macd_*, adx_*,
williams_14, atr_*, psar*, sma/ema_*) plus `close`.

## How to read the output

The report has three parts. Read them in this order and apply the decision rule literally — the
point of the skill is to resist the temptation to see signal in noise.

1. **IC decay table** — one row per horizon (5/10/15/20m).
   - `pooled IC` = Spearman(factor, forward return) over all rows. Sign = direction (positive →
     high factor predicts up-moves → CALL edge). **Do not trust the pooled p-value alone** — it is
     inflated by autocorrelation (overlapping bars are not independent).
   - `block mean-IC / IR / t / p` = IC recomputed inside time blocks (default 1h) then summarized.
     This is the **trustworthy** significance number. It is normal and instructive to see pooled p < 0.05
     while block p > 0.05 — that gap IS the autocorrelation illusion, and the block number wins.
   - **Decision:** a factor is a *candidate* only if some horizon has **|block mean-IC| > 0.03 AND
     block p < 0.05**. Otherwise it is noise. (Context: |IC| ~0.03–0.05 is weak-but-real in equities;
     below 0.02 is nothing.)

2. **Quantile spread @ primary horizon** — bucket rows by factor value, show mean forward return and
   hit-rate per bucket.
   - You want **monotonicity** (ρ near ±1): returns should climb smoothly across buckets, not jump
     around. A high IC with non-monotonic buckets is usually an artifact.
   - `hit-rate` vs **break-even WR = 1/(1+payout)** (55.6% at 0.8 payout) is the binary-option-
     specific test: a tradeable extreme bucket must clear break-even on the correct side (top bucket
     as CALL, bottom bucket as PUT). Mean-return-in-bps is meaningless if the hit-rate can't pay the
     payout deficit — that deficit, not slippage, is your real cost.

3. **Verdict** — `candidate` or `noise`, applying rule (1). Treat `noise` as final for that factor
   *as specified*; treat `candidate` as a hypothesis to confirm, never as a green light to trade.

## What a positive result earns (and what it does NOT)

A `candidate` verdict means *proceed to confirmation*, not *deploy*. The honest next steps:

1. **Purged walk-forward + embargo** — does the IC survive out-of-sample with overlapping labels
   removed? (See `../../RESEARCH_PROCEDURE.md`; the planned `purged-walk-forward-cv` skill.)
2. **Cross-regime replication** — re-run on the May agent.db / other snapshots. An edge that flips
   sign between regimes (as the prior momentum study did) is not real.
3. **Cost-netting** — net-of-payout, not gross bps.
4. Only then → modeling and `model-freeze-export` to a `*_params.json` for `ml-gate.js`.

Skipping straight from a single-snapshot `candidate` to a live gate is exactly the mistake this
skill is built to prevent.

## Notes & limits

- **Read-only / offline.** Uses Python (pandas/scipy) on a snapshot, opened immutable — this does
  not violate the "no runtime Python" rule, which is about the live bot process, not offline research.
- **Thin cross-section.** ~15 assets per timestamp, so IC is pooled and significance comes from
  time-blocks. Don't over-read a single horizon; look for a coherent pattern across the decay curve.
- See `references/methodology.md` for the math (IC, IR, block t-stat, quantile monotonicity, the
  payout-aware hit-rate test) and the rationale behind each threshold.
