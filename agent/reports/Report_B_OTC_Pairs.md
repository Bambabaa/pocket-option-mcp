# REPORT B — OTC Pairs

## ML Edge Discovery Report

---

| Parameter | Value |
|---|---|
| **Scope** | OTC (Over-The-Counter) forex pairs only |
| **Assets** | 56 pairs including AEDCNY\_otc, AUDCAD\_otc, AUDCHF\_otc, AUDJPY\_otc, AUDNZD\_otc, AUDUSD\_otc, BHDCNY\_otc, CADCHF\_otc, CADJPY\_otc, CHFJPY\_otc, CHFNOK\_otc, EURCHF\_otc, EURGBP\_otc, EURHUF\_otc, EURJPY\_otc, EURNZD\_otc, EURRUB\_otc, EURTRY\_otc, EURUSD\_otc, GBPAUD\_otc, GBPCAD\_otc, GBPCHF\_otc, GBPJPY\_otc, GBPUSD\_otc, KESUSD\_otc, NZDUSD\_otc, UAHUSD\_otc, USDCAD\_otc, USDCHF\_otc, USDJPY\_otc, and more |
| **Rows** | 20,389 candles (5-minute intervals) |
| **Period** | May 20–23, 2026 |
| **Features** | 56 engineered features |
| **Horizons** | 5m, 10m, 15m forward labels |
| **Timezone** | UTC-5 (New York) |
| **Label Balance** | 5m: 49.4% CALL / 50.6% PUT, 10m: 49.5% / 50.5%, 15m: 49.4% / 50.6% |

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
| American | 08:00–17:00 | 8,488 | 41.6% |
| Asian | 19:00–04:00 | 7,393 | 36.3% |
| Off-hours | Other | 2,664 | 13.1% |
| European | 03:00–12:00 | 1,844 | 9.0% |

OTC pairs have **much more Asian-session data** (36.3% vs 8.4% for non-OTC) and **near-perfect label balance** (49.4% / 50.6%), making them significantly harder to predict — there is no structural directional bias like the PUT dominance seen in non-OTC pairs.

---

## 2. Feature Engineering

Identical feature groups to Report A were applied:

| Category | Features | Purpose |
|---|---|---|
| Volatility Regime | atr\_pct, atr\_norm\_body, atr\_norm\_range, vol\_regime, bb\_width, squeeze | Market volatility classification |
| Trend Structure | ema\_spread, sma\_alignment, sma\_alignment\_bear, trend\_strength, psar\_dist | Directional bias |
| Momentum | rsi\_momentum, stoch\_momentum, macd\_accel, stc\_momentum | Momentum velocity |
| Mean Reversion | dist\_sma20, dist\_bb\_mid, dist\_keltner\_mid | Equilibrium displacement |
| Cross-Ratios | rsi\_cci\_ratio, stoch\_rsi\_diff, williams\_stoch\_diff, macd\_over\_atr | Divergence detection |
| Temporal (UTC-5) | hour\_sin, hour\_cos, session\_asian, session\_european, session\_american | Time and session encoding |

---

## 3. Correlation & Cluster Discovery

### 3.1 Pearson Correlation with Labels (label\_5m, Top 10)

| Feature | r | p-value | Direction |
|---|---|---|---|
| macd\_signal | −0.0232 | <0.001 | Negative MACD\_signal → CALL |
| macd\_line | −0.0206 | <0.01 | Negative MACD\_line → CALL |
| rsi\_14 | −0.0186 | <0.01 | Lower RSI → CALL |
| ema\_spread | −0.0179 | <0.01 | Negative EMA spread → CALL |
| atr\_norm\_range | −0.0139 | <0.05 | Smaller norm range → CALL |
| dist\_keltner\_mid | −0.0132 | <0.05 | Below Keltner mid → CALL |
| stc\_momentum | −0.0112 | NS | Weak signal |
| atr\_norm\_body | −0.0100 | NS | Near noise |
| dist\_sma20 | −0.0096 | NS | Near noise |

**Key finding:** OTC correlations are dramatically weaker than non-OTC (max |r| = 0.023 vs 0.148). No single feature has a strong linear relationship with labels. This confirms that **OTC pairs are fundamentally noisier** and require more complex confluence patterns for edge extraction.

### 3.2 Cross-Asset Stability

| Feature | Consistency | Mean r | Std r | Interpretation |
|---|---|---|---|---|
| macd\_signal | 0.430 | −0.023 | 0.054 | Most stable but weak |
| macd\_line | 0.364 | −0.021 | 0.057 | MACD moderately consistent |
| rsi\_14 | 0.350 | −0.019 | 0.053 | RSI weak but consistent direction |
| ema\_spread | 0.312 | −0.018 | 0.057 | EMA spread moderate |
| atr\_norm\_range | 0.267 | −0.014 | 0.052 | Low consistency |
| dist\_keltner\_mid | 0.242 | −0.013 | 0.055 | Poor stability |
| stc\_momentum | 0.196 | −0.011 | 0.058 | Near-noise |

**OTC consistency scores are 5–10× lower than non-OTC.** The most stable OTC feature (macd\_signal at 0.43) is weaker than the 9th most stable non-OTC feature. This fundamentally changes the edge discovery approach — OTC requires larger sample sizes and more cautious confidence estimates.

### 3.3 PCA Variance Explained

| Component | Variance | Cumulative |
|---|---|---|
| PC1 | 21.9% | 21.9% |
| PC2 | 7.3% | 29.3% |
| PC3 | 6.7% | 36.0% |
| PC4 | 6.0% | 42.0% |
| PC5 | 5.0% | 47.1% |

PCA explains less variance per component in OTC (21.9% vs 27.9% for PC1), confirming higher noise and lower indicator structure.

### 3.4 K-Means Indicator Clusters

The OTC clustering structure is similar to non-OTC but with weaker intra-cluster cohesion:

| Cluster | Role | Key Members |
|---|---|---|
| Volatility / Regime | Moderate predictive | atr\_pct, vol\_regime, bb\_width, adx, atr\_14 |
| Oscillator / Momentum | Weak-moderate | rsi\_14, stoch\_k, cci\_20, williams\_r, bb\_position |
| MACD / Trend | Moderate | macd\_line, macd\_signal, macd\_histogram, ema\_spread |
| STC Cycle | Weak | stc\_value, stc\_signal, stc\_prev, stc\_delta |
| Candle / ATR | Moderate | candle\_range, atr\_norm\_range, atr\_norm\_body |
| Temporal / Session | Notable | hour\_sin, hour\_cos, session flags |

### 3.5 Noise-Sensitive Indicators

| Indicator | Issue |
|---|---|
| zigzag\_reversal | Extremely noisy in OTC |
| rsi\_cci\_ratio | Inconsistent, near-zero predictive value |
| stoch\_prev\_d | Lagging and redundant |
| stc\_delta | Noise-responsive |
| dist\_bb\_mid / dist\_sma20 | Very low consistency in OTC |

---

## 4. ML Model Performance

| Model | Acc 5m | AUC 5m | Acc 10m | AUC 10m | Acc 15m | AUC 15m |
|---|---|---|---|---|---|---|
| **XGBoost** | 49.54% | 0.4952 | 52.98% | **0.5375** | 55.59% | **0.5757** |
| Random Forest | 49.25% | 0.4890 | 52.17% | 0.5297 | 53.64% | 0.5535 |
| Decision Tree | 50.12% | 0.4986 | 50.32% | 0.5087 | 51.56% | 0.5243 |
| Logistic Regression | 50.26% | 0.5006 | 50.87% | 0.5126 | 51.71% | 0.5201 |

**Critical findings:**

- **5m is essentially unpredictable** for OTC pairs — AUC ~0.50 (random) across all models
- 10m begins to show weak signal (AUC 0.54)
- 15m is the only usable horizon with AUC 0.5757 — still far weaker than non-OTC's 0.7283
- **OTC pairs are 2.6× harder to predict** than non-OTC at 15m (comparing AUC excess over 0.50)
- The balanced labels (49.4%) confirm no free directional edge exists in OTC

### Why OTC is Harder

OTC markets typically have wider spreads, lower liquidity, and synthetic pricing mechanisms that add noise. The near-random 5m performance suggests that sub-10-minute signals are dominated by market microstructure noise rather than tradeable patterns.

---

## 5. SHAP Feature Importance & Interactions

### 5.1 SHAP Importance — 5m Horizon

| Rank | Feature | SHAP | Category |
|---|---|---|---|
| 1 | hour\_cos | 0.0370 | Temporal |
| 2 | atr\_pct | 0.0312 | Volatility |
| 3 | macd\_histogram | 0.0274 | MACD |
| 4 | plus\_di | 0.0265 | Oscillator |
| 5 | stoch\_momentum | 0.0237 | Oscillator |
| 6 | rsi\_cci\_ratio | 0.0234 | Cross-Ratio |
| 7 | williams\_stoch\_diff | 0.0229 | Cross-Ratio |
| 8 | atr\_norm\_range | 0.0228 | Volatility |
| 9 | stc\_momentum | 0.0214 | STC |
| 10 | atr\_norm\_body | 0.0208 | Volatility |

### 5.2 SHAP Importance — 15m Horizon

| Rank | Feature | SHAP | Category |
|---|---|---|---|
| 1 | macd\_histogram | 0.0522 | MACD |
| 2 | hour\_cos | 0.0480 | Temporal |
| 3 | macd\_signal | 0.0458 | MACD |
| 4 | plus\_di | 0.0448 | Oscillator |
| 5 | bb\_width\_bps | 0.0437 | Volatility |
| 6 | macd\_over\_atr | 0.0427 | Cross-Ratio |
| 7 | hour\_sin | 0.0418 | Temporal |
| 8 | stoch\_momentum | 0.0396 | Oscillator |
| 9 | session\_american | 0.0311 | Temporal |
| 10 | macd\_line | 0.0307 | MACD |

**Key differences from non-OTC:**
- SHAP magnitudes are 5–10× smaller (0.037 vs 0.350 for top feature)
- **Temporal features rank #1** at 5m (hour\_cos) — time-of-day matters more than any indicator
- **MACD features dominate** at 15m — this is the primary predictive cluster for OTC
- session\_american appears at 15m, confirming American session has the most signal for OTC

### 5.3 SHAP Interaction Matrix

| Feature Pair | SHAP Corr | Interpretation |
|---|---|---|
| atr\_norm\_range × atr\_norm\_body | 0.315 | Candle size components correlated |
| atr\_pct × plus\_di | 0.148 | Volatility and DI weakly interact |
| hour\_cos × atr\_pct | 0.129 | Time-of-day × volatility |
| stoch\_momentum × atr\_norm\_range | 0.116 | Momentum × candle size |
| stoch\_momentum × stc\_momentum | 0.111 | Cross-oscillator synergy |
| atr\_pct × atr\_norm\_range | 0.110 | Volatility self-interaction |

**All interactions are much weaker** than non-OTC (max 0.315 vs 0.846), confirming lower signal-to-noise in OTC data.

---

## 6. Top Edges — Full Analysis

### ════════════════════════════════════════════════════════════════
### EDGE #1 — BigCandle + DI\_Pos → PUT
**Strategy Type:** Breakout Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 66.67% |
| **Sample Size** | 90 |
| **p-value** | 0.0010 ** |
| **Horizon** | 5m |

**Thresholds:** `ATR_norm_body > 1.5, DI_spread > 10`

| Session | WR | N |
|---|---|---|
| Asian | 65.5% | 29 |
| European | 50.0% | 8 |
| American | 71.4% | 35 |

**Why it works:** A big candle with positive DI (bullish directional energy) is an exhaustion spike in OTC. The strong American-session performance (71.4%) suggests institutional momentum followed by a reversal.

---

### ════════════════════════════════════════════════════════════════
### EDGE #2 — CCI\_High + RSI\_MidLow → CALL
**Strategy Type:** Momentum Divergence
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | CALL |
| **Win Rate** | 64.41% |
| **Sample Size** | 59 |
| **p-value** | 0.0182 * |
| **Horizon** | 5m and 10m |

**Thresholds:** `CCI_20 > 100, RSI_14 in [40, 50)`

| Session | WR | N |
|---|---|---|
| Asian | 53.9% | 13 |
| European | 83.3% | 6 |
| American | 65.8–71.1% | 38 |

**Why it works:** CCI extreme high with RSI in the lower-mid range = CCI is detecting momentum that RSI hasn't caught up with yet. This divergence predicts continuation. The **European session shows 83.3%** but small sample; American is the primary signal carrier.

---

### ════════════════════════════════════════════════════════════════
### EDGE #3 — LowVol + BigCandle → PUT
**Strategy Type:** Volatility Breakout Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 63.77% |
| **Sample Size** | 69 |
| **p-value** | 0.0148 * |
| **Horizons** | 5m and 10m |

**Thresholds:** `ATR_pct < 0.30, ATR_norm_body > 1.5`

| Session | WR | N |
|---|---|---|
| Asian | 54.6% | 22 |
| European | 57.1% | 7 |
| American | 67.7% | 31 |

**Why it works:** An oversized candle erupting from a low-volatility regime in OTC tends to exhaust. American session is the strongest context for this signal.

---

### ════════════════════════════════════════════════════════════════
### EDGE #4 — BigCandle + SMA\_Bear → PUT
**Strategy Type:** Trend Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 61.70% |
| **Sample Size** | 94 |
| **p-value** | 0.0149 * |
| **Horizon** | 5m |

**Thresholds:** `ATR_norm_body > 1.5, SMA_alignment_bear = 1`

| Session | WR | N |
|---|---|---|
| Asian | 53.9% | 39 |
| European | 66.7% | 9 |
| American | 67.7% | 31 |

**Why it works:** Big candle in a bearish SMA alignment = momentum exhaustion within a trend.

---

### ════════════════════════════════════════════════════════════════
### EDGE #5 — Stoch\_OB + DI\_Neg → PUT
**Strategy Type:** Reversal (Overbought in Bearish)
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 61.19% |
| **Sample Size** | 201 |
| **p-value** | 0.00092 *** |
| **Horizon** | 15m |

**Thresholds:** `Stoch_K > 80, DI_spread < -10`

| Session | WR | N |
|---|---|---|
| Asian | 60.0% | 85 |
| European | 61.1% | 18 |
| American | 62.3% | 77 |

**Why it works:** Stochastic overbought with bearish DI dominance. The **session-uniform** performance (60–62% across all sessions) is unusual for OTC and makes this the most **universally applicable** OTC edge. The large sample (N=201) and strong p-value (0.00092) provide the best statistical backing.

---

### ════════════════════════════════════════════════════════════════
### EDGE #6 — DI\_Neg + EMA\_Pos → PUT
**Strategy Type:** Trend Divergence
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 60.10% |
| **Sample Size** | 198 |
| **p-value** | 0.0027 ** |
| **Horizon** | 15m |

**Thresholds:** `DI_spread < -10, EMA_spread > 5`

| Session | WR | N |
|---|---|---|
| Asian | 63.8% | 80 |
| European | 48.9% | 47 |
| American | 57.5% | 47 |

**Why it works:** Bearish DI diverging from bullish EMA spread — the EMA is lagging and DI is leading the direction change. Asian session strongest (63.8%).

---

### ════════════════════════════════════════════════════════════════
### EDGE #7 — PSAR\_Bull + BigCandle → PUT
**Strategy Type:** Divergence Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 60.00% |
| **Sample Size** | 155 |
| **p-value** | 0.0079 ** |
| **Horizon** | 10m |

**Thresholds:** `PSAR_is_bullish = 1, ATR_norm_body > 1.5`

| Session | WR | N |
|---|---|---|
| Asian | 62.3% | 53 |
| European | 38.9% | 18 |
| American | 67.2% | 61 |

**Why it works:** Bullish PSAR with an outsized candle = exhaustion spike in OTC. American session (67.2%) is the primary signal carrier. European session inverts.

---

### ════════════════════════════════════════════════════════════════
### EDGE #8 — Williams\_OB + BigCandle → PUT
**Strategy Type:** Reversal Exhaustion
### ════════════════════════════════════════════════════════════════

| Metric | Value |
|---|---|
| **Direction** | PUT |
| **Win Rate** | 60.00% |
| **Sample Size** | 120 |
| **p-value** | 0.0177 * |
| **Horizon** | 5m |

**Thresholds:** `Williams_R > -20, ATR_norm_body > 1.5`

| Session | WR | N |
|---|---|---|
| Asian | 68.6% | 35 |
| European | 42.9% | 14 |
| American | 58.0% | 50 |

**Why it works:** Williams overbought with big candle = classic exhaustion in OTC. Asian session provides the strongest signal (68.6%).

---

## 7. Strategy Archetype Classification

| Strategy | Indicators | WR | N | Best Hz | Best Session | Key Assets |
|---|---|---|---|---|---|---|
| **Breakout Exhaustion** | big\_candle + di\_pos | 66.7% | 90 | 5m | American (71.4%) | CHFNOK\_otc (100%) |
| **Momentum Divergence** | cci\_hi + rsi\_mid\_lo | 64.4% | 59 | 5m/10m | American (65–71%) | NZDUSD\_otc |
| **Vol Breakout Exhaust** | low\_vol + big\_candle | 63.8% | 69 | 5m/10m | American (67.7%) | CHFNOK\_otc |
| **Trend Exhaustion** | big\_candle + sma\_bear | 61.7% | 94 | 5m | American (67.7%) | CHFNOK\_otc |
| **Universal Reversal** | stoch\_ob + di\_neg | 61.2% | 201 | 15m | Uniform (60–62%) | CADCHF\_otc, KESUSD\_otc |
| **Trend Divergence** | di\_neg + ema\_pos | 60.1% | 198 | 15m | Asian (63.8%) | Multiple |
| **Divergence Exhaust** | psar\_bull + big\_candle | 60.0% | 155 | 10m | American (67.2%) | CHFNOK\_otc |
| **Reversal Exhaust** | williams\_ob + big\_candle | 60.0% | 120 | 5m | Asian (68.6%) | AEDCNY\_otc |

### OTC vs Non-OTC Structural Differences

| Dimension | Non-OTC | OTC |
|---|---|---|
| **Max WR** | 98.1% | 66.7% |
| **Dominant direction** | PUT (strong, 55% base rate) | PUT (weak, 50.6% base rate) |
| **Session dependency** | Extreme Asian dominance | American session strongest |
| **Key indicator** | Candle\_range (SHAP 0.35) | hour\_cos / MACD (SHAP 0.04) |
| **Signal strength** | Strong (AUC 0.73) | Weak (AUC 0.58) |
| **CALL edges** | 1 found | 1 found (CCI+RSI) |
| **Big-candle role** | Less prominent | Central to most edges |
| **Best assets** | GBP pairs | CHFNOK\_otc, exotic pairs |

---

## 8. Asset-Time Matching Table

| Asset | Horizon | Strategy | Edge | Win Rate | N |
|---|---|---|---|---|---|
| CHFNOK\_otc | 5m | Breakout Exhaust | psar\_bull+big\_candle | 100% | 8 |
| CHFNOK\_otc | 5m | Breakout Exhaust | macd\_pos+big\_candle | 100% | 8 |
| CADCHF\_otc | 15m | Universal Reversal | stoch\_ob+di\_neg | 100% | 7 |
| KESUSD\_otc | 15m | Universal Reversal | stoch\_ob+di\_neg | 100% | 6 |
| CHFNOK\_otc | 5m | Reversal | williams\_ob+big\_candle | 100% | 6 |
| AEDCNY\_otc | 15m | Reversal | williams\_ob+big\_candle | 100% | 6 |
| AEDCNY\_otc | 15m | Breakout Exhaust | bb\_top+big\_candle | 100% | 6 |
| CHFNOK\_otc | 5m | Breakout | big\_candle+di\_pos | 100% | 5 |
| NZDUSD\_otc | 15m | Momentum Div | cci\_hi+rsi\_mid\_lo | 100% | 5 |
| CHFNOK\_otc | 5m/10m | Trend Exhaust | big\_candle+sma\_bear | 100% | 5 |
| CHFNOK\_otc | 5m/10m | Trend | big\_candle+ema\_neg | 100% | 5 |
| GBPCHF\_otc | 15m | Universal Reversal | stoch\_ob+di\_neg | 80.0% | 5 |
| EURUSD\_otc | 15m | Universal Reversal | stoch\_ob+di\_neg | 75.0% | 8 |
| GBPAUD\_otc | 15m | Trend Divergence | di\_neg+ema\_pos | 72.7% | 11 |
| EURUSD\_otc | 10m | Vol Breakout | low\_vol+big\_candle | 71.4% | 7 |

**Standout asset: CHFNOK\_otc** — appears in 8 of the top 15 entries with 100% WR across multiple edges. This exotic pair shows exceptional responsiveness to big-candle exhaustion signals, likely due to low liquidity and wide spreads creating pronounced reversal patterns.

---

## 9. Code-Ready Rule Blocks

```python
# ═══════════════════════════════════════════════════
# OTC PAIRS — Edge Functions
# ═══════════════════════════════════════════════════

def edge_breakout_exhaust_OTC(atr_norm_body, di_spread):
    """Edge #1: Big candle + bullish DI = exhaustion spike
    WR: 66.7% | N=90 | American: 71.4%"""
    if atr_norm_body > 1.5 and di_spread > 10:
        return "PUT", 0.667
    return None, None

def edge_momentum_diverge_OTC(cci_20, rsi_14):
    """Edge #2: CCI extreme + RSI mid-low = momentum divergence
    WR: 64.4% | N=59 | American: 65-71%"""
    if cci_20 > 100 and 40 <= rsi_14 < 50:
        return "CALL", 0.644
    return None, None

def edge_vol_breakout_OTC(atr_pct, atr_norm_body):
    """Edge #3: Low vol + big candle = exhaustion
    WR: 63.8% | N=69 | American: 67.7%"""
    if atr_pct < 0.30 and atr_norm_body > 1.5:
        return "PUT", 0.638
    return None, None

def edge_trend_exhaust_OTC(atr_norm_body, sma_alignment_bear):
    """Edge #4: Big candle in bear alignment = exhaustion
    WR: 61.7% | N=94 | American: 67.7%"""
    if atr_norm_body > 1.5 and sma_alignment_bear == 1:
        return "PUT", 0.617
    return None, None

def edge_universal_reversal_OTC(stoch_k, di_spread):
    """Edge #5: Stoch overbought + bearish DI = reversal
    WR: 61.2% | N=201 | Uniform across sessions
    BEST STATISTICAL BACKING for OTC"""
    if stoch_k > 80 and di_spread < -10:
        return "PUT", 0.612
    return None, None

def edge_trend_diverge_OTC(di_spread, ema_spread):
    """Edge #6: Bearish DI + bullish EMA = lagging divergence
    WR: 60.1% | N=198 | Asian: 63.8%"""
    if di_spread < -10 and ema_spread > 5:
        return "PUT", 0.601
    return None, None

def edge_psar_exhaust_OTC(psar_is_bullish, atr_norm_body):
    """Edge #7: Bullish PSAR + big candle = exhaustion
    WR: 60.0% | N=155 | American: 67.2%"""
    if psar_is_bullish == 1 and atr_norm_body > 1.5:
        return "PUT", 0.600
    return None, None

# ═══════════════════════════════════════════════════
# MASTER ROUTER — OTC PAIRS
# ═══════════════════════════════════════════════════
def get_signal_OTC(ind):
    """Check OTC edges in descending confidence order.
    NOTE: OTC edges are weaker (60-67% WR) than non-OTC.
    Use larger position sizing constraints accordingly."""
    atr_body = ind['atr_norm_body']
    di = ind['di_spread']; stoch = ind['stoch_k']
    cci = ind['cci_20']; rsi = ind['rsi_14']
    atr_pct = ind['atr_pct']; sma_bear = ind['sma_alignment_bear']
    ema_sp = ind['ema_spread']; psar = ind['psar_is_bullish']
    williams = ind['williams_r']

    # Priority 1: Big candle + bullish DI (66.7%)
    if atr_body > 1.5 and di > 10:
        return "PUT", 0.667, "BREAKOUT_EXHAUST"
    # Priority 2: CCI/RSI divergence — CALL (64.4%)
    if cci > 100 and 40 <= rsi < 50:
        return "CALL", 0.644, "MOMENTUM_DIVERGE"
    # Priority 3: Low vol + big candle (63.8%)
    if atr_pct < 0.30 and atr_body > 1.5:
        return "PUT", 0.638, "VOL_BREAKOUT"
    # Priority 4: Big candle in bear trend (61.7%)
    if atr_body > 1.5 and sma_bear == 1:
        return "PUT", 0.617, "TREND_EXHAUST"
    # Priority 5: Universal reversal (61.2%, best stats)
    if stoch > 80 and di < -10:
        return "PUT", 0.612, "UNIVERSAL_REVERSAL"
    # Priority 6: DI/EMA divergence (60.1%)
    if di < -10 and ema_sp > 5:
        return "PUT", 0.601, "TREND_DIVERGE"
    # Priority 7: PSAR exhaustion (60.0%)
    if psar == 1 and atr_body > 1.5:
        return "PUT", 0.600, "PSAR_EXHAUST"
    # Priority 8: Williams exhaustion (60.0%)
    if williams > -20 and atr_body > 1.5:
        return "PUT", 0.600, "WILLIAMS_EXHAUST"
    return None, None, None
```

---

## 10. Statistical Validation

| Metric | Non-OTC (Report A) | OTC (Report B) |
|---|---|---|
| Best model AUC (15m) | **0.7283** | 0.5757 |
| Best edge WR | **98.1%** | 66.7% |
| Edges with p < 0.001 | Many (>20) | 2 |
| Max feature correlation | |r| = 0.148 | |r| = 0.023 |
| Label balance | 45.0% / 55.0% (PUT bias) | 49.4% / 50.6% (balanced) |
| Cross-asset consistency | 2.9–3.4 | 0.2–0.4 |
| Session dependency | Asian dominant | American dominant |
| Key predictor | candle\_range | hour\_cos / MACD |
| Dominant edge type | Reversal / False Bounce | Breakout Exhaustion |
| CALL edges found | 1 | 1 |

### OTC-Specific Limitations

- OTC pairs are fundamentally noisier — 5m is unpredictable (AUC ~0.50)
- Win rates top out at 66.7% (vs 98.1% for non-OTC)
- Small per-asset sample sizes (N=5–8) on top entries warrant extreme caution
- CHFNOK\_otc appears dominant but may reflect pair-specific anomaly
- Edge confidence should be discounted by ~15–20% for OTC vs non-OTC
- The balanced label distribution (49.4/50.6) means there is no "free" directional bias
- Only the 15m horizon shows meaningful predictability — deploy edges at 15m where possible

---

*End of Report B — OTC Pairs*
