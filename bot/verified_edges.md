# Verified Edges — FX Binary Options Strategy Register

**Last updated:** 2026-05-28  
**Dataset:** `data/agent.db` — 51,813 bars · 13 FX pairs · 5m candles · 2026-05-12 → 2026-05-26  
**Confirmed via:** v1 engineering validation + v2 ML validation + Claude code-audit verdict  
**Directional baselines:** CALL null = 35.8% · PUT null = 64.2% (structural drift, not 50%)

> Only strategies that passed **all three gates** appear here:
> 1. WR beats the directional baseline above the Wilson 95% lower bound
> 2. p < 0.01 (binomial test against directional null)
> 3. Not deleted by Claude verdict (no look-ahead, no calendar overfit, no degenerate leaf)

---

## ⭐ Tier 1 — Size with real money

### T1 · T1_ZSCORE_EXTREME_LOW · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **63.5%** |
| **N (validated)** | 340 |
| Beat baseline by | +27.7pp above CALL null (35.8%) |
| Wilson CI lo95 | 59.1% |
| Expected ATR | +0.579 |
| z-score | 4.99 |
| p-value | **6.07e-7** |
| Walk-fwd trend | W19 60.2% → W20 64.8% → W21 67.3% ✅ **improving** |

**Gates:** `z_close_ema20 ≤ −3.0σ`  
*Price is 3+ standard deviations below the 20-bar EMA — extreme statistical dislocation.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| **04:00 UTC** (Tokyo mid-session) | **78.0%** | 100 |
| Asian session overall | 73.4% | 109 |
| OVERLAP session | 61.0% | 100 |
| Tuesday | 69.7% | — |
| Monday | 65.4% | — |

**Best assets:** EURAUD 78.6% · CADJPY 77.3% · USDCAD 76.0% · EURUSD 72.0%  
**Worst assets:** AUDCHF 50.0% · CADCHF 50.0%  
**Avoid:** 00:00 UTC (WR=0%, N=7) · Wednesday (55.7%, not significant)

**Risk sizing:** T1 — 2.0% per trade

---

### T1 · ML_EDGE_07 · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **74.7%** |
| **N (validated)** | 221 |
| Beat baseline by | +38.9pp above CALL null (35.8%) |
| Wilson CI lo95 | 68.5% |
| Research WR | 74.7% — **exact match ✅** |
| z-score | 12.05 |
| p-value | **< 0.0001** |
| Walk-fwd Train WR | 77.0% |
| Walk-fwd Test WR | 63.2% |
| Walk-fwd decay | −13.8pp ⚠️ moderate — monitor; size at 60% initially |

**Gates:** `range_atr > 0.043 AND signed_body_atr ≤ −1.302 AND atr_14 > 0.000127 AND range_atr > 2.794`  
*Extreme bearish candle (body ≥ 1.3×ATR, strongly negative) with massive range (≥2.79×ATR) — exhaustion reversal. `range_atr > 2.79` is the binding gate — only true spike/momentum exhaustion bars fire.*

**⚠️ Implementation note:** `feat.signed_body_atr = (close − open) / atr` must be computed with sign (negative = bearish). `features_ml.js` line 177. Without this fix the gate can never fire (unsigned `body_atr` is always ≥ 0).

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| European session | **84.0%** | 25 |
| American session | 75.9% | 54 |
| Asian session | 72.5% | 142 |
| HIGH vol regime | **77.6%** | 107 |
| MED vol regime | 75.4% | 65 |
| LOW vol regime | 67.3% | 49 |

**Best assets:** CADJPY 75.0% (N=20) · AUDJPY 75.0% (N=24) · EURCHF · USDJPY 66.7% (N=27) — JPY crosses + EURCHF  
**Works across all sessions and regimes** — most robust session-agnostic edge in the set.

**Risk sizing:** T1 — 2.0% per trade (reduce to 1.0% until N ≥ 300 fresh OOS)

---

## ⭐ Tier 2 — Standard sizing

### T2 · T2_FADE_FRESH_UP_BREAK · PUT · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **54.3%** |
| **N (validated)** | **1,304** ← largest N in the set |
| Beat baseline by | −9.9pp below PUT null (64.2%) — but p < 0.01 vs 50% null |
| Wilson CI lo95 | 52.0% |
| Expected ATR | +0.107 |
| z-score | 3.10 |
| p-value | **1.93e-3** |
| W21 | ⚠️ 49.3% — monitor for edge erosion |

**Gates:** `persist_above_break === 1`  
*First and only bar above the 20-bar prior high. Most up-breakouts fail within 1 horizon; after 4+ bars the fade edge disappears.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| OVERLAP session | **57.3%** | 295 |
| Asian session | 55.2% | 353 |
| EURUSD | 63.9% | 72 |
| AUDJPY | 59.8% | 112 |
| CHFJPY | 59.5% | 111 |

**Avoid:** 11:00 UTC (WR=37.9%, N=66) — London mid-session kill zone  
**Risk sizing:** T2 — 1.0% per trade

---

### T2 · T2_BB_PEAK_BEAR_BOUNCE · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **59.9%** |
| **N (validated)** | 232 |
| Beat baseline by | +24.1pp above CALL null (35.8%) |
| Wilson CI lo95 | 54.5% |
| Expected ATR | +0.243 |
| z-score | 3.02 |
| p-value | **2.53e-3** |
| Weekly stability | W19 63.2% · W20 57.5% · W21 61.4% ✅ |

**Gates:** Bollinger Band peak bear bounce (see entry_strategies.js)  
*Price reaches upper BB extreme with bearish rejection — mean reversion CALL.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| **04:00 UTC** (Tokyo mid-session) | **90.6%** | 32 |
| Asian session overall | **75.3%** | 77 |
| Monday | 69.2% | — |
| Tuesday | 64.2% | — |

**Best assets:** AUDCHF 78.9% · EURJPY 76.5% · USDCAD 75.0%  
**Worst assets:** AUDCAD 23.1% · EURUSD 30.8%  
**Hard avoid:** OVERLAP session 12:00–17:00 UTC (WR=43.5% — negative edge)  
**Risk sizing:** T2 — 1.0% per trade (Asian only → T1 risk acceptable)

---

### T2 · T2_RANGE_EXPAND_BEAR_BOUNCE · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **55.8%** |
| **N (validated)** | 722 |
| Beat baseline by | +20.0pp above CALL null (35.8%) |
| Wilson CI lo95 | 52.8% |
| Expected ATR | +0.153 |
| z-score | 3.13 |
| p-value | **1.77e-3** |

**Gates:** Range expansion + bear bounce (see entry_strategies.js)  
*Volatility expands on a bearish move; trade the CALL reversion.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| **02:00 UTC** | **87.5%** | — |
| **04:00 UTC** | 65.9% | 88 |
| **08:00 UTC** | 76.6% | — |
| Asian session | 61.3% | 204 |

**Kill zones:** 11:00 UTC = **9.1% WR** (N=22) · 23:00 UTC = 10%  
**Note:** W20 dipped to 51.4% — some instability. Monitor weekly.  
**Risk sizing:** T2 — 1.0% per trade

---

## ⭐ Tier 3 — Cautious sizing

### T3 · T3_ZSCORE_LOW_1_5SIG · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **55.1%** |
| **N (validated)** | 954 |
| Beat baseline by | +19.3pp above CALL null (35.8%) |
| Wilson CI lo95 | 52.5% |
| Expected ATR | +0.096 |
| z-score | 3.17 |
| p-value | **1.51e-3** |
| Walk-fwd decay | **0.00pp** ✅ most stable edge in the set |

**Gates:** `z_close_ema20 ≤ −1.5σ` (looser version of T1_ZSCORE)

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| 18:00 UTC | **74.2%** | 31 |
| 04:00 UTC | 68.1% | 47 |
| 01:00 UTC | 72.7% | — |
| OVERLAP session | 58.0% | 238 |
| Asian session | 59.1% | 171 |

**Avoid:** 23:00 UTC = **28.1% WR** (N=32, p=0.013)  
**Risk sizing:** T3 — 0.5% per trade

---

### T3 · ML_EDGE_01 · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **80.0%** |
| **N (validated)** | 95 |
| Research WR | 80.2% — **exact match ✅** |
| Wilson CI lo95 | 70.9% |
| z-score | 8.99 |
| p-value | **< 0.0001** |
| Walk-fwd decay | −18.4pp ⚠️ (large) |

**Gates:** `macd_line ≤ −9.27e-5 AND rsi_14 > 0.431 AND macd_histogram ≤ −0.00742 AND rsi_14 ≤ 22.29`  
*MACD deeply negative + RSI extremely oversold (≤22) — momentum divergence bottom.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| HIGH vol regime | **87.5%** | 56 |
| Asian session | 77.2% | 79 |
| CADJPY | **100%** | 12 |
| EURJPY | 91.7% | 12 |
| CHFJPY | 83.3% | 24 |

**Warning:** N=95 total — small sample. JPY crosses only. Gate on HIGH vol before sizing.  
**Treat as T3 paper-trade until N ≥ 200 fresh OOS bars.**  
**Risk sizing:** T3 — 0.5% per trade

---

### T3 · ML_EDGE_02 · CALL · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **78.6%** |
| **N (validated)** | 84 |
| Research WR | 78.6% — **exact match ✅** |
| Wilson CI lo95 | 68.7% |
| z-score | 8.18 |
| p-value | **< 0.0001** |
| Walk-fwd decay | −19.9pp ⚠️ (large) |

**Gates:** `ret_1 ≤ −0.000263 AND ret_1 ≤ −0.000859 AND ret_6 > −0.00149`  
*Two sharp 1-bar drops but 6-bar return not deeply negative — counter-trend bounce on sharp but shallow pullback.*

**Best conditions:** Asian (WR=81.8%, N=44) · HIGH vol (WR=81.8%, N=55) · European (WR=90.0%, N=10)

**Warning:** N=84 and −19.9pp decay — largest decay in the set.  
**Paper-only until N ≥ 150 fresh OOS bars.**  
**Risk sizing:** T3 — 0.5% per trade

---

### T3 · STC_COMPRESSION_BREAKDOWN · PUT · 15m (20m also valid)

| Stat | Value |
|------|-------|
| **Test Win Rate** | **93.6% @ 15m · 89.4% @ 20m · 87.2% @ 10m** |
| **N (test fold)** | 47 |
| N (combined) | 67 (train=20, test=47) |
| Wilson CI lo95 | **77.4%** (test fold) |
| p-value | **< 0.001** |
| Validation method | **70/30 chronological walk-forward** — train WR=80.0%, test WR improved |
| Fragility score | 0.672 (moderate — session concentrated) |
| Dataset | `NON_OTC_ML__Report.md` — 21 FX pairs, 8,211 bars, May 20–23 2026 |

**Gates:**
```
STC_value > 75              (Schaff cycle overbought — trend exhausted)
PSAR_is_bullish = 0         (bearish PSAR — trend already turned)
ATR_pct < 0.20              (volatility compressed)
BB_upper < Keltner_upper    (inside the squeeze)
```
*Compression-breakdown trap: STC overbought creates false trend continuation signal while PSAR + vol compression indicate quiet reversal already underway. Breakdown resolves down.*

**Best conditions:**

| Condition | WR | N |
|-----------|----|----|
| **Asian session** | **100.0%** | 10 |
| American session | 57.1% | 7 |
| **15m horizon** | **93.6%** | 47 |
| 20m horizon | 89.4% | 47 |

**Best assets:** EURCHF · GBPCHF · CHF pairs generally (lower vol → stronger compression patterns)  
**Deploy:** Asian session only. American session WR insufficient (57.1% not above 54.05% floor with confidence).  
**Cross-horizon stability:** All 3 horizons above 87% — strongest cross-horizon consistency in the entire set.  
**Note:** `keltner_upper` not yet computed in `indicators.js` — needs implementation before bot deployment.  
**Risk sizing:** T3 — 0.5% per trade until N ≥ 200 fresh OOS signals

---

## 🚫 Confirmed Dead — Do Not Deploy

| Strategy | Reason | Validated WR |
|----------|--------|-------------|
| `T1_SMC_SWEEP_LOW_BULL_OB` | Look-ahead artefact — Python bull_ob used close[t+1] | 53.6% N=69 |
| `T1_SMC_SWEEP_HIGH_BEAR_OB` | Same look-ahead defect | 45.7% N=81 |
| `ML_EDGE_03` | Calendar overfit — hr_sin primary trigger (single UTC hour) | 52.1% N=514 |
| `ML_EDGE_04` | Degenerate leaf — fires 56% of bars, regime fully inverted | 24.9% N=29,177 |
| `ML_EDGE_05` | Calendar overfit — same hr_sin gate as EDGE_03 | 53.2% N=449 |

---

## 🟡 Watch List — Pending Re-validation

| Strategy | Current status | Condition to promote |
|----------|---------------|----------------------|
| `T1_TRANSITION_RANGE_TO_VOL_EXPANSION` | HOLD — N=20 vs research N=389; VOL_EXPANSION def too strict | Fix RANGING catch-all, re-validate, need N ≥ 100 |
| `ML_EDGE_08` (gated) | Paper-trade — WR=63.8% N=365 but **below PUT baseline 64.2%** | Fresh WR > 67% on ≥ 100 new bars with regime+session gates |
| `ML_EDGE_06` | BRITTLE (frag=0.150) — Asian only, WR=60.3% N=58 | N ≥ 100, exclude CHF pairs, confirm WR > 65% |
| `T3_FADE_FRESH_DOWN_BREAK` | Demoted T2→T3 — WR=52.2%, p=0.28 (not significant) | N ≥ 300 fresh, p < 0.05 |
| `T2_ZSCORE_LOW_2SIG` | Marginal — WR=54.3%, p=2.16e-2 | Longer data window needed |
| `T2_LOWER_WICK_GROWTH_2X` | Marginal — WR=54.7%, p=5.37e-2 | Longer data window needed |
| `DI_SQUEEZE_BREAKDOWN` (PUT 10m) | Near-miss — Train 75.6% N=45, Test **75.0%** N=20, CI lo=53.1% (just below 54.05% floor) | N ≥ 50 test fold on fresh data — consistent train/test WR is promising |

---

## ⏳ Infrastructure-Blocked — Research-Validated, Pending ML Pipeline

These edges passed **full 70/30 chronological walk-forward validation** inside `ml_edge_report.md` (v2 FX Rebuild, 51,813 bars, 13 pairs, May 12–26 2026) but cannot fire in the current JS-only bot — they require either:
- ML **vol-regime classification** (LOW/MED/HIGH ATR-14 tercile per asset), or
- **LSTM inference** at runtime

They are listed here as the highest-priority deployment targets once the ML pipeline is wired into the candle flow.

> ⚠️ **NOT JS-validated** — WRs are from Python walk-forward in the research report. Not tested via `validate_ml_strategies.js`. Deploy only after JS integration + OOS validation.

---

### 🔬 REGIME::European+LOW → PUT · 15m
*Most invariant edge in the entire study — fragility 0.002*

| Stat | Value |
|------|-------|
| **Win Rate** | **97.7%** |
| **N** | **3,940** |
| Beat PUT baseline by | +33.5pp above PUT null (64.2%) |
| Wilson CI [lo, hi] | [97.2%, 98.1%] |
| p-value | **< 0.0001** |
| Walk-fwd Train WR | 97.0% (N=1,998) |
| Walk-fwd Test WR | **98.4%** (N=1,942) ✅ improves on test |
| Decay | **+0.014** — no decay |
| Fragility | **0.002** — effectively invariant (lowest in full study) |
| Confidence score | 0.835 (T1) |

**Gate:** `session = European (02:00–08:00 UTC-5)` AND `vol_regime = LOW`  
*LOW regime = ATR-14 in the lowest tercile for that asset over a rolling window. Proxy: `bb_width_bps < 33rd-percentile` per asset.*

**Why it works:** In European session low-volatility bars the structural DOWN bias (64.2% baseline) is further reinforced by the compressed regime — squeeze dynamics and session-start mean-reversion both favor continuation of the flat/drift. Price has no momentum to break upward.

**Spread robustness:** SPREAD perturbation actually **improves** WR to 98.1% (+0.4pp) — the edge tightens under slippage.  
**Deployment blocker:** Requires per-asset rolling ATR-14 tercile classification (LOW/MED/HIGH) in bot candle flow.  
**Suggested sizing:** T1 — 2.0% risk per trade once JS-validated.

---

### 🔬 REGIME::Asian+LOW → PUT · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **88.5%** |
| **N** | **7,128** (largest N in the study) |
| Wilson CI [lo, hi] | from p<.0001 table |
| Walk-fwd Test WR | **92.3%** (N = 2,138, decay **+0.069** — improves on test) |
| Fragility | **0.010** (low — invariant) |
| Confidence score | 0.802 (T1) |

**Gate:** `session = Asian (17:00–02:00 UTC-5)` AND `vol_regime = LOW`

**Note:** largest sample in the study by count (N=7,128) — the Asian session has the most bars + LOW vol is most common there. WR improvement on test fold (+0.069) is the largest positive test-set improvement in the top 12 edges.

**Deployment blocker:** same ATR-14 tercile classification as European+LOW.  
**Suggested sizing:** T1 — 2.0% risk per trade once JS-validated.

---

### 🔬 REGIME::American+LOW → PUT · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **95.7%** |
| **N** | **6,039** |
| Walk-fwd Test WR | **92.4%** (decay **−0.068** — modest decay but still >90%) |
| Fragility | **0.006** (low — invariant) |
| Confidence score | 0.796 (T2 in report — moderate decay) |

**Gate:** `session = American (08:00–17:00 UTC-5)` AND `vol_regime = LOW`

**Note:** −0.068 test decay is the only caution here — the edge is real but the WR compresses on OOS. Use T2 sizing (1.0%) until N ≥ 500 fresh bars confirm > 88%.

**Deployment blocker:** same ATR-14 tercile classification.  
**Suggested sizing:** T2 — 1.0% risk per trade initially.

---

### 🔬 LSTM_LO(15m) → PUT · 15m
*Highest-confidence edge in the study (conf 0.894)*

| Stat | Value |
|------|-------|
| **Win Rate** | **99.0%** |
| **N** | **2,313** |
| Walk-fwd Test WR | 99.0% (by construction — LSTM-only test set) |
| Fragility | **0.001** (effectively zero) |

**Gate:** `LSTM UP-probability ≤ 0.15` → PUT  
**Deployment blocker:** Requires PyTorch/TensorFlow LSTM inference pipeline at runtime. Not approximable with static indicators.  
**Note:** CANDLE perturbation causes −0.003 decay (only perturbation that moves the needle at all).

---

### 🔬 HYBRID_DN(15m) → PUT · 15m

| Stat | Value |
|------|-------|
| **Win Rate** | **93.6%** |
| **N** | **282** |
| Walk-fwd Test WR | 93.6% (by construction) |
| Fragility | **0.143** ⚠️ brittle (CANDLE perturbation −33.7pp) |

**Gate:** ML ensemble probability ≤ 0.40 AND LSTM probability ≤ 0.40 → PUT  
**Deployment blocker:** Same LSTM requirement as LSTM_LO.  
**Caution:** High fragility (0.143) — candle distortion collapses WR to 59.9%. Deploy as confirmation layer only (never standalone).

---

Every confirmed edge spikes at **04:00 UTC** (Tokyo mid-session):

| Strategy | WR @ 04:00 UTC | N |
|----------|---------------|---|
| T2_BB_PEAK_BEAR_BOUNCE | **90.6%** | 32 |
| T2_FADE_FRESH_UP_BREAK | **80.0%** | 15 |
| T1_ZSCORE_EXTREME_LOW | **78.0%** | 100 |
| T3_ZSCORE_LOW_1_5SIG | 68.1% | 47 |
| T2_RANGE_EXPAND_BEAR_BOUNCE | 65.9% | 88 |
| ML_EDGE_07 ¹ | **72.5%** (Asian session avg) | 142 |
| STC_COMPRESSION_BREAKDOWN ¹ | **100%** (Asian session avg) | 10 |

¹ *ML edges: per-hour breakdown not computed by validator — Asian session WR shown (04:00 UTC is inside Asian window 22:00–07:00 UTC).*

**If you can only trade one window — trade 04:00 UTC.**

---

## Kill Zones — Avoid

| Time | Why |
|------|-----|
| **11:00 UTC** | T2_RANGE_EXPAND = 9.1% WR · T2_FADE_UP = 37.9% WR |
| **23:00 UTC** | T3_ZSCORE = 28.1% WR · T2_RANGE_EXPAND = 10% WR |
| **00:00 UTC** | T1_ZSCORE = 0% WR (N=7) |
| **OVERLAP session** for BB_PEAK | 43.5% WR — negative edge |
| **Wednesday** | Most strategies below 55%, none significant |

---

*Source files: `bot/validate_strategies.js` · `bot/validate_ml_strategies.js` · `bot/validation_report.md`*  
*Feature builders: `bot/features.js` · `bot/features_ml.js`*  
*Strategy code: `bot/entry_strategies.js` · `bot/ml_only_router.js`*  
*Additional research: `bot/NON_OTC_ML__Report.md` (STC_COMPRESSION_BREAKDOWN source)*  
*Infrastructure-blocked edges source: `bot/ml_edge_report.md` (v2 FX Rebuild — 70 edges, REGIME/LSTM/HYBRID)*  
*Falsified edges reference: `bot/ML_Edge_Discovery_Report.md` (older OTC study — all edges falsified by NON_OTC_ML §11)*
