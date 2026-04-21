# Strategy Improvements — Synthesis of 5 Sessions
**Date:** 2026-04-20
**Source sessions:**
1. `session_qa_2026-04-20.md`          — QA1 outcome-based 8-phase audit
2. `session_qa2_2026-04-20.md`         — QA2 behavioral 9-phase audit
3. `session_asset_signature_2026-04-20.md` — toxic-asset trait hunt
4. `session_gate_ablation_2026-04-20.md`   — decorative vs sacred gates
5. `session_surgical_report_2026-04-20.md` — Phase 7 new-gate hunt

## Purpose

All five sessions attacked different angles of the same question: *how do we make the MODE D strategy more profitable?* This document collapses their conclusions into a single **ship plan**, ranked by evidence strength and risk.

---

## 🎯 Top-line findings (cross-validated across sessions)

| Finding | Sessions supporting | Evidence |
|---|---|---|
| **PUT_REV `bbw≥50` is too tight → use `bbw≥30`** | QA1, QA2, Ablation, Surgical | QA2 combo 85.7% WR +$11,300 at bbw≥30; ablation shows bbw_50 COSTLY +$840; |
| **`candle_efficiency ≤ 0.55` is a high-value CALL_UT loss-blocker** | QA2, Surgical | QA2 Cohen's d=0.60; Surgical n=70 avoids $3,680, WR 52.9%→66.7% |
| **22 gates across 3 patterns block zero signals** (pure decoration) | Ablation, Surgical | Zero-behavior-change code cleanup |
| **`gapShrinking` is the ONE truly sacred lookback gate** (PUT_DT) | Ablation, Surgical | 0% WR on 8 blocked signals, −$4k if removed |
| **K-D spread is a hidden dominant filter** | QA2, Surgical | QA2: fired μ=−11.1 vs almost μ=−3.8; Surgical PUT_DT kd_delta ≥ −1 adds +$620 |
| **Universal asset-quality gate does NOT generalize** | Asset Signature | Pooled d=1.19 but fails 3/5 DBs out-of-sample. **Don't ship.** |
| **CALL_REV stays disabled** | Ablation, Prior live data | Live P/L −$19k on 4 DBs; replay 57.1% WR only after stripping gates |

---

## 📦 Ship Plan — Ranked by Confidence × Impact

### TIER 1 — Ship immediately (multi-session consensus, zero risk)

#### 1. PUT_REV: drop `bbw≥50`, use `bbw≥30`
- **Impact:** +$6,200 vs current filter; enables the QA2 golden combo
- **Code:** `bot/indicators.js:892` — change `if (bbWidthBps < 50) return false;` → `if (bbWidthBps < 30) return false;`
- **Evidence:** QA1 cross-DB replay (+$11,300 at bbw30×vel<−12×RSI[60,70)); ablation confirms bbw_50 COSTLY on its own.

#### 2. PUT_REV: tighten with full QA2 combo
After bbw≥30, add `vel<−12 && RSI∈[60,70)` — **WR 85.7% n=35, +$11,300 replay**
- Currently `velInBand_m15_m8` = `[-15,-8]` is the wrong direction. Replace with `vel<−12` (open-ended lower bound).
- Add RSI entry-band `rsi>=60 && rsi<70` (narrower than current `[38,70)`).

#### 3. CALL_UT: add `candle_efficiency ≤ 0.55`
- **Impact:** n=70 → 30 kept, WR **52.9% → 66.7%**, +$3,680 in replay
- **Code:** inside the CALL_UT post-gate (`bot/indicators.js:948`), add:
  ```js
  const range = lastC[3] - lastC[4];  // high - low
  const body  = Math.abs(lastC[2] - lastC[1]);  // |close - open|
  const candleEfficiency = range > 0 ? body / range : 0;
  if (candleEfficiency > 0.55) return false;
  ```
- **Evidence:** Cohen's d=0.35 on win vs loss (CALL_UT); QA2 ranked it top synthetic feature d=0.60 pooled; Surgical validated threshold sweep.

#### 4. Code cleanup — delete 22 decorative gates (zero behavior change)
Comment-out/delete gates that block zero signals. Pure simplification, no P/L impact:
- **PUT_REV** (8): `isRed`, `rsiWasOverbought1`, `rsiFalling`, `rsiIn_38_70`, `kExitingOB_strict`, `dLaggingHigh_75`, `kBelowD_m3`, `stochAllOB_3`
- **CALL_UT** (6): `isGreen`, `rsi_above_50`, `stochK_above_30`, `kRising`, `rsiRising`, `noBearishCross`
- **PUT_DT** (8): `isRed`, `ma6AboveMa14`, `rsi_1_above_50`, `rsiFalling`, `rsi_below_55`, `stochK_below_70`, `stochResumingDown`, `noBullishCross`

These are implied by remaining core predicates. Removing them cannot change firings by definition.

---

### TIER 2 — Ship after replay confirmation

#### 5. PUT_DT: add `kd_delta ≥ −1`
- Block signals where K-D has already collapsed (momentum exhausted before entry)
- Surgical: n=10 → kept 3 at 66.7% WR, avoided $620
- **Risk:** small sample (n=10). Run live replay across 4 DBs to confirm before merging.

#### 6. PUT_REV: add `bbw_expand ≤ 0.02`
- Block when Bollinger width is rapidly expanding (volatility regime shift = failing reversal)
- QA2 ranked #3 synthetic feature Cohen's d=0.45
- Surgical: small n=6 but consistent with hypothesis
- **Risk:** replay sample size. Confirm under live payout regime.

---

### TIER 3 — High-impact but needs reconciliation

#### 7. CALL_UT: drop `ma14FlatOrRising`
- Ablation: removing adds 174 trades at 58.0% WR, **+$9,960**
- **But** this gate is nested in the lookback branch — possibly still valuable in the relaxed branch
- **Action:** run full `replay_full.cjs` on all 4 DBs with this gate commented out. If per-DB P/L uniformly positive → ship. If mixed → keep.

#### 8. CALL_UT: re-validate `stochK≥85`
- 2026-04-18 multi-DB: +$7,180 (win on all 4 DBs)
- 2026-04-20 ablation (replay): COSTLY, +$1,760 from dropping
- **Contradiction needs resolution** — ablation measured marginal inside lookback branch; live validation saw total net effect. Do not touch until re-measured end-to-end.

---

### REJECTED — Do NOT ship

#### Universal asset-quality gate (range_cov ≤ 0.326, etc.)
- Pooled Cohen's d=1.19 was misleading — driven by V3_16 alone
- Per-DB validation: fails 3 of 5 DBs, hurts PUT_REV by −5.4pp
- **Conclusion:** range_cov is rediscovering the asset blocklist, not a transferable trait
- **Alternative:** ship a *dynamic name-based* blocklist (rolling per-asset WR < 48% over n≥15 → auto-block). Session-monitor already has the infra.

#### Re-enabling CALL_REV
- Live P/L across 4 DBs: −$19,100
- Replay says 57.1% WR *only* after stripping `rsiAllLow_45`, but that gate is also the pattern's signature — stripping it defines a different pattern
- Keep disabled unless regime shift is observed in live data

---

## 📊 Expected Aggregate Impact

Projected from replay numbers. Live impact depends on payout regime (per `project_deferred_payout_work` — 70.7% avg payout may dominate).

| Change | Replay ΔP/L | Notes |
|---|---|---|
| PUT_REV: bbw_30 + QA2 combo | +$11,300 | QA2 validated n=35 |
| CALL_UT: add candle_efficiency ≤ 0.55 | +$3,680 | Surgical n=70 |
| PUT_DT: add kd_delta ≥ −1 | +$620 | Small n |
| PUT_REV: add bbw_expand ≤ 0.02 | +$580–$1,040 | Small n |
| CALL_UT: drop ma14FlatOrRising | +$9,960 (tentative) | Needs reconciliation |
| Code cleanup (22 decorative gates) | $0 | Zero behavior change |
| **Conservative ship (Tier 1 only)** | **+$15,000** | bbw_30 + candle_efficiency + cleanup |
| **Full program (Tier 1+2+3)** | **+$25,000–30,000** | All above, assuming tier-3 reconciliation goes positive |

---

## 🧭 Implementation Order

```
Week 1 (safe, high-confidence):
  1. Drop bbw_50 → bbw_30 in PUT_REV                   (1 line, validated)
  2. Swap velInBand + RSI gates to QA2 combo          (3 lines, validated)
  3. Add candle_efficiency ≤ 0.55 to CALL_UT          (4 lines, n=70)
  4. Delete 22 decorative gates                        (code cleanup, zero risk)

Week 2 (validated adds):
  5. Run replay_full.cjs on 4 DBs for Tier 2 changes  (verify)
  6. Ship PUT_DT kd_delta ≥ −1 if passes             (3 lines)
  7. Ship PUT_REV bbw_expand ≤ 0.02 if passes        (4 lines)

Week 3 (reconciliation):
  8. Investigate ma14FlatOrRising / stochK≥85 split  (instrument live-replay)
  9. Per-DB sign-off → merge or shelve
```

Every Tier 1 change is one-to-four lines. Week 1 is ~20 lines of diff.

---

## 🛡️ Guardrails Preserved

From `feedback_replay_validation.md`: **every change must be profitable on ≥3 of 4 DBs before shipping.** Apply this rule when running Tier 2 and Tier 3 replays.

From `project_deferred_payout_work.md`: avg payout dropped to 70.7%, pushing break-even WR to 58.6%. Any gate change should be cross-referenced against live payout conditions before declaring success.

From `project_active_gates.md`: current live state snapshot — all ship changes land on top of 2026-04-18 commit 95c0402 (K-Crash disabled, CALL_UT=K≥85, PUT_REV bbw≥50).

---

## 📂 Files

- `docs/session_qa_2026-04-20.md`
- `docs/session_qa2_2026-04-20.md`
- `docs/session_asset_signature_2026-04-20.md`
- `docs/session_gate_ablation_2026-04-20.md`
- `docs/session_surgical_report_2026-04-20.md`
- **`docs/session_strategy_improvements_2026-04-20.md`** — this document (consolidated ship plan)
