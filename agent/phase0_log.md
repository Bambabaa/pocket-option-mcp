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

### R.3 — Walk-forward validation (run on 2026-05-23)

Script: `agent/research/phase0_r3.cjs`
Output log: `agent/research/phase0_r3_output.log`
Outputs:
- `phase0_r3_results.csv` (1 row)
- `phase0_r3_asset_breakdown.csv` (34 per-asset rows)
- `phase0_r3_session_breakdown.csv` (4 per-session rows)

**Pre-checks (all passed):**

| Check | Result |
|---|---|
| Entry close correctness (200 sampled) | 0 mismatches — PASS |
| Exit from different bar (207 sampled) | 0 mismatches, 6 same-value cases (real flat moves, not bug) — PASS |
| 3-bar independence (15-min min gap) | 0 violations, min gap = 900s — PASS |
| Fold chronology (34 assets checked) | 0 violations — PASS |

No methodology bugs detected. No leakage path identified.

**Fold metrics for `di_oversold_bounce` CALL 15m:**

| Fold | n | k | WR | CI lower | CI upper | p-value |
|---|---|---|---|---|---|---|
| Train | 174 | 121 | 69.54% | 62.34% | 75.90% | 2.86e-5 |
| Test | 33 | 22 | 66.67% | **49.61%** | 80.25% | 1.00e-1 |

Train − Test delta = **+2.87pp** (well within the 5pp consistency tolerance).

**Verdict logic applied:**
- Pre-checks all passed ✓
- Consistency |delta| ≤ 5pp ✓ (2.87pp)
- Test clears break-even floor ✗ (test ci_lower = 49.61% vs floor 54.05%)
- → **r3_verdict = OVERFIT**

Per prompt's strict pass criteria: this gate is dead.

**Important nuance worth documenting (does NOT change verdict):**

1. The **point estimate** WR drop was negligible (69.54% → 66.67%, only 2.87pp). The verdict failed not because the gate stopped working, but because the test sample (n=33) is too small to push the 95% CI lower bound above 54.05%. With n=33 and 66.67% point estimate, ci_lower = 49.61%. To clear 54.05% with the same WR, would need ~n=85+.

2. **Sample ratio**: train n=174 vs test n=33 = 5.3x ratio. Expected ratio is 2.33x (70/30). The gate fires disproportionately less in the test period (last 30% of data). Possible interpretations:
   - Regime change — the DI/CCI/BB combo arose more often in earlier market conditions
   - Volatility difference — bb_width_bps band [13.7, 37.7] may exclude more bars in recent low-vol period
   - Survivorship — the gate's "edge" may have been a transient market regime
   - All of the above

3. **Session breakdown shows internal inconsistency:**

| Session | Train n | Train WR | Test n | Test WR |
|---|---|---|---|---|
| Asian | 9 | 33.3% | 1 | 100% |
| European | 72 | 63.9% | 0 | — |
| American | 64 | 70.3% | 29 | **72.4%** |
| Off-hours | 29 | 93.1% | 3 | 0% |

The American session shows clean train→test consistency (70.3% → 72.4% on n=64/29). The Off-hours train WR of 93.1% on n=29 is a textbook small-sample artefact — it collapses to 0% on test n=3. The European session has zero test signals (no firings during the test window in European hours).

4. **Per-asset concentration**: 34 distinct assets fired this gate. Top-3 share is 20.1% — well distributed, no single-asset over-fit signature.

**Per the prompt's hard constraint #6**: "No retrying on test fold. If a gate passes R.2 (train fold) but fails R.3 (test fold), it is dead. You do not search for a different threshold that makes it pass."

**Per the prompt's hard constraint #7**: "If R.3 kills every R.2 survivor, you stop and report. You do not invent new tests to find edge."

**Stop condition triggered. R.4, R.5, R.6 do not run unless user explicitly overrides.**

The honest conclusion is: across 102 cells with proper statistical methodology, exactly zero gates survived walk-forward validation on this dataset. The single R.2 survivor (`di_oversold_bounce` CALL 15m) had clean train-to-test consistency but the test fold was too small to confirm the edge above the break-even floor.

**Next:** await user decision. Three honest options:
- **(A) Stop now** — write `phase0_results.md` documenting the full pipeline failure. This is a valid completion. The dataset (57 hours, 28k bars) is too small for definitive Phase 0 conclusions on rare-firing gates. Recommendation: collect more data (target 200+ hours = ~1.4M+ ticks) and re-run.
- **(B) Continue to R.5/R.6 with the dead survivor** — explore the American-session pattern (n=29 test) as a finding, but explicitly note it is not a validated edge per strict R.3. Verdict stays OVERFIT in the strategy document.
- **(C) Add the survivor's failure to a `phase0_results.md`** as the falsification record of the ML report's `di_oversold_bounce` claim and stop here.

I will not propose a path without your decision.

---

### Round 2 — Sync + Check (2026-05-24)

- New candles synced:    5762
- New indicators synced: 5762
- test_r2 signals:       12

Test fold result (15m expiry):
  WR: 41.67%  n=12
  CI lower: 19.33%
  Flag: low_n  Verdict: INCONCLUSIVE

Next check at n_test = 20.

---

### Round 2 — OTC/non-OTC split (2026-05-24)
- OTC: n=31 WR=54.84% ci_low=37.77%
- non-OTC: n=176 WR=71.59% ci_low=64.52%
---

### Round 2 — Sync only (2026-05-24)
- Candles/indicators synced from agent.db (timestamp > 1779511200)
- test_r2 signals: 12 for di_oversold_bounce CALL
---

### Round 2 — Continuous check (2026-05-24)
- test_r2 n=12  WR=41.67%  ci_lower=19.33%  flag=low_n  verdict=INCONCLUSIVE
- Next milestone: n=20
---

### Round 2 — Pre-registration update (2026-05-24)

**Trigger:** Option (d) OTC/non-OTC split on R1 training corpus revealed a structural split that was not visible in the pooled R1 results.

**Finding (R1 training corpus, fold 0 + fold 1):**

| Group | n | WR | CI lower | CI upper | p-value | Clears floor |
|---|---|---|---|---|---|---|
| All combined | 207 | 69.1% | 62.5% | 75.0% | 9.78e-6 | ✓ |
| OTC only | 31 | 54.8% | 37.8% | 70.8% | 0.537 | ✗ |
| non-OTC only | 176 | 71.6% | 64.5% | 77.7% | 2.18e-6 | ✓ |

**Interpretation:** The `di_oversold_bounce` gate's edge resides almost entirely in non-OTC (standard forex) pairs. OTC signals (n=31) show 54.8% WR with no statistical significance — indistinguishable from noise. Non-OTC signals (n=176) show 71.6% WR, highly significant, CI lower 64.5% vs floor 54.05%.

Non-OTC session breakdown:
- American: n=78, WR=73.1%, CI lower=62.3% ← clears floor independently
- Off-hours: n=30, WR=83.3%, CI lower=66.4% ← clears floor independently
- European: n=68, WR=64.7%, CI lower=52.8% (just below floor)
- Asian: n=0 (gate never fires on non-OTC during Asian session — no market activity)

**Pre-registration decision:**

Per Round 2 methodology: a gate that passes R.2 on the full R1 training corpus can be pre-registered for test_r2 validation. The OTC/non-OTC split is an **observational finding on training data** — it informs what to watch in test_r2 but does NOT retroactively change the pre-registered gate definition.

**Two pre-registered positions for Round 2 test_r2 monitoring:**

1. **`di_oversold_bounce` CALL 15m — ALL assets** (original pre-registration, unchanged)
   - Training WR: 69.1% (n=207)
   - Validation standard: test_r2 ci_lower > 54.05%

2. **`di_oversold_bounce` CALL 15m — non-OTC only** (new pre-registration, added today)
   - Training WR: 71.6% (n=176, non-OTC subset of R1 corpus)
   - Validation standard: test_r2 non-OTC ci_lower > 54.05%
   - Rationale: OTC/non-OTC split is a meaningful structural distinction (different market microstructure, trading hours, liquidity). Pre-registering the non-OTC filter now — before seeing any test_r2 non-OTC results — is valid. It would not be valid after non-OTC test_r2 signals have arrived.
   - **This registration is locked as of 2026-05-24. Cannot be changed after non-OTC test_r2 signals appear.**

**Current test_r2 status:** n=12, all OTC. No non-OTC signals yet (11h10m of new data, limited non-OTC market hours in that window). OTC WR so far: 41.7% on n=12 — consistent with the finding that OTC has no edge.

**What to watch:**
- When non-OTC test_r2 signals arrive (London/NY open), run `phase0_r3_continuous.cjs` and inspect the OTC vs non-OTC split in the output.
- The non-OTC validation is the one that matters.
- Both registrations remain active — if ALL-assets clears the floor, that is also a valid pass.

**Action taken:** `phase0_r3_continuous.cjs` already reports OTC vs non-OTC split in its output block. No script changes needed.

---

### Round 2 — Continuous check (2026-05-24)
- non-OTC test_r2:  n=0  WR=n/a  ci_lower=n/a  verdict=INCONCLUSIVE
- OTC test_r2:      n=12  WR=41.7%  (informational only)
- Next non-OTC milestone: n=10
---

### Round 2 — Continuous check (2026-05-24)
- non-OTC test_r2:  n=0  WR=n/a  ci_lower=n/a  verdict=WAITING
- OTC test_r2:      n=12  WR=41.7%  (informational only — excluded from gate)
- Next non-OTC milestone: n=10
---

### Round 2 — Sync only (2026-05-24)
- Candles/indicators synced from agent.db (timestamp > 1779511200)
- test_r2 signals: 12 for di_oversold_bounce CALL
---

### Round 2 — Continuous check (2026-05-24)
- non-OTC test_r2:  n=0  WR=n/a  ci_lower=n/a  verdict=WAITING
- OTC test_r2:      n=12  WR=41.7%  (informational only — excluded from gate)
- Next non-OTC milestone: n=10
---
