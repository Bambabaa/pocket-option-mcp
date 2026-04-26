# Threshold Analysis Report — Leaf Strategy Gates
**Generated:** 2026-04-26
**Data source:** `data/paper_reversal_leaves_live_v2.csv` (N=491, 2026-04-25)
**Cross-referenced:** `docs/session_debrief_2026-04-25.md`, `docs/ML_REPORT_LEAF_PATTERN_V2.MD`
**Break-even WR:** 57.0% at live payout (~75%), 52.1% at paper payout (92%)

---

## Overview

Full threshold sweep across 5 key features (ma_trend_bps, bb_width_bps, stoch_kd_diff, schaff_value, hour_utc) plus combined filter stacking. Each feature tested per leaf (L16 CALL, L41 PUT, L65 PUT) and across ALL signals combined.

**Verdict symbols:** ✓ = WR ≥ 57% (profitable at live payout) | ~ = WR 52–57% (marginal) | ✗ = WR < 52% (losing)

---

## 1. ma_trend_bps

MA trend in basis points = `(ma6 - ma14) / ma14 × 10000`. Positive = uptrend, negative = downtrend.

### Band breakdown

| Band | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| < −20 | 42 / 52.4% ~ | — | 23 / 65.2% ✓ | 65 / 56.9% ~ |
| [−20, −10) | 13 / 53.8% ~ | — | 39 / 51.3% ✗ | 52 / 51.9% ✗ |
| [−10, −5) | 25 / 44.0% ✗ | — | 54 / 55.6% ~ | 79 / 51.9% ✗ |
| [−5, 0) | 13 / 46.2% ✗ | 2 / 100% ✓ | 136 / 49.3% ✗ | 151 / 49.7% ✗ |
| [0, 3) | — | 64 / 46.9% ✗ | 4 / 50.0% ✗ | 68 / 47.1% ✗ |
| [3, 5) | — | 19 / 31.6% ✗ | — | 19 / 31.6% ✗ |
| [5, 10) | — | 27 / 37.0% ✗ | — | 27 / 37.0% ✗ |
| [10, 20) | — | 16 / 37.5% ✗ | — | 16 / 37.5% ✗ |
| ≥ 20 | — | 14 / 64.3% ✓ | — | 14 / 64.3% ✓ |

### Threshold sweep (filtered sets)

| Filter | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| Excl [0,10) | 93 / 49.5% ✗ | 32 / 53.1% ~ | 252 / 52.4% ~ | 377 / 51.7% ✗ |
| Excl [3,10) | 93 / 49.5% ✗ | 96 / 49.0% ✗ | 256 / 52.3% ~ | 445 / 51.0% ✗ |
| Only < 0 | 93 / 49.5% ✗ | 2 / 100% ✓ | 252 / 52.4% ~ | 347 / 51.9% ✗ |
| Only < 0 or > 10 | 93 / 49.5% ✗ | 32 / 53.1% ~ | 252 / 52.4% ~ | 377 / 51.7% ✗ |

### Key findings

- **L16 and L65 fire exclusively in downtrend (< 0)** — ma_trend filter has no effect on them
- **L41 fires exclusively in uptrend [0, 20+)** — its dead zone is [3,10) at 31–37% WR
- **L41 ≥ 20** (strong uptrend) shows 64.3% WR but n=14 — too thin for a gate
- **Excluding [0,10) only recovers L41 to 53.1%** — still below live BEP
- **Conclusion:** ma_trend is not a sufficient gate for L41; L41 remains structurally broken regardless of trend filter

---

## 2. bb_width_bps

Bollinger Band width in basis points = `(bb_upper - bb_lower) / bb_middle × 10000`.

### Band breakdown

| Band | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| < 20 | 10 / 30.0% ✗ | 59 / 45.8% ✗ | 102 / 52.9% ~ | 171 / 49.1% ✗ |
| [20, 30) | 13 / 61.5% ✓ | 9 / 44.4% ✗ | 26 / 57.7% ✓ | 48 / 56.3% ~ |
| [30, 40) | 15 / 46.7% ✗ | 13 / 53.8% ~ | 41 / 39.0% ✗ | 69 / 43.5% ✗ |
| [40, 50) | 3 / 66.7% ✓ | 15 / 53.3% ~ | 9 / 55.6% ~ | 27 / 55.6% ~ |
| [50, 60) | 2 / 100% ✓ | 13 / 30.8% ✗ | 11 / 36.4% ✗ | 26 / 38.5% ✗ |
| [60, 80) | 4 / 25.0% ✗ | 12 / 0.0% ✗ | 19 / 52.6% ~ | 35 / 31.4% ✗ |
| [80, 100) | 11 / 45.5% ✗ | 6 / 50.0% ✗ | 19 / 57.9% ✓ | 36 / 52.8% ~ |
| [100, 150) | 15 / 60.0% ✓ | 2 / 100% ✓ | 9 / 66.7% ✓ | 26 / 65.4% ✓ |
| ≥ 150 | 20 / 45.0% ✗ | 13 / 61.5% ✓ | 20 / 65.0% ✓ | 53 / 56.6% ~ |

### Threshold sweep (filtered sets)

| Filter | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| ≥ 50 | 52 / 50.0% ✗ | 46 / 37.0% ✗ | 78 / 56.4% ~ | 176 / 49.4% ✗ |
| ≥ 60 | 50 / 48.0% ✗ | 33 / 39.4% ✗ | 67 / 59.7% ✓ | 150 / 51.3% ✗ |
| **≥ 80** | **46 / 50.0% ✗** | **21 / 61.9% ✓** | **48 / 62.5% ✓** | **115 / 57.4% ✓** |
| **≥ 100** | **35 / 51.4% ✗** | **15 / 66.7% ✓** | **29 / 65.5% ✓** | **79 / 59.5% ✓** |
| Excl [30,60) | 73 / 47.9% ✗ | 101 / 43.6% ✗ | 195 / 55.9% ~ | 369 / 50.9% ✗ |

### Key findings

- **[30,60) bps is the primary dead zone** — ALL 38–44% WR, confirmed by ML V2 report
- **[60,80) is catastrophic for L41** — 0.0% WR on 12 trades
- **`bbW ≥ 80` is the strongest single gate** — ALL 57.4% ✓, L65 62.5% ✓, L41 61.9% ✓
- **`bbW ≥ 100` is even stronger** — ALL 59.5% ✓ but cuts volume to 79 trades/day
- **L16 does not benefit from bbW gates** — WR stays 45–51% across all high-bbW bands; L16 actually wins in low-volatility (< 20 bps in session debrief)
- **Recommended gate:** `bbW ≥ 80` for L41 and L65; L16 exempt or use < 20 bps

---

## 3. stoch_kd_diff

Stochastic K minus D (5,3,3). Each leaf fires in a non-overlapping range by design.

### Band breakdown

| Band | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| < −30 | — | 6 / 0.0% ✗ | — | 6 / 0.0% ✗ |
| [−30, −20) | — | 90 / 47.8% ✗ | — | 90 / 47.8% ✗ |
| [−20, −10) | — | 46 / 43.5% ✗ | — | 46 / 43.5% ✗ |
| [−10, 0) | 48 / 54.2% ~ | — | — | 48 / 54.2% ~ |
| [0, 10) | 45 / 44.4% ✗ | — | — | 45 / 44.4% ✗ |
| [25, 30) | — | — | 172 / 54.1% ~ | 172 / 54.1% ~ |
| [30, 40) | — | — | 61 / 49.2% ✗ | 61 / 49.2% ✗ |

### Threshold sweep (L65 only, relevant range)

| Filter | L65 n/WR |
|---|---|
| ≥ 25 (current gate) | 233 / 52.8% ~ |
| ≥ 28 | 114 / 56.1% ~ |
| ≥ 30 | 61 / 49.2% ✗ |

### Key findings

- **Leaves fire in completely separate kd_diff ranges** — no cross-leaf filtering possible
- **L16** fires in [−10, 10): negative half (54.2% ~) beats positive half (44.4% ✗)
- **L41** fires in negatives — all bands losing, worst at extremes (< −30: 0% WR)
- **L65** fires in positives [25+): bulk is [25,30) at 54.1%. Raising threshold to 28 gives 56.1% on n=114 — marginal improvement, not above BEP
- **Conclusion:** stoch_kd_diff is not a useful post-gate for any leaf on this dataset. The existing entry threshold (24.66 for L65) is near-optimal.

---

## 4. schaff_value

Schaff Trend Cycle (EMA30/55, cycle 8, smooth 4/3). Range 0–100. Known pathological states: NULL (bot restart warmup ~7 bars), PEGGED-0 (≤1), PEGGED-100 (≥99).

### Band breakdown

| Band | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| NULL/empty | 32 / 50.0% ✗ | 0 | 0 | 32 / 50.0% ✗ |
| [0, 5) — incl PEGGED-0 | 32 / 40.6% ✗ | 3 / 33.3% ✗ | 136 / 51.5% ✗ | 171 / 49.1% ✗ |
| [5, 15) | 12 / 66.7% ✓ | 2 / 0.0% ✗ | 41 / 56.1% ~ | 55 / 56.4% ~ |
| [15, 25) | 5 / 40.0% ✗ | 1 / 0.0% ✗ | 24 / 54.2% ~ | 30 / 50.0% ✗ |
| [25, 50) | 6 / 16.7% ✗ | 6 / 50.0% ✗ | 22 / 54.5% ~ | 34 / 47.1% ✗ |
| **[50, 75)** | **4 / 100% ✓** | **5 / 40.0% ✗** | **12 / 58.3% ✓** | **21 / 61.9% ✓** |
| [75, 85) | 1 / 100% ✓ | 8 / 50.0% ✗ | 2 / 50.0% ✗ | 11 / 54.5% ~ |
| **[85, 99) — danger zone** | **1 / 100% ✓** | **57 / 33.3% ✗** | **16 / 43.8% ✗** | **74 / 36.5% ✗** |
| ≥ 99 — PEGGED-100 | — | 60 / 56.7% ~ | 3 / 33.3% ✗ | 63 / 55.6% ~ |

### Threshold sweep (filtered sets)

| Filter | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| < 75 | 59 / 47.5% ✗ | 17 / 35.3% ✗ | 235 / 53.2% ~ | 311 / 51.1% ✗ |
| < 85 | 60 / 48.3% ✗ | 25 / 40.0% ✗ | 237 / 53.2% ~ | 322 / 51.2% ✗ |
| [5, 75) | 27 / 55.6% ~ | 14 / 35.7% ✗ | 99 / 55.6% ~ | 140 / 53.6% ~ |
| **[5, 85)** | **28 / 57.1% ✓** | 22 / 40.9% ✗ | 101 / 55.4% ~ | 151 / 53.6% ~ |
| [25, 75) | 10 / 50.0% ✗ | 11 / 45.5% ✗ | 34 / 55.9% ~ | 55 / 52.7% ~ |
| **[50, 75)** | **4 / 100% ✓** | 5 / 40.0% ✗ | **12 / 58.3% ✓** | **21 / 61.9% ✓** |

### Key findings

- **[0,5) PEGGED-0 is the worst zone** — L16 40.6%, costs −$3,520. Primary drag on L16
- **[85,99) is the universal dead zone** — ALL 36.5% WR, −$11,080. L41 fires 57 trades here at 33.3%
- **[50,75) is the golden zone** — ALL 61.9% ✓ but n=21 only (thin for a gate)
- **`schaffVal ∈ [5,85)` is the practical L16 gate** — 57.1% WR, n=28, turns L16 from losing to marginally profitable
- **schaff has no useful gate for L41** — every range below BEP except PEGGED-100 (56.7%, n=60) which is an artifact
- **L65 is relatively insensitive to schaff** — no range produces strong consistent edge; [5,15) at 56.1% is the best practical band
- **Recommended gate:** `schaff ∈ [5,85)` — excludes PEGGED-0, NULL, and the [85,99) dead zone while keeping PEGGED-100 for L41 (where it is marginally neutral)

---

## 5. hour_utc

UTC hour of signal candle.

### Hour breakdown

| Hour UTC | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| 4 | 8 / 75.0% ✓ | 4 / 50.0% ✗ | 2 / 50.0% ✗ | 14 / 64.3% ✓ |
| 5 | 10 / 70.0% ✓ | 7 / 57.1% ✓ | 16 / 50.0% ✗ | 33 / 57.6% ✓ |
| 6 | 8 / 62.5% ✓ | 16 / 50.0% ✗ | 21 / 42.9% ✗ | 45 / 48.9% ✗ |
| 7 | 11 / 27.3% ✗ | 8 / 37.5% ✗ | 27 / 74.1% ✓ | 46 / 56.5% ~ |
| 8 | 10 / 40.0% ✗ | 18 / 50.0% ✗ | 26 / 50.0% ✗ | 54 / 48.1% ✗ |
| 9 | 1 / 100% ✓ | 14 / 50.0% ✗ | 25 / 44.0% ✗ | 40 / 47.5% ✗ |
| 10 | 9 / 44.4% ✗ | 15 / 33.3% ✗ | 17 / 58.8% ✓ | 41 / 46.3% ✗ |
| 11 | 5 / 40.0% ✗ | 9 / 22.2% ✗ | 18 / 55.6% ~ | 32 / 43.8% ✗ |
| 12 | 6 / 66.7% ✓ | 10 / 30.0% ✗ | 20 / 55.0% ~ | 36 / 50.0% ✗ |
| 13 | 2 / 50.0% ✗ | 12 / 33.3% ✗ | 29 / 48.3% ✗ | 43 / 44.2% ✗ |
| **14** | **9 / 55.6% ~** | **12 / 66.7% ✓** | **28 / 60.7% ✓** | **49 / 61.2% ✓** |
| **15** | **14 / 28.6% ✗** | **17 / 47.1% ✗** | **27 / 37.0% ✗** | **58 / 37.9% ✗** |

### Threshold sweep (filtered sets)

| Filter | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| Excl UTC 15 | 79 / 53.2% ~ | 125 / 44.0% ✗ | 229 / 54.1% ~ | 433 / 51.0% ✗ |
| Excl UTC 11,13,15 | 72 / 54.2% ~ | 104 / 47.1% ✗ | 182 / 54.9% ~ | 358 / 52.5% ~ |
| Excl UTC 10–15 | 48 / 54.2% ~ | 67 / 49.3% ✗ | 117 / 53.0% ~ | 232 / 52.2% ~ |
| Only UTC 4–7 | 37 / 56.8% ~ | 35 / 48.6% ✗ | 66 / 57.6% ✓ | 138 / 55.1% ~ |
| **Only UTC 14** | **9 / 55.6% ~** | **12 / 66.7% ✓** | **28 / 60.7% ✓** | **49 / 61.2% ✓** |

### Key findings

- **UTC 15 is the single worst hour** — ALL 37.9% ✗, every leaf loses, −$7,880. Confirmed by ML V2 (−11.56pp vs baseline)
- **UTC 14 is the only universally profitable hour** — ALL 61.2% ✓, all leaves positive or neutral
- **UTC 11 and 13 are secondary danger zones** — ALL 43–44% WR
- **L16 is strong in early session (UTC 4–6)** — 62–75% WR
- **L65 has a unique UTC 7 spike** — 74.1% WR on 27 trades (worth investigating)
- **No single hour filter (except UTC 15 block) is sufficient alone** — excl UTC 15 only recovers to 51.0% ALL
- **Recommended gate:** Block UTC 15 for all leaves. Consider restricting L65 to UTC 4–5, 7, 10, 14 (profitable hours only)

---

## 6. Combined Filter Stacking

Filters: excl ma_trend [0,10) + excl bbW [30,60) + schaff < 85 + excl UTC 15

| Combo | L16 n/WR | L41 n/WR | L65 n/WR | ALL n/WR |
|---|---|---|---|---|
| All 4 filters | 38 / 52.6% ~ | 4 / 75.0% ✓ | 156 / 60.3% ✓ | **198 / 59.1% ✓** |
| ma + bbW only | 73 / 47.9% ✗ | 27 / 51.9% ✗ | 192 / 56.3% ~ | 292 / 53.8% ~ |
| ma + UTC15 only | 79 / 53.2% ~ | 30 / 50.0% ✗ | 225 / 54.2% ~ | 334 / 53.6% ~ |
| **bbW + UTC15 only** | **60 / 53.3% ~** | 90 / 44.4% ✗ | **176 / 58.0% ✓** | **326 / 53.4% ~** |
| schaff<85 + UTC15 | 51 / 51.0% ✗ | 25 / 40.0% ✗ | 210 / 55.2% ~ | 286 / 53.1% ~ |
| **ma + bbW + UTC15** | **60 / 53.3% ~** | 25 / 48.0% ✗ | **173 / 58.4% ✓** | **258 / 56.2% ~** |

### Key findings

- **All 4 filters: ALL 59.1% WR, n=198, +$13,320** — above live BEP at paper payout
- **L41 essentially disappears under combined filters (n=4)** — validates the disable decision
- **L65 is the volume and profit driver** — 156 trades at 60.3% under full filter stack
- **bbW ≥ 80 + excl UTC15 is the minimum viable stack for L65** — 58% WR on 176 trades
- **L16 remains marginal (52.6%) under all combos** — the pattern needs its own specific gate (schaff [5,85)) not shared feature gates

---

## 7. Recommended Gate Changes (Threshold-Based, Evidence-Only)

All recommendations require minimum n ≥ 15 and WR ≥ 57% for live BEP conviction.

### Tier 1 — High conviction (consistent across all 3 reports)

| Gate | Condition | Applies to | Evidence |
|---|---|---|---|
| **Disable L41** | Remove entire block | L41 | ALL n=142 at 44.4%, no filter recovers it above BEP |
| **Block UTC 15** | `candleHour !== 15` | All leaves | ALL 37.9% WR, −$7,880, −11.56pp per ML V2 |
| **bbW ≥ 80** | `bbWidthBps >= 80` | L41, L65 | ALL 57.4% ✓ at ≥80; L65 62.5% ✓, L41 61.9% ✓ |
| **Excl schaff [85,99)** | `!(schaffVal >= 85 && schaffVal < 99)` | All leaves | ALL 36.5% ✗ in this zone, −$11,080 |

### Tier 2 — Moderate conviction (1-day dataset, needs cross-DB validation)

| Gate | Condition | Applies to | Evidence |
|---|---|---|---|
| **schaff ≥ 5** for L16 | `schaffVal >= 5` | L16 | Cuts PEGGED-0 (40.6% WR), raises L16 to 58.6% |
| **Excl UTC 11, 13** | `![11,13].includes(candleHour)` | All leaves | 43–44% WR in these hours |
| **Excl ma_trend [0,10)** | `!(maTrendBps >= 0 && maTrendBps < 10)` | L41 only | 31–37% WR, but L41 being disabled makes this moot |

### Tier 3 — Investigate further (thin n, not ready for gate)

| Observation | Detail |
|---|---|
| schaff [50,75) golden zone | 61.9% WR ALL but n=21 only — needs more data |
| L65 UTC 7 spike | 74.1% WR on 27 trades — single day artifact or real? |
| bbW ≥ 100 | 59.5% ✓ ALL but cuts to n=79 — aggressive volume reduction |
| stoch_kd_diff ≥ 28 for L65 | 56.1% on n=114 — marginal, not above BEP |

---

## 8. Single-Day Caveat

All findings are from **2026-04-25 only** (N=491). The ML V2 report confirms regime shift from Dataset A (Apr 9–21, N=1,018, WR=58.2%) to Dataset B (Apr 25, WR=49.5%). Key shifts:

| Feature | Dataset A mean | Dataset B mean | Change |
|---|---|---|---|
| bb_width_bps | 59.06 | 51.91 | −7.16 (lower volatility) |
| stoch_kd_diff | 8.21 | 5.83 | −2.37 (weaker momentum) |
| ma_trend_bps | −6.83 | −4.34 | +2.49 (less downtrend) |
| stc_stoch_diff | −8.68 | −0.82 | +7.86 (STC-stoch divergence) |

**Gates derived from this single day should be validated against historical DBs (v2_13-15, V3_16, V3_17) before applying to live bot.** The `bbW ≥ 80` and `excl UTC 15` gates have the highest cross-day generalizability given their magnitude and consistency with the session debrief.

---

*Source files: `data/paper_reversal_leaves_live_v2.csv`, `scripts/threshold_sweep.cjs`, `docs/session_debrief_2026-04-25.md`, `docs/ML_REPORT_LEAF_PATTERN_V2.MD`*
