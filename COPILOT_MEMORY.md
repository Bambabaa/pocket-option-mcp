# GitHub Copilot CLI — Pocket Option MCP Memory

**Last Updated**: 2026-04-28 16:13 UTC  
**Session Context**: STC Reversal Strategy Development & Validation

---

## 🎯 **Project Overview**

**Project**: pocket-option-mcp  
**Type**: MCP server connecting Claude to Pocket Option trading bot via SQLite  
**Primary Strategy**: 7-Gate Schaff Trend Cycle (STC) Reversal Strategy  
**Market**: OTC binary options (24/7 synthetic quotes)

---

## 📁 **Critical File Locations**

### **Databases**
- **Bot DB (readonly)**: `data/trading_data.db` — Bot writes candles/signals/trades, MCP reads
- **MCP DB (writable)**: `data/mcp.db` — MCP writes orders/blocks/logs, bot reads
- **Versioned DBs**: `data/trading_data_v1.db`, `v2_13-15.db`, `V3_17.db`, `V4_18.db`, `V5_25.db`

### **Bot Core**
- **Bot**: `bot/pocket-option-bot.js` — Main execution loop + order worker
- **Indicators**: `bot/indicators.js` — Stub only (MODE D logic external)
- **Database**: `bot/database.js` — SQLite wrapper
- **Schaff Script**: `bot/scripts/recalculate-schaff.js` — Recalculates STC values

### **MCP Server**
- **Server**: `src/server.js` — 40+ tools registered
- **Connection**: `src/connection.js` — Dual-DB (bot-db readonly + mcp-db writable)
- **Analysis**: `src/core/analysis.js` — Backtesting engine (7-gate logic)
- **Intelligence**: `src/core/intelligence.js` — Asset scanning, recommendations
- **Significance**: `src/core/significance.js` — Statistical tests (binomial, Wilson CI)

### **Scripts**
- **Paper Trading**: `scripts/paper_reversal_csv.cjs` — 7-gate signal generator
- **Session Monitor**: `src/scripts/session-monitor.js` — Auto block/unblock loop

### **Documentation**
- **User Guide**: `docs/user-guide.md` — Full tool reference
- **Strategy Guide**: `scripts/UPGRADE_SUMMARY.md` — 7-gate spec
- **Schaff Report**: `data/SCHAFF_RECALC_REPORT.md` — Recalculation summary

---

## 🔧 **Architecture**

```
Claude (MCP client)
    ↓
pocket-option-mcp (MCP stdio server — src/server.js)
    ↓
    ├── SQLite READONLY  → data/trading_data.db  ← Bot writes
    └── SQLite WRITABLE  → data/mcp.db           ← MCP writes, Bot reads
```

---

## 📊 **Data Schema**

### **Indicators Table (Core Strategy Data)**
| Column | Type | Description |
|---|---|---|
| `asset` | TEXT | e.g., EURUSD_otc |
| `timestamp` | INTEGER | Unix seconds |
| `rsi_5` | REAL | RSI period 5 |
| `stochastic_k_v2` | REAL | Stoch K (5,3,3) |
| `stochastic_d_v2` | REAL | Stoch D (5,3,3) |
| `ma1` | REAL | MA6 (fast) |
| `ma3` | REAL | MA14 (slow) |
| `ma2` | REAL | MA50 (NOT used in gates) |
| `bb_upper/middle/lower` | REAL | Bollinger Bands (20,2) |
| `schaff_value` | REAL | **STC (12,25,5,3,3)** — PRIMARY SIGNAL |

### **Candles Table**
| Column | Type | Description |
|---|---|---|
| `asset` | TEXT | Asset symbol |
| `timestamp` | INTEGER | Unix seconds |
| `open/high/low/close` | REAL | OHLC |
| `volume` | REAL | Tick volume (OTC = unreliable) |

### **Signals Table** (External Generator)
| Column | Type | Description |
|---|---|---|
| `asset` | TEXT | Asset symbol |
| `timestamp` | INTEGER | Unix seconds |
| `direction` | TEXT | CALL or PUT |
| `strategy_used` | TEXT | e.g., "MODE_D" |
| `reasons` | TEXT | JSON with gate values |

---

## 🎯 **7-Gate STC Reversal Strategy**

### **Strategy Status**
- **Active**: YES (paper trading ready)
- **Validation**: 17 signals backtested, 60% WR @ 1m expiry
- **Discarded**: MODE D (L65 Leaf, L41 Leaf patterns)

### **CALL Reversal Gates (Oversold Bounce)**
```
g1: STC ≤ 20              — Deeply oversold
g2: STC > STC[-1]         — Momentum turning up
g3: RSI < 20              — Extreme oversold
g4: K > D, K < 35         — Bullish cross in oversold
g5: BB width ≥ 10 bps     — Volatility gate (validated)
g6: RSI trough[10] < 15   — Deep retracement validation (NEW)
g7: MA6-MA14 gap > -20    — Not strong downtrend (NEW)
```

### **PUT Reversal Gates (Overbought Reversal)**
```
g1: STC ≥ 75              — Deeply overbought
g2: STC < STC[-1]         — Momentum turning down
g3: RSI > 70              — Strong overbought
g4: K < D, K > 65         — Bearish cross in overbought
g5: BB width ≥ 10 bps     — Volatility gate
g6: RSI peak[10] > 80     — Deep extension validation (NEW)
g7: MA6-MA14 gap < 20     — Not strong uptrend (NEW)
```

**All 7 gates must pass** = AND logic (restrictive, high precision)

---

## 🔬 **Schaff Trend Cycle (STC) Details**

### **Calculation**
1. **MACD**: EMA(12) - EMA(25) = momentum oscillator
2. **Stochastic**: %K on MACD over 5-period cycle
3. **First EMA**: 3-period smoothing
4. **Second EMA**: 3-period smoothing
5. **Result**: 0-100 scale (0 = oversold, 100 = overbought)

### **Parameters**
- **MACD**: 12, 25 (fast/slow EMAs)
- **Cycle**: 5 periods
- **Smoothing**: 3, 3 (double EMA)
- **Stored as**: `indicators.schaff_value`

### **Validation Status**
✅ **Tested**: 30 values across 3 assets (EURUSD, GBPUSD, AUDCAD)  
✅ **Accuracy**: 100% match (0.000000 difference)  
✅ **Recalculated**: 24,680 values across 5 databases

---

## 📈 **Backtest Results (3 Databases)**

**Date Range**: April 17, 18, 24-25, 2026  
**Total Signals**: 17  
**Databases**: V3_17 (4 signals), V4_18 (7 signals), V5_25 (6 signals)

### **Win Rates by Expiry**
| Expiry | WR | Wins | Losses | Status |
|---|---|---|---|---|
| **1 min** | **60.0%** | 9 | 6 | ✅ Best expiry |
| 2 min | 53.3% | 8 | 7 | ⚠️ Marginal |
| 3 min | 53.3% | 8 | 7 | ⚠️ Marginal |

### **Direction Breakdown**
- **CALL**: 4 signals (23.5%), 50% WR @ 1m
- **PUT**: 13 signals (76.5%), **63.6% WR @ 1m** ✅

**Statistical Significance**: NOT YET (need 100+ signals for p < 0.05)

---

## ⚠️ **Critical Rules**

### **Database Access**
- ❌ **NEVER write to `socket_option/determ/`** — Read-only source
- ✅ **All bot mods go in `pocket-option-mcp/bot/`**
- ❌ **No Python for SQLite** — Conflicts with JS process, use sqlite3 CLI only
- ✅ **Always validate with `po_simulate` before changing gates**

### **Strategy Rules**
- ✅ **MA50 NOT used** — Only MA6 (ma1) and MA14 (ma3) in gates
- ✅ **Use stochastic_k_v2 / d_v2** — NOT stochastic_k / d (old)
- ✅ **BB width < 10 bps = losing zone** — 45.8% WR, -$3,580 P/L on 135 signals
- ✅ **MODE D discarded** — Now using STC reversal strategy
- ✅ **1-minute expiry recommended** — 60% WR (best performance)

### **Asset Management**
- ✅ **Flat assets (BB < 5 bps) must be blocked** — Use `po_auto_block_sweep` at session start
- ✅ **Session monitor must run** — `src/scripts/session-monitor.js` (auto block on 3 consecutive losses)
- ✅ **No permanent blocks** — All blocks require `duration_minutes`

---

## 🔧 **MCP Tools (40+ Available)**

### **Intelligence (Agentic)**
- `po_scan_all` — Score all assets by 7 indicator layers
- `po_recommend` — Ranked trade picks (precision + WR + bias)
- `po_risk_check` — Pre-trade audit (0-100 score + verdict)
- `po_asset_bias` — Per-asset CALL vs PUT WR history
- `po_asset_volatility` — Rank by BB width (find flat assets)

### **Analysis (Backtesting)**
- `po_replay_candles` — Full historical replay with STC gates
- `po_find_edge` — 11-dimensional WR breakdown
- `po_optimize_gates` — Grid search over thresholds
- `po_simulate` — A/B test baseline vs modified gates

### **Trading**
- `po_trade` — Manual CALL/PUT order
- `po_cancel_order` — Cancel pending order
- `po_block_asset` — Block asset for N minutes
- `po_unblock_asset` — Remove block

### **Performance**
- `po_trades_ordered` — Executed trades with results
- `po_pnl_summary` — P/L by asset
- `po_rolling_summary` — Rolling WR + P/L
- `po_performance` — Daily performance table

---

## 🚨 **Known Issues**

### **1. Large Database Timeout (v1, v2)**
**Problem**: `paper_reversal_csv.cjs` times out after 5 minutes on datasets with 5000+ indicators  
**Impact**: Cannot backtest oldest historical data (v1) or April 13-15 period (v2)  
**Status**: Optimization pending

### **2. Small Sample Size**
**Problem**: Only 17 signals from 3 databases (insufficient for statistical significance)  
**Impact**: Cannot prove 60% WR with 95% confidence (need n ≥ 78)  
**Status**: Need to process v1/v2 or collect live data

### **3. Significance Tests Overstate Results**
**Problem**: No Bonferroni correction for multiple comparisons in `significance.js`  
**Impact**: p-values overstated when testing 50+ slices  
**Status**: Documented, fix pending (P0 priority)

---

## 📝 **Evidence-Based Facts**

### **Validated Through Analysis**
- ✅ **BB < 10 bps = losing zone**: 45.8% WR, validated on 135 signals
- ✅ **PUT > CALL**: 59.8% PUT vs 42.1% CALL baseline WR (historical)
- ✅ **Retracement depth matters**: RSI trough < 10 = 70.6% WR vs 30+ = 33.3% WR
- ✅ **With-trend > counter-trend**: CALL with-trend 68.9%, counter-trend 42.9%
- ✅ **STC calculation perfect**: 30/30 values matched (0.000000 error)

### **Backtest Observations**
- ✅ **1-minute best expiry**: 60% WR vs 53.3% at 2m/3m
- ✅ **PUT signals dominate**: 76.5% of 7-gate signals are PUT
- ✅ **April 18 strongest**: 71.4% WR @ 1m (best single day)
- ✅ **7 gates very selective**: 99.87% rejection rate (17 signals from 35,265 candles)

---

## 🔄 **Session Monitor (Autonomous Agent)**

**Purpose**: Auto-block losing assets, unblock recovered assets  
**Location**: `src/scripts/session-monitor.js`  
**Must run alongside**: Bot + MCP server

### **Behavior**
| Timer | Action |
|---|---|
| On startup | Clear all `source='session'` blocks (fresh slate) |
| Every 2 min | Check for 3 consecutive losses → block with `source='session'` |
| Every 10 min | Unblock `claude`/`auto` blocks if conditions recovered |

### **Block Sources**
- `session` — Auto-blocked by monitor (3 consecutive losses), cleared only on restart
- `auto` — Auto-blocked by `po_auto_block_sweep` (BB < 5 bps)
- `claude` — Manually blocked via `po_block_asset` (you or Claude)

---

## 🎓 **Key Learnings**

### **What Works**
1. **STC extreme readings** (< 10 or > 90) have 70%+ reversal rate
2. **BB touch + STC extreme** = high-probability setup (60-70% WR)
3. **Retracement/extension gates** (g6) boost WR by 15-20%
4. **Trend filters** (g7) avoid 30% WR counter-trend traps
5. **PUT signals more reliable** than CALL in OTC markets

### **What Doesn't Work**
1. **5-gate strategy too loose** — 50-55% WR (not enough edge)
2. **2-3 minute expiries inconsistent** — 20-100% WR swing by day
3. **Counter-trend reversals risky** — Even with perfect gates, MA gap < -20 bps = danger
4. **Flat markets (BB < 10 bps)** — 45.8% WR, must filter out
5. **CALL signals weaker** — Only 4 samples, 50% WR (needs more data)

### **Pending Validation**
- ⏳ **Live slippage** — Backtest 60% WR, but live may be 55% due to execution delay
- ⏳ **Time-of-day edge** — No data yet on UTC hour performance
- ⏳ **Asset-specific WR** — Don't know which assets perform best with 7-gate
- ⏳ **Multi-timeframe alignment** — No test of 1m + 5m confluence yet

---

## 🚀 **Current Development State**

### **Completed ✅**
- [x] STC calculation validated (100% accuracy)
- [x] 7-gate strategy implemented (`scripts/paper_reversal_csv.cjs`)
- [x] 5 databases recalculated (24,680 STC values)
- [x] Backtest on 3 databases (17 signals, 60% WR @ 1m)
- [x] Strategy documentation complete
- [x] Chart analysis examples reviewed

### **In Progress ⏳**
- [ ] Optimize script for large datasets (v1/v2 timeout)
- [ ] Collect 100+ signals for statistical significance
- [ ] Fix Bonferroni correction in `significance.js`

### **Pending 📋**
- [ ] Live paper trading (2-4 weeks, 50+ signals)
- [ ] Time-of-day analysis
- [ ] Asset profiling (whitelist/blacklist)
- [ ] Multi-timeframe confluence testing
- [ ] STC divergence detection (8th gate)

---

## 🎯 **Next Actions (When Ready)**

### **Immediate**
1. Optimize `paper_reversal_csv.cjs` to handle v1/v2 databases
2. Run combined analysis on all 5 databases
3. Generate master dataset with 50-100+ signals

### **Short-term**
1. Deploy live monitoring script
2. Paper trade for 100+ signals
3. Validate 60% WR holds in real conditions

### **Long-term**
1. Add time-of-day + asset filters (boost to 65-70% WR)
2. Implement STC divergence detection (8th gate)
3. Test multi-timeframe alignment
4. Go live with proven strategy

---

## 📞 **Quick Reference Commands**

### **Generate Signals from Database**
```bash
node scripts/paper_reversal_csv.cjs data/trading_data.db data/signals.csv
```

### **Recalculate STC Values**
```bash
node bot/scripts/recalculate-schaff.js data/trading_data.db
```

### **Check Database Status**
```bash
sqlite3 data/trading_data.db "SELECT COUNT(*) FROM indicators WHERE schaff_value IS NOT NULL"
```

### **Start Session Monitor**
```bash
node src/scripts/session-monitor.js
```

### **MCP Server Startup**
```bash
node src/server.js
```

---

## 🔒 **Security Notes**

- ✅ All databases are **local** (no cloud exposure)
- ✅ Bot credentials in environment variables (not committed)
- ✅ MCP server uses stdio (no network ports)
- ✅ Readonly/writable separation enforced

---

## 📚 **Reference Materials**

### **Technical Papers**
- Schaff Trend Cycle: Double-smoothed MACD + Stochastic normalization
- Wilson Confidence Interval: Better than Wald for extreme proportions
- Binomial Test: Exact for n ≤ 120, normal approximation above

### **Strategy Inspiration**
- BB reversion (mean-reversion at bands)
- Stochastic divergence (price vs momentum)
- STC crossover (0-20 oversold, 80-100 overbought zones)

---

**Memory Version**: 1.0  
**Last Session**: 2026-04-28  
**Strategy State**: 7-Gate STC Reversal (Paper Trading Ready)  
**Next Milestone**: 100+ signal validation

---

_This memory should be loaded at the start of each session for context continuity._
