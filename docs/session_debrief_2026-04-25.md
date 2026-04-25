# Session Debrief — 2026-04-25

## Overview

| Metric | Value |
|---|---|
| Date | 2026-04-25 |
| Data range | 2026-04-25 05:11–15:59 UTC |
| Assets (live DB) | 51 |
| Live trades | 494 |
| Live WR | 51.4% (254W / 240L) |
| Live net P&L | **−$24,140** |
| Avg win | $377 |
| Avg loss | −$500 |
| Breakeven WR at live payout | **57.0%** |
| Leaves active | L16 CALL, L41 PUT, L65 PUT |

All three leaves ran below their breakeven win rate. The dominant drag was L65 PUT flooding the system with near-zero STC signals that resolve at 52% WR — just enough to look alive, not enough to profit at 75% payout.

---

## 1. Per-Leaf Performance Summary

| Leaf | Direction | Signals | Trades | Coverage | WR | P&L | vs BEP |
|---|---|---|---|---|---|---|---|
| L16 | CALL | 89 | 88 | 98.9% | 50.0% | −$5,385 | −7.0 pp |
| L41 | PUT | 230 | 141 | 61.3% | 48.2% | −$10,180 | −8.8 pp |
| L65 | PUT | 471 | 265 | 56.3% | 53.6% | −$8,575 | −3.4 pp |

BEP = breakeven point at $377 avg win / $500 avg loss = **57.0%**

**L65 is the volume driver** (53.5% of all trades) yet runs 3.4 pp below breakeven. L41 is the worst on rate (48.2%) and accounts for $10.2k in losses — the single biggest drain.

---

## 2. BB Width Analysis

BB width in bps = `(bb_upper − bb_lower) / bb_middle × 10000`

### L16 CALL

| BB band | n | WR | P&L |
|---|---|---|---|
| <20 | 12 | **66.7%** | **+$760** |
| 20–50 | 36 | 47.2% | −$3,015 |
| 50–100 | 13 | 38.5% | −$2,185 |
| 100+ | 27 | 51.9% | −$945 |

L16 actually wins in the flattest market (<20 bps). Higher volatility zones hurt this pattern — the "price at BB floor" setup is a narrowing-band event.

### L41 PUT

| BB band | n | WR | P&L |
|---|---|---|---|
| <20 | 52 | 46.2% | −$4,885 |
| 20–50 | 40 | 45.0% | −$3,930 |
| 50–100 | 34 | 47.1% | −$2,760 |
| 100+ | 15 | **66.7%** | **+$1,395** |

L41 only shows edge in extreme-volatility (100+ bps). All three lower bands are below breakeven. But n=15 at 100+ is thin — not enough to build a gate from alone. Combined with the missing cross-DB validation, this pattern should be disabled.

### L65 PUT

| BB band | n | WR | P&L |
|---|---|---|---|
| <20 | 104 | 51.9% | −$4,690 |
| 20–50 | 81 | 54.3% | −$3,020 |
| 50–100 | 46 | 50.0% | −$2,280 |
| 100+ | 34 | **61.8%** | **+$1,415** |

L65 is consistently unprofitable below 100 bps. Gate at **≥50 bps** would cut 150 losing trades and retain the 34-trade 61.8% WR core. Gate at **≥100 bps** is too restrictive (leaves only 34 trades/day).

---

## 3. STC Zone Analysis

`schaff_value` zones: oversold <25, neutral 25–75, overbought ≥75

### L16 CALL

| STC zone | n | WR | P&L |
|---|---|---|---|
| null | 18 | **33.3%** | **−$4,065** |
| <25 | 53 | 52.8% | −$1,745 |
| 25–75 | 14 | 57.1% | +$320 |
| ≥75 | 3 | 66.7% | +$105 |

**18 trades fired with null STC at 33.3% WR, contributing −$4,065.** Without that drag, L16 baseline rises to 53.6% (still below BEP but recoverable). STC null guard is the single cheapest fix available.

### L41 PUT

| STC zone | n | WR | P&L |
|---|---|---|---|
| null | 14 | 50.0% | −$760 |
| <25 | 5 | 20.0% | −$1,550 |
| 25–75 | 8 | 62.5% | +$340 |
| ≥75 | 114 | 48.2% | −$8,210 |

**114 of 141 L41 trades (80.9%) fired with STC ≥75 (overbought) at 48.2% WR.** The PUT setup fires when RSI and stoch crash — but if STC is already overbought, that crash may just be a pullback within a larger up trend. No STC zone consistently wins. Pattern should be disabled.

### L65 PUT

| STC zone | n | WR | P&L |
|---|---|---|---|
| null | 25 | 56.0% | +$150 |
| <25 | 186 | 52.2% | −$8,970 |
| 25–75 | 34 | **61.8%** | **+$2,045** |
| ≥75 | 20 | 50.0% | −$1,800 |

**The current `schaffVal > 0.000060` gate is effectively no gate** — it admits everything except literal zero. This floods L65 with 186 oversold-STC PUT trades at 52.2% WR (−$8,970). The actual edge lives entirely in the neutral zone (25–75): **61.8% WR, +$2,045 on 34 trades**. Raising the STC gate to `≥ 25` would cut the losing mass and concentrate on the profitable subset.

---

## 4. Three-Layer Validation Architecture

The system has three distinct data layers for measuring strategy performance:

| Layer | Source | What it measures | Payout | n (today) |
|---|---|---|---|---|
| **Backtest** | `paper_reversal_leaves.cjs` | Recomputes leaf conditions from raw `indicators` table, resolves 2m exit from candles | 92% (fixed) | all historical |
| **Paper validation** | `signal_outcomes` | Bot-fired signals with simulated 2m exit from next candle close | 92% (fixed) | 789 |
| **Live** | `trades_ordered` | Actual broker execution, real fills | ~75% (avg $377 win) | 494 |

### Comparison by leaf (2026-04-25)

| Leaf | Paper validation (signal_outcomes) | Live (trades_ordered) |
|---|---|---|
| L16 CALL | n=89, WR=49.4%, P&L=−$2,140 | n=88, WR=50.0%, P&L=−$5,385 |
| L41 PUT | n=230, WR=45.7%, P&L=−$12,140 | n=141, WR=48.2%, P&L=−$10,180 |
| L65 PUT | n=470, WR=49.2%, P&L=−$11,780 | n=265, WR=53.6%, P&L=−$8,575 |

### Why the three layers diverge

**Backtest vs paper validation**: `paper_reversal_leaves.cjs` reads post-close indicator values from the `indicators` table and reapplies leaf conditions. The bot fires on live intra-candle stochastic values (peak during formation). For L65, ~37% of bot-fired signals have post-close K-D below the 24.66 threshold — meaning the candle looked overbought intra-bar but compressed by close. This is why backtest signal counts differ from signal_outcomes counts.

**Paper validation vs live — coverage gap**: L41 fires 230 signals; only 141 become live trades (61.3%). L65: 470 signals → 265 trades (56.3%). Blocked assets and queue saturation prevent ~40% of signals from executing. signal_outcomes captures all 789; trades_ordered captures 494.

**Paper validation vs live — payout asymmetry**: signal_outcomes assumes 92% ($460 win). Live actual is ~75.4% ($377 avg win). The $83/trade gap explains why paper P&L diverges from live even when WR tracks closely. At 57% BEP for live, all three leaves are losing at any realistic payout.

---

## 5. Asset-Level Picture

### Top performers (n≥5)

| Asset | n | WR | P&L |
|---|---|---|---|
| OMRCNY_otc | 7 | 100.0% | +$2,930 |
| AUDCHF_otc | 9 | 88.9% | +$2,820 |
| MADUSD_otc | 14 | 71.4% | +$2,085 |
| YERUSD_otc | 15 | 66.7% | +$1,700 |
| BHDCNY_otc | 8 | 75.0% | +$1,395 |
| NZDJPY_otc | 9 | 66.7% | +$1,240 |
| JODCNY_otc | 9 | 77.8% | +$1,230 |
| USDINR_otc | 7 | 71.4% | +$1,180 |
| EURTRY_otc | 7 | 71.4% | +$1,005 |
| CHFNOK_otc | 7 | 85.7% | +$960 |

### Worst performers 
| Asset | n | WR | P&L |
|---|---|---|---|
| USDMYR_otc | 10 | 10.0% | −$4,305 |
| USDTHB_otc | 11 | 18.2% | −$3,580 |
| ZARUSD_otc | 9 | 11.1% | −$3,540 |
| USDDZD_otc | 20 | 40.0% | −$3,280 |
| GBPAUD_otc | 11 | 27.3% | −$2,925 |
| UAHUSD_otc | 12 | 33.3% | −$2,420 |
| NZDUSD_otc | 13 | 38.5% | −$2,170 |
| AUDUSD_otc | 6 | 16.7% | −$2,040 |
| EURRUB_otc | 9 | 33.3% | −$1,765 |
| USDSGD_otc | 7 | 28.6% | −$1,655 |



---

## 6. Leaf Condition Audit

Thresholds verified identical between `bot/indicators.js` and `scripts/paper_reversal_leaves.cjs`. No divergence in gate values.

`stochastic_k` in `indicators.js` maps to `stochastic_k_v2` in the DB (Video 2 / 5,3,3). Confirmed correct by `bot/database.js:553`.

### Active conditions at time of session

```javascript
// L16 CALL
bbPosition <= 0.021859 && stochKdDiff > -1.668935 &&
closToLowerBps <= -1.013379 && rsi <= 2.679860 &&
stochD > 4.079007
// Note: no schaffVal != null guard — admits 18 null-STC trades

// L41 PUT
bbPosition > 0.021859 && bbPosition > 0.352286 &&
stcStochDiff > -58.236702 && rsi <= 17.150460 &&
stochKdDiff <= -16.898592

// L65 PUT
bbPosition > 0.021859 && bbPosition <= 0.721175 &&
stochKdDiff > 24.659285 && schaffVal > 0.000060
// schaffVal > 0.000060 ≈ no filter — admits all STC<25 trades
```

---

## 7. Action Items for Next Session

### Gate changes (priority order)

1. **Disable L41 PUT** — 48.2% WR on 141 live trades; no STC zone profitable except thin neutral slice; 4/7 DB cross-validation was already marked "WATCH"; confirmed losing on today's data across all BB bands. Comment out the L41 block in `bot/indicators.js`.

2. **Add STC null guard to L16 CALL** — Add `schaffVal != null &&` to the L16 condition. 18 null-STC trades cost −$4,065 at 33.3% WR. Zero cost, immediately recoverable.

3. **Raise L65 STC gate to `schaffVal >= 25`** — The neutral zone (25–75) is the only L65 subset with edge: 61.8% WR, +$2,045. Oversold-STC PUTs (186 trades, 52.2%) are the volume and the source of most losses. This is the highest-impact single gate change: estimated −$8,970→+$2,045 swing if STC<25 trades are excluded.

4. **Add `bbWidthBps >= 50` to L65 PUT** — Complements the STC gate. The 100+ bps band shows 61.8% WR. Gate at 50 keeps the middle and high volatility zones while cutting flat-market L65 signals.

### Validate before applying

Run `po_simulate` with proposed L65 changes before touching `bot/indicators.js` to confirm no regression on historical signal set.

### Operational

1. **Block 8 worst assets at session start** via `po_block_asset` (USDMYR, USDTHB, ZARUSD, USDDZD, GBPAUD, UAHUSD, NZDUSD, AUDUSD) — these 8 assets collectively shed −$24k today.
2. **Run `po_auto_block_sweep` at session start** — prevents new flat assets from entering the trade queue undetected.

---

## 8. Files Referenced

| File | Purpose |
|---|---|
| `data/trading_data.db` | Today's live candle + trade data |
| `bot/indicators.js` | MODE D strategy — L16/L41/L65 leaf conditions |
| `scripts/paper_reversal_leaves.cjs` | Indicator-based backtest (CSV) — redundant; signal_outcomes is canonical |
| `docs/ML_REPORT_LEAVES_V1.MD` | Cross-DB ML leaf validation reference |
| `docs/ML_REPORT_STC.MD` | STC feature analysis reference |

---

*Generated: 2026-04-25 | Data: 2026-04-25 05:11–15:59 UTC | Live trades: 494 | Assets: 51 | Leaves active: L16, L41, L65*
