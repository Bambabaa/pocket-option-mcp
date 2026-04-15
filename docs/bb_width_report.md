# BB Width Analysis Report

**Generated:** 2026-04-14  
**Dataset:** 135 validated signals (signal_outcomes joined with indicators), 2026-04-13  
**Strategy:** Fast Trend Follower  
**Trade size:** $500 | Win payout: $460 (92%) | Loss: -$500  
**Breakeven win rate:** 52.2%

---

## 1. BB Width Tier Breakdown

BB width is expressed in basis points (bps): `(bb_upper - bb_lower) / bb_middle × 10000`.

| Tier (bps) | Signals | Wins | Losses | Win% | P&L | CALL n / win% | PUT n / win% |
|---|---|---|---|---|---|---|---|
| 0–2 | 40 | 18 | 22 | 45.0% ❌ | -$2,720 | 16 / 31.3% | 24 / 54.2% |
| 2–4 | 0 | — | — | — | — | — | — |
| 4–6 | 1 | 0 | 1 | 0.0% | -$500 | — | 1 / 0.0% |
| 6–8 | 6 | 4 | 2 | 66.7% | +$840 | 1 / 0.0% | 5 / 80.0% |
| 8–10 | 12 | 5 | 7 | 41.7% ❌ | -$1,200 | 4 / 75.0% | 8 / 25.0% |
| 10–15 | 14 | 8 | 6 | 57.1% | +$680 | 2 / 50.0% | 12 / 58.3% |
| 15–20 | 12 | 7 | 5 | 58.3% | +$720 | — | 12 / 58.3% |
| 20–30 | 16 | 9 | 7 | 56.3% | +$640 | 5 / 20.0% | 11 / 72.7% |
| 30–50 | 18 | 12 | 6 | 66.7% | +$2,520 | 6 / 50.0% | 12 / 75.0% |
| 50+ | 16 | 11 | 5 | 68.8% | +$2,560 | 4 / 75.0% | 12 / 66.7% |
| **TOTAL** | **135** | **74** | **61** | **54.8%** | **+$3,540** | 38 / 42.1% | 97 / 59.8% |

### Key observations

- **40 signals (29.6%) fired in the 0–2 bps dead zone**, producing -$2,720 at a 45.0% win rate
- **59 signals (43.7%) fired below 10 bps total**, producing -$3,580 at 45.8% win rate
- Every tier above 10 bps is profitable; every tier below 10 bps (except the small 6–8 sample) is losing
- The 8–10 bps zone is a particular trap for PUTs: 8 PUT trades at only 25.0% win rate
- Win rate is monotonically improving from 10 bps upward: 57% → 58% → 56% → 67% → 69%
- CALL signals in narrow BBs (0–2 bps) win at only 31.3% — well below breakeven

---

## 2. Threshold Impact Analysis (from signal_outcomes — Fast Trend Follower)

This table shows the effect of applying a hard `bar_bb_bps_min` gate to the live strategy's historical signals.

| Threshold | Signals kept | Blocked | % Blocked | Overall win% | Overall P&L | CALL n / win% / P&L | PUT n / win% / P&L |
|---|---|---|---|---|---|---|---|
| None (baseline) | 135 | 0 | 0.0% | 54.8% | +$3,540 | 38 / 42.1% / -$3,640 | 97 / 59.8% / +$7,180 |
| **≥ 10 bps** | **76** | **59** | **43.7%** | **61.8%** | **+$7,120** | 17 / 47.1% / -$820 | 59 / 66.1% / +$7,940 |
| ≥ 15 bps | 62 | 73 | 54.1% | 62.9% | +$6,440 | 15 / 46.7% / -$780 | 47 / 68.1% / +$7,220 |
| ≥ 20 bps | 50 | 85 | 63.0% | 64.0% | +$5,720 | 15 / 46.7% / -$780 | 35 / 71.4% / +$6,500 |

### Win rate delta vs baseline

| Threshold | Overall delta | CALL delta | PUT delta |
|---|---|---|---|
| ≥ 10 bps | **+7.0 ppts** | +5.0 ppts | +6.3 ppts |
| ≥ 15 bps | +8.1 ppts | +4.6 ppts | +8.3 ppts |
| ≥ 20 bps | +9.2 ppts | +4.6 ppts | +11.6 ppts |

### P&L delta vs baseline

| Threshold | Overall P&L delta | Signals lost | P&L per remaining signal |
|---|---|---|---|
| ≥ 10 bps | **+$3,580** | 59 | $93.7 |
| ≥ 15 bps | +$2,900 | 73 | $103.9 |
| ≥ 20 bps | +$2,180 | 85 | $114.4 |

---

## 3. po_simulate Results (MODE D gate model)

> **Note:** `po_simulate` runs the stricter MODE D gate logic, which fires far fewer signals than the live Fast Trend Follower strategy. Only 3 total signals fired in the candle history under MODE D gates, so these results have very limited statistical weight. The signal_outcomes analysis above (135 trades) is the authoritative source for threshold decisions.

| Scenario | CALL fired | CALL win% | CALL P&L | PUT fired | PUT win% | PUT P&L | Total P&L | Delta |
|---|---|---|---|---|---|---|---|---|
| Baseline | 2 (1 val) | 100.0% | +$460 | 1 (1 val) | 0.0% | -$500 | -$40 | — |
| bar_bb_bps_min=10 | 1 (1 val) | 100.0% | +$460 | 0 | — | $0 | +$460 | **+$500** |
| bar_bb_bps_min=15 | 1 (1 val) | 100.0% | +$460 | 0 | — | $0 | +$460 | **+$500** |
| bar_bb_bps_min=20 | 1 (1 val) | 100.0% | +$460 | 0 | — | $0 | +$460 | **+$500** |

All three thresholds produce identical MODE D simulation results: they block the one losing PUT signal while keeping the winning CALL. The differentiation between thresholds must be drawn from the signal_outcomes data.

---

## 4. Recommendation

### Use `bar_bb_bps_min = 10`

**Rationale:**

1. **Best P&L outcome.** The 10 bps threshold adds +$3,580 to total P&L (+101% improvement), more than the 15 bps (+$2,900) or 20 bps (+$2,180) thresholds — because it keeps more of the profitable 10–20 bps signals that the higher thresholds discard.

2. **Signal volume is preserved better.** 76 signals remain at ≥10 bps vs 50 at ≥20 bps. With only one day of data, reducing to 50 signals increases variance risk significantly.

3. **The 10 bps cutoff is structurally justified.** The 8–10 bps zone is net losing (-$1,200, 41.7% win rate). Everything from 10 bps up is profitable. There is a clear performance cliff at this boundary, not a gradual slope.

4. **Higher thresholds improve win% but reduce absolute P&L.** Going from 10→15→20 bps raises win rate by another 2 ppts but costs $680–$1,400 in foregone profitable signals. The 10–20 bps tier (14 signals, 57.1% win, +$680) is worth keeping.

5. **PUT signals benefit most.** PUT win rate jumps from 59.8% → 66.1% at ≥10 bps, with P&L improving from +$7,180 → +$7,940. PUTs are the strategy's core edge — protecting them matters more than chasing the last few win rate points.

### Implementation note

Apply as a **bar-level filter** (not asset-level `min_bb_bps`), so assets are only skipped at bars where the BB is actually narrow — not excluded entirely based on their historical average. This allows assets like AUDNZD to trade normally during volatile sessions while being skipped during flat periods.

```
bar_bb_bps_min: 10
```

### Secondary recommendation

Once ≥10 bps is live and validated over a larger sample (recommend 500+ signals), revisit whether raising to 15 bps improves real-world performance. The simulated improvement is consistent but the sample is too small to be conclusive at this stage.

---

## 5. Summary

| Finding | Value |
|---|---|
| Signals firing in flat BB (< 10 bps) | 59 / 135 = **43.7%** |
| Win rate below 10 bps | **45.8%** (losing) |
| Win rate above 10 bps | **61.8%** (profitable) |
| Win rate gap | **+16.0 ppts** |
| P&L below 10 bps | **-$3,580** |
| P&L above 10 bps | **+$7,120** |
| Recommended gate | `bar_bb_bps_min = 10` |
| Expected P&L improvement | **+$3,580 (+101%)** on this dataset |
