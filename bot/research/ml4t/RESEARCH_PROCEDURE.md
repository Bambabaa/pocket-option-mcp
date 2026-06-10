# Trend-Continuation State Classification — Research Procedure

Self-contained study. A fresh session reads this file and reproduces the work from the repo alone.
Status: **SPEC — documented, building.** Read-only on snapshot DBs; no live DB writes.

This is a CLEAN restart (the prior macd_hist-slope momentum study was wiped). The decisive change is
the **label**: a price-based, tradeable target instead of an indicator's own slope.

---

## 1. Hypotheses
| | Statement |
|---|---|
| **H1** | A classifier on combined trend + momentum + volatility/directional indicators classifies momentum **gain / stable / decay** better than a linear baseline. |
| **H0** | The indicators do not beat random/baseline for this 3-class problem. |
| **H1a (trend)** | SMA10/20/50, EMA12/26, PSAR help identify strengthening vs weakening price movement. |
| **H1b (momentum)** | RSI14, Stoch %K/%D/prev%D, MACD line/signal/hist, CCI20, Williams%R14, STC value/signal/prev/delta improve detection of momentum transitions. |
| **H1c (volatility/directional)** | BB upper/mid/lower + width, Keltner u/m/l, ATR14, ATR%, ADX14/+DI/−DI improve separation of sustained vs weakening momentum. |

Tested via a **per-family ablation** (H1a-only, H1b-only, H1c-only, all) — each family's standalone
and marginal contribution is measured, directly answering H1a/H1b/H1c.

---

## 2. Target — NEW label (price-based, tradeable). LOCKED.
Signed trend-continuation over horizon n, relative to the current trend direction:
```
s = sign(close[t] - close[t-k])              # current trend direction (k-bar)
f = s * (close[t+n] - close[t]) / ATR_14[t]  # ATR-normalized signed continuation
gain   = f in TOP tercile     (trend accelerates in its direction)
stable = f in MIDDLE tercile  (flattens)
decay  = f in BOTTOM tercile  (decelerates / reverses)
```
- **k = 6** bars (trend definition), **n = 3** bars (forward horizon). Robustness: k∈{3,12}, n∈{6,12}.
- Terciles fit on the **training fold only** (causal) → balanced classes.
- **Why this is new & better:** the target is a forward PRICE move, not an indicator's slope, so a
  positive result means tradeable structure — not the smoothed-indicator inertia the prior study found.
- **Leakage note:** `f` references only future price (the target) times a known sign `s`; no current
  feature is mechanically inside the label. The EDA gate (Step 4) verifies this before modeling.

---

## 3. Features — grouped by H1a/b/c family (all causal, at bar close)
Levels that are non-stationary price are encoded as ATR-normalized distances/slopes/spreads.
- **TREND (H1a):** (close−sma10/20/50)/ATR, (close−ema12/26)/ATR, Δsma/Δema slopes, ema12−ema26,
  sma10−sma20, sma20−sma50 (all /ATR), (close−psar)/ATR, psar_bull.
- **MOMENTUM (H1b):** rsi, Δrsi, stoch_k, stoch_d, stoch_k−stoch_d, stoch_d−stoch_prevd,
  macd_hist, Δmacd_hist, macd_line−macd_signal, cci, williams, stc_value, stc_delta,
  stc_value−stc_signal, Δstc.
- **VOL/DIRECTIONAL (H1c):** bb_width_bps, Δbb_width, %B=(close−bb_lower)/(bb_upper−bb_lower),
  squeeze=bb_width/kc_width, (close−kc_middle)/ATR, atr_pct, Δatr_pct, adx, Δadx, di_spread=+DI−−DI.

REGISTRY tags every feature with its family so the ablation restricts cleanly.

---

## 4. Data
- All **21** synchronized FX pairs (June snapshots, 5-min bars) + **cross-regime** agent.db (May,
  ~14.6 days, older indicator names aliased). Candles + indicators only (read-only).

## 5. Validation & metrics
- Walk-forward / purged TimeSeriesSplit(5) over UNIQUE TIMESTAMPS (cross-section moves together),
  **embargo ≥ n** so forward labels don't leak. Impute+scale **inside** each fold.
- Metrics: macro-F1, balanced accuracy, OvR ROC-AUC, confusion matrix, per-class P/R.
  Random baseline: F1 0.333 / AUC 0.500.
- H1 vs H0: McNemar (ML vs LogReg) + bootstrap CI on macro-F1 gain. Cross-regime replication = SOP Step 5.

## 6. Models
LogReg (baseline) → RandomForest → XGBoost. (Sequential models optional later.)

## 7. Procedure / todos
1. Lock label (done). 2. Feature extractor (family-grouped). 3. Label constructor + EDA leakage gate.
4. Modeling harness + per-family ablation. 5. Stats + cross-regime. 6. Findings + verdict on H1/a/b/c.
Each step records the command that produced its result.
