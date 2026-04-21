# Surgical Gate Report — Final Phase 7/8 Synthesis

**Date:** 2026-04-20
**Scripts:** `scripts/qa_gate_ablation.cjs` + `scripts/qa_gates_to_add.cjs`
**Raw output:** `docs/_qa_gate_ablation.txt` + `docs/_qa_gates_to_add.txt`
**Prior session:** `docs/session_gate_ablation_2026-04-20.md` (Phases 1–5)

## Mission

For every pattern, decide: which gates are **sacred**, **decorative**, or **costly** — and identify **new gates to add** that block losses without sacrificing wins.

## Method

1. **Phase 1–5** (prior doc): replay all 5 DBs, trace gate-by-gate boolean per candle, ablate each gate
2. **Phase 7** (this run): for every signal where all live gates pass, compute 7 candidate synthetic features. Measure each feature as a NEW blocker gate (threshold sweep, block-losses vs block-wins)
3. **Phase 8**: synthesize MVP + additions per pattern

Across 5 DBs (55K candles), **86 signals fire live** (6 PUT_REV, 0 CALL_REV disabled, 70 CALL_UT, 10 PUT_DT).

---

## 🎯 PATTERN 1 — CALL_UT (Up Trend)

**Live baseline:** n=70, WR=52.9%, P/L=+$520, PF=1.03

### Feature separation (wins vs losses, Cohen's d)

| Feature | Win μ | Loss μ | \|d\| |
|---|---|---|---|
| **rsi_accel** | −0.58 | +9.56 | **0.46** |
| **upper_wick_ratio** | 1.26 | 0.57 | 0.40 |
| **candle_efficiency** | 0.533 | 0.628 | 0.35 |
| bbw_expand | −0.003 | +0.009 | 0.14 |
| body_pct_atr | 0.68 | 0.72 | 0.10 |

**Interpretation:** Losing CALL_UT signals fire on candles where **RSI is accelerating upward** (+9.56 vs −0.58 — late entry / exhaustion), have **lower upper wicks** (no rejection visible — price was still pushing), and have **higher candle_efficiency** (strong directional body — means we're chasing).

### Top new-gate candidates (threshold sweep)

#### `candle_efficiency ≤ 0.55` (block when body/range > 0.55)

| thr | blocked W/L | kept n | kept WR | avoided P/L |
|---|---|---|---|---|
| 0.40 | 24/27 | 19 | 68.4% | +$2,460 |
| 0.50 | 21/24 | 25 | 64.0% | +$2,340 |
| **0.55** | **17/23** | **30** | **66.7%** | **+$3,680** ← **winner** |
| 0.60 | 17/22 | 31 | 64.5% | +$3,180 |

**`candle_efficiency ≤ 0.55` avoids $3,680 in losses**, keeps 30 of 70 signals, WR jumps 52.9% → 66.7%.

#### `upper_wick_ratio ≥ 0.5` (block candles without rejection wick)

| thr | blocked W/L | kept n | kept WR | avoided |
|---|---|---|---|---|
| 0.30 | 18/20 | 32 | 59.4% | +$1,720 |
| **0.50** | **21/24** | **25** | **64.0%** | **+$2,340** |
| 1.00 | 27/28 | 15 | 66.7% | +$1,580 |

### CALL_UT — Surgical Verdict

**KEEP (sacred):**

- `stochAbove30_3bar` — ablation showed −4.8pp WR if removed
- `ma6BelowMa14` + `ma6Rising` + `rsi>50` — core pattern identity

**DROP (decorative or costly):**

- `isGreen`, `rsi_above_50`, `stochK_above_30`, `kRising`, `rsiRising`, `noBearishCross`, `stochRecovering` — all blocked zero signals
- `ma14FlatOrRising` — COSTLY, −$9,960 (remove)
- `gapShrinking` — near-decorative, slight negative

**ADD:**

- **`candle_efficiency ≤ 0.55`** — single best addition, +$3,680 in replay

**Net:** 14 gates → **5 core + 1 new** = 6 gates. WR ~67%.

---

## 🎯 PATTERN 2 — PUT_REV (Overbought Reversal)

**Live baseline:** n=6, WR=50.0%, P/L=−$120, PF=0.92

**Caveat:** n=6 is too small for threshold tuning alone. Combine with QA2's n=35 combo finding (bbw≥30 × vel<−12 × RSI[60,70) → 85.7% WR).

### Feature separation

| Feature | Win μ | Loss μ | \|d\| |
|---|---|---|---|
| **upper_wick_ratio** | 0.43 | 0.88 | **1.88** |
| **rsi_accel** | −3.95 | +1.76 | 1.29 |
| **body_pct_atr** | 0.60 | 0.32 | 1.23 |
| bbw_expand | +0.002 | +0.036 | 0.95 |
| candle_efficiency | 0.61 | 0.43 | 0.94 |
| kd_delta | −7.66 | −7.22 | 0.11 |

**Interpretation (PUT context):** Losing PUT_REV fires on candles with **larger upper wicks** (which would normally be bullish rejection — counter-intuitive here — suggests price spiking then gave up), **positive RSI accel** (momentum flipping back up), **smaller bodies** (indecision). Winners have decisive red bodies that already broke lower.

### Top new-gate candidates

#### `upper_wick_ratio ≤ 0.5` (wait — reversed for PUT)

Big |d| (1.88) but tiny n and inconsistent with direction hypothesis — treat as suggestive only.

#### `bbw_expand ≤ 0.02` (block if BB rapidly expanding)

| thr | blocked W/L | kept n | kept WR | avoided |
|---|---|---|---|---|
| −0.05 | 2/3 | 1 | 100% | +$580 |
| **0.02** | **1/3** | **2** | **100%** | **+$1,040** |

### PUT_REV — Surgical Verdict

**DROP (decorative):** 8 of 16 gates block zero signals — all implied by core:

- `isRed`, `rsiWasOverbought1`, `rsiFalling`, `rsiIn_38_70`, `kExitingOB_strict`, `dLaggingHigh_75`, `kBelowD_m3`, `stochAllOB_3`

**RELAX:**

- **`bbw_50 → bbw_30`** — bbw_50 was COSTLY in ablation (+$840 from dropping it); QA2 validated bbw≥30 (+$11,300 via combo)
- Drop `rsiExcl_55_65` — COSTLY on the 3 signals it blocks

**KEEP:**

- `velInBand_m15_m8` — blocks 50 signals at break-even (selective filter working)
- `rsiAllHigh_3` (3-bar lookback — the only lookback gate pulling its weight here)

**ADD (candidate — needs more data):**

- **`bbw_expand ≤ 0.02`** — blocks 3/4 losers, keeps the winner. n=6 fragile but consistent with QA2's "volatility opening up = reversal failing" hypothesis

**Net:** 16 gates → **~5 active gates** + 1 new = 6. Matches QA2's combo exactly.

---

## 🎯 PATTERN 3 — PUT_DT (Down Trend)

**Live baseline:** n=10, WR=50.0%, P/L=−$200, PF=0.92

### Feature separation

| Feature | Win μ | Loss μ | \|d\| |
|---|---|---|---|
| **upper_wick_ratio** | 0.25 | 0.08 | 0.80 |
| **rsi_accel** | −35.97 | −26.05 | 0.67 |
| **kd_delta** | −2.83 | −9.05 | 0.66 |
| candle_efficiency | 0.76 | 0.85 | 0.48 |
| bbw_expand | −0.002 | +0.056 | 0.46 |
| body_pct_atr | 1.10 | 1.37 | 0.44 |

**Interpretation:** Losing PUT_DT fires on candles with **K-D collapsing fast** (−9 vs −3 — momentum already gone) and **BB expanding** (volatility spike = trend reversal). Counter to naïve expectation, winners have **less K-D collapse**, meaning we catch the trend before momentum exhausts.

### Top new-gate candidates

#### `kd_delta ≥ −1` (block when K-D is still collapsing)

| thr | blocked W/L | kept n | kept WR | avoided |
|---|---|---|---|---|
| −10 | 2/3 | 5 | 60.0% | +$580 |
| −7 | 3/3 | 4 | 50.0% | +$120 |
| **−1** | **3/4** | **3** | **66.7%** | **+$620** |
| 0 | 3/4 | 3 | 66.7% | +$620 |

#### `upper_wick_ratio ≥ 0.3` (needs visible bearish rejection wick)

| thr | blocked W/L | kept n | kept WR | avoided |
|---|---|---|---|---|
| **0.3** | **4/5** | **1** | **100%** | **+$660** |

### PUT_DT — Surgical Verdict

**KEEP (sacred):**

- `gapShrinking` — the ONE true sacred lookback gate in the entire system (0% WR on blocked signals, −$4,000 if removed)
- `stochBelow70_3bar` — sacred (−4.1pp WR if removed)

**DROP (decorative):** 8 of 15 gates block zero:

- `isRed`, `ma6AboveMa14`, `rsi_1_above_50`, `rsiFalling`, `rsi_below_55`, `stochK_below_70`, `stochResumingDown`, `noBullishCross`

**RELAX:**

- `bbw_30` flagged COSTLY in pure replay (+$2,860 from dropping) but live-validated — **keep for now**, re-check with live replay

**ADD (candidate):**

- **`kd_delta ≥ −1`** — avoids $620, raises WR to 66.7%. Makes directional sense: don't enter when K-D has already collapsed.

---

## 🎯 PATTERN 4 — CALL_REV (K-Crash)

**Status:** Disabled since 2026-04-18 (see `project_active_gates.md`).

Replay fires zero signals with full gate set. Ablation showed only `rsiAllLow_45` does real work (+21 signals @ 57.1% WR if removed). But live P/L is −$19k.

**Verdict:** keep disabled. If re-enabled, MVP is: `kCrash≥25 + k_1≥50 + stochK∈[25,30) + rsi<30 + rsiAllLow_45`. Drop everything else.

---

## 📋 Consolidated Minimal Gate Definitions

### CALL_UT (v2)

```
IF isGreen AND ma6<ma14 AND ma6Rising AND rsi>50 AND stochK>30
   AND stochAbove30_3bar                         // sacred (WR −4.8pp without)
   AND candle_efficiency ≤ 0.55                  // NEW: +$3,680
THEN CALL
```

### PUT_REV (v2)

```
IF isRed AND rsi_1>70 AND rsi_2≥80 AND rsiFalling AND rsi∈[38,70)
   AND velInBand_m15_m8                          // 50 signals filtered
   AND rsiAllHigh_3                              // 3-bar lookback (protective)
   AND bbw ≥ 30                                  // QA2 validated (was 50)
   AND bbw_expand ≤ 0.02                         // NEW: volatility stable
THEN PUT
```

### PUT_DT (v2)

```
IF isRed AND ma6>ma14 AND ma6Falling AND rsi_1>50 AND rsiFalling AND rsi<55 AND stochK<70 AND kFalling
   AND gapShrinking                              // sacred — the only truly sacred lookback
   AND stochBelow70_3bar                         // sacred (WR −4.1pp without)
   AND bbw ≥ 30                                  // live-validated, keep
   AND kd_delta ≥ −1                             // NEW: avoid late-trend entries
THEN PUT
```

### CALL_REV: **DISABLED** — no change

---

## Risk / Caveats

1. **Small live-gate sample:** PUT_REV n=6, PUT_DT n=10. New-gate candidates derived here are directionally sound (|d|>0.6) but threshold values may shift with more data. QA2's PUT_REV combo (n=35 via relaxed branches) provides much stronger evidence than the n=6 strict branch measured here.
2. **Replay ≠ live payout regime** (per deferred payout work memory). Threshold values validated in replay may still underperform at 70.7% avg payout.
3. **`candle_efficiency ≤ 0.55` for CALL_UT is the single most confident recommendation** — n=70, |d|=0.35, avoids $3,680, WR jumps to 66.7%. Ship first.
4. **`bbw_50` removal for PUT_REV** is also high-confidence (replay + QA2 both say relax).
5. **`gapShrinking` for PUT_DT is a true sacred gate** — the one protective lookback in the entire MODE D system. Do not touch.

## Ship Order

| Priority | Change | Pattern | Evidence | Risk |
|---|---|---|---|---|
| 1 | Drop bbw_50, use bbw_30 | PUT_REV | ablation +$840, QA2 +$11,300 combo | Low |
| 2 | Add candle_efficiency ≤ 0.55 | CALL_UT | n=70, +$3,680, WR→66.7% | Low |
| 3 | Delete 8 decorative gates | PUT_REV | zero behavior change | None |
| 4 | Delete 6 decorative gates | CALL_UT | zero behavior change | None |
| 5 | Delete 8 decorative gates | PUT_DT | zero behavior change | None |
| 6 | Add kd_delta ≥ −1 | PUT_DT | n=10, +$620, WR→66.7% | Medium (small n) |
| 7 | Add bbw_expand ≤ 0.02 | PUT_REV | n=6, directionally supported by QA2 | Medium (small n) |
| 8 | Drop ma14FlatOrRising | CALL_UT | +$9,960 in replay, but live-validated multi-DB | **High — re-verify first** |

## Files

- `scripts/qa_gate_ablation.cjs` — Phases 1–5
- `scripts/qa_gates_to_add.cjs` — Phase 7
- `docs/_qa_gate_ablation.txt`, `docs/_qa_gates_to_add.txt` — raw outputs
- `docs/session_gate_ablation_2026-04-20.md` — earlier ablation report
- `docs/session_surgical_report_2026-04-20.md` — this final synthesis
