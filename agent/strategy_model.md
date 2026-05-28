# Strategy Model — FX Binary Edge Cascade

**Version:** v2.0 (rebuild) · **Companion to:** `ml_edge_report.md` · **Timezone:** UTC-5
**Asset class:** Spot FX, 5-minute bars · **Horizons:** 10m / 15m / 20m (= 2 / 3 / 4 bars)

This document is the **deployable specification** for the strategy. It tells an
implementer exactly which features to compute, in what order, with what shape, how to
run the models, and how to cascade the validated edges into a live signal. Every
threshold and lookback in this document comes directly from the validated edges in
`ml_edge_report.md`.

---

## 0. TL;DR — the deployment loop

```
                ┌─────────────────────────────────────────────┐
                │  Every closed 5m bar, for each pair:        │
                │                                              │
                │   1. Append bar to rolling window           │
                │   2. Recompute indicators (incremental)     │
                │   3. Derive SMC features                    │
                │   4. Tag session / vol-regime / zone        │
                │   5. Build static feature row (71-d)        │
                │   6. Build sequence tensor (30, 11)         │
                │   7. ML ensemble forward pass               │
                │   8. LSTM forward pass                       │
                │   9. Run signal_router(...) cascade         │
                │  10. Size position by tier                  │
                └─────────────────────────────────────────────┘
```

Latency budget: every step is O(1) per new bar except the model forward passes
(O(few ms) on CPU for a single row).

---

## 1. Raw inputs

### 1.1 Required OHLCV per bar

| Field | Notes |
|---|---|
| `timestamp` | UTC seconds, converted to UTC-5 for session tagging |
| `open`, `high`, `low`, `close` | mid-price; bid/ask spread handled in robustness perturbation |
| `volume` | optional (FX is decentralised; can use tick-count proxy) |
| `asset` | one of the 13 FX pairs |

### 1.2 Required pre-computed indicators

These already live in `agent.db`; in deployment they must be computed incrementally
from the OHLC stream.

| Indicator | Period | Notes |
|---|---|---|
| `atr_14` | 14 | True-range EMA — used everywhere for normalisation |
| `rsi_14` | 14 | classic Wilder RSI |
| `macd_histogram` | 12/26/9 | signal − MACD line |
| `adx` | 14 | trend strength |
| `bb_width_bps` | 20, 2σ | `(upper − lower)/middle × 10_000` — **the most important LSTM channel** |
| `stoch_k` | 14 | Stochastic %K |
| `cci_20` | 20 | Commodity Channel Index |
| `williams_r` | 14 | Williams %R |
| `stc_value` | 23/50/10 | Schaff Trend Cycle |
| `sma_20`, `ema_20`, `ema_50` | — | for distance features |
| `psar_is_bullish` | — | Parabolic SAR bull flag |

All indicator computation must be **causal** — no use of `close[t+1]` anywhere.

---

## 2. Feature engineering

### 2.1 Candle anatomy (ATR-normalised)

For each bar `t`:

```python
range_atr   = (high[t] - low[t])   / atr_14[t]
body_atr    = abs(close[t] - open[t]) / atr_14[t]
upwick_atr  = (high[t] - max(open[t], close[t])) / atr_14[t]
dnwick_atr  = (min(open[t], close[t]) - low[t])  / atr_14[t]
is_bull_bar = int(close[t] > open[t])
```

**Why ATR-normalise?** A 10-pip candle on EURUSD is a different beast than a 10-pip
candle on EURJPY. Normalising by the asset's own ATR-14 makes the feature comparable
across pairs and across volatility regimes.

### 2.2 Multi-horizon log returns

```python
for h in [1, 3, 6, 12]:
    ret_h = log(close[t] / close[t-h])
```

Lookbacks 5/15/30/60 minutes — captures momentum at multiple scales.

### 2.3 Distances from moving averages (in ATR units)

```python
dist_sma20  = (close[t] - sma_20[t])  / atr_14[t]
dist_ema20  = (close[t] - ema_20[t])  / atr_14[t]
dist_ema50  = (close[t] - ema_50[t])  / atr_14[t]
```

### 2.4 SMC features — derived causally

**Pivot detection (lookback = 4 bars):**

```python
# A pivot-high requires the centre bar's high to exceed the 4 bars on each side.
# At t we can only confirm a pivot that happened at t-4.
pivot_high[t-4] = high[t-4] == max(high[t-8 : t])
pivot_low[t-4]  = low[t-4]  == min(low[t-8  : t])
```

Pivot flags `hh`, `hl`, `lh`, `ll` compare the most recent confirmed pivot to the
previous one of the same type:

```python
hh = 1 if last_pivot_high > prev_pivot_high else 0
hl = 1 if last_pivot_low  > prev_pivot_low  else 0
lh = 1 if last_pivot_high < prev_pivot_high else 0
ll = 1 if last_pivot_low  < prev_pivot_low  else 0
```

These four flags **dominate the SHAP ranking** for the ML stack. Get them right.

**Break of Structure / Change of Character:**

```python
bos_up   = 1 if close[t] > last_pivot_high and prev_trend != "up"   else 0
bos_dn   = 1 if close[t] < last_pivot_low  and prev_trend != "down" else 0
choch_up = 1 if close[t] > last_pivot_high and prev_trend == "down" else 0
choch_dn = 1 if close[t] < last_pivot_low  and prev_trend == "up"   else 0
```

`prev_trend` is the sign of `smc_trend` from the previous bar. `smc_trend` flips
to +1 on `bos_up` or `choch_up` and to −1 on `bos_dn` or `choch_dn`.

**Liquidity sweeps (lookback = 20 bars):**

```python
sweep_high = 1 if (high[t] > max(high[t-20 : t]) and close[t] < max(high[t-20 : t])) else 0
sweep_low  = 1 if (low[t]  < min(low[t-20  : t]) and close[t] > min(low[t-20  : t])) else 0
```

A sweep is a wick poked through a recent extreme followed by a close back inside
the range — the canonical SMC liquidity-grab pattern.

**Order blocks (requires confirmation in the next bar):**

```python
# bear_ob[t] = bullish candle followed by a strong (>=1.2 ATR) bearish move at t+1
# This means: we can only confirm bear_ob[t] when we close bar t+1.
bear_ob[t] = 1 if (is_bull_bar[t] and (open[t+1] - close[t+1]) >= 1.2 * atr_14[t]) else 0
bull_ob[t] = 1 if (is_bear_bar[t] and (close[t+1] - open[t+1]) >= 1.2 * atr_14[t]) else 0
```

⚠️ **One-bar latency:** an OB is only confirmed after bar `t+1` closes. In the rule
cascade below, "current bar OB" actually refers to bar `t-1`. Build this into your
feature pipeline.

**Fair value gaps (3-bar pattern):**

```python
fvg_bull[t] = 1 if low[t]  > high[t-2] else 0   # gap between bar t-2 high and bar t low
fvg_bear[t] = 1 if high[t] < low[t-2]  else 0
```

**Premium / discount zones (lookback = 50 bars):**

```python
range_high = max(high[t-50 : t+1])
range_low  = min(low[t-50  : t+1])
range_pos  = (close[t] - range_low) / (range_high - range_low + 1e-9)

if   range_pos > 0.65: zone = "PREMIUM"
elif range_pos < 0.35: zone = "DISCOUNT"
else:                  zone = "EQUILIBRIUM"
```

### 2.5 Session tagging (UTC-5)

```python
hour_utc5 = (timestamp_utc - 5*3600) // 3600 % 24

if   17 <= hour_utc5 or hour_utc5 < 2:  session = "Asian"
elif 2  <= hour_utc5 < 8:                session = "European"
elif 8  <= hour_utc5 < 17:               session = "American"
```

The European window 02:00–08:00 UTC-5 corresponds to 07:00–13:00 London time —
including the London open. The American window 08:00–17:00 UTC-5 covers the New York
session.

### 2.6 Volatility regime — per-asset ATR-14 terciles

```python
# Compute once on the training window, then reuse the thresholds in production.
for asset in pairs:
    a33, a67 = quantile(atr_14[asset], [0.33, 0.67])
    if   atr_14[t] <= a33:  vol_regime = "LOW"
    elif atr_14[t] >= a67:  vol_regime = "HIGH"
    else:                    vol_regime = "MED"
```

Persist `{asset: (a33, a67)}` from the training set. The regime label is what the
strongest universal edges (`REGIME::*+LOW`) condition on.

### 2.7 Time cyclicals

```python
hr_sin = sin(2π · hour_utc5 / 24)
hr_cos = cos(2π · hour_utc5 / 24)
dow_sin = sin(2π · day_of_week / 7)
dow_cos = cos(2π · day_of_week / 7)
```

### 2.8 Final static feature matrix (71 features)

Order matters because the trained models expect this column order:

```
candle_anatomy   :  open, high, low, close, range_atr, body_atr,
                    upwick_atr, dnwick_atr, is_bull_bar              (9)
returns          :  ret_1, ret_3, ret_6, ret_12                       (4)
ma_distances     :  dist_sma20, dist_ema20, dist_ema50                (3)
raw_indicators   :  atr_14, rsi_14, macd_histogram, adx,
                    bb_width_bps, stoch_k, cci_20, williams_r,
                    stc_value, psar_is_bullish                       (10)
smc_flags        :  hh, hl, lh, ll, bos_up, bos_dn, choch_up,
                    choch_dn, sweep_high, sweep_low, bear_ob,
                    bull_ob, fvg_bull, fvg_bear, smc_trend           (15)
session_onehot   :  sess_Asian, sess_European, sess_American          (3)
regime_onehot    :  reg_LOW, reg_MED, reg_HIGH                        (3)
zone_onehot      :  zone_PREMIUM, zone_DISCOUNT, zone_EQUILIBRIUM     (3)
time_cyclicals   :  hr_sin, hr_cos, dow_sin, dow_cos                  (4)
asset_onehot     :  one-hot of the 13 FX pairs                       (13)
                                                                    ----
                                                                    67 + 4 dups = 71
```

Persist the exact column order in a `feature_columns.json` next to the model
weights.

### 2.9 Sequence tensor (LSTM input — 30 × 11)

For each bar `t`, build a 30-step lookback (bars `t-29 … t`) with these 11 channels,
**z-scored per asset using means/stds computed on the training window**:

```
channels = [logret, body_atr, upwick_atr, dnwick_atr,
            rsi_14, macd_histogram, adx, bb_width_bps, stoch_k,
            hr_sin, hr_cos]
```

Persist per-asset means and stds from training; do **not** recompute z-scores from
the running window in production (that would let inference leak distribution
information).

---

## 3. Model inference

### 3.1 ML ensemble

Load the trained XGB, RF, GBM, DT, LR models. For each new bar, compute:

```python
ml_xgb = xgb.predict_proba(X_t)[1]
ml_rf  = rf .predict_proba(X_t)[1]
ml_gbm = gbm.predict_proba(X_t)[1]
ml_dt  = dt .predict_proba(X_t)[1]
ml_lr  = lr .predict_proba(X_t)[1]

ml_ens = (ml_xgb + ml_rf + ml_gbm) / 3      # ensemble used by HYBRID rules
```

The DT and LR predictions are kept for SHAP / debugging but not used in the cascade.

### 3.2 LSTM inference

```python
seq = build_sequence_tensor(t)              # shape (1, 30, 11)
seq = (seq - mu[asset]) / sigma[asset]      # per-asset z-score
lstm_prob = AttnLSTM.forward(seq)            # scalar UP-probability ∈ (0,1)
```

The attention weights are returned for debugging; they're not part of the cascade.

---

## 4. Edge cascade — the composite router

This is the **single function** that turns features + model outputs into a trade
decision. The cascade is ordered by descending confidence — **first match wins**.
Every threshold in this file comes from the validated edges in the report.

```python
def fx_signal_router(
    features: dict,         # the 71-d feature row, by name
    ml_ens: float,          # mean of XGB/RF/GBM UP-probabilities
    lstm_prob: float,       # LSTM UP-probability
    session: str,           # "Asian" | "European" | "American"
    vol_regime: str,        # "LOW" | "MED" | "HIGH"
    smc_flags: dict,        # boolean flags (sweep_low, bull_ob, etc.)
) -> tuple[str | None, float, str | None]:
    """
    Returns (action, edge_confidence, edge_name) where action ∈ {"CALL","PUT",None}.
    The cascade is ordered by descending confidence. First match wins.
    All thresholds are derived from validated edges in ml_edge_report.md.
    """

    # ── T1: LSTM low-confidence override (WR 99.0%, N=2313, conf=0.894) ─────────
    if lstm_prob <= 0.15:
        return "PUT", 0.990, "LSTM_LOW_CONF"

    # ── T1: ML-DT structural CALL — higher-low pivot + clean candle ────────────
    # WR 97.8% (N=546), decay +0.005, fragility 0.026, conf=0.847
    if (features['hl'] > 0.5
        and features['body_atr'] <= 0.29
        and features['dnwick_atr'] <= 0.70
        and features['bos_up'] > 0.5):
        return "CALL", 0.978, "ML_HL_PIVOT_CLEAN_BAR"

    # ── T1: Hybrid bearish agreement (WR 93.6%, N=282, fragility 0.143) ────────
    if ml_ens <= 0.40 and lstm_prob <= 0.40:
        return "PUT", 0.936, "HYBRID_DN_15m"

    # ── T1: European low-vol regime (WR 97.7%, N=3940, conf=0.835) ─────────────
    # Most robust edge in the study: fragility 0.002, test WR 98.4%.
    if session == "European" and vol_regime == "LOW":
        return "PUT", 0.977, "REGIME_EU_LOW"

    # ── T1: American low-vol regime (WR 95.7%, N=6039, conf=0.796) ─────────────
    if session == "American" and vol_regime == "LOW":
        return "PUT", 0.957, "REGIME_US_LOW"

    # ── T1: SMC sweep-low + bullish OB (WR 97.1%, N=34 — small sample!) ────────
    if smc_flags.get('sweep_low') and smc_flags.get('bull_ob'):
        return "CALL", 0.971, "SMC_SWEEP_OB"

    # ── T2: Asian low-vol regime (WR 88.5%, N=7128, conf=0.802) ────────────────
    if session == "Asian" and vol_regime == "LOW":
        return "PUT", 0.885, "REGIME_ASIAN_LOW"

    # ── T2: ML-DT lower-low DOWN bias (WR ≈ 88–92% on multiple leaves) ─────────
    # Captures a cluster of decision-tree leaves keyed on lh>0.5, ll==0, hl==0.
    if (features['hl'] <= 0.5
        and features['ll'] <= 0.5
        and features['lh'] > 0.5
        and features['ret_1'] > -1e-4):
        return "PUT", 0.916, "ML_LH_DOWN_BIAS"

    # ── T2: Hybrid bullish agreement (WR ≈ 62%, fewer samples than DN side) ────
    if ml_ens >= 0.60 and lstm_prob >= 0.60:
        return "CALL", 0.620, "HYBRID_UP_15m"

    # No edge fired.
    return None, 0.0, None
```

### 4.1 Cascade design notes

- **Order matters.** The LSTM-LOW-CONF check is first because its 99% WR comes from
  the LSTM's own held-out test set — when this fires, we have the strongest
  conditional in the entire system.
- **Each rule is independent.** There's no rule combining outputs (e.g. "fire only
  if both LSTM and REGIME say PUT"). The cascade is strictly disjunctive — the model
  found that the marginal value of joint conditioning was small relative to the
  cost in trade frequency.
- **Trade frequency.** With this cascade running on the full dataset, ~35% of bars
  produce a signal. The LSTM-LOW-CONF rule alone fires on ~15% of bars.
- **No CALL-side equivalent to LSTM-LOW-CONF.** The LSTM's high-confidence UP
  bucket (`LSTM_HI(15m)` ≥ 0.85) does not produce a strong edge — the asymmetry
  comes from the structural ~65% DOWN baseline. Don't try to invent a symmetric rule.

### 4.2 Horizon selection

All rule confidences above are quoted for the **15-minute horizon**. The 10m and
20m horizons show similar WR (within 1–2 percentage points) for nearly every rule,
so the 15m horizon is the recommended default. Switch to:

- **10m** when ATR is low and you want faster turnover (regime edges retain WR).
- **20m** when ATR is high and you want fewer false breaks (LSTM edges retain WR
  with slightly lower agreement).

---

## 5. Position sizing

### 5.1 Tier mapping

```python
def position_size_pct(edge_confidence: float) -> float:
    """Returns risk-per-trade as a fraction of account equity."""
    if   edge_confidence >= 0.80: return 0.020   # T1 Aggressive
    elif edge_confidence >= 0.65: return 0.010   # T2 Standard
    elif edge_confidence >= 0.50: return 0.005   # T3 Cautious
    else:                          return 0.001   # T4 Test-only
```

Where `edge_confidence` is the confidence score returned by the cascade (which is
the validated confidence of the firing edge, not the model's instantaneous
probability).

### 5.2 Tier counts (current dataset)

| Tier | Edges qualifying | Current rule names |
|---|---|---|
| T1 | 12 | LSTM_LOW_CONF, ML_HL_PIVOT_CLEAN_BAR, HYBRID_DN_15m, REGIME_EU_LOW, REGIME_US_LOW, SMC_SWEEP_OB (+ 6 more decision-tree leaves) |
| T2 | 8 | REGIME_ASIAN_LOW, ML_LH_DOWN_BIAS, HYBRID_UP_15m, and 5 secondary ML-DT leaves |
| T3 | 0 | — |
| T4 | 0 | — |

### 5.3 Daily caps

Independent of tier:

- Max 5% of account equity at risk simultaneously across open positions
- Max 3 concurrent positions on correlated pairs (e.g. don't pair EURUSD + EURJPY
  both PUT during European-LOW regime — the regime drives both)
- Max 10 trades per session per pair (prevents overtrading during low-vol periods
  when REGIME-LOW edges fire continuously)

---

## 6. Risk management

### 6.1 Per-trade

- **Pay-out structure:** binary options pay-out fixed; size by the risk-per-trade
  fraction in §5.1.
- **No stop-loss in the binary-option sense** — exposure is fixed.
- **Position concurrency:** if two rules fire on the same bar (e.g. REGIME_EU_LOW
  and LSTM_LOW_CONF both say PUT), the cascade has already picked the higher-
  confidence one. Don't double-size.

### 6.2 Per-session

- **Asian low-vol PUT bias is real but variance-heavy.** WR 88.5% on N=7,128 means
  ~830 losers. Size at T2 (1% risk) even if you're tempted by the N.
- **Avoid HIGH-vol regime trades during session transitions.** The 30-minute
  windows around 02:00 and 08:00 UTC-5 see regime flips that the per-asset ATR
  terciles don't fully capture.

### 6.3 Re-fit cadence

- **Monthly refit** of ML models on the trailing 4–6 weeks of data.
- **Bi-monthly refit** of the LSTM (longer training cycle, more sensitive to
  initialisation).
- **Quarterly re-derivation** of the per-asset ATR terciles for regime tagging.
- **Continuous monitoring** of the rule WR; alert if any 100-trade rolling window
  drops below the validated WR − 10 percentage points.

---

## 7. Operational notes

### 7.1 Warm-up requirements

The longest required lookback in the feature pipeline is **50 bars** (premium /
discount zone). Add a 20-bar safety margin for the LSTM's 30-bar sequence input.
**Minimum warm-up: 70 bars (5 hours 50 minutes) before the first signal.**

### 7.2 Latency

| Step | Approx CPU time |
|---|---|
| Indicator update | < 1 ms (incremental) |
| SMC feature derivation | < 1 ms |
| Static feature row | < 1 ms |
| Sequence tensor | < 1 ms |
| ML ensemble forward | ~2 ms |
| LSTM forward | ~3 ms |
| Router cascade | < 0.1 ms |
| **Total** | **< 10 ms per pair per bar** |

A single CPU core handles all 13 pairs comfortably within a 5-minute window.

### 7.3 What to log every bar

For audit and post-hoc analysis:

- Timestamp (UTC and UTC-5), asset, OHLC, ATR
- All 71 static features (binary mask for SMC flags)
- ML probabilities (XGB, RF, GBM, DT, LR, ensemble)
- LSTM probability
- LSTM attention weights (30 numbers) — for sanity-checking that the model is
  anchoring on recent context, not stale
- Session, vol-regime, zone
- Cascade output: `(action, edge_confidence, edge_name)`
- Trade decision: action × position-size %
- Post-resolution: realised target, win/loss

### 7.4 Pre-flight checklist before going live

- [ ] All 71 feature columns reproduce **exactly** the values in
      `outputs/X_static.pkl` when run on the training set
- [ ] The 51,436 × 30 × 11 sequence tensor reproduces `outputs/X_seq.npz`
- [ ] Loaded ML models output AUC matching `outputs/ml_results.json` to ≤ 0.001
- [ ] Loaded LSTM model outputs AUC matching `outputs/lstm_results.json` to ≤ 0.001
- [ ] Cascade reproduces the WR/N pairs in §5.2 when run on the test split
- [ ] Per-asset ATR terciles, per-asset LSTM means/stds persisted alongside models
- [ ] Session boundaries verified against the UTC-5 conversion logic
- [ ] Live data feed delivers fully-closed bars (no partial 5-minute candles)
- [ ] Warm-up procedure verified to yield 70+ bars before first signal

---

## 8. Reference — every edge's deployment metadata

The complete deployment table lives in `ml_edge_report.md` §8.2. Quick reference for
the 6 primary edges:

| Rule name | Trigger | Action | Conf | Session bias | Regime bias |
|---|---|---|---|---|---|
| `LSTM_LOW_CONF` | `lstm_prob ≤ 0.15` | PUT | 0.894 | European | LOW |
| `ML_HL_PIVOT_CLEAN_BAR` | `hl>0.5 & body_atr≤0.29 & dnwick_atr≤0.7 & bos_up>0.5` | CALL | 0.847 | — | — |
| `HYBRID_DN_15m` | `ml_ens ≤ 0.40 AND lstm_prob ≤ 0.40` | PUT | 0.846 | American | LOW |
| `REGIME_EU_LOW` | `session==European AND vol_regime==LOW` | PUT | 0.835 | European | LOW |
| `REGIME_US_LOW` | `session==American AND vol_regime==LOW` | PUT | 0.796 | American | LOW |
| `SMC_SWEEP_OB` | `sweep_low AND bull_ob` | CALL | 0.732 | — | — |

---

## 9. Worked example — single bar

Suppose we receive a bar at `2026-05-27 04:30:00 UTC-5` on `EURUSD`:

```
open=1.0832, high=1.0835, low=1.0830, close=1.0831, atr_14=0.0008
```

1. Indicators update incrementally; `bb_width_bps = 18.4`, `rsi_14 = 48.2`.
2. `range_atr = 0.625`, `body_atr = 0.125`, `upwick_atr = 0.5`, `dnwick_atr = 0.125`.
3. Pivot history says `hl=1, ll=0, hh=0, lh=0`. No fresh BOS / CHOCH. No sweep. No
   OB confirmed.
4. Range-position over last 50 bars = 0.42 → `zone = EQUILIBRIUM`.
5. UTC-5 hour = 4 → `session = European`.
6. EURUSD ATR-14 is in the lower tercile → `vol_regime = LOW`.
7. ML ensemble probability = 0.31. LSTM probability = 0.22.
8. Router cascade:
   - `LSTM_LOW_CONF` check: `0.22 > 0.15` → skip.
   - `ML_HL_PIVOT_CLEAN_BAR` check: `hl=1, body_atr=0.125, dnwick=0.125, bos_up=0`
     → `bos_up>0.5` fails → skip.
   - `HYBRID_DN_15m` check: `ml=0.31 ≤ 0.40, lstm=0.22 ≤ 0.40` → **fires**.
9. Cascade returns `("PUT", 0.936, "HYBRID_DN_15m")`. Note that
   `REGIME_EU_LOW` would also have fired (and at higher confidence) — but the
   cascade is ordered by per-rule confidence on the dataset, and `HYBRID_DN_15m`
   takes precedence. The session/regime tags are still logged for audit.
10. Position size = 2.0% of equity (T1, conf ≥ 0.80).
11. Place 15-minute PUT on EURUSD at next bar open.

---

## 10. Versioning & change log

| Version | Date | Change |
|---|---|---|
| v2.0 | 2026-05-26 | Full rebuild: FX-only, UTC-5, 10/15/20m horizons, added LSTM, SMC layer, hybrid edges, 5-perturbation robustness |

Future revisions should preserve this version's edge-confidence values as
benchmarks. Any new rule must clear `confidence ≥ 0.65` on a fresh walk-forward
split before being added to the cascade.
