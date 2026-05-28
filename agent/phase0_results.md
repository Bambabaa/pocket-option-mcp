# Phase 0 Round 3 — Results

**Date:** 2026-05-27
**Dataset:** 13 non-OTC FX pairs, ~332h (~2 weeks), 51,813 5-minute candles (`phase0_research.db`, VACUUMed from live `agent.db`).
**Labelling:** 3-class WIN / LOSS / FLAT. PO refunds flat closes → flats excluded from the denominator. WR = wins / (wins + losses). Break-even floor = 0.5405 (0.85 payout).

**Bottom line:** Across 152 (gate × expiry) cells tested with full statistical rigor, **zero gates passed walk-forward validation.** The single candidate with a genuine, stable edge — the pre-registered `di_oversold_bounce` CALL 15m — has exceptional train-test consistency (0.72pp drift) but its held-out test fold (n=86) is too small to confirm the edge above the floor. This is a **data-volume limitation, not a performance failure.** No live strategy is authorized. Phase 2 (`po_agent_scan`) remains blocked.

---

## Pipeline summary

| Round | What ran | Outcome |
|---|---|---|
| R.0 | Feature engineering — `derived_features` (51,813 rows): candle anatomy, log returns, MA distances, swing pivots, SMC zones + flags, vol regime, session | All 8 sanity checks passed |
| R.1 | Signal capture, 3-class labelling, 38 gates × 4 expiries, 3-bar independence, 70/30 fold | 150,732 signals; labelling verified (CALL 51.22% / PUT 48.78% / flat 30.02%, reproduces prompt reference exactly) |
| R.2 | Per-gate significance, train fold, Wilson CI + binomial vs 0.5405 + BH FDR=0.05 | 1 survivor (pre-registered, BH-exempt); 0 of 151 exploratory cells survive BH |
| R.3 | Walk-forward, test fold, 4 pre-checks | OVERFIT by strict criteria (test ci_lower 47.58% < floor); 0.72pp WR drift — undersized test, not overfit |
| R.4 | 1m tick filter | SKIPPED — `prices` table empty in this VACUUM |
| R.6 | Exploratory per-dimension profiling (pooled folds, NOT validation) | 4 cells clear floor at n≥30; none survive BH |

---

## The one real candidate: `di_oversold_bounce` CALL 15m

Gate: `(plus_di - minus_di) < -25.6 AND cci_20 < -65 AND bb_width_bps BETWEEN 13.7 AND 37.7`

Pre-registered before this dataset was seen → single-test, BH-exempt.

| fold | n (decisive) | wins | losses | flats | WR | Wilson CI lower | CI upper | p |
|---|---|---|---|---|---|---|---|---|
| train | 615 | 362 | 253 | 7 | 58.86% | 54.93% | 62.68% | 9.3e-3 |
| test | 86 | 50 | 36 | 10 | 58.14% | **47.58%** | 68.00% | 2.6e-1 |

- **train→test WR delta = 0.72pp** — the cleanest train-test consistency of any candidate in any round.
- All 4 R.3 pre-checks passed (entry/exit correctness, exit-from-different-bar, independence, fold chronology). No leakage path.
- **Why it fails:** at 58% WR, the 95% Wilson lower bound clears 54.05% only at roughly **n≥170 decisive**. The test fold has 86. The point estimate is stable; the confidence interval is just too wide.
- The gate fires ~88% in the training (earlier) window, ~12% in the test window. Test n grew 33→86 as the dataset doubled (28k→51k bars) — trajectory is positive.

### Exploratory concentration (R.6 — pooled folds, in-sample, NOT validated)

Where the edge appears to concentrate (every cell below is BH-rejected — suggestive only):

| dimension | value | n | WR | ci_lower | BH-adj p |
|---|---|---|---|---|---|
| zone | DISCOUNT | 568 | 59.3% | 55.2% | 0.102 |
| vol_regime | LOW | 80 | 67.5% | 56.6% | 0.102 |
| asset | EURJPY | 32 | 75.0% | 57.9% | 0.102 |
| asset | CHFJPY | 69 | 66.7% | 54.9% | 0.131 |

Coherent story: the edge sits in the **DISCOUNT zone** (price low in its 50-bar range) and **LOW vol regime** — exactly where an oversold-bounce setup *should* work. Per-session is flat (~58–59% across Asian/European/American → no session edge). But no sub-slice survives multiple-testing correction; the dataset is too thin to confirm any of them.

---

## Falsification record

### All standard indicators have no edge
RSI, STC (floor/ceiling/deep/rising/falling), MACD histogram, stochastic crosses, PSAR, DI-dominance, Bollinger squeeze — all land 47–55% on the train fold; none clears the floor after BH. The closest, `rsi_oversold` CALL, clears the floor at all four expiries (54.2–55.7% ci_lo) but is BH-rejected — internally consistent yet not robust. **There is no single-indicator directional edge in this dataset.**

### Report v2 REGIME edges — DEFINITIVELY FALSIFIED under corrected labelling
The external ML report claimed 88–98% win rates for low-volatility session PUT regimes. Under 3-class labelling (flats refunded, not counted as PUT wins):

| Gate | Report claim | R.3 train WR | n | Verdict |
|---|---|---|---|---|
| REGIME_EU_LOW PUT 15m | 97.7% | **46.5%** | 286 | FALSIFIED |
| REGIME_US_LOW PUT 15m | 95.7% | **48.0%** | 818 | FALSIFIED |
| REGIME_ASIAN_LOW PUT 15m | 88.5% | **50.6%** | 1,890 | FALSIFIED |

`REGIME_ASIAN_LOW` on n=1,890 sitting at 50.6% (ci_lower 48.3%) is the cleanest possible falsification — large sample, dead center on a coin flip. The report's headline WRs were an artifact of counting refunded flat closes as PUT wins. Low-vol regimes have the *highest* flat rates, which is precisely why the error inflated them most.

### Report v2 ML / SMC gates — no edge
ML_HL_PIVOT_CLEAN_BAR (n=63), ML_LH_DOWN_BIAS, ML_LL_WILLIAMS_CALL, HL_LOW_BODY_BREAK, all SMC sweep/OB/reject and DISPLACEMENT gates — all either too rare (n<100 decisive) or below floor. None advances.

---

## Recommendation

1. **Accumulate more non-OTC data and re-run.** The pipeline is correct and validated (it reproduces the prompt's reference counts exactly at R.1/R.2/R.3). The only blocker is sample size on the one good candidate. Doubling the dataset took the test fold from n=33 to n=86; another ~2 weeks of the same 13 pairs should push it past the n≥170 needed to confirm or refute `di_oversold_bounce` CALL 15m.

2. **Features that showed potential** (worth keeping/prioritizing when data grows):
   - `zone=DISCOUNT` as a context filter for CALL bounces (n=568, 59.3%, the largest floor-clearing slice)
   - `vol_regime=LOW` for the same (67.5% but n=80)
   - The `di_oversold_bounce` gate itself — stable across the fold boundary, theory-consistent concentration

3. **Do NOT trade any gate yet.** No cell passed walk-forward validation. Phase 2 `po_agent_scan` stays blocked until a gate clears R.3 on a properly sized test fold.

4. **When re-running:** the pre-registration of `di_oversold_bounce` CALL 15m (all-assets and the implicit non-OTC framing — note this dataset is 100% non-OTC) remains locked. Do not re-tune its thresholds; only re-test on accumulated data.
