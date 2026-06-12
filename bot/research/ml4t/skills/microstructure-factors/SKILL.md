---
name: microstructure-factors
description: >-
  Extract tick-level MICROSTRUCTURE features per 5-minute bar from the 1-second `prices` stream
  (order-flow imbalance, run-length, micro-volatility, tick intensity, within-bar path/wick) and run
  them through the alpha-factor-eval IC gauntlet to test whether sub-bar information predicts the next
  bar where the 32 bar-close indicators cannot. Use this skill WHENEVER you want to mine NEW signal
  from raw ticks, when asked "is there anything in the tick data / order flow / microstructure",
  "does sub-bar price action predict the next move", "what's in the prices table", or when the
  indicator-based studies have hit AUC ~0.5 and you need a fresh INPUT (not a fancier model). It is
  the "are the untouched ticks any better than the bars?" probe. Note: tick data exists only in the
  June `trading_data*` DBs — the `agent_*` training DBs have none.
---

# Microstructure Factors (tick-derived)

## Why this exists

The project's recurring wall: the 32 indicators at 5-min bars carry ~no forward signal (AUC ~0.5).
The one untouched data source is the **1.13M-row, 1-second `prices` tick stream**. This skill is the
systematic test of whether sub-bar microstructure — the *shape and flow* inside each candle — predicts
the next bar where the bar-close indicators don't. It is an **inputs** probe, not a model: better
features, run through the same honest IC gauntlet as every other factor.

## When to use

- "Is there anything in the ticks / order flow / microstructure?"
- The indicator studies are stuck at AUC ~0.5 and you want a genuinely new input.
- Before reaching for a fancier model — capacity isn't the bottleneck here, inputs are.

## How to run

```bash
python bot/research/ml4t/skills/microstructure-factors/scripts/micro_factors.py \
  --db "data/trading_data00.db[,...]" [--horizons 5,10,15] [--min-ticks 10]
```
Tick DBs only (June `trading_data*`); pool several with a comma list for power. Per (asset, 5-min bar)
it computes causal tick features and reports each one's Information Coefficient vs the forward bar
return (pooled + honest block t-stat), flagging `SIGNAL?` when block |IC| > 0.03 and p < 0.05.

## The features

- **Tick-exclusive** (need the stream): `n_ticks` (intensity), `imbalance` (up/down tick balance),
  `max_run` (longest same-direction run), `micro_vol` (tick-return vol), `range_bps`, `spike_revert`
  (within-bar round-trip / wick).
- **Candle-shape** (computable from OHLC too, included as a bridge): `net_ret` (bar tick return),
  `close_pos` (where the close sits in the bar's range).

## How to read the output — and the headline finding

A `SIGNAL?` row is a *candidate*; confirm it via `purged-walk-forward-cv` (does the IC survive OOS and
clear break-even WR?). The first full run delivered a sharp, two-part verdict:

1. **Tick-exclusive features are NOISE.** Imbalance, run-length, micro-vol, intensity, range, wick —
   none clears block-IC significance even pooled across all June DBs (~19k bars). **The 1-second order
   flow does not predict the next bar.** The single biggest untapped data source adds nothing.
2. **The only signal is candle-shape mean-reversion.** `net_ret` and `close_pos` clear (block IC ~−0.05,
   p < 0.01, consistent 5/10/15m) — but they correlate **0.99** with the candle's own `(close−open)/open`
   and `(close−low)/(high−low)`, i.e. they are OHLC, not microstructure. Being OHLC-computable, they
   **cross-regime validate** on the 53-day agent_FXSB (block IC ~−0.06, p=0.000) — but purged-WF returns
   **STABLE-IC / SUB-BREAKEVEN** (extreme-WR 51.5% < 55.6%): real, bulletproof, ~4 points short of the
   payout wall, exactly like `rsi_14`.

So microstructure did **not** break the wall. It confirmed the market is mean-reverting at the
candle-shape level too, surfaced a *new* (non-indicator) factor — `close_pos` — that is a legitimate
**meta-label input**, but nothing here trades standalone.

## What it earns / next steps

- `po_data.load()` now also returns `open/high/low`, so candle-shape factors run through the whole
  gauntlet: e.g. `purged_wf.py --factor "(close-low)/(high-low)-0.5" --db agent/data/agent_FXSB.db`.
- The concrete improvement candidate: add `close_pos` (single-bar) as a **37th feature** to the
  decay-onset gate (the 36 engineered features use band-relative `v_pctB`, not bar-range position) and
  re-freeze — it may marginally sharpen `p_decay`. Sub-break-even alone, possibly additive in the model.

## Limits

- **June-only for ticks** — `agent_*` has no `prices` rows, so tick-exclusive features cannot be
  cross-regime validated. (The candle-shape winners can, because they're OHLC.)
- **One-pass exploratory** — a `SIGNAL?` flag is a lead; the verdict comes from purged-WF + WR, as above.
- See `references/methodology.md` for the feature math and the IC protocol.
