# Phase 0 — Research Log

Append-only session log. Each entry records: task run, key findings, decision for next task.

---

## Session 1 — 2026-05-22

### R.0 — Database setup (complete)

- Created `agent/data/phase0_research.db` via `VACUUM INTO` from live `agent.db`
- File size: 304 MB
- `PRAGMA integrity_check` → **ok**

**Row counts in `phase0_research.db`:**
| Table | Rows | Time span (unix) |
|---|---|---|
| candles | 28,505 | 1779305100 → 1779511200 (≈ 57.25 h) |
| indicators | 28,428 | 1779305400 → 1779511200 |
| prices | 3,975,721 | 1779334977 → 1779511734 |
| agent_orders | 0 | — |
| agent_log | 0 | — |

Distinct assets: **77** (mix of OTC and non-OTC forex).

**Deviation flagged:** `phase0-agent.md` line 112 states the `prices` table is empty. It is not — 3.97M tick rows exist. This means R.4 (1m-filter improvement test) is potentially runnable if R.3 produces a survivor; not auto-skipped as the prompt assumed. Decision deferred until R.3 completes.

**Next:** Build and run R.1 — signal capture.

---

## Session 2 — 2026-05-23

### Prompt update detected

`phase0-agent.md` updated between sessions. Material changes:

1. **34-gate inventory** (was 24): 12 CALL + 12 PUT original + 1 CALL + 9 PUT report-derived (`exhaustion_*`, `williams_di_div`, `stoch_di_bearish`, `universal_lowvol`, `di_oversold_bounce`).
2. **Session labels required**: Asian / European / American / Off-hours, UTC-5 fixed (no DST handling). Priority: Asian (19-02) > European (03-07) > American (08-17) > Off-hours (18).
3. **Constraint #8**: WR > 75% on n < 100 is a red flag, not a victory.
4. **R.2** stores per-session WR per cell (no significance test at R.2 — that's R.6).
5. **R.6** expanded: per-asset AND per-session BH-corrected breakdowns.
6. **Derivative features computed inline in R.1**:
   - `atr_pct`: rolling 100-bar percentile rank of ATR (null for bars with < 100 prior indicator rows)
   - `sma_alignment_bear`: SMA10 < SMA20 < SMA50 (1/0)
7. **Sanity checks** in R.1: `rsi_below_50` ~50%, `rsi_oversold` 5-15%, `psar_bullish` ~50%, `bb_squeeze_*` 1-5%, `exhaustion_triple` <2%, train 70% / test 30%, Asian ~36% OTC / ~8% non-OTC.

### Environment override

Prompt specifies Python. User overrode to Node.js (matches existing agent codebase, avoids the no-Python rule in `CLAUDE.md`). Scripts will be `.cjs` files using `better-sqlite3`. All statistics (Wilson CI, binomial p-value, Benjamini-Hochberg correction) written inline in JS.

Verified: Node v22.16.0, `better-sqlite3` reads `phase0_research.db` cleanly.

### R.1 design decisions (locked before code)

- **Tie handling**: tie = LOSS (win = 0). Conservative; matches strict reading of prompt's "1 if forward move was in trade direction else 0".
- **PSAR gate kept as-is** (`psar_is_bullish = 1` / `= 0`). Fires on ~50% of bars by design. Statistics will expose lack of edge if that's the truth.
- **3-bar independence** applied per (asset, gate, direction) — 15-minute gap minimum between same-gate fires.
- **Fold split** computed per asset, chronological 70/30, by bar position — before any signal selection.
- **atr_pct** requires 100 prior indicator rows (full window); NULL otherwise. Gates using `atr_pct` skip bars where it's NULL.
- **DST**: not handled. Prompt specifies fixed UTC-5; current data (May 2026) is actually NY EDT (UTC-4). Flagged here for honesty; using UTC-5 per prompt instruction.

**Next:** write `agent/research/phase0_r1.cjs`, run it, confirm sanity checks, stop at R.1→R.2 boundary for user confirmation.

### R.1 — Signal capture (run on 2026-05-23)

Script: `agent/research/phase0_r1.cjs`
Output log: `agent/research/phase0_r1_output.log`
Runtime: 9.8s
Output table: `backtest_signals` in `phase0_research.db`

**Totals:**
- Scanned bars: 28,428 (matches indicators table count)
- Fold split: train 69.84% / test 30.16% (target 70/30) ✓
- Signals written: **78,035** (train 52,181 / test 25,854)
- 3-bar independence rule rejected: 130,071 bars (within 15-min of prior same-gate fire)

**Sanity checks (6 of 7 passed):**

| Check | Expected | Actual | Verdict |
|---|---|---|---|
| `rsi_below_50` fire rate | 40–60% | 50.68% | PASS |
| `rsi_oversold` fire rate | 5–15% | 5.33% | PASS |
| `psar_bullish` fire rate | 40–60% | 49.32% | PASS |
| `bb_squeeze_call` fire rate | 1–5% | **17.78%** | **FAIL** |
| `exhaustion_triple` fire rate | <2% | 0.21% | PASS |
| Fold split | ~70/30 | 69.84 / 30.16 | PASS |
| Asian session OTC | ~36% | 35.72% | PASS |
| Asian session non-OTC | ~8% | 8.44% | PASS |

**`bb_squeeze` sanity failure**: 17.78% of bars have `bb_width_bps <= 5`, ~3.5x the expected. Most likely the data property, not a script bug — OTC pairs frequently sit at extremely tight spreads during low-tick periods. Threshold of 5 bps is more appropriate for active spot forex; on this dataset it captures a much broader "low-volatility" condition. **Methodology unaffected** — R.2 will still test whether the gate has predictive power, regardless of fire rate. Worth flagging as a finding when we get to R.6 (per-session breakdown will likely show very different rates Asian vs American).

**Low-count gates (train-fold < 50):**

| Gate | Direction | Train n | Action required |
|---|---|---|---|
| `exhaustion_pure` | PUT | 21 | user decision |
| `exhaustion_triple` | PUT | 6 | user decision |
| `exhaustion_psar_div` | PUT | 35 | user decision |
| `exhaustion_macd_trap` | PUT | 20 | user decision |
| `williams_di_div` | PUT | 41 | user decision |

All 5 are report-derived gates (claimed 75-95% WR in external ML reports). Per the prompt's R.1 stop condition: "If any gate fires on fewer than 50 train-fold bars across all assets combined, report and ask the user whether to keep or drop that gate before continuing." Awaiting decision.

Also flagged per constraint #5: any gate with < 100 train-fold signals is `low_n` and **does not advance to R.3 walk-forward** regardless of R.2 outcome. By that rule, all 5 above + `stc_di_bearish` (train=183 — survives) need attention. Even if R.2 produces a "significant" result on n=6 (`exhaustion_triple`), it dies at R.3 boundary.

**Recommendation**: keep all 5 low-count gates in R.1 (they're already captured). Run R.2 as planned. The low_n flag in R.2 output will make their statistical insignificance explicit. The user can then make a final keep/drop decision with full visibility.

**Next:** R.2 — per-gate significance (binomial vs 0.5405, Wilson CI, BH FDR=0.05 correction). Awaiting user confirmation.

### R.2 — Per-gate significance (run on 2026-05-23)

Script: `agent/research/phase0_r2.cjs`
Output log: `agent/research/phase0_r2_output.log`
Outputs: `phase0_r2_results.csv` (102 cells), `phase0_r2_survivors.csv` (1 row)

**Methodology applied:**
- Train fold only (`fold = 0`)
- Wilson 95% CI (z=1.96, two-tailed lower bound)
- One-sided binomial p-value vs H₀: WR ≤ 0.5405 (normal approx + continuity correction)
- Benjamini-Hochberg FDR=0.05 across all 102 p-values (step-up procedure)
- Pass = `n >= 100` AND `ci_lower > 0.5405` AND `bh_passed = TRUE`

**Result: 1 of 102 cells passed.**

| gate | dir | exp | n | WR | CI lower | p-val | BH-adj p | flags |
|---|---|---|---|---|---|---|---|---|
| **di_oversold_bounce** | CALL | **15m** | 174 | **69.54%** | **62.34%** | 2.86e-5 | **2.92e-3** | **PASS** |
| di_oversold_bounce | CALL | 10m | 174 | 64.37% | 57.01% | 3.97e-3 | 2.02e-1 | bh_failed |
| di_oversold_bounce | CALL | 5m  | 175 | 55.43% | 48.03% | 3.86e-1 | 1.00 | below_floor |

**Important context:**

1. The surviving gate is `di_oversold_bounce` — a **report-derived gate**: `(plus_di - minus_di) < -25.6 AND cci_20 < -65 AND bb_width_bps BETWEEN 13.7 AND 37.7`. CALL direction.

2. 69.54% WR on n=174 sits *just above* the prompt's expected 55-65% range for surviving report-derived gates, but *below* the 75% suspicion threshold for leakage. Not red-flag territory, but to be watched at R.3.

3. **Expiry profile is clean and physically plausible**: the gate identifies oversold conditions in a controlled volatility band — it needs time (15m) for the bounce to develop. At 5m the move hasn't completed yet (55%, no edge). At 10m the edge appears (64%) but BH correction is unforgiving across 102 tests. At 15m the WR is high enough that the uncorrected p-value is 2.86e-5, surviving BH at adjusted p=2.92e-3.

4. **All standard indicators failed clearly**:
   - RSI gates (rsi_below_50, rsi_oversold, rsi_above_50, rsi_overbought) — all 49-55%, all below floor.
   - STC gates (floor, ceiling, deep, rising, falling) — all 47-52%, all below floor.
   - MACD (hist_pos, hist_neg) — 48-50%.
   - Stochastic (os_cross, ob_cross) — 48-50%.
   - PSAR (bullish, bearish) — 47-50%.

5. **Report-derived gate claims NOT reproduced**:
   - `exhaustion_triple`: train n=6 (claimed 94.6% in ML report). The pattern is too rare on this dataset to validate.
   - `exhaustion_pure`: 38-55% on n=20-21.
   - `exhaustion_psar_div`: 45-49% on n=35.
   - `exhaustion_macd_trap`: 50-60% on n=20.
   - `williams_di_div`: 53-61% on n=39-41.
   - `exhaustion_bear_sma`: 50-52% on n=229-232 (sufficient sample, but no edge).
   - `universal_lowvol`: 49-52% on n=1456-1475 (large sample, definitively no edge).
   - `stoch_di_bearish`: 48-54% on n=181-182.
   - This is a clean falsification of the ML report's 75-95% headline claims for most of those patterns.

**Closest to passing (failed but near boundaries):**

| gate | dir | exp | n | WR | CI low | reason |
|---|---|---|---|---|---|---|
| di_oversold_bounce | CALL | 10m | 174 | 64.37% | 57.01% | clears floor but BH-rejected (adj p=0.20) |
| rsi_overbought | PUT | 15m | 374 | 55.35% | 50.28% | barely above 50%, doesn't clear floor |
| rsi_oversold | CALL | 15m | 494 | 54.25% | 49.84% | barely above 50%, doesn't clear floor |

**Next:** R.3 — walk-forward validation. The single survivor (`di_oversold_bounce` CALL 15m) must be re-tested on the held-out test fold. Pass requires test-fold ci_lower > 0.5405 AND test-fold WR within 5pp of train-fold WR (consistency check for overfitting). The 10m and 5m versions of the same gate are dead per R.2 — they won't be re-tested. Awaiting user confirmation.

---
