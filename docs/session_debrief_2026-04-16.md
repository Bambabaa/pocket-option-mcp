# Session Debrief — 2026-04-16

**Session window:** 16:47 – 20:46 UTC (~4 hours)
**Total trades:** 668 | **332W 336L** | **49.7% WR** | **P/L: -$36,435**

---

## Summary

A heavy-volume session (668 trades, 2.8/min average, 9 max in a single minute) that ran at near-breakeven win rate but produced a large loss due to negative payout asymmetry — $460 avg win vs $500 loss. The strategy fired 475 executions against 403 "No Strategy Conditions Met" neutrals, meaning the bot was trading almost constantly across all assets simultaneously. This is the core problem: volume is too high, asset coverage is too wide, and losing assets are pulling the session deeply negative.

The new gate tightening (BB ≥ 20 bps, RSI < 20 for CALL, RSI[-2] > 80 for PUT) was **not yet live** during this session — indicators.js was updated after the session ran.

---

## Hourly Breakdown

| Hour (UTC) | W | L | WR | P/L |
|---|---|---|---|---|
| 16:00 | 12 | 22 | **35%** | -$5,840 |
| 17:00 | 86 | 96 | 47% | -$12,690 |
| 18:00 | 91 | 85 | **52%** | -$6,480 |
| 19:00 | 85 | 76 | **53%** | -$5,045 |
| 20:00 | 58 | 57 | 50% | -$6,380 |

16:00 UTC is the worst hour — 35% WR, -$5,840 in only 34 trades. This matches the pattern from the previous session (first 30–60 min after market open tends to be noisier). 18:00–19:00 was the best window (52–53% WR) but still lost due to payout drag.

---

## CALL vs PUT

| Direction | W | L | WR | P/L |
|---|---|---|---|---|
| CALL | 100 | 96 | **51.0%** | -$7,350 |
| PUT | 232 | 240 | **49.2%** | -$29,085 |

PUT dominated volume (472 vs 196 CALL) and lost the most. Neither direction is producing positive P/L — the 50% WR is below the ~54% break-even threshold for 92% payout on $500 stakes.

---

## Asset Winners (P/L > +$500)

| Asset | W | L | WR | P/L |
|---|---|---|---|---|
| YERUSD_otc | 13 | 4 | 76% | +$3,500 |
| AUDNZD_otc | 10 | 4 | 71% | +$2,565 |
| EURUSD_otc | 11 | 6 | 65% | +$1,965 |
| AUDJPY_otc | 12 | 6 | 67% | +$1,920 |
| USDARS_otc | 9 | 3 | 75% | +$1,895 |
| USDCAD_otc | 12 | 4 | 75% | +$1,685 |
| USDBRL_otc | 7 | 3 | 70% | +$1,245 |
| USDMXN_otc | 10 | 6 | 63% | +$1,200 |
| GBPJPY_otc | 8 | 5 | 62% | +$1,080 |
| AUDCAD_otc | 11 | 8 | 58% | +$1,060 |

These 10 assets combined: +$17,115. Strong cluster of commodity-linked and cross pairs.

---

## Asset Losers (P/L < -$2,000)

| Asset | W | L | WR | P/L | Flag |
|---|---|---|---|---|---|
| USDJPY_otc | 3 | 11 | 21% | -$4,265 | BLOCK |
| LBPUSD_otc | 8 | 13 | 38% | -$3,815 | BLOCK |
| EURTRY_otc | 4 | 9 | 31% | -$3,445 | BLOCK |
| USDIDR_otc | 4 | 10 | 29% | -$3,185 | BLOCK |
| EURGBP_otc | 1 | 7 | 13% | -$3,110 | BLOCK |
| CADJPY_otc | 7 | 12 | 37% | -$3,015 | BLOCK |
| NGNUSD_otc | 7 | 11 | 39% | -$3,000 | BLOCK |
| SARCNY_otc | 2 | 7 | 22% | -$2,770 | BLOCK |
| EURCHF_otc | 6 | 11 | 35% | -$2,740 | BLOCK |
| EURJPY_otc | 3 | 8 | 27% | -$2,675 | BLOCK |
| ZARUSD_otc | 4 | 9 | 31% | -$2,660 | BLOCK |
| JODCNY_otc | 3 | 7 | 30% | -$2,535 | BLOCK |
| USDSGD_otc | 5 | 8 | 38% | -$2,390 | BLOCK |
| QARCNY_otc | 2 | 6 | 25% | -$2,080 | BLOCK |
| UAHUSD_otc | 5 | 8 | 38% | -$2,080 | BLOCK |

These 15 assets combined: -$43,770. Every one of them is below 40% WR (break-even is ~54%). They are drowning the winners.

---

## Stale Feed Guard

Guard 2 (duplicate candle push) fired **477 times** — active throughout the session, starting as early as 12:55 UTC (before live trading began). The feed freeze pattern is persistent and widespread across assets. Guard 1 (signal blocked on stale timestamp) fired **0 times** — the candle push guard is catching the freeze at the right layer before a signal is ever evaluated.

---

## Unresolved Orders (session-end)

Six orders never received a result sync match and were still pending at shutdown (20:20 UTC):

- #621 USDARS_otc PUT — 30 failed match attempts
- #620 AUDNZD_otc CALL — 30 failed match attempts
- #667 EURTRY_otc PUT — 13 failed match attempts
- #660 GBPAUD_otc PUT — 14 failed match attempts
- #681 USDCAD_otc PUT — 8 failed match attempts
- #680 CADJPY_otc PUT — 8 failed match attempts

The `⚠️ No deals found — check closed tab selector or DOM` warning fired 8 times in the final minutes of the session — Pocket Option's DOM changed or the closed-deals tab lost visibility. Results for these orders are unknown.

---

## Key Observations

**1. Volume is the main lever.** 668 trades in 4 hours at a flat ~50% WR produces a guaranteed loss due to payout asymmetry (92% on wins, 100% loss on losses). Break-even requires ~54.3% WR. The strategy needs fewer, higher-quality entries — not more.

**2. The loser pool is large and consistent.** 15 assets are contributing -$43,770 while 10 winners contribute +$17,115. The net is -$26,655 from asset selection alone before accounting for flat assets. USDJPY, EURGBP, SARCNY, EURJPY, QARCNY — these repeat as losers across sessions. They should be pre-blocked at session start.

**3. The gate tightening was not live yet.** Changes from the session report (BB ≥ 20 bps, RSI < 20, PUT RSI[-2] > 80) are now implemented. These will materially reduce signal volume on marginal setups — which is the goal.

**4. The result-sync DOM issue is recurring.** The "No deals found" warnings at session end indicate the closed-deals selector is unreliable when the asset list is short. This is a bot-side UI issue, not a strategy issue.

**5. 16:00 UTC open is consistently bad.** Third session in a row where the first hour (16–17 UTC) produces below 40% WR. Should consider delaying bot start to 17:00 UTC or applying a stricter gate in that window.

---

## Recommended Actions

1. **Block the 15 consistent losers** at session start using `po_auto_block_sweep` + manual `po_block_asset` for: USDJPY, LBPUSD, EURTRY, USDIDR, EURGBP, CADJPY, NGNUSD, SARCNY, EURCHF, EURJPY, ZARUSD, JODCNY, USDSGD, QARCNY, UAHUSD
2. **Let the new gate tightening run** (BB ≥ 20, RSI < 20 CALL, RSI[-2] > 80 PUT) — this session was pre-change; next session will show reduced signal volume
3. **Skip 16:00–17:00 UTC** or restrict to top-5 assets only in that window
4. **Investigate result-sync DOM selector** — `⚠️ No deals found` is leaving real trades unaccounted
