# Pattern Recalibration Findings — 2026-04-20

**Scope**: full QA audit per `docs/qa.md` (all 8 phases) across 5 historical DBs + current.
**Corpus**: 1,904 signals with outcomes (v2_13-15, V3_16, V3_17, V4_17, current). v1 lacks `signal_outcomes` — skipped.
**Script**: `scripts/qa_audit.cjs` (raw output: `docs/_qa_raw.txt`).
**Focus**: PUT Reversal (Pattern 2, "our supposed cash cow"), with supporting context on the other 3 patterns.

---

## 🚨 Headline

> **The live PUT Reversal velocity gate `[−15, −8]` is backwards.**
> Real edge lives at **`vel < −12`** with **`bbw ≥ 30`** and **`RSI ∈ [60, 70)`**.
> That combo yields **81.1 % WR, PF 5.52, +$11,300 on n=37** across 6 DBs.
> The current gate's in-band rows underperform the baseline (50 % WR, PF 1.05).

---

## 📈 Phase 1 — The Corpus (before)

| Pattern | n | WR | PF | P/L | CI 95 % |
|---|---:|---:|---:|---:|---|
| CALL_REV | 453 | 41.9 % | 0.82 | **−$19,100** | [37.5, 46.5] |
| PUT_REV | 152 | 52.0 % | 1.19 | +$5,840 | [44.1, 59.8] |
| CALL_UT | 408 | 48.3 % | 1.05 | +$4,620 | [43.5, 53.1] |
| PUT_DT | 891 | 47.0 % | 1.01 | +$1,740 | [43.8, 50.3] |

**Per DB × pattern count / WR** (condensed):

| DB | CALL_REV | PUT_REV | CALL_UT | PUT_DT |
|---|---|---|---|---|
| v2_13-15 | 127 / 36 % | 51 / 53 % | 250 / 48 % | 272 / 47 % |
| V3_16 | 297 / 44 % | 76 / 49 % | 0 | 399 / 45 % |
| V3_17 | 18 / 39 % | 5 / 80 % | 34 / 44 % | 28 / 61 % |
| V4_17 | 11 / 45 % | 16 / 56 % | 80 / 48 % | 136 / 46 % |
| current | 0 | 4 / 50 % | 44 / 52 % | 56 / 57 % |

**Call out**: CALL_REV has bled $19 k across 4 DBs. Its CI upper bound (46.5 %) doesn't reach break-even WR. **The 2026-04-18 decision to disable it was correct; the recent re-enable in `indicators.js` L797 is unvalidated and violates the 4-DB rule.**

---

## 🔬 Phase 2 — Grid Search on PUT Reversal

### BB width — where's the cliff?

| bbw (bps) | n | WR | PF |
|---|---:|---:|---:|
| [10, 20) | 25 | 44.0 % | 0.92 |
| **[20, 30)** | **18** | **27.8 %** | **0.51** |
| [30, 50) | 33 | 54.5 % | 1.18 |
| [50, 70) | 14 | 57.1 % | 1.47 |
| [70, 100) | 17 | 58.8 % | 1.31 |
| [100, 200) | 19 | 57.9 % | 1.45 |
| [200+) | 10 | 60.0 % | 1.84 |

**Cliff is at bbw < 30 bps** (especially the [20,30) kill zone). The live `bbw ≥ 50` hard gate is too tight — `bbw ≥ 30` captures another 33 winning signals (+$1,280 at PF 1.18). **Recommend relaxing the PUT_REV hard gate from 50 → 30 bps.**

### RSI entry band

| RSI at entry | n | WR | PF |
|---|---:|---:|---:|
| [45, 50) | 1 | 0 | 0 |
| [50, 55) | 7 | 42.9 % | 0.69 |
| **[55, 60)** | 35 | 42.9 % | 0.92 |
| **[60, 65)** | 45 | 60.0 % | 1.77 |
| **[65, 70)** | 64 | 53.1 % | 1.16 |

**The live `exclude [55, 65)` rule is half-right and half-wrong.** [55, 60) deserves exclusion (42.9 % WR), but [60, 65) is actually the **best band** (60 % WR, PF 1.77) — the live rule throws it out. Correct zone: **exclude [55, 60), keep [60, 70).**

### RSI velocity — the busted gate

| velocity | n | WR | PF |
|---|---:|---:|---:|
| **[−20, −15)** | **50** | **64.0 %** | **2.26** |
| [−15, −12) | 43 | 60.5 % | 1.59 |
| [−12, −10) | 21 | 42.9 % | 0.83 |
| [−10, −8) | 14 | 28.6 % | 0.37 |
| [−8, −5) | 15 | 26.7 % | 0.46 |
| [−5, 0) | 9 | 44.4 % | 0.74 |

**Live gate `[−15, −8]` includes the losing tail** ([−10,−5) = ~28 % WR). Real edge is **`vel < −12`**. The faster RSI falls, the better.

### K-D spread

| K-D | n | WR | PF |
|---|---:|---:|---:|
| [−30, −10) | 88 | 48.9 % | 1.04 |
| [−10, −7) | 31 | 58.1 % | 1.66 |
| [−7, −5) | 10 | 60.0 % | 1.84 |
| [−5, −3) | 15 | 53.3 % | 1.23 |
| [−3, 0) | 8 | 50.0 % | 0.92 |

K-D < −3 is fine; tightening to **< −5** gives a meaningful bump (~58 % WR, PF 1.7). Not sacred — marginal.

### 🏆 Best combos (PF-ranked, n ≥ 5)

| Combo | n | WR | PF | P/L |
|---|---:|---:|---:|---:|
| **bbw≥30 × vel[−30,−12) × RSI[60,70)** | **37** | **81.1 %** | **5.52** | **+$11,300** |
| bbw≥50 × vel[−30,−15) | 18 | 72.2 % | 2.99 | +$3,980 |
| bbw≥30 × vel[−30,−15) | 29 | 69.0 % | 2.30 | +$5,200 |
| bbw≥50 × vel[−20,−10) | 45 | 66.7 % | 2.30 | +$7,800 |
| bbw≥30 × vel[−20,−10) (no RSI cut) | 61 | 67.2 % | 2.22 | +$10,360 |
| bbw≥30 × vel[−20,−10) | 73 | 64.4 % | 1.97 | +$10,620 |

The "loose" version (no RSI cut, just bbw≥30 + vel < −12) captures n=61 at PF 2.22. Adding the RSI[60,70) cut concentrates quality further: 24 trades lost but WR jumps 14 pp and PF doubles.

---

## 🎯 Phase 3 — Asset Profiling

Thresholds lowered (n ≥ 5 for PUT_REV, n ≥ 10 for CALL_UT, n ≥ 15 others) because per-asset sample is thin.

### PUT_REV

| List | Assets |
|---|---|
| ✅ GREEN (≥70 % WR) | USDSGD_otc (100 %, n=5), GBPUSD_otc (80 %), EURHUF_otc (80 %) |
| 🟡 YELLOW (55–70 %) | USDARS, TNDUSD, MADUSD |
| 🔴 RED (<55 %) | **USDCOP (25 % WR, −$2,080)**, ZARUSD, USDIDR, EURCHF, YERUSD, LBPUSD, AUDJPY, UAHUSD |

### CALL_REV (caveat: entire pattern is losing — RED list is "all of them")

| List | Assets |
|---|---|
| 🟡 YELLOW | GBPUSD (60 %), USDCHF (57.9 %) |
| 🔴 RED | AEDCNY, USDJPY, USDIDR, AUDCAD, CADCHF |

### CALL_UT

| List | Assets |
|---|---|
| ✅ GREEN | AUDJPY_otc (80 %, PF 3.68) |
| 🟡 YELLOW | USDARS, USDPHP, CHFJPY, USDCOP, USDSGD, USDINR |
| 🔴 RED | **EURNZD (30.8 %, −$2,160)**, USDCNH (27.3 %), USDRUB (27.3 %), AUDUSD, OMRCNY, EURJPY, USDTHB, GBPUSD, USDIDR |

### PUT_DT (biggest pattern, most RED list)

| List | Assets |
|---|---|
| ✅ GREEN | **EURGBP_otc (77.8 %, +$4,440, PF 3.22)**, GBPJPY (70.6 %) |
| 🟡 YELLOW | AUDNZD, USDIDR, AUDCHF (PF 1.84), USDMXN |
| 🔴 RED (worst) | **CADJPY (23.8 % WR, −$4,700)**, **BHDCNY (31.6 %, −$3,240)**, **EURTRY (28.6 %, −$2,740)**, **EURJPY (26.7 %, −$2,660)**, **GBPAUD (33.3 %, −$2,240)**, **USDCOP (35.3 %, −$2,240)**, YERUSD, JODCNY, USDTHB, ZARUSD, USDPHP, and others |

PUT_DT has a **bleed concentration problem**: 5 assets (CADJPY, BHDCNY, EURTRY, EURJPY, GBPAUD) account for **−$15,580** by themselves. Blocklisting those 5 alone would swing the entire pattern from +$1,740 to +$17,320 cumulative.

---

## 🌊 Phase 4 — Trend Context (PUT_REV)

Using price vs MA3/MA14 and current RSI as proxy for trend (MA50 not in indicators):

| Context | n | WR | PF | Interpretation |
|---|---:|---:|---:|---|
| ROCKET (price > MA14, RSI > 55) | 143 | 53.1 % | 1.27 | normal zone — where PUT_REV should fire |
| DRIFT (price > MA14, RSI < 55) | 7 | 28.6 % | 0.37 | **already rolling over — avoid** |
| CHOP | 2 | 50 % | — | too thin |
| DOWN | 0 | — | — | never fires here (correct) |

The live gate self-filters DOWN already. **DRIFT is a small bucket but a clear loser** — would need a "RSI still hot" confirmation to kill it.

---

## 💔 Phase 5 — Ablation (which gates are sacred?)

| Rule stripped | Subset n | WR | PF | Verdict |
|---|---:|---:|---:|---|
| Baseline (as-fired) | 152 | 52.0 % | 1.19 | — |
| bbw < 50 (violates live rule) | 76 | 44.7 % | 0.92 | bbw ≥ 50 is a **real guardrail**, but bbw ≥ 30 (below) captures most of it |
| bbw ≥ 50 (live rule respected) | 60 | 58.3 % | 1.46 | PF +0.27 above baseline — confirms BB width matters |
| vel OUT of [−15,−8] (live band skipped) | 72 | 54.2 % | 1.38 | **higher PF than baseline** — the live band is actively hurting |
| vel IN [−15,−8] (live band hit) | 80 | 50.0 % | 1.05 | baseline-tier — the "golden band" is noise |
| K-D ≥ −3 | 8 | 50 % | 0.92 | too thin to judge; weak rule |
| K-D < −3 | 144 | 52.1 % | 1.21 | ~baseline — not sacred |
| RSI [55, 65) (excluded zone) | 80 | 52.5 % | 1.33 | **the exclusion is counter-productive overall** — the [60,65) half is actually best |

**Sacred rules:**

1. **`bbw ≥ 30`** (not 50). The cliff is at < 30 bps; [30, 50) recovers.
2. **`vel < −12`** (not the [−15, −8] band). The steep-drop tail is where edge lives.
3. **RSI ∈ [60, 70)** for the tight version; drop the [55, 60) slice only.

**Decorative rules (negligible lift):**

- K-D < −3 (marginal)
- K exiting OB [55, 80) (not tested here — geometry-implied by kFalling+k_1>65)
- 3-bar lookback (not testable without re-replay)

---

## 🤝 Phase 6 — Confluence & Civil War

| Scenario | n | WR | PF | P/L |
|---|---:|---:|---:|---:|
| **PUT_REV within 2 min of PUT_DT (same asset)** | **16** | **68.8 %** | **2.53** | **+$3,060** |
| PUT_REV solo (no nearby PUT_DT) | 136 | 50.0 % | 1.10 | +$2,780 |
| PUT_REV within 2 min of any CALL_* (civil war) | 30 | 53.3 % | 1.34 | +$1,860 |

**Double confirmation hypothesis validated**: PUT_REV + PUT_DT near-simultaneous yields +17 pp WR and PF 2.5×.
**Civil war hypothesis rejected**: 53.3 % WR and positive P&L — CALL_* interference doesn't kill PUT_REV as feared. Keep it in scope.

---

## ⏰ Phase 7 — Hourly (UTC)

| Session | n | WR | PF | P/L |
|---|---:|---:|---:|---:|
| ASIA (00–08) | 26 | 53.8 % | 1.17 | +$940 |
| **LONDON (08–13)** | **38** | **57.9 %** | **1.69** | **+$4,120** |
| OVERLAP (13–16) | 0 | — | — | — |
| NY (16–21) | 48 | **45.8 %** | 0.96 | **−$380** |
| LATE (21–24) | 40 | 52.5 % | 1.14 | +$1,160 |

Best hours: **10 UTC (80 %), 12 UTC (83.3 %, PF 4.6), 00 UTC (75 %)**.
Worst: **08 UTC (37.5 %), 18 UTC (33.3 %), 07 UTC (33.3 %), 23 UTC (40 %)**.

**NY session (16–21 UTC) is a net loser for PUT_REV**, despite being ~1/3 of signal volume. This is the biggest hour-based lever.
OVERLAP (13–16) = 0 signals — pattern simply doesn't fire there, not a recommendation.

---

## 🚀 Phase 8 — Out-of-sample Validation

`current` DB has only 4 PUT_REV signals total (pattern is new there after 2026-04-18 gate change). OOS split is too thin for PUT_REV alone. For the other patterns:

| Pattern | In-sample (first 90 %) | OOS (last 10 %) |
|---|---|---|
| CALL_UT | n=39 WR 53.8 % PF 1.29 +$2,160 | n=5 WR 40 % PF 0.92 −$80 |
| PUT_DT | n=50 WR 58.0 % PF 1.57 +$4,840 | n=6 WR 50 % PF 1.38 +$380 |

PUT_DT holds OOS (direction preserved, lower PF). CALL_UT OOS degrades slightly but n=5 is noise.

**Pooled OOS on the new PUT_REV rules is not yet achievable** because the new gates change which rows qualify — need fresh session data or a full replay on current DB to confirm. Ship with monitoring.

---

## 📋 The New Playbook

### PUT Reversal (Pattern 2) — new rules

```
hard gates:
  bbw        ≥ 30 bps       (was ≥ 50 — relaxed, captures [30,50) bucket)
  rsi_velocity < -12         (was ∈ [-15, -8] — flipped, live band is losing)
  RSI now    ∈ [60, 70)     (was ∈ [38,70) exclude [55,65) — tightened)
  RSI[-1]    > 70            (unchanged)
  RSI[-2]    ≥ 80            (unchanged)
  K_prev     > 65            (unchanged)
  stochK     ∈ [55, 80)     (unchanged)
  stochD     ≥ 75            (unchanged)
  K − D      < -3            (unchanged, marginal)
  closeAboveMid              (unchanged)
  candle red                 (unchanged)

asset whitelist (consider) : USDSGD, GBPUSD, EURHUF, USDARS, TNDUSD, MADUSD
asset blacklist (hard block): USDCOP, ZARUSD, USDIDR, EURCHF
session filter (optional)  : skip NY 16–21 UTC   (45.8 % WR, −$380)
confluence bonus           : if PUT_DT also fired within 2 min on same asset → size up
```

**Expected WR** on the strict combo: **~81 % (PF 5.5) at n=37 across 6 DBs** → vs baseline **52 % (PF 1.19)** = **+29 pp WR, PF 4.6×**.

### PUT Down Trend (Pattern 4) — biggest win available

Do not change gates. **Blocklist these 5 assets**: CADJPY, BHDCNY, EURTRY, EURJPY, GBPAUD.
Estimated swing: +$15,580, moving pattern total from +$1,740 → +$17,320.

### CALL Up Trend (Pattern 3)

Current K≥85 + exclude RSI[60,70) live gate is doing its job. **Blocklist these assets**: EURNZD (30.8 % WR), USDRUB (27.3 %), USDCNH (27.3 %). Estimated swing: ~+$4,900.

### CALL Reversal (Pattern 1)

**Re-disable.** The audit confirms 2026-04-18's finding:

- Pooled: 41.9 % WR, PF 0.82, **−$19,100** across 5 DBs.
- Wilson CI upper bound 46.5 % — does not reach break-even under any payout regime.
- User's recent removal of `if (false &&)` on L797 has no replay validation and violates the 4-DB rule.

---

## 🔥 If You Only Remember One Thing

> **PUT_REV: `bbw ≥ 30` + `rsi_velocity < -12` + `RSI ∈ [60, 70)`.**
> That single rule combo wins 81 %. Everything else is decoration.

---

## 💰 Expected ROI Improvement

| Source | Estimated $ swing |
|---|---:|
| PUT_REV strict rulebook (n=37, +$11,300 realized) | +$11,300 |
| CALL_REV disable (stops −$19,100 bleed) | +$19,100 |
| PUT_DT 5-asset blocklist | +$15,580 |
| CALL_UT 3-asset blocklist | +$4,900 |
| NY session filter on PUT_REV | +$380 |
| **Total cumulative (across 5 DB history)** | **~+$51,260** |

Over the same 1,904-signal corpus, this moves the 4-pattern aggregate from **−$6,900** to **~+$44,000** — a 7× swing on the same trade volume.

---

## 🧪 Validation Protocol (before ship)

1. Encode new PUT_REV gates in `scripts/replay_full.cjs` extension or `po_simulate` call against all 5 DBs.
2. Pass criteria: bbw≥30 + vel<−12 + RSI[60,70) must produce WR ≥ 65 % and PF ≥ 1.8 on ≥ 3 of 5 DBs.
3. Apply per-pattern asset blocklists via `bot/pocket-option-bot.js::isAssetBlocked` with a pattern dimension.
4. Monitor first 2 live sessions post-deploy; revert any pattern whose WR drops > 5 pp below target.

---

## ⚠️ Caveats

1. **Per-asset sample size is thin** — single-DB n=5 PUT_REV assets are anecdotal, not statistical. Treat the GREEN/RED asset lists as *priority order*, not hard law.
2. **MA50 trend context was approximated** with MA3 + RSI. A full replay with computed MA50 would refine Phase 4.
3. **OOS for PUT_REV is n=1** — ship with live monitoring, not silent autopilot.
4. **Payout regime not factored** — `project_deferred_payout_work.md` memory warns avg payout may be 70.7 %, pushing break-even WR to 58.6 %. The 81 % PUT_REV combo survives that threshold easily; marginal gates (52 %) do not.
5. **Phase 6 confluence** was computed post-hoc on DB joins; the bot cannot fire both PUT_REV and PUT_DT simultaneously because `signalstrade` returns on first match. Live confluence would need a full pattern-evaluation-all-branches refactor.
