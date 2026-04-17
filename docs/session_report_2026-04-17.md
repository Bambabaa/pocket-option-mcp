# Session Report — 2026-04-17

## Overview

Analysis session covering the 2026-04-16 trading day. Full candle replay across 48 assets, 705 signals. Objective: identify the highest-confidence conditions for each of the 4 MODE D patterns.

| Metric | Value |
|---|---|
| Date | 2026-04-16 |
| Assets replayed | 48 |
| Total signals (replay) | 705 |
| Live trades | 668 |
| Live WR | 49.7% |
| Live P&L | **-$36,435** |
| Replay baseline WR | 48.5% |
| Replay baseline P&L | -$24,180 |

Today was a losing session across the board. PUT Down Trend (418 signals, 46.7% WR) was the primary drag. Recommended gates rescued $16,100–$27,860 depending on tightness.

---

## 1. Live Trade Summary

### By Direction

| Direction | Trades | WR | P&L |
|---|---|---|---|
| PUT | 472 | 49.2% | -$29,085 |
| CALL | 196 | 51.0% | -$7,350 |

### Top Assets (live)

| Asset | n | WR | P&L |
|---|---|---|---|
| YERUSD_otc | 17 | 76.5% | +$3,500 |
| USDARS_otc | 12 | 75.0% | +$1,895 |
| USDCAD_otc | 16 | 75.0% | +$1,685 |
| AUDNZD_otc | 14 | 71.4% | +$2,565 |
| AUDJPY_otc | 18 | 66.7% | +$1,920 |
| EURUSD_otc | 17 | 64.7% | +$1,965 |
| USDBRL_otc | 10 | 70.0% | +$1,245 |

### Worst Assets (live)

| Asset | n | WR | P&L |
|---|---|---|---|
| USDJPY_otc | 14 | 21.4% | -$4,265 |
| EURTRY_otc | 13 | 30.8% | -$3,445 |
| LBPUSD_otc | 21 | 38.1% | -$3,815 |
| EURGBP_otc | 8 | 12.5% | -$3,110 |
| USDIDR_otc | 14 | 28.6% | -$3,185 |

### By Hour (live)

| Hour UTC | n | WR | P&L |
|---|---|---|---|
| 17:00 | 182 | 47.3% | -$12,690 |
| 18:00 | 176 | 51.7% | -$6,480 |
| 19:00 | 161 | 52.8% | -$5,045 |
| 20:00 | 115 | 50.4% | -$6,380 |

---

## 2. Full Candle Replay — Pattern Summary

| Pattern | Signals | WR | P&L |
|---|---|---|---|
| CALL K-Crash Reversal | 182 | 48.9% | -$5,560 |
| PUT Overbought Reversal | 105 | **55.2%** | **+$3,180** |
| CALL Up Trend | 0 | — | — |
| PUT Down Trend | 418 | 46.7% | -$21,800 |
| **ALL COMBINED** | **705** | **48.5%** | **-$24,180** |

---

## 3. Best Conditions by Pattern

### 3.1 PUT Overbought Reversal — Best Pattern Today

Baseline: n=105, **55.2% WR**, +$3,180

#### Prior RSI (rsiFrom) — sweet spot is 78–82

| rsiFrom | n | WR | Delta |
|---|---|---|---|
| < 70 | 20 | 50.0% | -5.2pp |
| 70–75 | 25 | 56.0% | +0.8pp |
| 75–78 | 26 | 53.8% | -1.4pp |
| **78–80** | **7** | **71.4%** | **+16.2pp** |
| **80–82** | **9** | **77.8%** | **+22.6pp** |
| 82–85 | 14 | 50.0% | -5.2pp |
| >= 85 | 4 | 25.0% | -30.2pp ✗ |

> Overbought 80–82 is the exact zone: genuinely extended but not so extreme it already snapped back. Above 85 = late signal, price already reversing.

#### RSI Velocity — controlled pullback wins

| Velocity | n | WR | Delta |
|---|---|---|---|
| < -20 | 44 | 45.5% | -9.7pp ✗ |
| **-20 to -15** | **22** | **72.7%** | **+17.5pp** |
| -15 to -12 | 22 | 72.7% | +17.5pp |
| -12 to -10 | 11 | 54.5% | -0.7pp |
| **-10 to -8** | **8** | **62.5%** | **+7.3pp** |
| **-8 to -5** | **12** | **66.7%** | **+11.5pp** |
| > -5 | 8 | 37.5% | -17.7pp ✗ |

> Velocity too fast (< -20) = RSI collapsing = whipsaw reversal. Velocity too slow (> -5) = RSI barely moving = not actually reversing. The -15 to -8 range is the reliable zone.

#### Best Combos

| Condition | n | WR | P&L |
|---|---|---|---|
| **rsiFrom[80,82) + vel[-15,-10)** | **9** | **88.9%** | **+$3,180** |
| vel[-15,-12) + bbW>=30 | 25 | **72.0%** | +$4,780 |
| rsiFrom>=75 + vel[-15,-10) | 20 | **70.0%** | +$3,440 |
| rsiFrom>=80 + bbW>=30 | 18 | 66.7% | +$2,520 |
| rsiFrom[80,85) + vel<-10 | 23 | 60.9% | +$1,940 |
| rsiFrom>=78 + vel<-10 | 34 | 58.8% | +$2,200 |

**Golden condition:** rsiFrom 80–82 + velocity -15 to -10 → **88.9% WR** (9 signals). Controlled overbought RSI with a measured but clear pullback velocity.

---

### 3.2 PUT Down Trend — Only Wide BB Has Edge

Baseline: n=418, **46.7% WR**, -$21,800

#### BB Width — the defining gate

| BB Width | n | WR | Delta |
|---|---|---|---|
| 0–5 bps | 136 | 48.5% | +1.8pp |
| 5–10 bps | 23 | **56.5%** | **+9.8pp** |
| **10–15 bps** | **33** | **27.3%** | **-19.4pp ✗** |
| 15–20 bps | 29 | 34.5% | -12.2pp ✗ |
| 20–25 bps | 39 | 38.5% | -8.2pp ✗ |
| 25–30 bps | 23 | 34.8% | -11.9pp ✗ |
| **30–40 bps** | **50** | **52.0%** | **+5.3pp** |
| **40–60 bps** | **47** | **57.4%** | **+10.7pp** |
| **60+ bps** | **38** | **55.3%** | **+8.6pp** |

> The 10–30 bps zone is a **kill zone** today — all 4 buckets are losing. Below 10 or above 30 is where the edge lives.

#### RSI at Signal

| RSI | n | WR | Delta |
|---|---|---|---|
| 0–20 | 91 | 47.3% | +0.6pp |
| 20–30 | 106 | 45.3% | -1.4pp |
| **30–40** | **104** | **53.8%** | **+7.1pp** |
| 40–50 | 95 | 45.3% | -1.4pp |
| **50–60** | **22** | **22.7%** | **-24.0pp ✗** |

> RSI 30–40 is ideal for PUT DT — momentum confirmed falling but not so oversold it bounces. RSI 50–60 at a downtrend signal = trend not confirmed, avoid.

#### Hour of Day

| Hour UTC | n | WR | Delta |
|---|---|---|---|
| 18:00 | 81 | 45.7% | -1.0pp |
| 19:00 | 94 | 44.7% | -2.0pp |
| 20:00 | 79 | 46.8% | +0.1pp |
| 21:00 | 91 | 44.0% | -2.7pp |
| **22:00** | **73** | **53.4%** | **+6.7pp** |

#### Best Combos

| Condition | n | WR | P&L |
|---|---|---|---|
| **hour=22 + bbW>=30** | **25** | **68.0%** | **+$3,820** |
| **bbW[30,60) + RSI[20,40)** | **34** | **67.6%** | **+$5,080** |
| bbW>=30 + rsi<=40 | 89 | 59.6% | +$6,380 |
| bbW>=50 + rsi<=40 | 47 | 57.4% | +$2,420 |
| bbW>=30 + rsi<=30 | 63 | 55.6% | +$2,100 |

**Best condition:** bbW 30–60 bps + RSI 20–40 → **67.6% WR**, +$5,080 (n=34). Add hour=22 UTC and it reaches 68%.

---

### 3.3 CALL K-Crash Reversal — Pattern Broke Down Today

Baseline: n=182, **48.9% WR**, -$5,560

The historically recommended gates (kDrop>=25 + rsi<40 + bbW>=30) performed poorly today (41.7% WR). Different dimensions had edge:

#### K_curr Landing Zone — most important today

| K_curr | n | WR | Delta |
|---|---|---|---|
| 10–20 | 31 | 45.2% | -3.7pp |
| **20–25** | **60** | **36.7%** | **-12.2pp ✗** |
| **25–30** | **90** | **58.9%** | **+10.0pp** |

> K landing 25–30 (partial crash, not extreme) = 58.9% WR. K landing 20–25 (too deep) = 36.7% WR. The crash magnitude matters less than where it lands.

#### BB Width

| BB Width | n | WR | Delta |
|---|---|---|---|
| 30–40 bps | 38 | 36.8% | -12.1pp ✗ |
| **40–60 bps** | **32** | **56.3%** | **+7.4pp** |
| 60+ bps | 43 | 48.8% | -0.1pp |

#### Price vs BB Mid — critical gate today

| Price vs Mid | n | WR | Delta |
|---|---|---|---|
| Below mid -10 to -30 bps | 64 | 53.1% | +4.2pp |
| Below mid 0 to -10 bps | 72 | 51.4% | +2.5pp |
| Above mid 0 to +10 bps | 21 | 42.9% | -6.0pp |
| **Above mid +10 bps** | **7** | **14.3%** | **-34.6pp ✗** |

> Price already above BB mid when K-crash fires = likely false signal. Price at or below mid = setup still valid.

#### Best Combos Today

| Condition | n | WR | P&L |
|---|---|---|---|
| **kCurr[25,30) + any** | **90** | **58.9%** | **+$5,880** |
| bbW[40,60) + rsi[30,50) | ~20 | ~56% | ~+$1,000 |
| hour=19 | 44 | 54.5% | +$1,040 |
| hour=20 | 49 | 53.1% | +$460 |

**Key today:** historically recommended gates broke down. K current landing zone (25–30) was the real edge signal — not K drop magnitude.

---

### 3.4 CALL Up Trend — 0 signals

No CALL UP TREND signals fired on 2026-04-16. Pattern did not trigger.

---

## 4. Baseline vs Recommended Gates

| Config | n | WR | P&L | Delta |
|---|---|---|---|---|
| Baseline (no filters) | 705 | 48.5% | -$24,180 | — |
| Recommended v1 (bbW>=20 PutDT) | 260 | 48.8% | -$8,080 | **+$16,100** |
| **Tighter (bbW>=30+rsi<=40 PutDT)** | **152** | **54.6%** | **+$3,680** | **+$27,860** |

The tighter PutDT gate (bbW>=30 + rsi<=40) turned a -$24,180 day into +$3,680 — a complete flip. 152 signals vs 705 baseline (-78% volume).

---

## 5. Cross-Session Gate Stability

The following table tracks how recommended gates perform across the two sessions analysed:

| Gate | Apr 13–15 WR | Apr 16 WR | Verdict |
|---|---|---|---|
| PutDT bbW>=20 | 55.5% | 49.2% | Unstable — 20 bps too low |
| **PutDT bbW>=30** | **~55%** | **54.8%** | **Consistent** |
| **PutDT bbW>=30+rsi<=40** | n/a | **59.6%** | **Best today** |
| PutOB rsiFrom>=80 | 58.1% | 55.6% | Consistent |
| PutOB vel[-15,-10) | n/a | **72.7%** | **New — add as gate** |
| KCrash kDrop>=25+rsi<40+bbW>=30 | 58.2% | 41.7% | Broke down Apr 16 |
| KCrash kCurr[25,30) | n/a | **58.9%** | **New — add as gate** |

---

## 6. Updated Gate Recommendations

Based on combined Apr 13–16 evidence:

### PUT Down Trend
```
bbW >= 30 bps    (raised from 20 — the 20-30 zone is a kill zone)
RSI <= 40        (confirmed momentum, not mid-range noise)
Hour preference: 22:00 UTC (best session)
```

### PUT Overbought Reversal
```
rsiFrom 78–85    (prior RSI was genuinely overbought but not extreme)
velocity -15 to -8   (measured pullback — not a collapse, not stalling)
bbW >= 30        (adds +11.5pp WR when combined with rsiFrom>=80)
```

### CALL K-Crash Reversal
```
kCurr 25–30      (K landing zone more important than K drop magnitude)
price <= BB mid  (price above mid +10bps kills the pattern completely)
Hour: 19-20 UTC  (best hours today)
bbW 40–60 bps    (sweet spot — very wide BBs not necessarily better)
```

---

## 7. Asset Leaderboard — Replay (min 5 signals)

### Top performers

| Asset | n | WR | P&L |
|---|---|---|---|
| YERUSD_otc | 16 | **81.3%** | +$4,480 |
| CADCHF_otc | 13 | 69.2% | +$2,140 |
| TNDUSD_otc | 13 | 69.2% | +$2,140 |
| USDPKR_otc | 13 | 69.2% | +$2,140 |
| USDCHF_otc | 22 | 68.2% | +$3,400 |
| GBPAUD_otc | 12 | 66.7% | +$1,680 |
| GBPUSD_otc | 17 | 64.7% | +$2,060 |
| NZDJPY_otc | 13 | 61.5% | +$1,180 |
| USDCAD_otc | 18 | 61.1% | +$1,560 |

### Worst performers

| Asset | n | WR | P&L |
|---|---|---|---|
| EURGBP_otc | 10 | **10.0%** | -$4,040 |
| USDIDR_otc | 15 | 20.0% | -$4,620 |
| UAHUSD_otc | 13 | 23.1% | -$3,620 |
| EURJPY_otc | 12 | 25.0% | -$3,120 |
| AEDCNY_otc | 14 | 28.6% | -$3,160 |
| CHFJPY_otc | 17 | 29.4% | -$3,700 |
| USDBDT_otc | 15 | 33.3% | -$2,700 |

> Note: CHFJPY and AEDCNY were strong on Apr 13–15 (CALL UT allowlist). They performed badly Apr 16 on PUT DT signals — asset edges are pattern-specific and session-specific.

---

## 8. Key Findings This Session

| Finding | Evidence |
|---|---|
| PUT OB rsiFrom 80–82 + vel -15 to -10 = golden | 88.9% WR (9 signals) |
| PUT DT kill zone: bbW 10–30 bps | 27–38% WR across all 4 sub-buckets |
| PUT DT bbW[30,60) + RSI[20,40) = best trend condition | 67.6% WR, +$5,080 |
| KCrash kCurr landing 25–30 outperforms kDrop magnitude | 58.9% WR vs 36.7% for kCurr 20–25 |
| Price above BB mid +10bps on K-Crash = avoid | 14.3% WR (7 signals) |
| Hour 22 UTC best for PUT DT | +6.7pp vs baseline |
| Hours 19–20 UTC best for K-Crash | 53–55% WR vs 45% at 18:00 |
| Raising PutDT gate to bbW>=30+rsi<=40 flipped -$24k day to +$3.7k | +$27,860 delta |
| Tighter gates not always better — PutOB velocity needs range, not minimum | vel < -20 = 45.5% WR; vel -15 to -8 = 65-72% WR |

---

## 9. Files Referenced

| File | Purpose |
|---|---|
| `data/trading_data.db` | Live candle and trade history |
| `bot/indicators.js` | Active MODE D strategy logic |
| `scripts/replay_full.cjs` | Full candle replay script (run anytime for latest data) |
| `scripts/find_edge_all.cjs` | Exhaustive condition sweep across all 4 patterns |
| `docs/session_report_2026-04-16_08-05.md` | Prior session — gate validation (Apr 13–15 data) |

---

*Generated: 2026-04-17 | Data: 2026-04-16 | Signals replayed: 705 | Live trades: 668 | Assets: 48*

---

## 10. CALL K-Crash — Live Session Deep Correlation (2026-04-17)

Analysis of 51 CALL signal outcomes from today's live session. Threshold sweep across all gates.

### Overall
| Metric | Value |
|---|---|
| Total CALL signals | 51 |
| Pattern split | 18 OVERSOLD_REVERSAL, 34 UP_TREND |
| Both patterns today | Losing (39% and 44% WR) |
| Primary cause | 34 of 51 signals fired into MA downtrend |

---

### RSI Threshold Sweep

| Cutoff | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| ≤ 15 | 3 | 33% | -$540 | AVOID |
| ≤ 20 *(current gate)* | 5 | **20%** | **-$1,540** | **AVOID — worst** |
| ≤ 25 | 7 | 43% | -$620 | AVOID |
| ≤ 30 | 8 | 38% | -$1,120 | AVOID |
| **≤ 35** | **17** | **53%** | **+$640** | MARGINAL |
| **≤ 40** | **17** | **53%** | **+$640** | MARGINAL |

> Current RSI<20 gate is the worst performing threshold — deeply oversold RSI paradoxically loses on CALLs. Break-even is RSI ≤ 35–40. Recommend changing gate to RSI ≤ 40.

---

### K Crash Magnitude Sweep

| Min Crash | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| ≥ 10 pts | 20 | 45% | -$1,360 | MARGINAL |
| ≥ 15 pts | 17 | 41% | -$1,780 | AVOID |
| ≥ 20 pts | 7 | 57% | +$340 | GOOD |
| **≥ 25 pts** *(current)* | **4** | **75%** | **+$880** | **STRONG** |

> Crash ≥ 25 pts validated — current gate is correct. Do not lower this threshold.

---

### K Value at Signal Bar

| K Zone | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| EXT < 10 | 4 | 25% | -$1,040 | AVOID |
| DEEP 10–20 | 2 | 0% | -$1,000 | AVOID |
| **OS 20–30** | **5** | **60%** | +$380 | GOOD |
| **NEAR 30–40** | **8** | **63%** | +$800 | GOOD |
| OUT 40+ | 30 | 40% | -$3,480 | AVOID |

> Threshold sweep: K ≤ 40 keeps 21 trades at 48% WR. K ≤ 35 keeps 17 at 41%. K in 20–40 range is the working zone — extreme K (<20) loses. This aligns with Apr 16 finding that kCurr 25–30 outperforms deeper crashes.

---

### Bars Since K Was Above 50 — Strongest Single Gate Found

| Max Bars | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| **≤ 1** | **6** | **83%** | **+$1,800** | **STRONG** |
| **≤ 2** | **10** | **60%** | **+$760** | GOOD |
| ≤ 3 | 16 | 56% | +$640 | GOOD |
| ≤ 4 | 19 | 58% | +$1,060 | GOOD |
| ≤ 5 | 22 | 50% | -$440 | MARGINAL |

> **Best single threshold found today: barsSinceK50 ≤ 1 = 83% WR (+$1,800).** K must have just crossed below 50 — a fresh momentum break. Stale oversold (5+ bars below 50) = 0% WR. Not currently gated in bot.

---

### K-D Spread Sweep

| Max Spread | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| ≤ -20 | 7 | 57% | +$340 | GOOD |
| ≤ -10 | 13 | 54% | +$220 | MARGINAL |
| **≤ 0** | **25** | **48%** | **-$480** | MARGINAL |
| **> 10** *(current)* | **15** | **27%** | **-$3,660** | **AVOID** |

> K-D spread > 10 is a death zone — 27% WR, -$3,660 on 15 trades. K far above D means the signal fires too early before D catches up. Recommend gate: spread ≤ 0.

---

### BB Width Sweep

| Min Width | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| ≥ 20 bps *(current)* | 30 | 40% | -$3,480 | AVOID |
| ≥ 30 bps | 24 | 38% | -$3,360 | AVOID |
| ≥ 40 bps | 19 | 42% | -$1,820 | AVOID |
| **≥ 50 bps** | **14** | **57%** | **+$680** | GOOD |

> 20–50 bps is a kill zone for CALLs (same as PUT DT on Apr 16). Gate needs to be raised from 20 to 50 bps for CALL signals specifically.

---

### MA Trend Sweep

| Min maTrendBps | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| ≥ -50 | 52 | 42% | -$3,880 | AVOID |
| ≥ -20 | 47 | 43% | -$3,300 | AVOID |
| **≥ 0** | **22** | **45%** | **-$400** | MARGINAL |

> MA trend alone insufficient but critical as a filter. 34 of 51 CALL signals fired into downtrend — that group is -$4,520. Requiring MA ≥ 0 removes the biggest source of losses.

---

### Best Stacked Combos

| Combo | Keep | WR | P&L | Verdict |
|---|---|---|---|---|
| **BB≥50 + MA≥0** | **5** | **80%** | **+$1,340** | **STRONG** |
| **RSI≤40 + Crash≥25** | **4** | **75%** | **+$880** | **STRONG** |
| MA≥0 + Spread≤0 | 14 | 57% | +$1,180 | GOOD |
| PRICE_BELOW + MA≥0 | 10 | 60% | +$760 | GOOD |

---

### Proposed New CALL K-Crash Gates

| Gate | Current | Recommended | Evidence |
|---|---|---|---|
| RSI | < 20 | **≤ 40** | Current gate 20% WR; ≤40 = 53% |
| K crash | ≥ 25 pts | Keep ≥ 25 | Validated |
| barsSinceK50 | none | **≤ 1** | 83% WR — strongest gate found |
| BB width | ≥ 20 bps | **≥ 50 bps** | 20–50 bps kill zone |
| MA trend | none | **≥ 0 bps** | 34/51 losses from downtrend signals |
| K-D spread | none | **≤ 0** | spread>10 = 27% WR death zone |

> Cross-session consistency check needed before pushing to bot. Run `po_simulate` with these thresholds against Apr 16 replay data to validate stability.

---

*Live session analysis appended: 2026-04-17 | CALL signals analysed: 51 | Threshold sweep: 7 dimensions*
