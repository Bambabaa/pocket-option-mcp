# REPORT A — NON-OTC FX Pairs

## ML Edge Discovery Report

---

| Parameter | Value |
|---|---|
| **Scope** | NON-OTC standard forex pairs only |
| **Assets** | 21 pairs: AUDCAD, AUDCHF, AUDJPY, AUDUSD, CADCHF, CADJPY, CHFJPY, EURAUD, EURCAD, EURCHF, EURGBP, EURJPY, EURUSD, GBPAUD, GBPCAD, GBPCHF, GBPJPY, GBPUSD, USDCAD, USDCHF, USDJPY |
| **Rows** | 8,211 candles (5-minute intervals) |
| **Period** | May 20–23, 2026 |
| **Features** | 56 engineered features |
| **Horizons** | 5m, 10m, 15m forward labels |
| **Timezone** | UTC-5 (New York) |
| **Label Balance** | 5m: 45.0% CALL / 55.0% PUT, 10m: 45.7% / 54.3%, 15m: 46.4% / 53.6% |

---

## Table of Contents

1. [Data Engineering & Labeling](#1-data-engineering--labeling)
2. [Feature Engineering](#2-feature-engineering)
3. [Correlation & Cluster Discovery](#3-correlation--cluster-discovery)
4. [ML Model Performance](#4-ml-model-performance)
5. [SHAP Feature Importance & Interactions](#5-shap-feature-importance--interactions)
6. [Top Edges — Full Analysis](#6-top-edges--full-analysis)
7. [Strategy Archetype Classification](#7-strategy-archetype-classification)
8. [Asset-Time Matching Table](#8-asset-time-matching-table)
9. [Code-Ready Rule Blocks](#9-code-ready-rule-blocks)
10. [Statistical Validation](#10-statistical-validation)

---

## 1. Data Engineering & Labeling

All timestamps were converted to UTC-5 (New York time). Sessions were encoded as:

| Session | UTC-5 Range | Count | Share |
|---|---|---|---|
| American | 08:00–17:00 | 4,536 | 55.2% |
| European | 03:00–12:00 | 1,974 | 24.0% |
| Asian | 19:00–04:00 | 693 | 8.4% |
| Off-hours | Other | 1,008 | 12.3% |

The strong PUT bias across all labels (55.0–53.6%) already indicates that non-OTC FX pairs during this window had a structural downward tendency, particularly in the Asian session.

Forward labels were created by comparing close(t + N) vs close(t). Rows with NaN in critical indicators (RSI, MACD, ADX, BB, Stoch, CCI, Williams %R, ATR) were dropped.

---

## 2. Feature Engineering

| Category | Features | Purpose |
|---|---|---|
| Volatility Regime | atr\_pct, atr\_norm\_body, atr\_norm\_range, vol\_regime, bb\_width, squeeze | Market volatility state classification |
| Trend Structure | ema\_spread, sma\_alignment, sma\_alignment\_bear, trend\_strength, psar\_dist | Directional bias and trend strength |
| Momentum | rsi\_momentum, stoch\_momentum, macd\_accel, stc\_momentum | Velocity of price change |
| Mean Reversion | dist\_sma20, dist\_bb\_mid, dist\_keltner\_mid | Displacement from equilibrium |
| Cross-Ratios | rsi\_cci\_ratio, stoch\_rsi\_diff, williams\_stoch\_diff, macd\_over\_atr | Inter-indicator divergences |
| Temporal (UTC-5) | hour\_sin, hour\_cos, session\_asian, session\_european, session\_american | Time-of-day and session encoding |

---

## 3. Correlation & Cluster Discovery

### 3.1 Pearson Correlation with Labels (label\_5m, Top 10)

| Feature | r | p-value | Direction |
|---|---|---|---|
| candle\_range | +0.1283 | <0.0001 | Larger candles → CALL |
| atr\_14 | +0.1473 | <0.0001 | Higher ATR → CALL |
| atr\_pct | +0.1371 | <0.0001 | Higher vol percentile → CALL |
| atr\_norm\_range | +0.1092 | <0.0001 | Normalized range → CALL |
| vol\_regime | +0.1220 | <0.0001 | Higher vol regime → CALL |
| bb\_width\_bps | +0.1008 | <0.0001 | Wider bands → CALL |
| hour\_cos | −0.0925 | <0.0001 | Time-of-day effect |
| session\_asian | −0.0917 | <0.0001 | Asian session → PUT |
| session\_american | +0.0733 | <0.0001 | American session → CALL |
| di\_spread | +0.0601 | <0.0001 | Bullish DI → CALL |

**Key finding:** Volatility features dominate the correlation structure for non-OTC pairs. Low volatility strongly favors PUT direction. The Asian session has a strong negative correlation with CALL labels, confirming the session-dependent PUT bias.

### 3.2 Cross-Asset Stability

| Feature | Consistency | Mean r | Std r | Interpretation |
|---|---|---|---|---|
| hour\_cos | 3.378 | −0.0925 | 0.027 | Most stable predictor — time-of-day effect universal |
| atr\_14 | 3.112 | +0.1473 | 0.047 | ATR universally predictive |
| session\_asian | 3.047 | −0.0917 | 0.030 | Asian = PUT bias, consistent across all 21 pairs |
| atr\_norm\_range | 2.917 | +0.1092 | 0.037 | Normalized range very stable |
| candle\_range | 2.914 | +0.1283 | 0.044 | Candle size → direction, highly consistent |
| atr\_pct | 2.885 | +0.1371 | 0.048 | Volatility percentile reliable |
| bb\_width\_bps | 2.848 | +0.1008 | 0.035 | BB width stable |
| vol\_regime | 2.346 | +0.1220 | 0.052 | Regime classification reliable |
| session\_american | 2.216 | +0.0733 | 0.033 | American session → slight CALL bias |

### 3.3 PCA Variance Explained

| Component | Variance | Cumulative | Top Loadings |
|---|---|---|---|
| PC1 | 27.9% | 27.9% | Price-level / Moving Average cluster |
| PC2 | 10.1% | 38.0% | Volatility / ATR cluster |
| PC3 | 8.6% | 46.6% | Oscillator / Momentum cluster |
| PC4 | 5.4% | 51.9% | MACD / STC cluster |
| PC5 | 5.1% | 57.0% | Trend alignment cluster |

### 3.4 K-Means Indicator Clusters (6 clusters)

#### Cluster 0 — MACD / STC / Trend Direction
- **Members:** macd\_line, macd\_signal, stc\_value, stc\_signal, stc\_prev, ema\_spread, sma\_alignment, macd\_over\_atr, williams\_stoch\_diff
- **Role:** Trend momentum and direction signals

#### Cluster 1 — Noisy / Mixed Temporal
- **Members:** zigzag\_direction, zigzag\_reversal, minus\_di, sma\_alignment\_bear, stoch\_momentum, squeeze, rsi\_cci\_ratio, stc\_momentum, hour\_cos, session\_asian
- **Role:** Mixed — includes noise-sensitive indicators (zigzag) and strong temporal signals

#### Cluster 2 — Oscillator / Mean-Reversion
- **Members:** rsi\_14, plus\_di, cci\_20, williams\_r, rsi\_momentum, bb\_position, keltner\_position, dist\_sma20, dist\_bb\_mid, di\_spread, dist\_keltner\_mid
- **Role:** Overbought/oversold detection, displacement from mean

#### Cluster 3 — Volatility Regime
- **Members:** bb\_width\_bps, adx, atr\_pct, vol\_regime, trend\_strength, bb\_width
- **Role:** **Strongest predictive cluster.** Regime classification drives edge quality.

#### Cluster 4 — Stochastic / PSAR / Momentum
- **Members:** macd\_histogram, stoch\_k, stoch\_d, stoch\_prev\_d, stc\_delta, psar\_trend, psar\_is\_bullish, macd\_accel, stoch\_rsi\_diff, psar\_dist
- **Role:** Momentum and trend-follower signals

#### Cluster 5 — Candle / ATR / Temporal
- **Members:** atr\_14, candle\_body, candle\_range, atr\_norm\_body, atr\_norm\_range, hour\_sin, session\_european, session\_american
- **Role:** Volatility magnitude and time-based features

### 3.5 Noise-Sensitive Indicators

| Indicator | Issue |
|---|---|
| zigzag\_reversal | Highly noisy, inconsistent across assets |
| rsi\_cci\_ratio | Unstable ratio, low cross-asset consistency |
| stoch\_prev\_d | Lagging, redundant with stoch\_d |
| stc\_delta | Overly responsive to noise |

---

## 4. ML Model Performance

| Model | Acc 5m | AUC 5m | Acc 10m | AUC 10m | Acc 15m | AUC 15m |
|---|---|---|---|---|---|---|
| **XGBoost** | 58.65% | **0.6300** | 63.50% | **0.6941** | 66.24% | **0.7283** |
| Random Forest | 57.84% | 0.6173 | 60.07% | 0.6530 | 61.73% | 0.6749 |
| Decision Tree | 56.18% | 0.5913 | 58.16% | 0.6234 | 60.00% | 0.6524 |
| Logistic Regression | 56.52% | 0.5952 | 57.12% | 0.6071 | 57.89% | 0.6228 |

**Key findings:**

- XGBoost is the clear winner with AUC **0.7283 at 15m** — substantially stronger than the combined (OTC+NON-OTC) analysis
- Predictability increases dramatically with horizon: 15m AUC is **15.6% higher** than 5m
- Non-OTC FX pairs are significantly more predictable than OTC pairs (see Report B)
- Even at 5m, XGBoost achieves AUC 0.63 — well above random

---

## 5. SHAP Feature Importance & Interactions

### 5.1 SHAP Importance — 5m Horizon

| Rank | Feature | SHAP | Category |
|---|---|---|---|
| 1 | candle\_range | 0.3495 | Volatility |
| 2 | atr\_pct | 0.1114 | Volatility |
| 3 | williams\_stoch\_diff | 0.0765 | Cross-Ratio |
| 4 | bb\_position | 0.0651 | Oscillator |
| 5 | hour\_sin | 0.0625 | Temporal |
| 6 | stc\_momentum | 0.0614 | STC |
| 7 | stoch\_momentum | 0.0576 | Oscillator |
| 8 | atr\_norm\_range | 0.0573 | Volatility |
| 9 | williams\_r | 0.0518 | Oscillator |
| 10 | ema\_spread | 0.0504 | Trend |

### 5.2 SHAP Importance — 15m Horizon

| Rank | Feature | SHAP | Category |
|---|---|---|---|
| 1 | candle\_range | 0.3069 | Volatility |
| 2 | atr\_pct | 0.1434 | Volatility |
| 3 | hour\_cos | 0.1284 | Temporal |
| 4 | williams\_stoch\_diff | 0.1012 | Cross-Ratio |
| 5 | hour\_sin | 0.0909 | Temporal |
| 6 | atr\_14 | 0.0771 | Volatility |
| 7 | macd\_signal | 0.0710 | MACD |
| 8 | di\_spread | 0.0701 | Oscillator |
| 9 | dist\_sma20 | 0.0664 | Mean Reversion |
| 10 | macd\_histogram | 0.0628 | MACD |

**Candle\_range dominates SHAP** at both horizons (3× the next feature). Temporal features (hour\_sin, hour\_cos) become much more important at 15m, confirming session-dependent predictability.

### 5.3 SHAP Interaction Matrix

| Feature Pair | SHAP Corr | Interpretation |
|---|---|---|
| candle\_range × atr\_pct | 0.846 | Highly synergistic — candle size in vol context |
| candle\_range × atr\_norm\_range | 0.534 | Redundant — same underlying signal |
| bb\_position × williams\_r | 0.496 | Oscillator confluence — both measure overbought/oversold |
| atr\_pct × atr\_norm\_range | 0.490 | Vol regime amplifies normalized range |
| stoch\_momentum × atr\_norm\_range | 0.376 | Momentum + volatility interaction |
| williams\_stoch\_diff × bb\_position | 0.364 | Cross-oscillator divergence × band position |
| bb\_position × ema\_spread | −0.348 | Negative: trend vs. band position diverges |

---

## 6. Top Edges — Full Analysis

### ════════════════════════════════════════════════════════════════
### EDGE #1 — RSI\_OS + MACD\_Pos → PUT
**Strategy Type:** Reversal (False Bounce Trap)
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 98.11% | 98.00% | 97.87% |
| **Sample Size** | 53 | 50 | 47 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `RSI_14 < 30, MACD_histogram > 0`

| Session | WR | N |
|---|---|---|
| Asian | 100.0% | 48 |
| European | — | <5 |
| American | — | <5 |

**Best assets:** GBPCHF (100%, N=16), GBPJPY (100%, N=18), GBPUSD (100%, N=18)

**Why it works:** RSI oversold with positive MACD histogram in non-OTC pairs is almost exclusively an Asian-session phenomenon. The positive MACD is a lagging artifact — it traps bulls expecting a bounce that never comes. In the low-liquidity Asian session, there is no counter-trend buying pressure to support the reversal, so the downtrend continues with near-perfect consistency.

---

### ════════════════════════════════════════════════════════════════
### EDGE #2 — RSI\_OS + ADX\_Weak → PUT
**Strategy Type:** Reversal (Triple Exhaustion Base)
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 95.74% | 97.73% | 97.56% |
| **Sample Size** | 47 | 44 | 41 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `RSI_14 < 30, ADX < 20`

| Session | WR | N |
|---|---|---|
| Asian | 100.0% | 42–45 |

**Best assets:** GBPCHF (100%, N=15), GBPJPY (100%, N=15), GBPUSD (100%, N=15)

**Why it works:** Oversold RSI in a trendless regime. Mean-reversion fails because there is no trend structure to revert within. The ADX < 20 confirms no directional energy, so the drift continues.

---

### ════════════════════════════════════════════════════════════════
### EDGE #3 — RSI\_OS + LowVol → PUT
**Strategy Type:** Universal Reversal
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 89.72% | 88.46% | 87.50% |
| **Sample Size** | 107 | 104 | 96 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `RSI_14 < 30, ATR_pct < 0.30`

| Session | WR | N |
|---|---|---|
| Asian | 100.0% | 48 |

**Best assets:** GBPCHF (100%, N=29), GBPJPY (100%, N=29), GBPUSD (96.7%), AUDUSD (85.7%)

**Why it works:** Low ATR percentile combined with RSI oversold creates a quiet-market exhaustion. The larger sample size (N=107) provides stronger statistical backing than Edges #1-2.

---

### ════════════════════════════════════════════════════════════════
### EDGE #4 — RSI\_OS + PSAR\_Bull → PUT
**Strategy Type:** Reversal (Divergence)
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 86.27% | 89.58% | 88.89% |
| **Sample Size** | 51 | 48 | 45 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `RSI_14 < 30, PSAR_is_bullish = 1`

| Session | WR | N |
|---|---|---|
| Asian | 100.0% | 33 |
| European | 71.4% | 7 |
| American | 60–80% | 5 |

**Why it works:** Bullish PSAR contradicts oversold RSI — classic false floor divergence.

---

### ════════════════════════════════════════════════════════════════
### EDGE #5 — LowVol + STC\_High + SMA\_Bear → PUT
**Strategy Type:** Trend + Volatility Regime
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 76.87% | 77.14% | 75.94% |
| **Sample Size** | 147 | 140 | 133 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `ATR_pct < 0.30, STC_value > 75, SMA_alignment_bear = 1`

| Session | WR | N |
|---|---|---|
| Asian | 100.0% | 61–75 |
| American | 53.1% | 49 |
| European | 0.0% | 4 (too small) |

**Best assets:** AUDCAD (100%), EURJPY (100%), GBPUSD (100%), AUDCHF (95.7%), EURUSD (91.7%)

**Why it works:** Bear SMA alignment in a low-vol environment with high STC (overbought cycle indicator) creates a triple confluence. The Asian session dominance is extreme (100% WR).

---

### ════════════════════════════════════════════════════════════════
### EDGE #6 — LowVol + MACD\_Pos + SMA\_Bear → PUT
**Strategy Type:** Trend + Volatility Regime
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 76.21% | 75.16% | 72.77% |
| **Sample Size** | 475 | 467 | 459 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `ATR_pct < 0.30, MACD_histogram > 0, SMA_alignment_bear = 1`

| Session | WR | N |
|---|---|---|
| Asian | 98.0% | 153 |
| American | 59.3% | 145 |
| European | 39.1% | 46 |

**Best assets:** EURJPY (89.5%), GBPJPY (87.5%), AUDUSD (86.7%), AUDJPY (86.4%), AUDCAD (85.7%)

**Why it works:** Bear SMA alignment contradicted by positive MACD in low-vol = false bounce. The extremely large sample size (N=475) makes this one of the most statistically robust edges. The Asian session carries the signal (98% WR) while European session actually reverses (39% WR = 61% PUT failure).

---

### ════════════════════════════════════════════════════════════════
### EDGE #7 — LowVol + ADX\_Weak + SMA\_Bear → PUT
**Strategy Type:** Universal Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 75.26% | 75.26% | 73.39% |
| **Sample Size** | 388 | 380 | 372 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `ATR_pct < 0.30, ADX < 20, SMA_alignment_bear = 1`

| Session | WR | N |
|---|---|---|
| Asian | 98.1% | 154 |
| American | 55.2% | 116 |
| European | 47.2% | 36 |

**Best assets:** AUDJPY (90.9%), AUDUSD (90.0%), AUDCAD (89.5%), EURJPY (89.5%), EURUSD (84.6%)

**Why it works:** Triple exhaustion in bear regime with no trend energy. Massive sample size (N=388) confirms reliability.

---

### ════════════════════════════════════════════════════════════════
### EDGE #8 — LowVol + ADX\_Weak + MACD\_Pos → PUT
**Strategy Type:** Universal
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 73.06% | 73.58% | 71.81% |
| **Sample Size** | 594 | 579 | 564 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `ATR_pct < 0.30, ADX < 20, MACD_histogram > 0`

| Session | WR | N |
|---|---|---|
| Asian | 95.3% | 257 |
| American | 55.4% | 175 |
| European | 35.6% | 45 |

**Best assets:** AUDJPY (95.2%), EURJPY (91.3%), CHFJPY (90.0%), GBPJPY (87.5%), EURUSD (85.2%)

**Why it works:** The broadest form of the low-vol + trendless + false momentum signal. N=594 is the largest sample among high-WR edges. Asian session drives the signal entirely.

---

### ════════════════════════════════════════════════════════════════
### EDGE #9 — LowVol + BigCandle + STC\_High → CALL
**Strategy Type:** Breakout / Bounce
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 15m |
|---|---|---|
| **Win Rate** | 72.73% | 72.73% |
| **Sample Size** | 22 | 22 |
| **p-value** | 0.0262 * | 0.0262 * |

**Thresholds:** `ATR_pct < 0.30, ATR_norm_body > 1.5, STC_value > 75`

| Session | WR | N |
|---|---|---|
| European | 100.0% | 6 |
| American | 62.5% | 8 |

**Why it works:** This is the **only significant CALL edge** in the non-OTC space. A large candle in a low-vol environment with high STC signals a breakout that sustains — but only in European/American sessions. Small sample warrants caution.

---

### ════════════════════════════════════════════════════════════════
### EDGE #10 — LowVol + ADX\_Weak + PSAR\_Bull → PUT
**Strategy Type:** Universal
### ════════════════════════════════════════════════════════════════

| Metric | 5m | 10m | 15m |
|---|---|---|---|
| **Win Rate** | 71.31% | 71.06% | 69.41% |
| **Sample Size** | 596 | 584 | 572 |
| **p-value** | <0.0001 *** | <0.0001 *** | <0.0001 *** |

**Thresholds:** `ATR_pct < 0.30, ADX < 20, PSAR_is_bullish = 1`

| Session | WR | N |
|---|---|---|
| Asian | 94.9% | 216 |
| American | 56.4% | 197 |
| European | 44.6% | 65 |

**Best assets:** AUDJPY (100%), EURUSD (91.7%), EURJPY (90.0%), AUDCAD (87.8%), AUDUSD (82.8%)

**Why it works:** Bullish PSAR in low-vol, trendless regime = divergence trap. Massive sample (N=596) with strong Asian-session performance.

---

## 7. Strategy Archetype Classification

| Strategy | Indicators & Thresholds | WR Range | N Range | Best Hz | Best Session | Best Assets |
|---|---|---|---|---|---|---|
| **Reversal (False Bounce)** | RSI<30 + MACD\_pos | 97.9–98.1% | 47–53 | All | Asian (100%) | GBPCHF, GBPJPY, GBPUSD |
| **Reversal (Exhaustion)** | RSI<30 + ADX<20 | 95.7–97.7% | 41–47 | All | Asian (100%) | GBPCHF, GBPJPY, GBPUSD |
| **Reversal (LowVol)** | RSI<30 + atr\_pct<0.3 | 87.5–89.7% | 96–107 | 5m | Asian (100%) | GBPCHF, GBPJPY (100%) |
| **Trend + Vol Regime** | low\_vol + STC\_high + SMA\_bear | 75.9–77.1% | 133–147 | All | Asian (100%) | AUDCAD, EURJPY, GBPUSD |
| **Universal (Broad)** | low\_vol + ADX<20 + MACD\_pos | 71.8–73.6% | 564–594 | 10m | Asian (95%) | AUDJPY, EURJPY, CHFJPY |
| **Breakout (CALL)** | low\_vol + big\_candle + STC\_high | 72.7% | 22 | 5m/15m | European (100%) | USDCHF, EURCHF |

### Session Dominance Pattern (Non-OTC)

A critical structural finding: **virtually all non-OTC edges are Asian-session dependent.** The Asian session (19:00–04:00 UTC-5) delivers 95–100% WR on most edges, while the European session often shows reversed performance (35–47% WR = signal inversion). The American session falls between at 55–60%.

This means these edges should be deployed **primarily during Asian hours** with reduced or zero sizing during European hours.

---

## 8. Asset-Time Matching Table

| Asset | Horizon | Strategy | Edge | Win Rate | N |
|---|---|---|---|---|---|
| GBPCHF | All | Reversal | RSI\_OS+LowVol | 100% | 27–29 |
| GBPJPY | All | Reversal | RSI\_OS+LowVol | 100% | 27–29 |
| GBPJPY | All | Reversal | RSI\_OS+MACD\_Pos | 100% | 16–18 |
| GBPUSD | All | Reversal | RSI\_OS+MACD\_Pos | 100% | 16–18 |
| GBPUSD | All | Reversal | RSI\_OS+PSAR\_Bull | 100% | 16–18 |
| GBPCHF | All | Reversal | RSI\_OS+ADX\_Weak | 100% | 14–15 |
| AUDCHF | 15m | Trend+Vol | LowVol+STC\_Hi+SMA\_Bear | 100% | 22 |
| EURJPY | 15m | Universal | LowVol+ADX\_Weak+MACD\_Pos | 100% | 21 |
| EURJPY | 15m | Universal | LowVol+ADX\_Weak+SMA\_Bear | 100% | 17 |
| AUDCAD | 5m | Trend+Vol | LowVol+STC\_Hi+SMA\_Bear | 100% | 9 |
| EURUSD | 10m | Universal | LowVol+ADX\_Weak+PSAR\_Bull | 100% | 23 |
| AUDUSD | 5m | Universal | LowVol+SMA\_Bear+PSAR\_Bull | 90.0% | 40 |
| AUDCHF | 10m | Universal | LowVol+SMA\_Bear+PSAR\_Bull | 93.9% | 33 |
| EURCHF | 15m | Trend+Vol | LowVol+STC\_Hi+SMA\_Bear | 90.0% | 20 |
| USDJPY | 5m | Trend+Vol | LowVol+STC\_Hi+PSAR\_Bull | 80.0% | 40 |
| EURGBP | 5m | Trend+Vol | LowVol+STC\_Hi+PSAR\_Bull | 85.0% | 40 |

---

## 9. Code-Ready Rule Blocks

```python
# ═══════════════════════════════════════════════════
# NON-OTC FX — Edge Functions
# ═══════════════════════════════════════════════════

def edge_false_bounce_nonOTC(rsi_14, macd_histogram):
    """Edge #1: RSI oversold + MACD positive = false bounce trap
    WR: 98.1% | N=53 | Asian session only"""
    if rsi_14 < 30 and macd_histogram > 0:
        return "PUT", 0.981
    return None, None

def edge_exhaustion_nonOTC(rsi_14, adx):
    """Edge #2: RSI oversold + weak trend
    WR: 95.7-97.7% | N=41-47 | Asian session"""
    if rsi_14 < 30 and adx < 20:
        return "PUT", 0.957
    return None, None

def edge_quiet_oversold_nonOTC(rsi_14, atr_pct):
    """Edge #3: RSI oversold + low volatility
    WR: 89.7% | N=107 | Asian session"""
    if rsi_14 < 30 and atr_pct < 0.30:
        return "PUT", 0.897
    return None, None

def edge_triple_trend_vol_nonOTC(atr_pct, stc_value, sma_alignment_bear):
    """Edge #5: Low vol + high STC + bearish SMA
    WR: 76.9% | N=147 | Asian session"""
    if atr_pct < 0.30 and stc_value > 75 and sma_alignment_bear == 1:
        return "PUT", 0.769
    return None, None

def edge_false_macd_bear_nonOTC(atr_pct, macd_histogram, sma_alignment_bear):
    """Edge #6: Low vol + positive MACD + bear SMA
    WR: 76.2% | N=475 | Asian: 98%, Amer: 59%"""
    if atr_pct < 0.30 and macd_histogram > 0 and sma_alignment_bear == 1:
        return "PUT", 0.762
    return None, None

def edge_universal_exhaustion_nonOTC(atr_pct, adx, macd_histogram):
    """Edge #8: Universal low-vol trendless false momentum
    WR: 73.1% | N=594 | Asian: 95%"""
    if atr_pct < 0.30 and adx < 20 and macd_histogram > 0:
        return "PUT", 0.731
    return None, None

def edge_breakout_call_nonOTC(atr_pct, atr_norm_body, stc_value):
    """Edge #9: ONLY CALL edge — breakout in low vol
    WR: 72.7% | N=22 | European session"""
    if atr_pct < 0.30 and atr_norm_body > 1.5 and stc_value > 75:
        return "CALL", 0.727
    return None, None

# ═══════════════════════════════════════════════════
# MASTER ROUTER — NON-OTC FX
# ═══════════════════════════════════════════════════
def get_signal_nonOTC(ind):
    """Check edges in descending confidence order."""
    rsi = ind['rsi_14']; adx = ind['adx']
    atr_pct = ind['atr_pct']; macd_h = ind['macd_histogram']
    psar_bull = ind['psar_is_bullish']; stc = ind['stc_value']
    sma_bear = ind['sma_alignment_bear']; atr_body = ind['atr_norm_body']

    # Priority 1: False bounce (98.1%)
    if rsi < 30 and macd_h > 0:
        return "PUT", 0.981, "FALSE_BOUNCE"
    # Priority 2: Exhaustion (95.7%)
    if rsi < 30 and adx < 20:
        return "PUT", 0.957, "EXHAUSTION"
    # Priority 3: Quiet oversold (89.7%)
    if rsi < 30 and atr_pct < 0.30:
        return "PUT", 0.897, "QUIET_OVERSOLD"
    # Priority 4: PSAR divergence (86.3%)
    if rsi < 30 and psar_bull == 1:
        return "PUT", 0.863, "PSAR_DIVERGE"
    # Priority 5: STC + SMA bear in low vol (76.9%)
    if atr_pct < 0.30 and stc > 75 and sma_bear == 1:
        return "PUT", 0.769, "TREND_VOL_STC"
    # Priority 6: MACD false in bear (76.2%)
    if atr_pct < 0.30 and macd_h > 0 and sma_bear == 1:
        return "PUT", 0.762, "FALSE_MACD_BEAR"
    # Priority 7: Universal exhaustion (73.1%)
    if atr_pct < 0.30 and adx < 20 and macd_h > 0:
        return "PUT", 0.731, "UNIVERSAL_EXHAUST"
    # Priority 8: Breakout CALL (72.7%)
    if atr_pct < 0.30 and atr_body > 1.5 and stc > 75:
        return "CALL", 0.727, "BREAKOUT_CALL"
    return None, None, None
```

---

## 10. Statistical Validation

| Metric | Value |
|---|---|
| Test | Binomial test (one-sided), H0: WR = 50% |
| All top-10 edges | p < 0.0001 (***) except Edge #9 (p = 0.026 *) |
| Minimum sample | N = 22 (Edge #9, CALL breakout) |
| Maximum sample | N = 596 (Edge #10, universal) |
| Model validation | 3-fold stratified CV |
| SHAP | TreeExplainer, 1,500-sample subset |
| Stability | |mean\_r| / std\_r across 21 assets |
| Horizon trend | 15m AUC 15.6% higher than 5m |
| Session dependency | Asian session carries 95–100% of edge performance |

### Limitations

- 2.5-day window limits generalizability
- Asian session dominance may reflect specific market conditions during this period
- CALL edges are scarce (only 1 found) — further data needed
- European session shows signal inversion on many edges — requires investigation
- 100% win rates on GBP pairs warrant out-of-sample validation

---

*End of Report A — NON-OTC FX Pairs*
