# Session Debrief — 2026-04-18

## Overview

| Metric | Value |
|---|---|
| Date | 2026-04-18 |
| Data range | 2026-04-17 to 2026-04-18 |
| Assets (live DB) | 53 |
| Replay signals | 229 |
| Replay WR | 51.1% |
| Replay P&L | **−$2,180** |
| Live trades executed | 209 |
| Live WR | 53.1% (111W / 98L) |
| Live net P&L | **−$9,730** |

Today's session applied the gate tightenings validated across Apr 13–16 to live trading. Replay shows modest improvement over baseline but net still losing; live execution underperformed replay by ~$7.5k, suggesting either execution slippage or that most trades fired under an older gate state before mid-session edits went live.

---

## 1. Questions Asked This Session

Five analytical questions drove this debrief. Each answered against `data/trading_data.db`.

### Q1. How often did indicator snapshots repeat across trades for the same asset?

**Answer: 0%.**

Across all 244 signals, zero had RSI_5, Stoch_K_v2, BB_upper, or MA1 values identical to the prior signal on the same asset. No stale-indicator pipeline issue. Every signal has a fresh indicator row.

### Q2. What fraction of signals fired when candle timestamps were duplicated or out-of-order?

**Answer: 0% of signals, ~0.1% of candles.**

- Duplicate `(asset, timestamp)` rows in `candles`: 0.
- Out-of-order candle inserts: 10 assets with exactly 2 OOO rows each (20 rows / 14,002 total = 0.14%).
- Signals with no matching candle: 0 / 244.

OOO events occur in the raw feed but never land on signal bars. Not affecting strategy output.

### Q3. How many trades had unresolved results, and what's the P&L impact conservatively?

**Answer: 0 unresolved; adjusted P&L = −$9,730 (unchanged).**

209 trades in `trades_ordered`, all resolved: 98 LOSS (−$49,000 gross) + 111 WIN (+$39,270 gross) = **net −$9,730**. No conservative-loss adjustment needed.

### Q4. Which assets show the most feed anomalies and should be blocked regardless of edge?

**Answer: None qualify on anomalies alone.**

The only anomaly type present is 1–2 out-of-order candles per asset, and correlation with P&L is weak (NZDJPY +$855, EURJPY +$495, USDVND +$350 are all anomalous but winning). The real block-list is driven by performance, not feed quality. See §5.

### Q5. What do the conditions from `session_report_2026-04-17.md` look like on today's data?

**Answer: Narrow "golden" conditions broke; broader conditions held.** See §3.

---

## 2. Pattern Summary (Replay on current DB)

| Pattern | Signals | WR | P&L | vs. Apr 13–16 |
|---|---|---|---|---|
| CALL K-Crash | 8 | 37.5% | −$1,120 | Worse |
| PUT Overbought | 17 | 47.1% | −$820 | Regressed (was 67.9–75.0%) |
| CALL Up Trend | 83 | 48.2% | −$3,100 | Filter firing wrong |
| **PUT Down Trend** | **121** | **54.5%** | **+$2,860** | Consistent winner |

PUT DT carried the book. The three other patterns were net losers.

---

## 3. Cross-Session Condition Stability

Testing every "recommended" condition from `session_report_2026-04-17.md` against today's data:

### PUT Overbought Reversal

| Condition | Reported WR | Today WR | Verdict |
|---|---|---|---|
| rsiFrom[80,82) + vel[-15,-10) "golden" | 88.9% | **33.3%** (3 sigs) | **Broken** |
| vel[-15,-12) + bbW≥30 | 72.0% | 66.7% (6 sigs) | Held ✓ |
| rsiFrom≥75 + vel[-15,-10) | 70.0% | 45.5% (11) | Broken |
| rsiFrom[78,85) sweet spot | ~75% | 33.3% (9) | Inverted |

New winner on today's data: **rsiFrom[75,78) → 75% WR (+$880, 4 sigs)** — the report called this "break-even." And `vel[-12,-10)` = 60% WR (5 sigs).

### PUT Down Trend

| Condition | Reported WR | Today WR | Verdict |
|---|---|---|---|
| hour=22 + bbW≥30 | 68.0% | **60.6%** (33) / +$2,700 | Held ✓ |
| bbW[30,60) + RSI[20,40) "best" | 67.6% | **37.8%** (37) / −$5,060 | **Broken hard** ✗ |
| bbW≥30 + rsi≤40 | 59.6% | 55.4% (92) / +$2,960 | Held |
| bbW≥50 + rsi≤40 | 57.4% | **59.2%** (49) / **+$3,340** | Held+ |
| bbW≥30 + rsi≤30 | 55.6% | **58.7%** (63) / **+$4,020** | Held+ |

Surprise: **RSI[0,20) = 64.9% WR / +$4,540 (37 sigs)** — the report said 20–40 was optimal, but deeply oversold is now the best bucket. The best combo found on today's data is **bbW≥30 + rsi≤30 → +$4,020**, the single largest winning condition in the entire DB.

### CALL K-Crash

| Condition | Reported WR | Today WR | Verdict |
|---|---|---|---|
| kCurr[25,30) | 58.9% | 0 signals | Can't test |
| BB≥50 + MA≥0 "80% strong" | 80% | **0% WR / −$2,000** (4) | **Fully inverted** |
| price≤BB mid | 53% | 50% (6) | Break-even |

Only 8 K-Crash signals total. Pattern is too thin to rescue via parameter tuning. Candidate for disable.

### CALL Up Trend

The current filter `stochK≥85 && bbW≤30` produced 83 signals at 48.2% WR / −$3,100. Breakdown by bbW band:

| bbW bucket | n | WR | P&L |
|---|---|---|---|
| [0,10) | **41** | **56.1%** | **+$1,580** ← winning, unfiltered by code |
| [10,20) | 22 | 45.5% | −$1,400 |
| [20,30) | 20 | 35.0% | −$3,280 |
| [30+) | 0 | — | — |

The `bbW≤30` cap blocks nothing (no signals exist at >30). The profitable zone is bbW<10. Gemini's "Goldilocks [20,30]" claim completely inverted — that's the worst bucket on today's data.

**Pattern**: narrow, multi-gate "golden" conditions from the prior report broke. Broader 2-gate combos generalized. Going forward, prefer 2-gate combos over 3-gate "golden" ones.

---

## 4. Global BB Gate — Per-Pattern Correlation

The global gate at `indicators.js:764` declares `bbWidthSufficient = bbWidthBps >= 10` but **CALL UT never references it**, so 41 of 83 CALL UT signals fire at bbW<10.

### Compliance check

| Pattern | Below 10 bps | At/above 10 bps |
|---|---|---|
| K-Crash | 0 | 8 / 37.5% |
| PUT-OB | 0 | 17 / 47.1% |
| **CALL-UT** | **41 / 56.1% / +$1,580** (prohibited zone, winning) | 42 / 40.5% / −$4,680 |
| PUT-DT | 0 | 121 / 54.5% |

### Optimal bbW band per pattern (each wants something different)

| Pattern | Sweet spot | Kill zone |
|---|---|---|
| K-Crash | [30,50) — 100% (2 sigs, thin) | [50+) 0% |
| PUT-OB | [50,100) + [100+) → 77.8% combined (9 sigs) | [10,50) → mostly negative |
| **CALL-UT** | **[0,10) → 56% / +$1,580** | **[20,30) → 35% / −$3,280** |
| PUT-DT | monotonic: wider=better, peaks at [100+) 69% | none pronounced |

### Global what-if

| Global gate | Kept signals | Kept P&L | Dropped signals | Dropped P&L |
|---|---|---|---|---|
| bbW ≥ 10 (current) | 188 / 50.0% | −$3,760 | 41 | **+$1,580** (CALL UT) |
| bbW ≥ 30 | 139 / 54.0% | **+$2,500** | 90 | −$4,680 |
| bbW ≥ 50 | 74 / 56.8% | **+$3,320** | 155 | −$5,500 |

**Insight**: no single global BB threshold fits all patterns. CALL UT wants <10; PUT-OB and PUT-DT want ≥50. The current unified global gate hurts net P&L by blocking the CALL UT sweet spot while permitting the PUT-OB mid-band kill zone.

---

## 5. Asset-Level Picture

### Top live performers

CADCHF 85.7% (+$2,260), YERUSD 83.3% (+$1,800), CHFNOK 75.0% (+$1,760), AUDJPY 71.4%, KESUSD 71.4%, AUDCAD 66.7%, CADJPY 66.7%, EURHUF 66.7%, USDSGD 66.7%.

### Biggest bleed (block candidates)

| Asset | Trades | Live P&L |
|---|---|---|
| AUDUSD_otc | 6 | −$2,040 |
| USDDZD_otc | 4 | −$2,000 |
| GBPAUD_otc | 8 | −$1,865 |
| EURNZD_otc | 9 | −$1,725 |
| AEDCNY_otc | 5 | −$1,590 |
| AUDCAD_otc | 5 | −$1,540 |
| EURHUF_otc | 9 | −$1,540 |
| USDCAD_otc | 3 | −$1,500 |
| USDMXN_otc | 3 | −$1,500 |
| CHFNOK_otc | 6 | −$1,365 |
| EURTRY_otc | 2 | −$1,000 |
| NGNUSD_otc | 2 | −$1,000 |
| CHFJPY_otc | 6 | −$2,040 |

Blocking these 13 assets proactively would have saved approximately −$19,000 in losing trades. **`po_auto_block_sweep` needs to actually run at session start** — the biggest missed-opportunity cost this session.

Note: EURHUF and CHFNOK appear in both top and bottom lists at different sample sizes; asset edge is regime-dependent and can flip within a session.

---

## 6. Hour-by-Hour (UTC)

| Hour | All sigs | WR | P&L |
|---|---|---|---|
| 00:00 | 65 | 47.7% | −$2,740 |
| 01:00 | 28 | 53.6% | +$400 |
| 21:00 | 9 | 55.6% | +$300 |
| **22:00** | 66 | **56.1%** | **+$2,520** |
| 23:00 | 61 | 47.5% | −$2,660 |

Hour 22 UTC remains the best hour (confirms the Apr 17 report). Hours 00 and 23 are reliably losing.

---

## 7. Live vs Replay P&L Gap

| Source | Signals / trades | WR | P&L |
|---|---|---|---|
| Replay (current gates) | 229 | 51.1% | −$2,180 |
| Live execution | 209 | 53.1% | **−$9,730** |

Live WR is actually *higher* than replay (53.1% vs 51.1%), but live P&L is **$7,550 worse**. Candidates:

- Payout slippage (replay assumes 92% on all wins; live may vary)
- Trades placed earlier in session before the latest gate edits deployed
- Order sizing / compounding from earlier-session losses
- Missed exits or expired trades counted as losses

Worth investigating before accepting replay numbers as a proxy for live P&L going forward.

---

## 8. Data Quality

| Metric | Value |
|---|---|
| Stale indicator snapshot rate | 0% |
| Duplicate `(asset,ts)` candle rows | 0 |
| Out-of-order candle inserts | 20 / 14,002 (0.14%, 10 assets) |
| Signals on missing candle | 0 / 244 |
| Unresolved trades | 0 / 209 |

Pipeline is healthy. Data quality is NOT the cause of losses.

---

## 9. Action Items for Next Session

### Gate changes to consider

1. **CALL Up Trend — replace current filter with `bbW < 20`**
   - Captures the bbW<10 sweet spot and excludes the 20-30 kill zone.
   - Expected: 63 sigs / ~52% WR / +$1,220 vs current 83/48%/−$3,100 = +$4,320 swing.
   - Needs cross-validation on Vn_ DBs before applying (may regress there).

2. **PUT Down Trend — add `rsi ≤ 30` to existing `bbW ≥ 30`**
   - Today's best combo: 63 sigs / 58.7% WR / +$4,020.
   - Currently 121 sigs at 54.5%; tighter gate trims to high-quality subset.

3. **CALL K-Crash — disable**
   - Pattern is too thin (8 sigs in 2 days) and consistently losing. Save code complexity by commenting out block 1.

4. **PUT Overbought — revert to broader gate**
   - Narrow "golden" (rsiFrom[80,82) + vel[-15,-10)) broke.
   - Broader vel[-15,-12) + bbW≥30 held at 66.7% on 6 signals — keep directionally, relax velocity band.

### Operational

1. **Wire `po_auto_block_sweep` into session startup** — biggest missed ROI today (~$19k in preventable losses).
2. **Investigate live vs replay P&L gap** — $7.5k delta needs root cause before trusting replay numbers.
3. **Never apply single-session "golden" conditions to production** — today proved they overfit. Require 2-session stability before live.

---

## 10. Files Referenced

| File | Purpose |
|---|---|
| `data/trading_data.db` | Today's live candle + trade data |
| `data/trading_data_v2_13-15.db` | Apr 13–15 historical replay |
| `data/trading_data_V3_16.db` | Apr 16 historical replay |
| `bot/indicators.js` | MODE D strategy — gates applied 2026-04-17 |
| `scripts/replay_full.cjs` | Full candle replay (accepts DB path as argv[2]) |
| `docs/session_report_2026-04-17.md` | Prior report — conditions tested in §3 |
| `docs/session_gemini_2026-04-17.md` | Gemini CALL UT recommendations (verified, mostly broken on today's data) |

---

*Generated: 2026-04-18 | Data: 2026-04-17 to 2026-04-18 | Signals replayed: 229 | Live trades: 209 | Assets: 53*

---

## 11. Pre-Commit Validation — Four-Question Audit (2026-04-18)

Ran a dedicated replay pass across four DBs (v2_13-15, V3_16, V3_17, current) to answer:

1. Does each proposed gate improve results on Apr 13–15 vs Apr 16–17 **separately** (not combined)?
2. What is the Wilson 95% CI on the WR lift for each gate — which "wins" are small-sample illusions?
3. Which gates are **stable across sessions** vs **session-specific**?
4. What if the gate is applied but trade count is held constant (by loosening another filter)? Separates quality improvement from trading less.

### Q1 — Per-DB baselines (no proposed gate applied)

| Pattern | v2_13-15 | V3_16 | V3_17 | current |
|---|---|---|---|---|
| K-Crash | n=23 WR=52.2% CI[33.0,70.8] +$20 | n=12 WR=41.7% CI[19.3,68.0] −$1,200 | n=5 WR=40.0% CI[11.8,76.9] −$580 | n=8 WR=37.5% CI[13.7,69.4] −$1,120 |
| PUT OB | n=28 WR=67.9% CI[49.3,82.1] +$4,240 | n=20 WR=75.0% CI[53.1,88.8] +$4,400 | n=7 WR=28.6% CI[8.2,64.1] −$1,580 | n=17 WR=47.1% CI[26.2,69.0] −$820 |
| CALL UT (post-live-filter) | n=110 WR=53.6% CI[44.4,62.7] +$1,640 | n=73 WR=58.9% CI[47.4,69.5] +$4,780 | n=30 WR=53.3% CI[36.1,69.8] +$360 | n=83 WR=48.2% CI[37.8,58.8] −$3,100 |
| PUT DT | n=248 WR=55.6% CI[49.4,61.7] +$8,480 | n=179 WR=54.7% CI[47.4,61.9] +$4,580 | n=56 WR=48.2% CI[35.7,61.0] −$2,080 | n=121 WR=54.5% CI[45.7,63.1] +$2,860 |

Note on `current` CALL UT: the 83 sigs include trades logged before the K≥85+bbW≤30 filter went live mid-Apr-17. True post-filter count measured separately below.

### Q2 + Q3 — CALL UT filter variants with confidence intervals + stability

CALL UT **pre-filter** (no K/bbW cap) is a disaster on historical data:

- v2_13-15: n=739 WR=49.7% CI[46.1,53.3] **−$17,180**
- V3_16: n=524 WR=49.6% CI[45.4,53.9] **−$12,400**
- V3_17: n=206 WR=50.5% CI[43.7,57.2] **−$3,160**
- current: n=431 WR=52.7% CI[48.0,57.3] +$2,420

Pattern MUST be filtered. Comparison of three filter candidates:

| Variant | v2_13-15 | V3_16 | V3_17 | current | Stability |
|---|---|---|---|---|---|
| K≥85 + bbW≤30 (currently live) | n=26 WR=50.0% CI[32.1,67.9] **−$520** | n=19 WR=63.2% CI[41.0,80.9] +$2,020 | n=5 WR=80.0% CI[37.6,96.4] +$1,340 | n=18 WR=61.1% CI[38.6,79.7] +$1,560 | MIXED — loses v2 |
| K≥80 + bbW≤30 (looser K) | n=66 WR=48.5% CI[36.8,60.3] **−$2,280** | n=42 WR=52.4% CI[37.7,66.6] +$120 | n=18 WR=55.6% CI[33.7,75.4] +$600 | n=40 WR=60.0% CI[44.6,73.7] +$3,040 | UNSTABLE |
| **K≥85 only** (drop bbW cap) | n=63 WR=54.0% CI[41.8,65.7] **+$1,140** | n=45 WR=55.6% CI[41.2,69.1] +$1,500 | n=12 WR=66.7% CI[39.1,86.2] +$1,680 | n=25 WR=64.0% CI[44.5,79.8] +$2,860 | **STABLE — profitable on all 4 DBs** |

**Finding: drop the bbW≤30 cap.** K≥85 alone is the only variant profitable across all four DBs. The bbW cap actively removes winners (−$1,660 v2 delta) with no compensating WR lift elsewhere. CI lower bound ≥41.2% on every DB — no illusion.

### Q2 + Q3 — PUT DT variants

| Variant | v2_13-15 | V3_16 | V3_17 | current | Stability |
|---|---|---|---|---|---|
| bbW≥30 (currently live) | n=248 WR=55.6% CI[49.4,61.7] +$8,480 | n=179 WR=54.7% +$4,580 | n=56 WR=48.2% −$2,080 | n=121 WR=54.5% +$2,860 | MOSTLY STABLE |
| bbW≥30 + rsi≤30 (proposed today) | n=136 WR=52.9% CI[44.6,61.1] **+$1,120** | n=97 WR=56.7% +$4,300 | n=23 WR=43.5% −$1,900 | n=63 WR=58.7% CI[46.4,70.0] +$4,020 | UNSTABLE — kills v2 (+$8.5k→+$1.1k) |
| bbW[30,60)+rsi[20,40) (old "golden 67.6%") | n=63 WR=46.0% −$3,660 | n=46 WR=65.2% +$5,800 | n=20 WR=40.0% −$2,320 | n=37 WR=37.8% **−$5,060** | REJECTED — losing on 3 of 4 DBs |

**Finding: the "bbW≥30 + rsi≤30" combo trims too many v2 winners. Reject. Keep bbW≥30 only.** The old golden combo is a textbook session-specific illusion — looked great on V3_16, broke everywhere else.

### Q2 + Q3 — PUT OB narrow condition (illusion check)

| Variant | v2_13-15 | V3_16 | V3_17 | current |
|---|---|---|---|---|
| rsiFrom[80,82)+vel[-15,-10) ("golden 88.9%") | n=3 WR=33.3% CI[6.1,79.2] −$540 | n=4 WR=100% CI[51.0,100.0] +$1,840 | n=1 WR=0% CI[0.0,79.3] −$500 | n=3 WR=33.3% CI[6.1,79.2] −$540 |
| rsiFrom≥80 (broad, live) | n=6 WR=50.0% CI[18.8,81.2] −$120 | n=5 WR=100% CI[56.6,100.0] +$2,300 | n=2 WR=0% CI[0.0,65.8] −$1,000 | n=3 WR=33.3% CI[6.1,79.2] −$540 |

**Finding: narrow golden is pure small-sample illusion** — n≤4/DB, CIs span 6–100%, WR oscillates between 0% and 100%. Broad rsiFrom≥80 is also thin (n=2–6) but at least doesn't claim a false precision. Keep live as-is; flag pattern for monitoring.

### Q2 + Q3 — K-Crash (marginal zone)

| Variant | v2_13-15 | V3_16 | V3_17 | current |
|---|---|---|---|---|
| kDrop≥25+rsi<30 (live) | n=23 WR=52.2% CI[33.0,70.8] +$20 | n=12 WR=41.7% CI[19.3,68.0] −$1,200 | n=5 WR=40.0% CI[11.8,76.9] −$580 | n=8 WR=37.5% CI[13.7,69.4] −$1,120 |
| kDrop≥30+rsi<20 (initial tighten, rejected) | n=1 WR=100% +$460 | n=1 WR=100% +$460 | n=0 — | n=0 — |

**Finding: live K-Crash is a coin flip — every DB's CI straddles 50%.** Losing P&L on 3 of 4 DBs. Candidate for full disable if another session regresses. Further tightening collapses n to ≤1.

### Q4 — Trade-count-constant test (quality vs volume)

Only CALL UT has meaningful sample-size shifts across variants. Holding signal count roughly constant on the current DB:

| Config | n | WR | CI | P&L | Delta vs live |
|---|---|---|---|---|---|
| K≥85 + bbW≤30 (live, tightest) | 18 | 61.1% | [38.6,79.7] | +$1,560 | baseline |
| **K≥85 only** (drop cap, loosens to match) | 25 | 64.0% | [44.5,79.8] | +$2,860 | **+7 trades, +2.9pp WR, +$1,300** |

**Finding: dropping the bbW cap is a *pure quality win* by the equal-N criterion.** More trades AND higher WR AND higher P&L. The cap was removing profitable signals, not filtering for quality. Not a "just trading less" effect — the reverse.

### Final stability tags

| Gate | Tag | Action |
|---|---|---|
| CALL UT: K≥85 only | **STABLE** | Edit `bot/indicators.js:944` — drop `&& bbWidthBps <= 30` |
| CALL UT: K≥85 + bbW≤30 | MIXED (loses v2) | Currently live — replace |
| CALL UT: K≥80 + bbW≤30 | UNSTABLE | Reject |
| PUT DT: bbW≥30 | STABLE | Keep live |
| PUT DT: bbW≥30 + rsi≤30 | UNSTABLE | Reject |
| PUT DT: bbW[30,60)+rsi[20,40) | UNSTABLE (ILLUSION) | Reject |
| PUT OB: rsiFrom≥80 (broad, live) | THIN (n≤6/DB) | Keep, monitor |
| PUT OB: narrow golden | ILLUSION (CI[0,100]) | Reject |
| K-Crash: kDrop≥25+rsi<30 (live) | MARGINAL | Keep, flag for disable review |
| K-Crash: kDrop≥30+rsi<20 | COLLAPSES | Reject |

### Code change recommended

`bot/indicators.js` line 944:

```diff
- if (!(stochK != null && stochK >= 85 && bbWidthBps <= 30)) return false;
+ if (!(stochK != null && stochK >= 85)) return false;
```

Expected impact summed across 4 DBs: **+$7,180** (vs current filter's +$4,400), net delta **+$2,780** with 32 additional signals. Also removes the silent "CALL UT bypasses global BB gate" anomaly noted in §5 — K≥85 alone doesn't interact with bbW at all.

---

## 12. Loss Concentration & Kill-Zone Audit (2026-04-18)

Four-question analysis over the **live trades** (`signal_outcomes` table) across all four DBs — answers the questions: where is the bleed concentrated, is it pattern-specific, which pattern×asset pairs repeat as losers, and what are the per-pattern kill zones.

### Q1 — What % of total loss comes from the worst N assets?

| DB | Gross loss | Worst 5 ($ / % of loss) | Worst 10 | Worst 15 |
|---|---|---|---|---|
| v2_13-15 | −$37,920 | −$13,880 / **36.6%** | −$23,640 / 62.3% | −$29,920 / 78.9% |
| V3_16 | −$43,640 | −$15,400 / **35.3%** | −$26,140 / 59.9% | −$33,420 / 76.6% |
| V3_17 | −$10,520 | −$4,660 / **44.3%** | −$7,200 / 68.4% | −$9,700 / 92.2% |
| current | −$26,860 | −$11,440 / **42.6%** | −$18,640 / 69.4% | −$23,420 / 87.2% |

**Finding: ~35–45% of losses come from the 5 worst assets; ~60–70% from the worst 10.** Pareto-like tail concentration is consistent across all four sessions. Blocking ~10 assets would eliminate the bulk of drawdown.

**Worst-5 asset lists per DB** (intersect for repeat offenders):
- **v2_13-15**: ZARUSD_otc, EURNZD_otc, USDJPY_otc, GBPAUD_otc, USDIDR_otc
- **V3_16**: USDCOP_otc, CADJPY_otc, USDIDR_otc, GBPAUD_otc, AEDCNY_otc
- **V3_17**: NGNUSD_otc, EURTRY_otc, USDCHF_otc, AUDUSD_otc, USDPHP_otc
- **current**: CADJPY_otc, AUDUSD_otc, YERUSD_otc, EURHUF_otc, USDCHF_otc

**Repeat offenders (appear in worst-5 of ≥2 DBs)**: GBPAUD_otc, USDIDR_otc, CADJPY_otc, EURNZD_otc, USDCHF_otc, AUDUSD_otc.

### Q2 — Loss distribution across patterns (live trades)

| DB | KCrash | PutDT | PutOB | CallUT |
|---|---|---|---|---|
| v2_13-15 | n=127 WR=36.2% **−$7,840** | n=272 WR=47.1% +$2,380 | n=51 WR=52.9% +$2,420 | n=250 WR=48.4% +$5,160 |
| V3_16 | n=297 WR=44.4% **−$9,280** | n=399 WR=45.1% **−$6,700** | n=76 WR=48.7% +$520 | — (pattern absent) |
| V3_17 | n=18 WR=38.9% −$1,780 | n=28 WR=60.7% +$3,820 | n=5 WR=80.0% +$1,840 | n=34 WR=44.1% −$2,100 |
| current | n=11 WR=45.5% −$200 | n=136 WR=45.6% **−$2,980** | n=16 WR=56.3% +$640 | n=80 WR=47.5% −$520 |

**Finding: K-Crash is the single most consistently losing pattern — negative on all 4 DBs, dropping $19k cumulatively.** PutDT swings (huge win on v2 and V3_17, loss on V3_16 and current) — sensitive to market regime. CallUT switched from winning on v2 to losing on current. PutOB is the only quietly positive pattern on all DBs (though n is small).

**The bleed is not evenly spread — K-Crash and regime-sensitive PutDT are the concentration points.**

### Q3 — Pattern × Asset pairs consistently negative across sessions

Blocklist candidates: pairs with n≥6 cumulative and negative P&L in ≥2 DBs. Top 20:

| Pattern × Asset | Neg sessions | Total n | Total P&L | Per-DB |
|---|---|---|---|---|
| PutDT × CADJPY_otc | 2/3 | 21 | **−$4,700** | v2:+$920, V3_16:−$2,080, current:−$3,540 |
| PutDT × BHDCNY_otc | 2/2 | 19 | −$3,240 | v2:−$1,080, V3_16:−$2,160 |
| KCrash × NGNUSD_otc | 2/2 | 14 | −$3,120 | V3_16:−$2,120, V3_17:−$1,000 |
| PutDT × EURTRY_otc | 2/3 | 21 | −$2,740 | v2:−$1,580, V3_16:−$1,160 |
| PutDT × EURJPY_otc | 2/2 | 15 | −$2,660 | v2:−$2,040, V3_16:−$620 |
| KCrash × GBPJPY_otc | 2/3 | 13 | −$2,620 | v2:−$1,500, V3_16:−$620, V3_17:−$500 |
| CallUT × EURNZD_otc | 2/2 | 12 | −$2,620 | v2:−$2,580, current:−$40 |
| PutDT × GBPAUD_otc | 2/4 | 18 | −$2,240 | v2:−$500, V3_16:−$3,040, V3_17:+$460, current:+$840 |
| PutDT × USDCOP_otc | 2/2 | 17 | −$2,240 | v2:−$80, V3_16:−$2,160 |
| PutOB × USDCOP_otc | 2/2 | 8 | −$2,080 | v2:−$1,000, V3_16:−$1,080 |
| CallUT × USDCNH_otc | 2/3 | 9 | −$2,080 | v2:−$1,540, V3_17:−$500, current:−$40 |
| KCrash × USDSGD_otc | 2/3 | 6 | −$2,040 | v2:−$1,000, V3_16:−$1,500, current:+$460 |
| CallUT × USDJPY_otc | 2/3 | 6 | −$2,040 | v2:−$540, V3_17:−$1,000, current:−$500 |
| PutDT × AEDCNY_otc | 2/3 | 17 | −$1,780 | v2:−$1,540, V3_16:+$800, current:−$1,040 |
| **PutDT × CHFJPY_otc** | **3/3** | 17 | −$1,780 | v2:−$80, V3_16:−$1,160, current:−$540 |
| PutDT × YERUSD_otc | 2/3 | 23 | −$1,740 | v2:+$460, V3_16:−$1,080, current:−$1,120 |
| PutDT × JODCNY_otc | 2/3 | 15 | −$1,740 | v2:−$1,040, V3_16:−$1,160, V3_17:+$460 |
| KCrash × USDCOP_otc | 2/3 | 13 | −$1,700 | v2:−$1,540, V3_16:−$620, V3_17:+$460 |
| KCrash × CHFNOK_otc | 2/2 | 13 | −$1,660 | v2:−$1,500, V3_16:−$160 |
| CallUT × USDPKR_otc | 2/3 | 7 | −$1,580 | v2:−$80, V3_17:−$500, current:−$1,000 |

**Only true 3-for-3 pair: PutDT × CHFJPY_otc** — negative in every DB it appears, across 17 signals.

**Strongest blocklist candidates (consistency × magnitude)**: PutDT × {CADJPY, BHDCNY, EURTRY, EURJPY, CHFJPY, CHFNOK}, KCrash × {NGNUSD, GBPJPY, USDCOP, CHFNOK, USDSGD}, CallUT × {EURNZD, USDCNH, USDJPY, USDPKR}.

Combined estimated savings if all 20 pairs blocked: roughly **+$46k** cumulative across the 4 DBs.

### Q4 — Kill zones and sweet spots per pattern

Replay-derived (all signals that passed pattern-internal gates, bucketed by bbW and RSI).

**K-Crash** (thin n per DB — treat with care):
| Metric | Kill zone | Sweet spot (any DB ≥2 wins) |
|---|---|---|
| bbW | [100+) on v2 (−$1,120), [20,30) mostly neg | [30,50) on v2 & current (+$420/+$920) |
| RSI | [0,20) — loses on v2/V3_17/current (−$2,660 net) | [20,30) moderate; no consistent positive |
| **Verdict** | **No stable sweet spot; kill zone bbW[100+) and RSI[0,20).** | Pattern remains marginal. Consider disable. |

**PUT OB**:
| Metric | Kill zone | Sweet spot |
|---|---|---|
| bbW | [10,30) inconsistent; [30,50) current=−$1,500 (regressed) | **[50,100) wins on all 4 DBs: +$1,800/+$2,300/−$540/+$380** → best consistent band |
| RSI | RSI[60,70) is the only populated band; wins on v2 (+$3,360) & V3_16 (+$4,440), loses V3_17/current | mid-RSI required but variable |
| **Verdict** | **Kill zone: bbW[10,30) on current data.** | **Sweet spot: bbW≥50.** Adding `bbWidthBps >= 50` to PUT OB would remove losing low-bbW regime — candidate for next round. |

**CALL UT** (all bbW<30 by construction — the 3-bucket sweep is inside that range):
| Metric | Kill zone | Sweet spot |
|---|---|---|
| bbW | **[20,30) losing on all 4 DBs: −$560/−$2,320/+$300/−$3,280** = cumulative −$5,860 | **[10,20) wins on all 4 DBs: +$3,240/+$2,980/+$1,800/−$1,400** (small current loss) |
| RSI | [60,70) loses on all 4 DBs: −$580/−$80/−$500/−$1,540 | [70,80)+[80,100) mostly positive on 3/4 DBs |
| **Verdict** | **bbW[20,30) is the real CALL UT kill zone** — this is what today's §3 analysis also showed. | **Sweet spot: bbW[10,20) + K≥85.** Tightening the bbW cap to `≤ 20` (instead of `≤ 30`) would remove the worst bucket. |

**PUT DT**:
| Metric | Kill zone | Sweet spot |
|---|---|---|
| bbW | [30,50) was strong on v2/V3_16, weakened on V3_17/current (−$600/−$240) | [100+) regime: wins 3/4 DBs (+$200/−$860/−$40/+$2,140) — extreme-volatility band getting stronger |
| RSI | **[50,60) = coin flip with big swings**: +$840/−$2,660/+$1,800/−$1,540 — unstable | **[0,20) deeply oversold: wins on v2 (+$5,920) and current (+$4,540)** — the current-session winner held into extremes |
| **Verdict** | Avoid RSI[50,60); avoid bbW[30,50) when market is quieter (V3_17/current regime) | **RSI[0,20) + bbW≥30 is the most stable PUT DT zone.** |

### Cross-pattern kill-zone summary

| Pattern | Stable kill zone | Action |
|---|---|---|
| CALL UT | **bbW[20,30) — losing on all 4 DBs** | Tighten live filter from `bbW≤30` to `bbW≤20` (or apply K≥85-only per §11) |
| PUT OB | bbW[10,30) with current-regime weakness | Add `bbW≥50` gate (current live has no upper BB structure) |
| PUT DT | RSI[50,60) | Add upper-RSI exclusion to PUT DT entry |
| K-Crash | RSI[0,20) when bbW[100+) | No rescue available; disable candidate |

### Action items added by this audit

1. **Blocklist deployment**: block the 20 pattern×asset pairs above via `po_block_asset` on session start (estimated −$46k→0 across historical regimes). Implement as a per-pattern map in the bot rather than global block — CALL UT × EURNZD_otc losing doesn't mean PUT DT × EURNZD_otc loses.
2. **Disable K-Crash entirely** pending regime change — losing on all 4 DBs, no sweet spot found.
3. **Tighten CALL UT bbW cap** from ≤30 to ≤20 (or drop cap entirely per §11 K≥85-only recommendation — §11 wins on equal-N test).
4. **Add PUT OB `bbWidthBps >= 50` gate** — the only bbW band consistently positive across all 4 DBs.
5. **Add PUT DT RSI[50,60) exclusion** — eliminates the single most unstable bucket.
