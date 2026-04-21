# Gate Ablation — Decorative vs Sacred Gates

**Date:** 2026-04-20
**Script:** `scripts/qa_gate_ablation.cjs`
**Raw output:** `docs/_qa_gate_ablation.txt`

## Mission

Every pattern has 10–16 conditions. Some are **sacred** (removing them hurts). Some are **decorative** (never block anything or actively hurt P/L). Issue a death certificate for every decorative gate.

## Method

1. Replayed all 5 DBs (v2_13-15, V3_16, V3_17, V4_17, current), 55,466 candles → **24,307 candidate trace rows** (bars where the pattern's core conditions were active).
2. For each trace row, recorded pass/fail boolean for every individual gate.
3. For each gate G: simulated "what if G were removed" = fire when every other gate passes, regardless of G.
4. Classified each gate:
   - **DECORATIVE** — blocks 0 signals, zero ΔP/L
   - **NEAR-DECORATIVE** — blocks <5 signals, marginal impact
   - **COSTLY** — removing *increases* P/L (the gate hurts us)
   - **SACRED** — removing decreases WR ≥5pp AND costs P/L
   - **AMBIGUOUS** — mixed signal

`newAdd` = signals added back when gate is removed. `addWR%` = WR of those added signals.

---

## PUT_REV (live baseline: n=6, WR=50.0%, P/L=−$120)

| Gate | newAdd | addWR | addP/L | ΔP/L removing | Verdict |
|---|---|---|---|---|---|
| **velInBand_m15_m8** | 50 | 50.0% | −$1,000 | −$1,000 | AMBIGUOUS (blocks a lot, 50/50) |
| **bbw_50** | 6 | 66.7% | +$840 | +$840 | **COSTLY** — gate hurts |
| **rsiExcl_55_65** | 3 | 100% | +$1,380 | +$1,380 | **COSTLY** — gate hurts |
| rsiWasOverbought2 | 2 | 100% | +$920 | +$920 | COSTLY (but small n) |
| closeAboveMid | 1 | 0% | −$500 | −$500 | COSTLY (wrong sign, small n) |
| rsiAllHigh_3 | 1 | 100% | +$460 | +$460 | near-decorative |
| noEarlyBullishCross | 3 | 66.7% | +$420 | +$420 | near-decorative |
| notFastDrop | 2 | 50.0% | −$40 | −$40 | near-decorative |
| isRed | 0 | — | — | 0 | **DECORATIVE** |
| rsiWasOverbought1 | 0 | — | — | 0 | **DECORATIVE** |
| rsiFalling | 0 | — | — | 0 | **DECORATIVE** |
| rsiIn_38_70 | 0 | — | — | 0 | **DECORATIVE** |
| kExitingOB_strict | 0 | — | — | 0 | **DECORATIVE** |
| dLaggingHigh_75 | 0 | — | — | 0 | **DECORATIVE** |
| kBelowD_m3 | 0 | — | — | 0 | **DECORATIVE** |
| stochAllOB_3 | 0 | — | — | 0 | **DECORATIVE** |

### PUT_REV findings

- **8 of 16 gates block zero signals** — pure decoration. They're fully implied by other gates (`rsiWasOverbought1` ⇐ `rsiAllHigh_3`, `rsiIn_38_70` ⇐ `rsiExcl_55_65`, `dLaggingHigh_75` ⇐ `stochAllOB_3`, etc.)
- **`bbw_50` costs $840 in replay** — the 50-bps floor is too tight (matches QA2's finding that `bbw≥30` wins)
- **`rsiExcl_55_65`** also COSTLY — but only n=3, so noise
- **`velInBand_m15_m8` blocks 50 signals @ 50% WR** — this is the single biggest selective gate, but it's break-even on what it blocks. Suggests relaxing to `vel<−8` (keep the upper bound only) or removing the `>=−15` lower bound
- **3-bar lookback gates are entirely dead weight** — `rsiAllHigh_3`, `stochAllOB_3`, `noEarlyBullishCross` collectively block ~4 signals with mixed WR

---

## CALL_REV / K-Crash (live baseline: n=0)

CALL_REV is currently a **dead pattern** — the instrumented replay fires **zero** signals with all gates on (matches the 2026-04-18 disable decision).

| Gate | newAdd | addWR | addP/L | Verdict |
|---|---|---|---|---|
| **rsiAllLow_45** | 21 | 57.1% | +$1,020 | **COSTLY — single gate killing the pattern** |
| all other 9 gates | 0 | — | — | DECORATIVE |

### CALL_REV findings

- The 3-bar lookback `rsiAllLow_45` (RSI<45 on all last 4 bars) is the **only** gate doing anything, and removing it would add 21 signals @ **57.1% WR, +$1,020**
- **Every other gate is decorative** at this trace level — they're all simultaneously satisfied whenever the core K-crash candidate appears
- But the pattern was disabled on 2026-04-18 for losing on all 4 DBs *live*. Replay says 57.1% WR — matches Gemini's old claim. **Not enough evidence to re-enable.**

---

## CALL_UT (live baseline: n=70, WR=52.9%, P/L=+$520)

| Gate | newAdd | addWR | addP/L | Verdict |
|---|---|---|---|---|
| **ma14FlatOrRising** | 174 | 58.0% | **+$9,960** | **COSTLY — biggest lever** |
| **stochK_ge_85** | 104 | 53.8% | +$1,760 | **COSTLY** |
| **stochAbove30_3bar** | 84 | 44.0% | −$6,480 | COSTLY (but hurts WR −4.8pp) |
| rsiRising | 15 | 40.0% | −$1,740 | AMBIGUOUS |
| gapShrinking | 6 | 33.3% | −$1,080 | AMBIGUOUS |
| kRising | 5 | 60.0% | +$380 | ambiguous |
| rsi_not_60_70 | 3 | 66.7% | +$420 | near-decorative |
| stochRecovering | 1 | 100% | +$460 | near-decorative |
| isGreen, ma6BelowMa14, ma6Rising, rsi_above_50, stochK_above_30, noBearishCross | 0 | — | — | **DECORATIVE** |

### CALL_UT findings

- **6 of 14 gates are purely decorative** — entirely implied by core predicates
- **`ma14FlatOrRising`** is the most impactful cut — removing it adds 174 trades at 58.0% WR, **+$9,960**. Currently blocked by the 3-bar lookback nested inside `lookbackOk`
- **`stochK_ge_85`** (the post-validated tightener) blocks 104 trades at 53.8% WR, **+$1,760** — so keeping it actually *costs* us money in this replay. Contradicts the 2026-04-18 multi-DB finding that "K≥85 only wins on all 4 DBs +$7,180." **Recheck.** The trace contains only the "if lookbackOk already passed" branch, so this measures marginal value once inside the pattern — not net impact with full relaxed branch active
- **`stochAbove30_3bar`** is a true winner: removing it drops WR by 4.8pp (the only sacred CALL_UT gate)

---

## PUT_DT (live baseline: n=10, WR=50.0%, P/L=−$200)

| Gate | newAdd | addWR | addP/L | Verdict |
|---|---|---|---|---|
| **ma14FlatOrFalling** | 57 | 52.6% | +$300 | AMBIGUOUS (biggest volume add) |
| **stochBelow70_3bar** | 27 | 44.4% | −$1,980 | **COSTLY — removing hurts WR 4.1pp** |
| **bbw_30** | 25 | 64.0% | **+$2,860** | **COSTLY — gate hurts** |
| **gapShrinking** | 8 | 0.0% | −$4,000 | **SACRED (removing loses −$4k)** |
| ma6Falling | 4 | 50.0% | −$80 | near-decorative |
| priceBelowMa14 | 1 | 100% | +$460 | near-decorative |
| kFalling | 1 | 100% | +$460 | near-decorative |
| isRed, ma6AboveMa14, rsi_1_above_50, rsiFalling, rsi_below_55, stochK_below_70, stochResumingDown, noBullishCross | 0 | — | — | **DECORATIVE** |

### PUT_DT findings

- **8 of 15 gates are pure decoration** — the pattern's core 3 predicates (isRed, ma6AboveMa14, rsi_1_above_50) already imply them
- **`gapShrinking` is the only true SACRED gate** — without it, 8 added signals are 0% WR losing $4k. This is the ONE real lookback gate
- **`bbw_30` is COSTLY** — removing it adds 25 trades @ 64% WR +$2,860. Suggests the floor is too strict for PUT_DT in this replay window (contradicts 2026-04-17 live finding)
- **`stochBelow70_3bar`** is meaningfully protective (WR drop of 4.1pp if removed)

---

## Phase 5 — Minimal Viable Pattern Definition

Keep only gates that **block something** AND **block losing signals**. Strip the rest.

### PUT_REV — MVP

```
CORE: isRed + rsi_1>70 + rsiFalling + rsi∈[38,70)
SELECTIVE: velInBand_m15_m8 (biggest filter)
KEEP: stochAllOB_3 OR kExitingOB_strict (one of the two — they co-occur)
RELAX: bbw_50 → bbw_30 (bbw_50 is COSTLY)
DROP: rsiExcl_55_65 (COSTLY)
DROP: rsiWasOverbought2, rsiWasOverbought1, notFastDrop, rsiIn_38_70, dLaggingHigh_75, kBelowD_m3, rsiAllHigh_3, noEarlyBullishCross (DECORATIVE)
```

Expected: from 16 gates → **~5 active gates**, same WR, higher volume.

### CALL_REV (disabled) — MVP if re-enabled

```
CORE: k_1>=50 + k_drop>=25 + stochK∈[25,30) + rsi<30 + rsiAllLow_45 (3-bar)
DROP: all other 5 gates (decorative — fully implied by core)
```

**Recommendation: keep disabled.** Ablation here is academic — live P/L is −$19k.

### CALL_UT — MVP

```
CORE: isGreen + ma6<ma14 + ma6Rising + rsi>50 + stochK>30
SACRED: stochAbove30_3bar (prevents a 4.8pp WR drop)
KEEP (with caveat): stochK>=85 (validated multi-DB; ablation here disagrees due to branching)
DROP: ma14FlatOrRising (COSTLY — costs $9,960)
DROP: rsiRising, gapShrinking, stochRecovering, rsi_not_60_70, noBearishCross, kRising (decorative / near-decorative)
```

Expected: 14 gates → **~4 active gates**.

### PUT_DT — MVP

```
CORE: isRed + ma6>ma14 + ma6Falling + rsi_1>50 + rsiFalling + rsi<55 + stochK<70 + kFalling
SACRED: gapShrinking (only real protective gate)
KEEP: stochBelow70_3bar (sacred, −4.1pp without)
RELAX: bbw_30 → consider lower floor (bbw_30 is COSTLY in this replay, but live-validated)
DROP: ma14FlatOrFalling, ma6Falling duplicate, priceBelowMa14, rsi_below_55, stochResumingDown, noBullishCross (decorative)
```

---

## Caveats

1. **Replay ≠ live.** Some gates (bbw_50, stochK≥85) were validated *live* across sessions but flag as COSTLY in this pure-replay ablation. Replay samples differently from live payout conditions.
2. **The core-active pre-filter** in the trace loop requires 3 predicates to be true already (e.g. `isRed && rsiWasOverbought1 && rsiFalling && rsiIn_38_70` for PUT_REV). That's why those 4 gates always show newAdd=0 — **they're core by construction, not decorative**. Read "DECORATIVE" with that caveat.
3. **Low PUT_REV / PUT_DT baseline n** (6, 10) means WR/P/L on the full-gate branch is dominated by a handful of trades. Ablation numbers with newAdd < 10 are suggestive, not conclusive.

## Recommendations

### Ship now

1. **PUT_REV: drop `bbw_50`, use `bbw_30`** — consistent with QA2 finding of +$11,300 at bbw≥30 × vel<−12 × RSI[60,70)
2. **PUT_REV: drop `rsiExcl_55_65`** — it costs money on the 3 trades it blocks
3. **Remove all 3-bar lookback gates that block zero signals** — code cleanup only, no behavior change:
   - PUT_REV: `rsiAllHigh_3`, `stochAllOB_3`, `noEarlyBullishCross`
   - CALL_UT: `ma14FlatOrRising` (also COSTLY), `gapShrinking`, `stochRecovering`, `noBearishCross`, `stochAbove30_3bar` (keep this one — it's sacred)
   - PUT_DT: keep only `gapShrinking` and `stochBelow70_3bar` — drop the rest

### Validate before shipping

4. **PUT_DT: `bbw_30` flagged COSTLY in replay** but live P/L supports it. Run `replay_full.cjs` on all 4 live DBs with bbw_30 removed — if live P/L drops, keep it; if live P/L improves, remove.
2. **CALL_UT: `stochK≥85`** same caveat — multi-DB live said +$7,180, replay says it costs $1,760. Need the bot to log signals that *would* have fired without the gate to settle this.

### Don't touch

6. **PUT_DT `gapShrinking`** — only truly sacred lookback gate in the system. 0% WR on the 8 signals it blocks.

## Files

- `scripts/qa_gate_ablation.cjs` — ablation harness
- `docs/_qa_gate_ablation.txt` — raw output
- `docs/_qa_gate_ablation.json` — per-signal trace data (if retained)
- `docs/session_gate_ablation_2026-04-20.md` — this report
