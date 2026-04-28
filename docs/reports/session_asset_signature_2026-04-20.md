# Toxic Asset Signature — Behavioral Gate Hunt
**Date:** 2026-04-20
**Script:** `scripts/qa_asset_signature.cjs`
**Raw output:** `docs/_qa_asset_signature.txt`

## Mission

Individual asset blocklists don't generalize — new assets appear, regimes shift. We must find a **measurable behavioral trait** that predicts poor performance, then gate on the **trait** (not the name).

From QA1 the worst performers clustered into cross pairs without USD (CADJPY, EURJPY, EURNZD, GBPAUD), managed currencies (USDCNH, USDRUB, USDCOP, USDIDR), illiquid crosses (BHDCNY), and high-risk EM (EURTRY, ZARUSD). Question: what do they share structurally?

---

## Phase 1 — Asset Buckets (5 DBs pooled, n≥10)

Source: `signal_outcomes` across v2_13-15 / V3_16 / V3_17 / V4_17 / current. Pooled WR regardless of pattern.

### GREEN — WR ≥ 70% (n=3, 62 signals, +$13,160)
| Asset | n | WR | P/L |
|---|---|---|---|
| EURUSD_otc | 27 | 77.8% | +$6,660 |
| USDEGP_otc | 18 | 72.2% | +$3,480 |
| KESUSD_otc | 17 | 70.6% | +$3,020 |

### RED — WR < 55% (n=34, 1,068 signals, −$56,220 cumulative)
Top 10 worst:

| Asset | n | WR | P/L |
|---|---|---|---|
| BHDCNY_otc | 22 | 31.8% | −$4,280 |
| EURTRY_otc | 25 | 32.0% | −$4,820 |
| USDJPY_otc | 34 | 35.3% | −$5,480 |
| GBPAUD_otc | 25 | 36.0% | −$3,860 |
| USDBRL_otc | 27 | 37.0% | −$3,900 |
| CADJPY_otc | 41 | 39.0% | −$5,140 |
| USDPKR_otc | 33 | 39.4% | −$4,020 |
| EURJPY_otc | 29 | 41.4% | −$2,980 |
| YERUSD_otc | 24 | 41.7% | −$2,400 |
| USDCOP_otc | 48 | 41.7% | −$4,800 |

Full list of 34 RED assets: see raw output. Every QA1 hypothesis-cluster confirmed (JPY crosses, managed currencies, illiquid EM).

### GREY — 55% ≤ WR < 70% (n=18, 568 signals)

---

## Phase 2 — Candidate Traits

Per-asset computation across first 20,000 ticks + 2,000 candles + 2,000 indicator rows per DB, averaged across DBs.

| Trait | Definition |
|---|---|
| `tick_cadence` | Median Δt between price ticks (seconds) |
| `tick_autocorr` | Lag-1 autocorrelation of tick returns |
| `tick_stddev` | Stddev of tick-to-tick return |
| `range_cov` | Stddev/mean of candle (high−low) |
| `wick_dom` | Mean `1 − body/range` per candle |
| `gap_rate` | Fraction of bars with \|open−prev_close\| > 0.5×prev_range |
| `bbw_median` | Median BB width in bps |
| `bbw_cov` | Stddev/mean of BB width bps |
| `ma_chop` | Rate of MA6−MA14 sign flips |
| `stoch_whipsaw` | Rate of sign flips in ΔK |
| `rsi_range` | max(RSI5) − min(RSI5) over window |

---

## Phase 3 — Trait Separation (Cohen's d, GREEN vs RED)

Ranked by |d|:

| Trait | GREEN μ | RED μ | d | Interpretation |
|---|---|---|---|---|
| **range_cov** | 0.3205 | 0.3316 | **−1.19** | RED assets have more variable candle ranges |
| ma_chop | 0.0757 | 0.0917 | −0.85 | RED assets have more MA whipsaw |
| tick_autocorr | +0.0049 | −0.0004 | +0.78 | GREEN ticks trend; RED ticks are noisy/mean-reverting |
| stoch_whipsaw | 0.3701 | 0.3495 | +0.76 | (opposite direction than expected — low d priority) |
| bbw_cov | 0.3499 | 0.3827 | −0.68 | RED assets have less-stable volatility |
| rsi_range | 94.43 | 96.43 | −0.56 | RED assets exhibit wider RSI excursions |
| tick_stddev | 0.0001 | 0.0002 | −0.29 | Marginal |
| bbw_median | 17.5 | 55.4 | −0.25 | Large raw gap but high variance → low d |
| gap_rate | 0.0027 | 0.0025 | +0.16 | Negligible |
| wick_dom | 0.497 | 0.497 | +0.07 | No separation |
| tick_cadence | 1.00 | 1.00 | ~0 | All OTC feeds emit at 1s — **not usable as a gate** |

### Top finding
**`range_cov` (|d|=1.19) is the dominant separator.**

Secondary: `ma_chop` (0.85), `tick_autocorr` (0.78), `bbw_cov` (0.68) form a coherent "chop signature" — RED assets have unstable range, whippy MAs, and non-trending tick dynamics.

---

## Phase 4 — Proposed Universal Gate

### Single-trait (threshold = midpoint)

**`range_cov ≤ 0.326`**

Simulation impact (signals removed if applied):

| Bucket | Blocked | Total | % |
|---|---|---|---|
| RED | 767 | 1,068 | **71.8%** |
| GREEN | 0 | 62 | **0.0%** |
| GREY | 485 | 568 | 85.4% |

**Zero false-positive on GREEN** assets. Kills ~72% of RED-asset signals with no collateral damage to the three proven winners. GREY collateral is 85% — but GREY's aggregate WR/P/L is sub-profitable anyway, so cutting it is a feature.

### Caveat
GREEN–RED means are numerically close (0.3205 vs 0.3316). Gate is statistically well-separated (d=1.19) but **measurement noise** in `range_cov` per session could flip borderline assets. Recommend a composite of the top 3 traits:

**Composite gate:** `range_cov ≤ 0.326 AND ma_chop ≤ 0.085 AND tick_autocorr ≥ 0`

This tightens the filter but needs a second simulation pass before wiring.

### Estimated ROI
- RED cumulative P/L: −$56,220 across 5 DBs
- Gate blocks 71.8% of RED signals → avoided loss ≈ **+$40k** in replay
- Plus ~85% of GREY's marginally-negative trades
- Zero cost to GREEN (+$13,160 preserved)

---

## Implementation Sketch

Add a pre-signal filter in `bot/indicators.js` before any pattern emits:

```js
// Compute range_cov over rolling window (last 200 bars)
const ranges = candles.slice(-200).map(c => c.high - c.low);
const m = ranges.reduce((s,x)=>s+x,0) / ranges.length;
const sd = Math.sqrt(ranges.reduce((s,x)=>s+(x-m)*(x-m),0)/(ranges.length-1));
const rangeCov = m > 0 ? sd / m : 0;

if (rangeCov > 0.326) return null; // toxic-chop regime, skip
```

Run hot on the live feed using a rolling 200-bar window so the filter is asset-agnostic and adapts to regime changes automatically.

---

## Open Questions

1. **Window length:** 200 bars is ~3.3 h at 1-min candles. Shorter (60 bars) captures fast regime shift; longer (500) is more stable. Needs sensitivity check.
2. **Composite vs single:** Compare the 3-trait composite simulation to single `range_cov` threshold. If composite doesn't improve RED-kill rate materially, prefer the simpler gate.
3. **Per-pattern application:** Should the filter apply uniformly to all 4 patterns, or only to the two that benefit most (PUT_REV, PUT_DT)? Baseline QA1 showed CALL_UT is structurally different.
4. **Re-validation cadence:** With a behavioral gate, stale bucketing becomes less load-bearing, but recompute GREEN/RED monthly to confirm the trait holds as new sessions arrive.

---

## Phase 5 — Per-DB Validation (out-of-sample test)

Pooled Cohen's d was strong (1.19 on `range_cov`), but that could be driven by a single DB. Here we validate the gate **per DB independently** — no pooling. Traits are computed from each DB's own prices/candles/indicators (not cross-DB leaked).

### Composite gate (range_cov ≤ 0.326 AND ma_chop ≤ 0.085 AND tick_autocorr ≥ 0)

| DB | Before n | Before WR | Before P/L | After n | After WR | After P/L | Δ WR |
|---|---|---|---|---|---|---|---|
| v2_13-15 | 614 | 52.4% | +$2,120 | 27 | 44.4% | −$1,980 | **−8.0pp** |
| V3_16 | 701 | 49.8% | −$15,460 | 117 | 55.6% | +$3,900 | +5.8pp |
| V3_17 | 79 | 54.4% | +$1,780 | 0 | — | — | (killed all) |
| V4_17 | 225 | 50.7% | −$3,060 | 26 | 42.3% | −$2,440 | **−8.4pp** |
| current | 94 | 60.6% | +$7,720 | 14 | 57.1% | +$680 | −3.5pp |
| **Aggregate** | **1,713** | **51.7%** | **−$6,900** | **184** | **52.2%** | **+$160** | **+0.5pp** |

**Verdict: composite gate fails out-of-sample.** Only V3_16 shows real improvement. v2_13-15, V3_17, V4_17, current all regress. WR lift is 0.5pp — inside noise. The gate is **overfit** to the pooled GREEN/RED bucketing.

### Single-trait gate (range_cov ≤ 0.326)

| DB | Before n / WR / P/L | After n / WR / P/L | Δ WR |
|---|---|---|---|
| v2_13-15 | 614 / 52.4% / +$2,120 | 190 / 53.2% / +$1,960 | +0.7pp |
| V3_16 | 701 / 49.8% / −$15,460 | 220 / 51.8% / −$560 | +2.0pp |
| V3_17 | 79 / 54.4% / +$1,780 | 0 / — / — | (killed all) |
| V4_17 | 225 / 50.7% / −$3,060 | 84 / 48.8% / −$2,640 | −1.9pp |
| current | 94 / 60.6% / +$7,720 | 37 / 59.5% / +$2,620 | −1.2pp |
| **Aggregate** | **1,713 / 51.7% / −$6,900** | **531 / 52.4% / +$1,380** | **+0.7pp** |

**Slightly better, still weak.** Only V3_16 and v2_13-15 improve. V4_17 and current **regress**. V3_17 kills every trade (rare regime where no asset's `range_cov` ≤ 0.326).

### Per-pattern impact (single-trait gate)

| Pattern | Before n / WR / P/L | After n / WR / P/L | Δ WR | Notes |
|---|---|---|---|---|
| PUT_DT | 801 / 52.3% / +$1,740 | 258 / 54.3% / +$5,400 | +2.0pp | Best — gate works here |
| CALL_UT | 369 / 53.4% / +$4,620 | 85 / 54.1% / +$1,660 | +0.7pp | Marginal |
| CALL_REV | 403 / 47.1% / −$19,100 | 141 / 48.2% / −$5,220 | +1.1pp | Reduces loss but still unprofitable |
| **PUT_REV** | **140 / 56.4% / +$5,840** | **47 / 51.1% / −$460** | **−5.4pp** | **Gate hurts the one profitable pattern** |

**Red flag:** The gate actively damages PUT_REV (the strongest pattern per QA1/QA2) — it removes too much signal from profitable assets.

---

## Conclusion & Honest Verdict

**The universal gate hypothesis is not supported by out-of-sample evidence.**

- Pooled Cohen's d (1.19) looked strong, but the separation was driven mostly by one DB (V3_16, which has the most extreme red-asset losses).
- No single threshold of `range_cov` generalizes across all 5 DBs.
- The gate damages the highest-edge pattern (PUT_REV, +$5.8k → −$460).
- Only V3_16 gets meaningful lift — this is the classic single-DB overfit signature we committed to avoid (per `feedback_replay_validation.md`).

### What the finding actually tells us

`range_cov` is a **real** signal — it correlates with asset quality in the pool — but:
1. It's too coincident with asset identity (it's basically rediscovering the blocklist)
2. It's a session-level property that doesn't vary much between signal-triggers, so it filters uniformly rather than selecting the right trades within each asset
3. The dominant QA1/QA2 gates (K-D spread, vel, RSI band) are **per-bar** behavioral filters and they already do the separation inside each asset

### Recommendation: DO NOT SHIP the universal gate

Instead:

1. **Keep the proven per-bar combo**: `bbw≥30 × vel<−12 × RSI[60,70)` (QA2 validated, +$11,300 replay P/L on PUT_REV)
2. **Ship a dynamic (not behavioral) asset blocklist** sourced from a rolling 200-signal window per asset — if a specific asset's trailing WR < 48% over n ≥ 15 signals, auto-block. This is a "name-based" block but it's **dynamic** so new assets get the same treatment.
3. **Re-visit trait gating later** with a richer feature set (order-book microstructure, volume profile) — the current OHLC+tick traits don't carry enough signal for a universal rule.

---

## Deliverable: JSON Gate Spec (NOT recommended for deployment)

```json
{
  "name": "universal_asset_quality_filter",
  "status": "REJECTED_OUT_OF_SAMPLE",
  "conditions": [
    { "trait": "range_cov",     "operator": "<=", "value": 0.326 },
    { "trait": "ma_chop",       "operator": "<=", "value": 0.085 },
    { "trait": "tick_autocorr", "operator": ">=", "value": 0.0 }
  ],
  "action": "block_signal",
  "window": { "ticks": 20000, "candles": 2000, "indicators": 2000 },
  "validated_dbs": ["v2_13-15", "V3_16", "V3_17", "V4_17", "current"],
  "per_db_wr_delta_pp": { "v2_13-15": -8.0, "V3_16": 5.8, "V3_17": "killed_all", "V4_17": -8.4, "current": -3.5 },
  "aggregate_impact": {
    "before": { "n": 1713, "wr_pct": 51.7, "pnl": -6900 },
    "after":  { "n": 184,  "wr_pct": 52.2, "pnl":   160 },
    "wr_improvement_pp": 0.5,
    "avoided_loss": 7060,
    "verdict": "fails 3 of 5 DBs independently; overfit to pooled bucketing"
  }
}
```

Single-trait variant (`range_cov ≤ 0.326` alone) is weaker but equally overfit:

```json
{
  "name": "universal_asset_quality_filter_single",
  "status": "REJECTED_OUT_OF_SAMPLE",
  "conditions": [{ "trait": "range_cov", "operator": "<=", "value": 0.326 }],
  "aggregate_impact": { "before_pnl": -6900, "after_pnl": 1380, "wr_pp": 0.7 },
  "per_db_wr_delta_pp": { "v2_13-15": 0.7, "V3_16": 2.0, "V3_17": "killed_all", "V4_17": -1.9, "current": -1.2 },
  "per_pattern_damage": { "PUT_REV_wr_delta_pp": -5.4, "PUT_REV_pnl_delta": -6300 }
}
```

---

## Files

- `scripts/qa_asset_signature.cjs` — Phase 1-4 trait hunt
- `scripts/qa_universal_gate_validate.cjs` — Phase 5 per-DB validation
- `docs/_qa_asset_signature.txt`, `docs/_qa_universal_gate_validate.txt`, `docs/_qa_universal_gate_single.txt` — raw outputs
- `docs/session_asset_signature_2026-04-20.md` — this report
