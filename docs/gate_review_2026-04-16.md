# Gate Change Review — 2026-04-16

Review of the three MODE D gate changes implemented from the session report. Backtested against the current DB (48 assets, ~5.7 hours of data, 10,979 evaluable bar pairs with full indicator history).

---

## Data Limitation

The current `trading_data.db` contains **only today's session** — 5.7 hours, 11,642 indicator rows across 48 assets. The session report that drove these changes was generated from a much larger historical dataset (1,689 replayed signals). The numbers below reflect today's data only. The direction of each gate's effect is correct; the absolute signal counts are low by design — today's window simply doesn't have enough bars for robust statistical validation.

---

## Signal Volume: Old Gates vs New Gates

| | CALL fired | CALL WR | PUT fired | PUT WR |
|---|---|---|---|---|
| Old gates (RSI<40, BB≥10, no g0) | 7 | 57.1% | 2 | 100% |
| **New gates (RSI<20, BB≥20, g0)** | **2** | **50.0%** | **1** | **100%** |

Signal volume dropped from 9 total → 3 total on today's data. Win rate held or improved for PUT (1/1 validated). CALL dropped from 4/7 to 1/2 — too few to judge.

---

## CALL Gate Funnel

Starting from 10,979 evaluable bars:

| Gate | Bars passing | Drop |
|---|---|---|
| g1: MA6 < MA14 | 5,234 | — |
| g2: K crash > 25 pts | 114 | -5,120 |
| g3: K < 25 (oversold) | 56 | -58 |
| g4: K[-1] ≥ 50 (crashed from mid) | 13 | -43 |
| **g5: RSI < 20 (new) vs RSI < 40 (old)** | **2 vs 12** | **-10 signals lost to tightening** |
| g6: maTrend > -20 | 2 | 0 |
| g7: BB ≥ 20 bps (new) | **2** (pass) | — |
| g7: BB ≥ 10 bps (old) | 7 (pass) | — |

**The RSI < 20 gate is doing almost all the work.** Of 13 bars that pass g1-g4, only 2 have RSI < 20. The old threshold of < 40 passed 12/13 — nearly everything that survived the K crash stack. The new threshold filters 83% of CALL candidates that previously fired.

The BB gate (10→20 bps) eliminates 5 additional signals on top of the RSI filter (7 old passes → 2 new passes after combining both changes).

---

## PUT Gate Funnel

Starting from 10,979 evaluable bars:

| Gate | Bars passing | Notes |
|---|---|---|
| g1: RSI[-2]>70 & [-1]>70, excl 75-80 | 1,701 | Frequent overbought condition |
| g2: RSI falling [38,70) vel>-12, close≥BB mid | 28 | Hard gate — velocity + price position |
| g3: K[-1]>65, K falling, K[0] in [55,80) | 14 | |
| g4: D ≥ 80 | 4 | D lagging high is rare |
| g5: MA6 > MA14 | 4 | |
| g6: K-D spread < -3 | 4 | |
| g7: maTrend < 20 | 3 | |
| g8: BB ≥ 20 bps (new) | 2 | vs 2 at BB ≥ 10 — no difference here |
| **g0: RSI[-2] > 80 (new, applied last)** | **1** | **Removes 1 of 2 qualifying bars** |

**The PUT funnel was already extremely tight before g0.** Only 3 bars reached g7, and 2 passed the BB gate. g0 (RSI[-2] > 80) then eliminates 1 of those 2 — the one where bar-2 RSI was in the 70-80 range rather than genuinely overbought. On today's data this is a 50% reduction in PUT signals. On the larger historical dataset it had a more meaningful impact (the session report showed PUT was the higher-edge direction).

The BB gate change (10→20 bps) had **zero impact on PUT** on today's data — both thresholds passed the same 2 bars. This confirms BB ≥ 10 was already filtering the flat-market cases for PUT; raising to 20 is more conservative but not a significant change for this pattern.

---

## What the Gate Changes Actually Do

### Change 2 — BB ≥ 20 bps (was 10)

- CALL: cuts 5 signals that passed the old threshold (7→2 after RSI change)
- PUT: no impact on today's data — PUT setup conditions already require volatility through other gates
- Net effect: further reduces noise in flat-market periods; does not materially change the PUT edge

### Change 3 — PUT g0: RSI[-2] > 80

- Removes PUT signals where RSI touched 70-80 two bars ago but never reached a genuine overbought peak
- Today: cuts 1 of 2 qualifying PUT signals (50% reduction)
- Historically (session report): improved PUT WR significantly — the 70-80 zone was producing false reversals
- This gate is working as intended but will make PUT signals very rare

### Change 4 — CALL RSI < 20 (was < 45)

- The most aggressive change. Cuts 10 of 12 CALL candidates that passed g1-g4
- Only bars with extreme RSI readings qualify now — true capitulation, not just mild pullbacks
- On the session report data this improved CALL WR significantly; on today's 5-hour window it's impossible to validate (2 signals is not a sample)

---

## Concern: Signal Starvation

On a 5-hour session at normal market activity, the new gates produce approximately **2-3 total signals** across 48 assets. That is not enough volume to trade meaningfully. A full trading day would likely produce 8-15 signals based on scaling from today's data.

However — the session we just reviewed (668 trades at 49.7% WR, -$36,435) demonstrates the opposite failure mode: too many signals at breakeven WR guaranteed a loss due to payout asymmetry. **The question is where the actual edge lies, not how to maximise volume.**

The previous session report showed that on the larger dataset, the tighter gates produced meaningfully higher WR (≥ 60% for the patterns that passed). We need more data in the DB to validate this properly.

---

## Recommendation

The gate direction is correct — all three changes filter out the low-confidence setups that were diluting session WR. The immediate concern is that the historical data in the DB is too thin (5.7 hours) to give a meaningful signal count for backtesting.

**Short term:** Run the bot for 2-3 sessions with the new gates live. Observe how many MODE D signals fire vs how many would have fired under old gates (log both). The signal reason strings in `trades_ordered` already include the pattern name and BB width — this is enough to audit.

**Recalibration candidates if too few signals:**

- CALL RSI: try < 25 or < 30 as a middle ground between old (< 45) and new (< 20)
- BB threshold: the 20 bps gate seems right; keep it
- PUT g0: keep it — it is a meaningful quality filter

Run `po_simulate call_rsi_max=25` or `call_rsi_max=30` once more data accumulates in the DB.
