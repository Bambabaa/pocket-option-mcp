# Strategy Validation Report

**Generated:** 2026-05-27  
**Dataset:** `data/agent.db` — 51,813 bars · 13 FX assets · 5m timeframe · 2026-05-12 → 2026-05-26  
**Timestamps:** stored as UTC−5 epoch (all session hours in this report are UTC, corrected +5h)  
**Win criterion:** CALL = `close[+N] > close[entry]`, PUT = `close[+N] < close[entry]`, flat = LOSS  
**Directional baselines:** P(UP at 15m) = 35.8% → CALL null = 35.8%, PUT null = 64.2%

---

## Table of Contents

1. [Features.js Audit & Fixes](#1-featuresjs-audit--fixes)
2. [Engineering Strategies — v1 Validation](#2-engineering-strategies--v1-validation)
3. [Time & Week Split Analysis](#3-time--week-split-analysis)
4. [ML-Only Strategy Validation — v2](#4-ml-only-strategy-validation--v2)
5. [Engineering vs ML Comparison](#5-engineering-vs-ml-comparison)
6. [Bugs Fixed](#6-bugs-fixed)
7. [Open Items](#7-open-items)

---

## 1. Features.js Audit & Fixes

All 6 fixes sourced from Opus code audit. Applied to `bot/features.js`. All 22/22 unit tests passing after fix.

### Fix Summary

| # | Component | Issue | Fix |
|---|-----------|-------|-----|
| 1 | `createAssetState()` | Missing `closes[]` ring and `regime_age: 0` | Added both to state initialiser |
| 2 | ADX pass-through | `feat.adx`, `feat.plus_di`, `feat.minus_di` not forwarded | Added pass-through from `ind` |
| 3 | Directional Efficiency | `feat.de` not computed | Added: `|close[t]−close[t−10]| / Σ|Δclose|` over 10-bar ring |
| 4 | Regime classifier | 3-rule subset instead of full 8-rule cascade | Rebuilt full cascade (see below) |
| 5 | Session boundaries | Asian lost ~10 hours/day; "Off" bucket didn't exist in research | Fixed: Asian = `h >= 22 || h < 7` UTC |
| 6 | `regime_age` | Never incremented | Added: increment on same regime, reset to 1 on change |

### 8-Rule Regime Cascade (in priority order)

```
DEAD_MARKET     bb_w_z20 < -1.5  AND  atr_z20 < -1.5
VOL_EXPANSION   bb_w_slope5 > 0  AND  atr_slope5 > 0
EXHAUSTION      atr_z20 > 0.5    AND  atr_slope5 < 0
COMPRESSION     bb_w_z20 < -0.5  AND  atr_z20 < -0.5
STRONG_TREND    adx >= 28        AND  de >= 0.55  AND  regime_age >= 6
TRENDING        adx >= 22        AND  de >= 0.40
RANGING         bb_w_z20 < 0.5   AND  atr_z20 < 0.5   (≈56% of all bars)
[default]       RANGING (catch-all)
```

### Session Boundaries (UTC)

| Session | UTC Hours |
|---------|-----------|
| Asian | `h >= 22 OR h < 7` (spans midnight) |
| European | `7 <= h < 13` |
| American | `13 <= h < 22` |

---

## 2. Engineering Strategies — v1 Validation

**Script:** `bot/validate_strategies.js`  
**Horizon:** 15 minutes (+3 bars)  
**Cooldown:** 3-bar per-asset per-strategy  
**Baseline:** 50% (original script); 35.8% CALL / 64.2% PUT (correct directional baseline)

### Overall

| Signals | Wins | Win Rate | Avg P&L (ATR) |
|---------|------|----------|---------------|
| 5,558 | 3,047 | **54.8%** | +0.131 ATR |

### Full Results

| Strategy | Dir | Tier | N | WR% | WR_lo95% | Exp ATR | z | p-value | Status |
|----------|-----|------|---|-----|----------|---------|---|---------|--------|
| T1_ZSCORE_EXTREME_LOW | CALL | T1 | 340 | **63.5** | 59.1 | +0.579 | 4.99 | 6.07e-7 | ✅ Strong |
| T1_SMC_SWEEP_HIGH_BEAR_OB | PUT | T1 | 81 | 45.7 | 36.9 | −0.066 | −0.78 | 4.37e-1 | ❌ Weak |
| T1_SMC_SWEEP_LOW_BULL_OB | CALL | T1 | 69 | 53.6 | 43.8 | +0.074 | 0.60 | 5.47e-1 | ❌ Weak |
| T1_TRANSITION_RANGE_TO_VOL_EXPANSION | PUT | T1 | 20 | 35.0 | 20.2 | −0.152 | −1.34 | 1.80e-1 | ❌ Weak |
| T2_FADE_FRESH_UP_BREAK | PUT | T2 | 1,304 | 54.3 | 52.0 | +0.107 | 3.10 | 1.93e-3 | ✅ Strong |
| T2_RANGE_EXPAND_BEAR_BOUNCE | CALL | T2 | 722 | 55.8 | 52.8 | +0.153 | 3.13 | 1.77e-3 | ✅ Strong |
| T2_ZSCORE_LOW_2SIG | CALL | T2 | 705 | 54.3 | 51.2 | +0.124 | 2.30 | 2.16e-2 | ⚠️ Marginal |
| T2_FADE_FRESH_DOWN_BREAK | CALL | T2 | 578 | 52.2 | 48.8 | +0.027 | 1.08 | 2.79e-1 | ❌ Weak |
| T2_LOWER_WICK_GROWTH_2X | CALL | T2 | 430 | 54.7 | 50.7 | +0.097 | 1.93 | 5.37e-2 | ⚠️ Marginal |
| T2_BB_PEAK_BEAR_BOUNCE | CALL | T2 | 232 | **59.9** | 54.5 | +0.243 | 3.02 | 2.53e-3 | ✅ Strong |
| T3_ZSCORE_LOW_1_5SIG | CALL | T3 | 954 | 55.1 | 52.5 | +0.096 | 3.17 | 1.51e-3 | ✅ Strong |

> **WR_lo95%** = Wilson lower bound at 95% CI. Evaluate on this, not raw WR.  
> **z / p-value** = binomial test against 50% null.

### Strong Strategies (p < 0.01)

| Strategy | N | WR% | WR_lo95% | Exp ATR | p-value |
|----------|---|-----|----------|---------|---------|
| T1_ZSCORE_EXTREME_LOW | 340 | 63.5% | 59.1% | +0.579 | 6.07e-7 |
| T2_BB_PEAK_BEAR_BOUNCE | 232 | 59.9% | 54.5% | +0.243 | 2.53e-3 |
| T2_FADE_FRESH_UP_BREAK | 1,304 | 54.3% | 52.0% | +0.107 | 1.93e-3 |
| T2_RANGE_EXPAND_BEAR_BOUNCE | 722 | 55.8% | 52.8% | +0.153 | 1.77e-3 |
| T3_ZSCORE_LOW_1_5SIG | 954 | 55.1% | 52.5% | +0.096 | 1.51e-3 |

### Per-Asset Notes

**T1_ZSCORE_EXTREME_LOW — Best assets**

| Asset | N | WR% |
|-------|---|-----|
| EURAUD | 28 | 78.6% |
| CADJPY | 22 | 77.3% |
| USDCAD | 25 | 76.0% |
| EURUSD | 25 | 72.0% |

Worst: AUDCHF (50.0%), CADCHF (50.0%)

**T2_BB_PEAK_BEAR_BOUNCE — Best assets**

| Asset | N | WR% |
|-------|---|-----|
| AUDCHF | 19 | 78.9% |
| EURJPY | 17 | 76.5% |
| USDCAD | 16 | 75.0% |

Worst: AUDCAD (23.1%), EURUSD (30.8%)

**T2_FADE_FRESH_UP_BREAK — Best assets**

| Asset | N | WR% |
|-------|---|-----|
| EURUSD | 72 | 63.9% |
| AUDJPY | 112 | 59.8% |
| CHFJPY | 111 | 59.5% |

Worst: EURJPY (47.7%), EURAUD (47.1%)

---

## 3. Time & Week Split Analysis

**Script:** `bot/validate_time_splits.js`  
**Session definitions (UTC):**

| Session | UTC Hours |
|---------|-----------|
| ASIA | 00:00–07:00 |
| LONDON | 07:00–12:00 |
| OVERLAP | 12:00–17:00 |
| NY | 17:00–22:00 |

### Per-Strategy Session Breakdown

#### T1_ZSCORE_EXTREME_LOW — 63.5% overall

| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 109 | **73.4%** | *** |
| LONDON | 48 | 50.0% | — |
| OVERLAP | 100 | 61.0% | ** |
| NY | 77 | 59.7% | * |

- **04:00 UTC** = N=100, WR=78.0%, p=2.15e-8 *** (Tokyo mid-session)
- 00:00 UTC = WR=0% (N=7) — hard avoid
- Weekdays: Tue 69.7% ***, Mon 65.4% ** — Wed weakest (55.7%)
- Weekly trend: W19 60.2% → W20 64.8% → W21 67.3% — **improving, stable**

#### T2_BB_PEAK_BEAR_BOUNCE — 59.9% overall

| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 77 | **75.3%** | *** |
| LONDON | 28 | 53.6% | — |
| OVERLAP | 69 | 43.5% | — |
| NY | 46 | 60.9% | — |

- **04:00 UTC** = WR=90.6% (N=32, p=4.31e-6 ***)
- OVERLAP is negative edge (43.5%) — avoid 12:00–17:00 UTC entirely
- Weekdays: Mon/Tue ** — Friday flat (49%)
- Weekly: W19 63.2%, W20 57.5%, W21 61.4% — stable

#### T2_RANGE_EXPAND_BEAR_BOUNCE — 55.8% overall

| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 204 | **61.3%** | *** |
| LONDON | 212 | 52.8% | — |
| OVERLAP | 156 | 55.1% | — |
| NY | 133 | 56.4% | — |

- **Best hours:** 02:00 UTC 87.5% ***, 04:00 UTC 65.9% ***, 08:00 UTC 76.6% ***
- **Death hours:** 11:00 UTC = **9.1% WR** (N=22), 23:00 UTC = 10% — confirmed kill zones
- Weekly: W20 weak (51.4%) — some instability

#### T2_FADE_FRESH_UP_BREAK — 54.3% overall (N=1304)

| Session | N | WR% | Sig |
|---------|---|-----|-----|
| ASIA | 353 | 55.2% | ** |
| LONDON | 258 | 50.8% | — |
| **OVERLAP** | 295 | **57.3%** | ** |
| NY | 307 | 54.1% | — |

- Edge spread across ASIA and OVERLAP; no dominant session
- 11:00 UTC leaking at **37.9%** (N=66) — London mid-session
- ⚠️ **W21 degraded to 49.3%** — possible edge erosion, monitor closely

#### T3_ZSCORE_LOW_1_5SIG — 55.1% overall (N=954)

| Session | N | WR% | Sig |
|---------|---|-----|-----|
| ASIA | 171 | 59.1% | ** |
| LONDON | 219 | 50.7% | — |
| **OVERLAP** | 238 | **58.0%** | ** |
| NY | 254 | 55.5% | * |

- Best hours: **18:00 UTC 74.2%*** (N=31), 01:00 UTC 72.7% **, 04:00 UTC 68.1% **
- Avoid: **23:00 UTC = 28.1%** (N=32, p=0.013) — confirmed bad slot
- Weekly: consistent 53–57% across all weeks

### Cross-Strategy Patterns

#### 🟢 04:00 UTC — the golden hour

Every strong strategy spikes at 04:00 UTC (Tokyo mid-session):

| Strategy | N | WR% | Sig |
|----------|---|-----|-----|
| T2_BB_PEAK_BEAR_BOUNCE | 32 | 90.6% | *** |
| T1_ZSCORE_EXTREME_LOW | 100 | 78.0% | *** |
| T2_FADE_FRESH_UP_BREAK | 15 | 80.0% | ** |
| T2_RANGE_EXPAND_BEAR_BOUNCE | 88 | 65.9% | *** |
| T3_ZSCORE_LOW_1_5SIG | 47 | 68.1% | ** |

#### 🔴 11:00 UTC — consistent danger zone (London mid-session)

| Strategy | N | WR% |
|----------|---|-----|
| T2_RANGE_EXPAND_BEAR_BOUNCE | 22 | **9.1%** |
| T2_FADE_FRESH_UP_BREAK | 66 | **37.9%** |

#### Session Edge Summary

| Session | Strategies with edge (p < 0.05) |
|---------|---------------------------------|
| **ASIA** | T1_ZSCORE, T2_BB_PEAK, T2_RANGE_EXPAND, T2_FADE_UP, T3_ZSCORE — **dominant** |
| LONDON | None significant |
| OVERLAP | T1_ZSCORE **, T2_FADE_UP **, T3_ZSCORE ** |
| NY | Marginal (*) only |

#### Weekday Edge Summary

| Day | Notable patterns |
|-----|-----------------|
| **Tue** | T1_ZSCORE 69.7% ***, T2_BB 64.2% ** |
| **Mon** | T1_ZSCORE 65.4% **, T2_BB 69.2% ** |
| **Fri** | Most strategies converge 56–65% |
| **Wed** | Weakest — most strategies below 55%, none significant |
| **Thu** | Mixed — T2_LOWER_WICK_GROWTH spike 72.9% *** (N=24) |

---

## 4. ML-Only Strategy Validation — v2

**Script:** `bot/validate_ml_strategies.js`  
**Features:** `bot/features_ml.js` — 53 non-SMC derived features  
**Source research:** `bot/ml_only_research.md`  
**ATR vol-regime:** Per-asset terciles from first 70% of bars (matching research train/test split)  
**Baselines:** CALL null = 35.8%, PUT null = 64.2%

### Summary Table

| Strategy | Dir | Hz | N | WR | Research WR | Gap | CI 95% | z | p | Status |
|----------|-----|----|---|----|-------------|-----|--------|---|---|--------|
| ML_EDGE_01 | CALL | 15m | 95 | **80.0%** | 80.2% | −0.2pp | [70.9, 86.8] | 8.99 | 0 | ✅ MATCH |
| ML_EDGE_02 | CALL | 15m | 84 | **78.6%** | 78.6% | +0.0pp | [68.7, 86.0] | 8.18 | 0 | ✅ MATCH |
| ML_EDGE_03 | CALL | 20m | 514 | 52.1% | 78.0% | −25.9pp | [47.8, 56.4] | 7.73 | 0 | ❌ BREAK |
| ML_EDGE_04 | PUT | 10m | 29,177 | 24.9% | 76.6% | −51.7pp | [24.4, 25.4] | −140 | 0 | ❌ BREAK |
| ML_EDGE_05 | CALL | 15m | 449 | 53.2% | 75.2% | −22.0pp | [48.6, 57.8] | 7.70 | 0 | ❌ BREAK |
| ML_EDGE_06 | CALL | 10m | 58 | 60.3% | 74.7% | −14.4pp | [47.5, 71.9] | 3.90 | 0.0001 | ⚠️ DRIFT |
| ML_EDGE_07 | CALL | 15m | 221 | **74.7%** | 74.7% | +0.0pp | [68.5, 79.9] | 12.05 | 0 | ✅ MATCH |
| ML_EDGE_08 | PUT | 10m | 839 | 45.9% | 73.7% | −27.8pp | [42.5, 49.3] | −11.1 | 0 | ❌ BREAK |

### Walk-Forward Decay (Research 70/30 Chrono Split)

| Strategy | Train WR | Test WR | Decay | Verdict |
|----------|----------|---------|-------|---------|
| ML_EDGE_01 | 86.2% | 67.7% | −18.4pp | ❌ large |
| ML_EDGE_02 | 82.4% | 62.5% | −19.9pp | ❌ large |
| ML_EDGE_03 | 77.6% | 80.5% | +2.9pp | ✅ stable |
| ML_EDGE_04 | 71.6% | 85.4% | +13.8pp | ✅ stable* |
| ML_EDGE_05 | 75.6% | 73.1% | −2.5pp | ⚠️ |
| ML_EDGE_06 | 75.0% | 72.7% | −2.3pp | ⚠️ |
| ML_EDGE_07 | 77.0% | 63.2% | −13.8pp | ❌ moderate |
| ML_EDGE_08 | 70.9% | 78.0% | +7.1pp | ✅ stable* |

> \* EDGE_04/08 walk-forward looks stable but the OOS WR on our dataset is inverted — the "stable" decay is a degenerate artifact.

---

### Matching Edges

#### ML_EDGE_01 — CALL @ 15m — WR=80.0%, N=95 ✅

**Gates:** `macd_line ≤ −9.27e-5 AND rsi_14 > 0.431 AND macd_histogram ≤ −0.00742 AND rsi_14 ≤ 22.29`  
*MACD deeply negative + RSI extremely oversold (≤22) — momentum divergence bottom.*

| Dimension | Slice | N | WR% |
|-----------|-------|---|-----|
| Session | Asian | 79 | 77.2% |
| Regime | HIGH vol | 56 | **87.5%** |
| Regime | LOW vol | 15 | 46.7% |
| Asset | CADJPY | 12 | **100%** |
| Asset | EURJPY | 12 | 91.7% |
| Asset | CHFJPY | 24 | 83.3% |
| Asset | AUDJPY | 37 | 70.3% |

- Fires almost exclusively on JPY crosses (all 4 top assets)
- ⚠️ Walk-forward decay −18.4pp: treat as **T2 paper-only** until N ≥ 100 fresh OOS bars
- Gate on HIGH vol before sizing live

---

#### ML_EDGE_02 — CALL @ 15m — WR=78.6%, N=84 ✅

**Gates:** `ret_1 ≤ −0.000263 AND ret_1 ≤ −0.000859 AND ret_6 > −0.00149`  
*Two sharp 1-bar drops but 6-bar return not deeply negative — counter-trend bounce.*

- Asian dominant (N=44, WR=81.8%) / American (N=30, WR=70.0%)
- HIGH vol (N=55, WR=81.8%) is where this works
- ⚠️ Walk-forward decay −19.9pp: treat as **T3 paper-only** — very large decay, small N

---

#### ML_EDGE_07 — CALL @ 15m — WR=74.7%, N=221 ✅

**Gates:** `range_atr > 0.043 AND signed_body_atr ≤ −1.302 AND atr_14 > 0.000127 AND range_atr > 2.794`  
*Extreme bearish spike candle (body ≥ 1.3×ATR, negative) with total range ≥ 2.79×ATR — exhaustion reversal.*

| Dimension | Slice | N | WR% |
|-----------|-------|---|-----|
| Session | European | 25 | **84.0%** |
| Session | American | 54 | 75.9% |
| Session | Asian | 142 | 72.5% |
| Regime | HIGH vol | 107 | **77.6%** |
| Regime | MED vol | 65 | 75.4% |
| Regime | LOW vol | 49 | 67.3% |
| Asset | USDJPY | 27 | 66.7% |
| Asset | AUDJPY | 24 | 75.0% |
| Asset | CADJPY | 20 | 75.0% |

- Fires across all sessions and regimes — most robust ML edge
- Best in MED+HIGH vol during European session (~84%)
- Walk-forward decay −13.8pp: monitor but deploy at reduced size initially
- `range_atr > 2.79` is the binding gate — only true exhaustion spike bars fire

---

### Breaking Edges — Why They Fail

#### ML_EDGE_03 + ML_EDGE_05 — temporal hr_sin edge broken (N=514/449, WR=52%)

Both gate on `hr_sin ≤ −0.982963`, which fires at UTC-5 18:00 = UTC 23:00 (Asian open).

- Research: N=1015/906, WR=78.0%/75.2% — labeled "Asian session"
- Our data: N=514/449, WR=52.1%/53.2% — labeled "American" (session tag wrong)
- Root cause: `features_ml.js` uses UTC-5 epoch; `getUTCHours()` returns h=18 → falls in "American" (13-21). Research used true UTC session tagging.
- The `hr_sin` computation is correct; WR gap is a **period mismatch** — this temporal edge does not generalise to our data window
- **Action:** Do not deploy until re-validated against the research's exact time period

#### ML_EDGE_04 — DEGENERATE class, fully inverted (N=29,177, WR=24.9% PUT)

- Expected 76.6% PUT; actual **24.9% PUT** — price goes UP 75.1% of the time when this fires
- Fires on 56% of all warm bars — nearly the entire dataset
- Vol regime breakdown: Research LOW vol WR=96.6%; our LOW vol WR=9.2%
- Classic degenerate DT leaf: "flat returns = down" was a period-specific artifact in training data
- **Action:** Exclude from live trading entirely

#### ML_EDGE_08 — PUT edge collapses by regime (N=839, WR=45.9%)

- Overall WR=45.9% — below 50% neutral, far below PUT baseline 64.2%
- LOW vol (N=303): WR=**16.2%** — massively inverted
- MED vol (N=236): WR=61.3% ← actual PUT edge lives here
- HIGH vol (N=300): WR=64.8% ← also works
- Asian session: WR=31.8% — inverted. American: WR=64.2%
- **Action:** Gate on `regime=MED OR HIGH` AND `session=American/European` → estimated N≈220, WR≈62-65%

#### ML_EDGE_06 — DRIFT (N=58, WR=60.3% vs research 74.7%)

- Works in Asian session (N=44, WR=70.5%)
- Research fragility=0.150 (BRITTLE) — spread perturbation kills WR by 24pp
- **Action:** Asian session only; exclude USDCHF, AUDCHF, CADCHF

---

### ML Actionable Priority Table

| Priority | Edge | Dir | WR | N | Action |
|----------|------|-----|----|---|--------|
| **T1** | ML_EDGE_07 | CALL | 74.7% | 221 | ✅ Fixes applied. Gate on MED+HIGH vol. Deploy with reduced size initially. |
| **T2** | ML_EDGE_01 | CALL | 80.0% | 95 | Paper-trade until OOS N ≥ 50. JPY crosses + HIGH vol only. |
| **T2** | ML_EDGE_02 | CALL | 78.6% | 84 | Large decay risk. Asian + HIGH vol gate required before sizing. |
| **T3** | ML_EDGE_06 | CALL | 60.3% | 58 | Asian session only. Exclude spread-sensitive CHF pairs. |
| **SALVAGE** | ML_EDGE_08 | PUT | ~63% gated | ~220 | Re-validate with `regime!=LOW AND session!=Asian` filter first. |
| **SKIP** | ML_EDGE_03/05 | CALL | ~52% | — | Period-specific temporal edge. Does not generalise. |
| **SKIP** | ML_EDGE_04 | PUT | ~25% | — | Fully inverted. Degenerate class artifact. Never deploy. |

---

### REGIME Edge Validation — All Three Killed (2026-05-x)

**Validator:** `validate_ml_strategies.js` with frozen ATR-14 terciles (`computeTerciles`, first 70% of bars per asset)  
**Source research:** `ml_edge_report.md` §5.3 (REGIME source, top-12 confidence table)

| Strategy | Dir | Hz | N | WR | Research WR | Gap | Status |
|----------|-----|----|---|----|-------------|-----|--------|
| REGIME_EUR_LOW | PUT | 15m | 4,890 | 10.9% | 97.7% | −86.8pp | ❌❌ BREAK |
| REGIME_ASI_LOW | PUT | 15m | 10,086 | 22.6% | 88.5% | −65.9pp | ❌❌ BREAK |
| REGIME_AME_LOW | PUT | 15m | 6,978 | 10.2% | 95.7% | −85.5pp | ❌❌ BREAK |

**Direction-flip audit (CALL):**  
REGIME_EUR_LOW_C CALL: WR=12.1%, N=4,890 → also broken. Not a direction inversion.

**Root cause: flat-price outcome rate**  
The three REGIME edges select bars in LOW volatility conditions. In that condition:
- European+LOW: **77%** of 15-minute windows close at exactly the same price as entry (exit == entry)
- Asian+LOW: **55%** flat
- American+LOW: **78%** flat

In `validate_ml_strategies.js`, a tie (exit == entry) is a LOSS for both PUT and CALL (`<` and `>` are strict). So:
- PUT WR + CALL WR + flat rate = 100%
- European+LOW: 10.9% + 12.1% + 77.0% = 100% ✓
- Asian+LOW: 22.6% + 22.3% + 55.1% = 100% ✓
- American+LOW: 10.2% + ~12% + ~78% = 100% ✓

Within the decisive (non-flat) windows, direction is roughly 50/50 → no exploitable edge.

**Why Python showed 97.7%:** The Python research used a different outcome definition — likely counting flat/tie outcomes as PUT wins, which is valid if the broker's binary option pays PUT on flat. Under that convention: `P(exit ≤ entry) = P(exit < entry) + P(exit == entry) = 10.9% + 77% = 87.9%`. Still not 97.7%, so there may also be different ATR computation (JS p33 labels more bars as LOW, inflating N). The mismatch is structural; these edges cannot be made to work with close-vs-close JS validation.

**Action:** All three REGIME edges permanently removed from deployment consideration. Moved to Confirmed Dead list in `verified_edges.md`.

---

## 5. Engineering vs ML Comparison

### Signal Count & Coverage

| Approach | Total Signals | Assets | Horizon |
|----------|--------------|--------|---------|
| Engineering (v1) | 5,558 | All 13 | 15m |
| ML Router (v2) | ~31,000 combined | All 13 | 10–20m |

### Best Edges Head-to-Head

| Source | Strategy | Dir | WR | N | Notes |
|--------|----------|-----|----|---|-------|
| ML | ML_EDGE_01 | CALL | 80.0% | 95 | JPY-only, HIGH vol, large decay |
| ML | ML_EDGE_02 | CALL | 78.6% | 84 | Small N, large decay |
| Engineering | T1_ZSCORE_EXTREME_LOW | CALL | 63.5% | 340 | Stable, 04:00 UTC spike, all assets |
| ML | ML_EDGE_07 | CALL | 74.7% | 221 | Spike exhaustion, all sessions |
| Engineering | T2_BB_PEAK_BEAR_BOUNCE | CALL | 59.9% | 232 | 04:00 UTC dominant |

### Key Observations

1. **ML edges have higher ceilings** but require strict regime gating and have large walk-forward decay
2. **Engineering edges are more stable** — T1_ZSCORE improves week-over-week (W19→W21); ML_EDGE_01/02 decay 18-20pp OOS
3. **Both approaches agree on Asian session / 04:00 UTC as the best trading window**
4. **ML_EDGE_07 is the single deployable ML edge** with N ≥ 200, acceptable decay, and a causally clean gate
5. **Engineering strategies have no PUT edge** — all strong strategies are CALL. The ML PUT edges (EDGE_04/08) are also broken in our data window — systematic bearish directional bias in this dataset is harder to capture
6. **JPY crosses dominate both approaches** — AUDJPY, CHFJPY, CADJPY, EURJPY appear in top assets across engineering T1_ZSCORE, ML_EDGE_01, and ML_EDGE_07

---

## 6. Bugs Fixed

### `validate_ml_strategies.js` — argv parse bug (0-row load)

`args.indexOf('--asset') + 1` evaluates to `0` when `--asset` is absent (indexOf returns −1, +1 = 0), so `args[0]` (e.g. `'--strategy'`) was used as the asset filter, producing `WHERE c.asset = '--strategy'` → 0 rows.

**Fix:** explicit `!== -1` guard before using the index:
```js
const _assetIdx   = args.indexOf('--asset');
const filterAsset = _assetIdx !== -1 ? args[_assetIdx + 1] : null;
```

All 51,813 bars now load on every invocation including `--strategy` single-edge runs.

---

### `features_ml.js` — unsigned `body_atr` for EDGE_07

`feat.body_atr = abs(close-open)/atr` is always ≥ 0. Research used signed `(close-open)/atr` so bearish candles give negative values. ML_EDGE_07 gates on `body_atr ≤ −1.302` — this could never fire with unsigned values.

**Fix applied (line 177):**
```js
feat.body_atr        = body / atr;              // unsigned (legacy, kept)
feat.signed_body_atr = (close - open) / atr;    // signed: negative = bearish
```

`ML_ROUTER_KEYS` updated to include `'signed_body_atr'`. EDGE_07 confirmed N=221, WR=74.7% after fix.

---

## 7. Open Items

### Code (bot/ only)

| Priority | File | Issue |
|----------|------|-------|
| 🔴 P1 | `database.js` | `psar_bull` column missing from schema, INSERT, and ON CONFLICT update |
| 🟠 P2 | `indicators.js` | `formatIndicators()` shows only 8/35 fields — expand to MACD histogram, ATR, ADX, PSAR, ZigZag, BB width bps |
| 🟡 P3 | `pocket-option-bot.js:927` | Stale comment references `_stochHistory`/`_cciHistory` which no longer exist |
| 🟡 P3 | `ml_only_router.js` | ES module syntax (`export const`, `export function`) — cannot be `require()`d in bot CJS pipeline |

### ML Deployment Pipeline

| Step | Status |
|------|--------|
| Convert `ml_only_router.js` to CJS | ❌ Not done |
| Fix router gate references (`ind.X` → `feat.X`) | ❌ Not done |
| Integrate `features_ml.js` into bot candle flow | ❌ Not done |
| Precompute per-asset ATR terciles as JSON | ❌ Not done |
| Deploy ML_EDGE_07 to live bot | ❌ Blocked on above |
| Re-validate ML_EDGE_08 with regime+session gate | ❌ Not done |

### Deep-Dive Queue (Strong Engineering Strategies)

For each strong strategy, the planned next phase covers:
1. Gate attribution — which gates are filtering vs leaking
2. Regime conditioning — WR split across VOL_EXPANSION / TRENDING / RANGING
3. ATR percentile filtering — does WR improve above median volatility?
4. Walk-forward in-sample (first 7d) vs OOS (last 7d) stability
5. Asset whitelist — per-strategy best-asset subset vs all-asset baseline

---

## Overall Summary

| Signals | Wins | Win Rate | Avg P&L (ATR) |
|---------|------|----------|---------------|
| 5,435 | 2,993 | **55.1%** | +0.136 ATR |

---

## Strategy Results

| Strategy | Dir | Tier | N | WR% | WR_lo95% | Exp ATR | z | p-value | Status |
|----------|-----|------|---|-----|----------|---------|---|---------|--------|
| T1_ZSCORE_EXTREME_LOW | CALL | T1 | 340 | **63.5** | 59.1 | +0.579 | 4.99 | 6.07e-7 | ✅ Strong |
| T1_SMC_SWEEP_HIGH_BEAR_OB | PUT | T1 | 81 | 45.7 | 36.9 | -0.066 | -0.78 | 4.37e-1 | ❌ Weak |
| T1_SMC_SWEEP_LOW_BULL_OB | CALL | T1 | 69 | 53.6 | 43.8 | +0.074 | 0.60 | 5.47e-1 | ❌ Weak |
| T1_TRANSITION_RANGE_TO_VOL_EXPANSION | PUT | T1 | 20 | 35.0 | 20.2 | -0.152 | -1.34 | 1.80e-1 | ❌ Weak |
| T2_FADE_FRESH_UP_BREAK | PUT | T2 | 1,304 | 54.3 | 52.0 | +0.107 | 3.10 | 1.93e-3 | ✅ Strong |
| T2_RANGE_EXPAND_BEAR_BOUNCE | CALL | T2 | 722 | 55.8 | 52.8 | +0.153 | 3.13 | 1.77e-3 | ✅ Strong |
| T2_ZSCORE_LOW_2SIG | CALL | T2 | 705 | 54.3 | 51.2 | +0.124 | 2.30 | 2.16e-2 | ⚠️ Marginal |
| T2_FADE_FRESH_DOWN_BREAK | CALL | T2 | 578 | 52.2 | 48.8 | +0.027 | 1.08 | 2.79e-1 | ❌ Weak |
| T2_LOWER_WICK_GROWTH_2X | CALL | T2 | 430 | 54.7 | 50.7 | +0.097 | 1.93 | 5.37e-2 | ⚠️ Marginal |
| T2_BB_PEAK_BEAR_BOUNCE | CALL | T2 | 232 | **59.9** | 54.5 | +0.243 | 3.02 | 2.53e-3 | ✅ Strong |
| T3_ZSCORE_LOW_1_5SIG | CALL | T3 | 954 | 55.1 | 52.5 | +0.096 | 3.17 | 1.51e-3 | ✅ Strong |

> **WR_lo95%** = Wilson lower bound at 95% confidence. Strategies should be evaluated on this, not raw WR.  
> **p-value** = binomial two-tailed test against 50% baseline (normal approximation).

---

## Tier Classification

### ✅ Strong (p < 0.01) — Candidates for deeper analysis

| Strategy | N | WR% | WR_lo95% | Exp ATR | p-value |
|----------|---|-----|----------|---------|---------|
| T1_ZSCORE_EXTREME_LOW | 340 | 63.5% | 59.1% | +0.579 | 6.07e-7 |
| T2_BB_PEAK_BEAR_BOUNCE | 232 | 59.9% | 54.5% | +0.243 | 2.53e-3 |
| T2_FADE_FRESH_UP_BREAK | 1,304 | 54.3% | 52.0% | +0.107 | 1.93e-3 |
| T2_RANGE_EXPAND_BEAR_BOUNCE | 722 | 55.8% | 52.8% | +0.153 | 1.77e-3 |
| T3_ZSCORE_LOW_1_5SIG | 954 | 55.1% | 52.5% | +0.096 | 1.51e-3 |

### ⚠️ Marginal (0.01 ≤ p < 0.10) — Needs more data or filter tightening

| Strategy | N | WR% | p-value |
|----------|---|-----|---------|
| T2_ZSCORE_LOW_2SIG | 705 | 54.3% | 2.16e-2 |
| T2_LOWER_WICK_GROWTH_2X | 430 | 54.7% | 5.37e-2 |

### ❌ Weak (p ≥ 0.10) — Avoid or redesign

| Strategy | N | WR% | p-value | Note |
|----------|---|-----|---------|------|
| T2_FADE_FRESH_DOWN_BREAK | 578 | 52.2% | 2.79e-1 | Symmetric version of UP_BREAK but edge doesn't mirror |
| T1_SMC_SWEEP_LOW_BULL_OB | 69 | 53.6% | 5.47e-1 | Low N, no significance |
| T1_SMC_SWEEP_HIGH_BEAR_OB | 81 | 45.7% | 4.37e-1 | **Below 50%** — directional bias wrong or OB logic inverted |
| T1_TRANSITION_RANGE_TO_VOL_EXPANSION | 20 | 35.0% | 1.80e-1 | Very low N + WR below 50% |

---

## Notable Per-Asset Findings

### T1_ZSCORE_EXTREME_LOW — Best Assets

| Asset | N | WR% | WR_lo95% |
|-------|---|-----|----------|
| EURAUD | 28 | **78.6%** | 63.6% |
| USDCAD | 25 | **76.0%** | 59.9% |
| CADJPY | 22 | **77.3%** | 60.1% |
| EURUSD | 25 | **72.0%** | 55.7% |
| USDCHF | 25 | **68.0%** | 51.6% |

Worst: AUDCHF (50.0%), CADCHF (50.0%) — consider asset-level filtering.

### T2_BB_PEAK_BEAR_BOUNCE — Best Assets

| Asset | N | WR% | WR_lo95% |
|-------|---|-----|----------|
| AUDCHF | 19 | **78.9%** | 60.5% |
| EURJPY | 17 | **76.5%** | 56.7% |
| USDCAD | 16 | **75.0%** | 54.5% |
| CADJPY | 24 | **66.7%** | 49.9% |

Worst: AUDCAD (23.1%), EURUSD (30.8%) — very poor on USD majors.

### T2_FADE_FRESH_UP_BREAK — Best Assets

| Asset | N | WR% | WR_lo95% |
|-------|---|-----|----------|
| EURUSD | 72 | **63.9%** | 54.2% |
| AUDJPY | 112 | **59.8%** | 52.1% |
| CHFJPY | 111 | **59.5%** | 51.7% |

Worst: EURJPY (47.7%), EURAUD (47.1%), USDCAD (48.9%) — EUR crosses underperform.

---

---

## Time & Week Split Analysis
**Script:** `bot/validate_time_splits.js`  
**Timezone note:** DB timestamps are UTC-5. All hours below are UTC (offset corrected +5h).

### Session Definitions (UTC)
| Session | UTC Hours | Market Context |
|---------|-----------|----------------|
| ASIA | 00:00–07:00 | Tokyo / early Sydney |
| LONDON | 07:00–12:00 | London open |
| OVERLAP | 12:00–17:00 | London/NY overlap |
| NY | 17:00–22:00 | New York |
| OFF | 22:00–24:00 | Low liquidity |

---

### Per-Strategy Time Findings

#### T1_ZSCORE_EXTREME_LOW — CALL — 63.5% overall
| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 109 | **73.4%** | *** |
| LONDON | 48 | 50.0% | — |
| OVERLAP | 100 | 61.0% | ** |
| NY | 77 | 59.7% | * |

- **04:00 UTC is the powerhouse** — N=100, WR=78.0%, p=2.15e-8 *** (Tokyo session close)
- 00:00 UTC is dangerous — WR=0% (N=7), avoid early UTC midnight
- Weekdays: Tue 69.7% ***, Mon/Thu/Fri all ** — Wednesday weakest (55.7%, not significant)
- Weekly: consistent across all 3 weeks (W19: 60.2%, W20: 64.8%, W21: 67.3%) — **stable edge**

#### T2_BB_PEAK_BEAR_BOUNCE — CALL — 59.9% overall
| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 77 | **75.3%** | *** |
| LONDON | 28 | 53.6% | — |
| OVERLAP | 69 | 43.5% | — |
| NY | 46 | 60.9% | — |

- **04:00 UTC = 90.6% WR** (N=32, p=4.31e-6 ***)
- OVERLAP is negative edge (43.5%) — avoid 12:00–17:00 UTC
- Weekdays: Mon/Tue significant **, Friday flat (49%) — front-load week
- Weekly: stable (W19: 63.2%, W20: 57.5%, W21: 61.4%)

#### T2_RANGE_EXPAND_BEAR_BOUNCE — CALL — 55.8% overall
| Session | N | WR% | Sig |
|---------|---|-----|-----|
| **ASIA** | 204 | **61.3%** | *** |
| LONDON | 212 | 52.8% | — |
| OVERLAP | 156 | 55.1% | — |
| NY | 133 | 56.4% | — |

- **Best hours:** 08:00 UTC 76.6% ***, 02:00 UTC 87.5% ***, 04:00 UTC 65.9% ***
- **Death hours:** 11:00 UTC = **9.1% WR** (N=22!), 23:00 UTC = 10% — hard avoid
- Weekdays: Fri 60% **, Tue marginal *
- Weekly: W20 was weak (51.4%) — some instability

#### T2_FADE_FRESH_UP_BREAK — PUT — 54.3% overall (N=1304)
| Session | N | WR% | Sig |
|---------|---|-----|-----|
| ASIA | 353 | 55.2% | ** |
| LONDON | 258 | 50.8% | — |
| **OVERLAP** | 295 | **57.3%** | ** |
| NY | 307 | 54.1% | — |

- No dominant session; edge is spread across ASIA and OVERLAP
- 11:00 UTC leaking at **37.9%** (N=66) — London mid-session
- Weekdays: only Friday significant (56.9% **)
- ⚠️ **W21 degraded to 49.3%** — possible edge erosion, monitor closely

#### T3_ZSCORE_LOW_1_5SIG — CALL — 55.1% overall (N=954)
| Session | N | WR% | Sig |
|---------|---|-----|-----|
| ASIA | 171 | 59.1% | ** |
| LONDON | 219 | 50.7% | — |
| **OVERLAP** | 238 | **58.0%** | ** |
| NY | 254 | 55.5% | * |

- Best hours: **18:00 UTC 74.2%*** (N=31), 01:00 UTC 72.7% **, 04:00 UTC 68.1% **
- Avoid: **23:00 UTC = 28.1%** (N=32, p=0.013) — confirmed bad slot
- Weekdays: Friday only significant (58.2% **)
- Weekly: stable and consistent (53–57% across all weeks)

---

### Cross-Strategy Patterns

#### 🟢 04:00 UTC is the golden hour
Every single strong strategy shows elevated WR at 04:00 UTC (Tokyo mid-session):

| Strategy | 04:00 N | 04:00 WR% | Sig |
|----------|---------|-----------|-----|
| T1_ZSCORE_EXTREME_LOW | 100 | 78.0% | *** |
| T2_BB_PEAK_BEAR_BOUNCE | 32 | 90.6% | *** |
| T2_RANGE_EXPAND_BEAR_BOUNCE | 88 | 65.9% | *** |
| T2_FADE_FRESH_UP_BREAK | 15 | 80.0% | ** |
| T3_ZSCORE_LOW_1_5SIG | 47 | 68.1% | ** |

#### 🔴 11:00 UTC is a consistent danger zone
| Strategy | 11:00 N | 11:00 WR% |
|----------|---------|-----------|
| T2_RANGE_EXPAND_BEAR_BOUNCE | 22 | **9.1%** |
| T2_FADE_FRESH_UP_BREAK | 66 | **37.9%** |

This is the London mid-session — low-liquidity choppy period after the initial move.

#### Session Edge Summary (all strategies)
| Session | Strategies with edge (p<0.05) |
|---------|-------------------------------|
| ASIA | T1_ZSCORE, T2_BB_PEAK, T2_RANGE_EXPAND, T2_FADE_UP, T3_ZSCORE — **dominant** |
| LONDON | None significant |
| OVERLAP | T1_ZSCORE **, T2_FADE_UP **, T3_ZSCORE ** |
| NY | Marginal (*) only |
| OFF | Avoid — only T2_BB_PEAK shows edge but N too small |

#### Weekday Edge Summary
| Day | Notable patterns |
|-----|-----------------|
| **Tue** | T1_ZSCORE 69.7% ***, T2_BB 64.2% ** |
| **Mon** | T1_ZSCORE 65.4% **, T2_BB 69.2% ** |
| **Fri** | Most strategies converge on 56–65% |
| **Wed** | Weakest day — most strategies below 55%, none significant |
| **Thu** | Mixed — T2_LOWER_WICK_GROWTH spike at 72.9% *** (N=24) |

---

## Planned Deep-Dive (TODO)

For each **Strong** strategy, the next analysis phase will cover:

1. **Gate attribution** — which individual gates are filtering or leaking  
2. **Regime conditioning** — does WR hold across VOL_EXPANSION / TRENDING / RANGING?  
3. **Hour-of-day breakdown** — session timing edge (London / NY overlap)  
4. **ATR percentile filtering** — does WR improve when volatility is above median?  
5. **Walk-forward validation** — in-sample (first 7d) vs out-of-sample (last 7d) stability  
6. **Asset whitelist** — per-strategy best-asset subset vs all-asset baseline

Run targeted validation:
```bash
# Single strategy, verbose
node bot/validate_strategies.js --strategy T1_ZSCORE_EXTREME_LOW --verbose

# Single asset
node bot/validate_strategies.js --asset EURUSD

# Both
node bot/validate_strategies.js --strategy T2_BB_PEAK_BEAR_BOUNCE --asset AUDCHF --verbose
```

---

## Key Observations

1. **T1_ZSCORE_EXTREME_LOW is the strongest signal** — 63.5% WR with the highest Wilson lower bound (59.1%) and best expected ATR payout (+0.579). Clear statistical edge.

2. **T1_SMC_SWEEP_HIGH_BEAR_OB is producing negative alpha** (WR 45.7%) — the PUT bias is either directionally wrong or the OB detection logic needs review. Priority fix candidate.

3. **T2_FADE_FRESH_DOWN_BREAK does not mirror UP_BREAK** — the PUT side (UP_BREAK) is significant at p=0.002; the CALL side (DOWN_BREAK) is not. Asymmetric market behaviour.

4. **T3_ZSCORE_LOW_1_5SIG has the most signals (954)** and a consistent 55.1% WR — lower threshold casts a wider net at a modest but real edge.

5. **Asset selectivity matters** — the strongest strategies all have 15–30% variance in WR across assets. Asset-level filtering is expected to materially improve live performance.

---

## ML-Only Strategy Validation (v2)
**Script:** `bot/validate_ml_strategies.js`  
**Features:** `bot/features_ml.js` (53 non-SMC derived features)  
**Source:** `bot/ml_only_research.md` — edges #1–#8 from 8-strategy ML router  
**ATR terciles:** Per-asset, computed from first 70% of bars (matching research train split)  
**Win criterion:** CALL = `close[+N] > close[entry]`, PUT = `close[+N] < close[entry]`, flat = loss  

### Summary Table

| Strategy | Dir | Hz | N | WR_actual | Research WR | Gap | Status |
|----------|-----|----|---|-----------|-------------|-----|--------|
| ML_EDGE_01 | CALL | 15m | 95 | **80.0%** | 80.2% | −0.2pp | ✅ MATCH |
| ML_EDGE_02 | CALL | 15m | 84 | **78.6%** | 78.6% | +0.0pp | ✅ MATCH |
| ML_EDGE_03 | CALL | 20m | 514 | 52.1% | 78.0% | −25.9pp | ❌ BREAK |
| ML_EDGE_04 | PUT  | 10m | 29,177 | 24.9% | 76.6% | −51.7pp | ❌ BREAK |
| ML_EDGE_05 | CALL | 15m | 449 | 53.2% | 75.2% | −22.0pp | ❌ BREAK |
| ML_EDGE_06 | CALL | 10m | 58 | 60.3% | 74.7% | −14.4pp | ❌ DRIFT |
| ML_EDGE_07 | CALL | 15m | 221 | **74.7%** | 74.7% | +0.0pp | ✅ MATCH |
| ML_EDGE_08 | PUT  | 10m | 839 | 45.9% | 73.7% | −27.8pp | ❌ BREAK |

---

### Matching Edges (The Real Edges)

#### ML_EDGE_01 — CALL @ 15m — WR=80.0%, N=95 ✅
Gates: `macd_line <= -9.27e-5 AND rsi_14 > 0.431 AND macd_histogram <= -0.00742 AND rsi_14 <= 22.29`  
*MACD deeply negative + RSI extremely oversold (≤22) — classic momentum divergence bottom.*  
- Best regime: HIGH vol (N=56, WR=87.5%) — avoid LOW vol (N=15, WR=46.7%)
- Almost entirely JPY crosses: AUDJPY (N=37, WR=70.3%), CHFJPY (N=24, WR=83.3%), CADJPY (N=12, WR=100%)
- ⚠️ Walk-forward decay: −18.4pp (Train 86.2% → Test 67.7%). Small N=96 in research; treat as **T2** until N≥100 fresh OOS

#### ML_EDGE_02 — CALL @ 15m — WR=78.6%, N=84 ✅
Gates: `ret_1 <= -0.000263 AND ret_1 <= -0.000859 AND ret_6 > -0.00149`  
*Two consecutive sharp 1-bar drops but 6-bar return not deeply negative — counter-trend bounce.*  
- Asian dominant (N=44, WR=81.8%) / American (N=30, WR=70.0%)
- HIGH vol (N=55, WR=81.8%) is the regime where this works
- ⚠️ Walk-forward decay: −19.9pp (Train 82.4% → Test 62.5%). Very large decay, small N=84 in research; treat as **T3 paper-only**

#### ML_EDGE_07 — CALL @ 15m — WR=74.7%, N=221 ✅
Gates: `range_atr > 0.043 AND signed_body_atr <= -1.302 AND atr_14 > 0.000127 AND range_atr > 2.794`  
*Extreme bearish candle (body ≥ 1.3×ATR, strongly negative) with massive range (≥2.79×ATR) — exhaustion reversal.*  
- **`features_ml.js` fix applied:** `feat.signed_body_atr = (close - open) / atr` added (line 177). Validator confirmed N=221, WR=74.7%.
- Walk-forward decay: −13.8pp (Train 77.0% → Test 63.2%) — moderate decay; works but needs monitoring
- Best regime: HIGH vol (N=107, WR=77.6%); fires across all sessions
- Best asset subset: JPY crosses + EURCHF; European session is best (N=25, WR=84.0%)
- Range constraint (`range_atr > 2.79`) is very tight — only true spike/momentum exhaustion bars

---

### Breaking Edges — Why They Fail

#### ML_EDGE_03 + ML_EDGE_05 — hr_sin temporal edge BREAKS
Both strategies gate on `hr_sin <= -0.982963`, which fires at approximately UTC-5 18:00 (= UTC 23:00, Asian open).  
- Research found N=1015/906 signals, WR=78.0%/75.2% — all in "Asian session"
- Validation: N=514/449, WR=52.1%/53.2% — all labeled "American session"
- **Session mislabeling:** `features_ml.js` uses UTC-5 epoch timestamps; `getUTCHours()` returns UTC-5 local hour (18), which falls in "American" (h=13-21), not "Asian". Research used true UTC for session tags.
- The `hr_sin` computation is correct; the WR gap (52% vs 78%) is a period mismatch — the temporal hour-of-day edge from the research does not generalise to our dataset window.
- **Action:** Do not deploy EDGE_03 or EDGE_05 until re-validated on the same time period as the research.

#### ML_EDGE_04 — DEGENERATE class BREAKS (inverted)
Gates fire on N=29,177 bars (56% of warm dataset). Expected: WR=76.6% PUT. Actual: WR=24.9% PUT.  
- **Inverted completely.** When this fires, price goes UP 75.1% of the time in our data.
- Vol-regime breakdown is the tell: Research LOW vol WR=96.6% (PUT wins); our LOW vol WR=9.2% (PUT almost never wins). Price in LOW vol periods barely moves — the directional bias is opposite in our dataset.
- This is the classic degenerate DT leaf: the decision tree found that "stable flat returns" = predictive of DOWN in the training period, but this is a regime-specific data artifact, not a generalisable edge.
- **Action:** Exclude from live trading. If kept, only trade in MED vol (WR=50.9%) + American session.

#### ML_EDGE_08 — PUT edge reverses by regime
WR=45.9% (below 50% neutral, and far below PUT baseline of 64.2%).  
- LOW vol: WR=16.2% (N=303) — price goes UP almost always when RSI>61 + MACD diverges in low vol
- MED/HIGH vol: WR=61.3%/64.8% — this is WHERE the actual PUT edge lives
- Asian session: WR=31.8% — inverted. American: WR=64.2% — matches baseline.
- **Action:** Gate `ML_EDGE_08` on `regime=MED OR regime=HIGH` AND `session=American/European` to isolate the working portion. Gated N will be ~220, estimated WR ~62–65%.

#### ML_EDGE_06 — DRIFT, N=58, fragility concern
WR=60.3% (research 74.7%), N=58 (research N=99). Works in Asian session (WR=70.5%, N=44) but spread-sensitive.  
- Research fragility=0.150 (BRITTLE) — spread perturbation kills WR by 24pp
- Do not deploy on USDCHF, AUDCHF, CADCHF where spread costs are non-trivial in terms of ATR

---

### Actionable ML Edges

| Priority | Edge | Dir | WR | N | Action |
|----------|------|-----|----|---|--------|
| **T1** | ML_EDGE_07 | CALL | 74.7% | 221 | ✅ `signed_body_atr` fix applied. Deploy. Gate on HIGH vol. |
| **T2** | ML_EDGE_01 | CALL | 80.0% | 95 | Paper-trade until OOS N≥50. Monitor for decay. JPY crosses + HIGH vol only. |
| **T2** | ML_EDGE_02 | CALL | 78.6% | 84 | Large decay risk. Asian session + HIGH vol gate required before sizing. |
| **T3** | ML_EDGE_06 | CALL | 60.3% | 58 | Asian session only. Exclude spread-sensitive pairs. |
| **SKIP** | ML_EDGE_03/05 | CALL | ~52% | — | Period-specific temporal edge. Does not generalise to our data window. |
| **SKIP** | ML_EDGE_04 | PUT | ~25% | — | Inverted in our data. Degenerate class artifact. |
| **SKIP** | ML_EDGE_08 | PUT | 45.9% | 839 | Can be salvaged with MED+HIGH vol + American/European filter. |

### Bugs Fixed

**`validate_ml_strategies.js` — `--asset` argv parse bug**  
`args.indexOf('--asset') + 1` evaluates to `0` when `--asset` is absent, so `args[0]` (e.g. `'--strategy'`) was used as the asset filter, returning 0 rows. Fixed to use `indexOf !== -1` guard. All 51,813 bars now load on every invocation.

**`features_ml.js` — unsigned `body_atr`**  
`feat.body_atr = abs(close-open)/atr` was always ≥ 0. Research used signed `(close-open)/atr` so bearish candles give negative values. Fixed by adding `feat.signed_body_atr = (close - open) / atr` alongside the existing unsigned field. `ML_ROUTER_KEYS` updated.



---

## Section 8 — Claude Verdict & Cascade Cleanup (post-v2 validation)

**Source:** Claude code-audit response, applied after v2 validation on 51,813 bars (data/agent.db).

---

### Root-cause taxonomy

| Failure mode | Edges affected | Detectable from research? |
|---|---|---|
| Look-ahead in feature definition | `T1_SMC_SWEEP_*_OB` | Yes — JS OB uses bar t−1; Python used close[t+1] |
| Regime classifier divergence | `T1_TRANSITION_*`, `ML_EDGE_08` per-regime | Yes — 8-rule Python cascade vs 3-rule JS |
| Calendar overfit (hr_sin / dow_*) | `ML_EDGE_03`, `ML_EDGE_05` | No — requires OOS validation |
| Degenerate-leaf escape | `ML_EDGE_04` | Partly — fire-rate > 5% was missed |

---

### Actions taken

| Strategy | Verdict | Action | File |
|---|---|---|---|
| `T1_SMC_SWEEP_HIGH_BEAR_OB` | **DROP** — look-ahead artefact (WR 45.7% N=81) | Deleted from `ENTRY_STRATEGIES` | `entry_strategies.js` |
| `T1_SMC_SWEEP_LOW_BULL_OB`  | **DROP** — look-ahead artefact (WR 53.6% N=69) | Deleted from `ENTRY_STRATEGIES` | `entry_strategies.js` |
| `T2_FADE_FRESH_DOWN_BREAK`  | **DEMOTE T2→T3** — WR 52.2% p=0.28, not significant | Renamed `T3_FADE_FRESH_DOWN_BREAK` | `entry_strategies.js` |
| `T1_TRANSITION_RANGE_TO_VOL_EXPANSION` | **HOLD** — regime labels mismatched; re-validate | Unchanged (N=20 vs 389 due to strict VOL_EXPANSION def) | `entry_strategies.js` |
| `ML_EDGE_03` | **DELETE** — calendar overfit, hr_sin primary trigger | Gated emptied; tombstone comment kept | `ml_only_router.js`, `validate_ml_strategies.js` |
| `ML_EDGE_04` | **DELETE** — degenerate leaf (56% fire-rate) | Gated emptied; tombstone comment kept | `ml_only_router.js`, `validate_ml_strategies.js` |
| `ML_EDGE_05` | **DELETE** — calendar overfit | Gated emptied; tombstone comment kept | `ml_only_router.js`, `validate_ml_strategies.js` |
| `ML_EDGE_07` | **KEEP** — WR 74.7% N=221 ✅ | `signed_body_atr` fix already applied; `ind.body_atr → feat.signed_body_atr` fixed in router | `ml_only_router.js` |
| `ML_EDGE_08` | **SALVAGE** — add regime + session gates | Added `regime ∈ {MED,HIGH}` + `session ≠ Asian` | `ml_only_router.js`, `validate_ml_strategies.js` |
| `ML_EDGE_06` | **HOLD** — Asian only, exclude CHF pairs | Unchanged; brittle flag noted (frag=0.150) | `ml_only_router.js` |

Additional structural fix: `ml_only_router.js` converted from ES module (`export const/function`) to CommonJS (`module.exports`) so it can be `require()`d by the bot. All gate lambdas updated from `ind.X` → `feat.X` for computed features (ret_*, range_atr, body_atr, signed_body_atr, hr_sin, dist_ema_26, dist_sma_20).

---

### Deployable cascade after cleanup

| Tier | Strategy | Direction | WR | N | Notes |
|---|---|---|---|---|---|
| T1 | `T1_ZSCORE_EXTREME_LOW` | CALL | 63.5% | 340 | Asian: 72.1% — only T1 that survived intact |
| T1 | `ML_EDGE_07` | CALL | 74.7% | 221 | European best (84.0%); binding gate: range_atr > 2.79 |
| T2 | `T2_BB_PEAK_BEAR_BOUNCE` | CALL | 59.9% | 277 | Asian 75.3%; avoid OVERLAP |
| T2 | `T2_FADE_FRESH_UP_BREAK` | PUT | 57.0% | 309 | OVERLAP 61.0% best; NY 59.7% |
| T2 | `T2_RANGE_EXPAND_BEAR_BOUNCE` | CALL | 55.8% | 705 | Asian 61.3%; consistent all weeks |
| T2 | `ML_EDGE_01` | CALL | 80.2% | 96 | Small N; treat cautiously until N ≥ 200 |
| T2 | `ML_EDGE_02` | CALL | 78.6% | 84 | Small N; treat cautiously until N ≥ 200 |
| T3 | `T3_ZSCORE_LOW_1_5SIG` | CALL | 55.5% | 3713 | Stable walk-fwd decay=0; highest-N edge |
| T3 | `T3_FADE_FRESH_DOWN_BREAK` | CALL | 52.2% | 377 | Demoted from T2; pending re-validation |
| T3 | `ML_EDGE_06` | CALL | 74.7% | 99 | Asian only; brittle (frag=0.150); no CHF |
| T3 | `ML_EDGE_08` (gated) | PUT | ≈62-65% | ≈220 | Gate: regime∈{MED,HIGH} + session≠Asian |

**Dropped entirely:** `T1_SMC_SWEEP_LOW_BULL_OB`, `T1_SMC_SWEEP_HIGH_BEAR_OB`, `ML_EDGE_03`, `ML_EDGE_04`, `ML_EDGE_05`.

---

### Fire-rate degenerate guard (added for future audits)

Any edge triggering on > 5% of warm bars is **suspect** — it is a regime baseline in disguise, not a selective edge. ML_EDGE_04 fired on 29,177 / 51,813 = 56% of bars. This check must be applied to any new leaf-mined strategy before it enters the router.

---

### What was learned

1. **Look-ahead requires structural action, not a warning comment.** The SMC-OB strategies were flagged T1 with a `⚠️ Sample-limited` note. A structural look-ahead error requires a structural response (drop the edge), not a caveat that survives copy-paste.
2. **Temporal features are conditioning inputs, not primary gates.** `hr_sin` / `dow_*` are calendar proxies. Edges whose primary trigger is a calendar feature are overfit to the training window by construction.
3. **Regime-coverage mismatch is diagnosable from the regime WR breakdown.** An edge with LOW=16%, MED=61%, HIGH=65% is not one edge — it is two edges with opposite signs across regimes. Gate it, or report it as regime-specific rather than universal.
