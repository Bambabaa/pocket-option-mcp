# 7-Gate STC Reversal Strategy — Upgrade Summary

**Date**: 2026-04-28  
**Script**: `scripts/paper_reversal_csv.cjs`

---

## ✅ What Changed

### **Old Strategy** (Discarded)
- Simple RSI/Stoch/BB reversal combinations (7 patterns)
- No STC validation
- No retracement depth checks
- No trend filters
- Loose thresholds (RSI < 30/> 70, Stoch K < 20/> 80)

### **New Strategy** (7-Gate STC Reversal)
Two signals only:
1. **STC_CALL_7G** — Deeply oversold bounce with retracement validation
2. **STC_PUT_7G** — Deeply overbought reversal with extension validation

---

## 🎯 CALL Reversal Gates (7 gates, all must pass)

| Gate | Condition | Threshold | Rationale |
|---|---|---|---|
| **g1** | STC ≤ floor | 20 | Deeply oversold (tightened from 25) |
| **g2** | STC > STC[-1] | — | Momentum turning up (crossover proxy) |
| **g3** | RSI < max | 20 | Deeply oversold (tightened from 30) |
| **g4** | K > D AND K < max | 35 | Bullish cross in oversold zone (tightened from 50) |
| **g5** | BB width ≥ min | 10 bps | Volatility gate (validated: < 10 bps = 45.8% WR) |
| **g6** | RSI trough (10 bars) < min | 15 | Deep retracement validation (**NEW**) |
| **g7** | MA6-MA14 gap > min | -20 bps | Not in strong downtrend (**NEW**) |

**Expected impact**: -70-80% signals, +20-30% WR improvement

---

## 🎯 PUT Reversal Gates (7 gates, all must pass)

| Gate | Condition | Threshold | Rationale |
|---|---|---|---|
| **g1** | STC ≥ ceiling | 75 | Deeply overbought (unchanged) |
| **g2** | STC < STC[-1] | — | Momentum turning down |
| **g3** | RSI > min | 70 | Overbought (tightened from 60) |
| **g4** | K < D AND K > min | 65 | Bearish cross in overbought zone (tightened from 50) |
| **g5** | BB width ≥ min | 10 bps | Volatility gate |
| **g6** | RSI peak (10 bars) > min | 80 | Deep extension validation (**NEW**) |
| **g7** | MA6-MA14 gap < max | 20 bps | Not in strong uptrend (**NEW**) |

**Expected impact**: -70-80% signals, +20-30% WR improvement

---

## 📊 Initial Results (First Test Run)

**Data source**: `data/trading_data.db` (35,265 candles scanned)  
**Output**: 46 signals fired

### Win Rates by Expiry
| Expiry | Wins | Losses | Win Rate |
|---|---|---|---|
| **1 min** | 30 | 16 | **65.2%** |
| **2 min** | 33 | 13 | **71.7%** ✅ |
| **3 min** | 31 | 15 | **67.4%** |
| **5 min** | TBD | TBD | TBD |
| **10 min** | TBD | TBD | TBD |

### Direction Breakdown
- **CALL signals**: 17 (37%)
- **PUT signals**: 29 (63%)

**Observation**: PUT bias aligns with historical data (PUT 59.8% vs CALL 42.1% baseline WR).

---

## 🔬 Evidence Base for Gates

| Gate Change | Source | Evidence |
|---|---|---|
| STC ≤ 20 (CALL) | `po_optimize_gates` grid search | Tested 10/15/18/20/22/25/28/30 — tighter = higher WR |
| RSI < 20 (CALL) | `po_find_edge` by_retracement | RSI trough < 10 = 70.6% WR vs 30+ = 33.3% WR |
| RSI > 70 (PUT) | `po_find_edge` by_rsi | 70-80 = 66.7%, 80-100 = 69% vs 60-70 = ~55% |
| Stoch K < 35 (CALL) | `po_find_edge` by_stochastic_k | 0-20 = 71.4% WR, 20-40 = 58.4% |
| Stoch K > 65 (PUT) | `po_find_edge` by_stochastic_k | 80-100 = 67.1% WR, 60-80 = 63.1% |
| BB width ≥ 10 bps | `bb_width_report.md` | < 10 bps = 45.8% WR, -$3,580 P/L on 135 signals |
| RSI trough/peak gates | `po_find_edge` by_retracement | Deep retracements = +15-20% WR improvement |
| MA trend filters | `po_find_edge` by_ma_gap_trend | With-trend: CALL 68.9%, PUT 73.1% vs against-trend 42-52% |

---

## 📁 CSV Output Columns

**New columns added**:
- `stc` — Schaff Trend Cycle current value
- `stc_prev` — Prior bar STC (for momentum gate)
- `rsi_peak_10` — Max RSI in prior 10 bars (PUT retracement depth)
- `rsi_trough_10` — Min RSI in prior 10 bars (CALL retracement depth)

**All columns**:
```
timestamp_utc, asset, open, high, low, close,
rsi_5, stoch_k_v2, stoch_d_v2,
bb_upper, bb_middle, bb_lower, bb_width_bps,
ma6, ma14, ma_trend_bps,
stc, stc_prev,
rsi_peak_10, rsi_trough_10,
signal, direction,
exit_1m, pnl_1m, win_1m,
exit_2m, pnl_2m, win_2m,
exit_3m, pnl_3m, win_3m,
exit_5m, pnl_5m, win_5m,
exit_10m, pnl_10m, win_10m
```

---

## 🔧 Usage

### Generate CSV from database
```bash
node scripts/paper_reversal_csv.cjs [dbPath] [outCsv]

# Examples:
node scripts/paper_reversal_csv.cjs
node scripts/paper_reversal_csv.cjs data/trading_data.db data/signals_2026-04-28.csv
```

### Analyze in Excel/Python
```python
import pandas as pd
df = pd.read_csv('data/paper_reversal_today.csv')

# Overall stats
print(f"Total signals: {len(df)}")
print(f"2m WR: {df['win_2m'].mean():.1%}")
print(f"2m P/L: ${df['pnl_2m'].sum():,.0f}")

# By direction
print(df.groupby('direction').agg({
    'win_2m': 'mean',
    'pnl_2m': 'sum'
}))

# By asset
print(df.groupby('asset').agg({
    'signal': 'count',
    'win_2m': 'mean',
    'pnl_2m': 'sum'
}))
```

---

## 🚀 Next Steps

1. **Run on full historical data** — Test across months of data for statistical significance
2. **Sync to `src/core/analysis.js`** — Apply same 7-gate logic to MCP analytical tools
3. **Update `bot/indicators.js`** — If external signal generator supports it, sync thresholds
4. **Backtest vs baseline** — Compare 7-gate vs old 5-gate STC strategy using `po_simulate`
5. **Live paper trade** — Run for 100+ signals before going live

---

## ⚠️ Important Notes

- **Old 7 patterns discarded** — RSI, Stoch, BB, RSI+Stoch, RSI+BB, Stoch+BB, RSI+Stoch+BB removed
- **Only 2 signals now** — STC_CALL_7G and STC_PUT_7G
- **Fewer signals, higher quality** — Expect 70-80% reduction in signal count, 20-30% WR improvement
- **Requires Schaff value** — Candles without `schaff_value` are skipped (need 33+ candles warmup)
- **2-minute expiry looks strongest** — 71.7% WR on initial test (needs validation on larger dataset)

---

**Generated by**: Claude (Anthropic) + GitHub Copilot CLI  
**Script version**: 2026-04-28 (7-gate STC reversal)
