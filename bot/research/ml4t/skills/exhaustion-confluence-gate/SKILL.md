---
name: exhaustion-confluence-gate
description: >-
  Test the FAITHFUL multi-indicator exhaustion confluence — price rejected at the Bollinger
  band while stochastic, STC, and CCI all roll over together from an extreme level — the way a
  human reads the chart, with LEVEL-aware and DIRECTION-aware encoding. Use this skill when
  evaluating the reversal/fade setup, when asked whether requiring "all four indicators to agree"
  produces a tradeable win rate, or when investigating why the deployed kinetic-feature gate
  (ml-gate.js) underperforms. It exists because the deployed model degraded that confluence into a
  single lossy feature (Stoch_Divergence = |K-D|, importance 0.988) that is blind to direction and
  to the overbought/oversold level — so it never actually detected the setup. This skill encodes the
  confluence faithfully and asks: does the REAL confluence carry the edge the proxy lost? Validated
  train-period (agent_v1, May 12-26) vs clean zero-overlap OOS (agent, May 29-Jun 12).
---

# Exhaustion-Confluence Gate

## Why this exists

The deployed reversal gate was meant to encode a human exhaustion read:

> Price tagged the upper Bollinger band and failed to hold; stochastic crossed **down** from
> **overbought**; STC turned **down** from elevated; CCI rolled over from **above zero**, dropping.
> All four point the same way at once -> fade the overextension (SELL the pullback).

But the trained model does NOT encode this. Its features are lossy proxies, and the worst-aligned
one dominates:

| human signal | deployed feature | faithful? |
|---|---|---|
| price rejected at band | BB_Deviation = (close-bb_lower)/band | position only, no "tagged then rejected" |
| stoch crossed DOWN from OVERBOUGHT | **Stoch_Divergence = \|K-D\|** | **NO — drops direction AND level** |
| STC turning down from high | STC_Momentum = stc[t]-stc[t-1] | slope only, no level |
| CCI rolling over from above 0 | CCI_Velocity = (cci[t]-cci[t-2])/2 | slope only, no level |

Tree importance Stoch_Divergence **0.988**; logreg coef 0.593 vs ~0 on the others. The model leans
almost entirely on the ONE feature that can't see the setup, and ignores the slope features that
can. `|K-D|`=20 looks identical whether stochastic crosses down from 90 (the setup) or up from 10
(its opposite). So the gate fires on "K and D are far apart", not on the confluence — which is why
it is coin-flip out-of-period (see ../reversal-gate-retest reports).

## The hypothesis

Encode the confluence the way a human reads it — **level-aware + direction-aware**, per side
(bearish ceiling / bullish floor), and count how many of the four agree. Then test whether
requiring more agreement raises the fade win rate above the binary break-even (~59% at 0.69 payout),
and whether that holds on BOTH the train period (agent_v1) and the clean OOS period (agent).

## Confluence definition (per side)

Bearish exhaustion (mirror for bullish floor):
- **band**: bar high tagged/exceeded upper band AND close fell back inside it
- **stoch**: K in overbought (>=80) AND K crossed below D (signed down-cross)
- **stc**: STC elevated (>=75) AND STC turning down (stc[t] < stc[t-1])
- **cci**: CCI above +100 AND CCI dropping (cci[t] < cci[t-2])

`confluence_score` = count of the four met (0-4). Bet = fade (bearish -> PUT, bullish -> CALL).
Win = price closes against the extreme over the expiry horizon.

## What "passes"

Win rate RISES monotonically with confluence_score, and at score>=3 (or 4) clears break-even on
BOTH agent_v1 and agent (the two-period lie detector). If it does not, the confluence shape itself
has no tradeable edge at this timeframe — not just the lossy encoding.

## Scripts

- `scripts/confluence_scan.py` — build the faithful confluence, WR by confluence_score per side,
  per period (v1 vs agent), across horizons; the two-period lie detector.
