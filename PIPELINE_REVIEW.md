# Pocket Option Bot - Complete Pipeline Review

## Architecture Overview

```
WebSocket (Pocket Option)
        ↓
    Puppeteer CDP
        ↓
processWebSocketMessage()
        ↓
    ├─ History Data → candles[] + indicators
    └─ Real-time Prices → candle OHLC aggregation
        ↓
Signal Generation Pipeline
        ↓
Execution Pipeline
        ↓
Validation Loop (every 5m)
        ↓
Database (trading_data.db + mcp.db)
```

---

## Component Dependency Graph

```
pocket-option-bot.js (main)
├── ./indicators.js
│   └── Calculates: MA, RSI, Bollinger Bands, Stochastic, STC, CCI, MACD, ATR
├── ./database.js (TradingDatabase)
│   ├── INSERT candles (asset, timestamp, OHLC)
│   ├── INSERT indicators
│   ├── INSERT signals
│   ├── INSERT orders_queue (for execution)
│   └── INSERT signal_outcomes (from validation)
├── ./ml-gate.js (ML Reversal Gate)
│   ├── evaluateGate(ind, payout) → tree/logreg scores
│   └── Per-asset state (cci_history, stc_history)
├── ./scripts/order-executor.js
│   ├── executeOneOrder(db, order, config)
│   ├── syncLiveTradeResultsFromDOM(page, db)
│   └── resetSessionCalibration()
├── ./scripts/validate_ml_signals.js
│   └── validatePendingSignals(db, lookAheadSeconds, tradeAmount, options)
├── ./config.js
│   └── CONFIG.execution, CONFIG.candle, CONFIG.logging
└── puppeteer (browser automation)
    └── WebSocket interception via CDP
```

---

## Data Flow: Signal Generation (History Backfill)

```
WebSocket: { history: [[ts, price], ...], asset: "EURUSD", candles: [[ts, o, c, h, l], ...] }
        ↓
processWebSocketMessage()
        ↓
STATE.CANDLES[asset] = candles (in-memory)
        ↓
database.insertCandle(asset, timestamp, open, high, low, close)
        ↓
candles.length >= minCandles (≈20)?
        ├─ YES: Indicators.calculateAll(asset, candles)
        │   ├── Store in STATE.INDICATORS[asset]
        │   ├── database.insertIndicators(asset, timestamp, indicatorData)
        │   ├── Backfill: recalculate for all prior bars
        │   └── Restore STC history (avoid stale-feed leakage)
        │
        └─ NO: Log warning, wait for more candles
        ↓
evaluateMLGate(indicatorData, asset, STATE.CANDLES[asset], 0.80)
        ├── mlGate.evaluateGate(ind, payout=0.80)
        │   ├── Compute 4 kinetic features (BB_Dev, CCI_Vel, Stoch_Div, STC_Mom)
        │   ├── Decision tree inference → tree.score, tree.approved
        │   └── Logistic regression inference → logreg.score, logreg.approved
        │
        ├── If neither approved → return null (no signal)
        │
        └── If approved:
            ├── computeDirectionFromRecentMove(asset, candles)
            │   └── Fade recent 3-bar move: move > 0 → PUT, move < 0 → CALL
            ├── Return signal { direction, strategyUsed: 'ML_REVERSAL_GATE_*', tier: 1, reasons }
            └── database.insertSignal(asset, timestamp, signal)
```

---

## Data Flow: Signal Generation (Real-time)

```
WebSocket: [[asset, timestamp, price], ...]
        ↓
Real-time price tick received (every second)
        ↓
priceBatchBuffer.push({ asset, timestamp, price })
        ↓
Every 10s OR 200 prices: database.insertPriceBatch()
        ↓
Build in-memory OHLC candle:
    STATE.CURRENT_CANDLE[asset] = { open, high, low, close }
    STATE.CURRENT_CANDLE_TICKS[asset]++
        ↓
Candle period completes (5m rollover)?
    ├─ YES: Finalize & persist
    │   ├── database.insertCandle(asset, timestamp, O, H, L, C)
    │   ├── Recalculate indicators on finalized candle
    │   └── Update STATE.CANDLES[asset] with live-aggregated OHLC
    │
    └─ NO: Continue updating OHLC
        ↓
After finalize: 
    ├── Stale-feed guard: Check if candle timestamp matches previous signal
    ├── evaluateMLGate(indicatorData, asset, STATE.CANDLES[asset], 0.80)
    └── If signal: → Execution Pipeline (below)
```

---

## Execution Pipeline

```
Signal created & stored
        ↓
database.insertSignal(asset, timestamp, signal)
        ↓
database.enqueueOrder(sigId, asset, direction, timestamp)
        ├── Creates orders_queue row
        └── Returns enqResultId
        ↓
isAssetBlocked(asset)?
        ├─ YES: Update order status = SKIPPED, return
        └─ NO: Continue
        ↓
hasAssetInFlightLiveOrder(asset)?
        ├─ YES: Skip (one per asset), return
        └─ NO: Continue
        ↓
hasOrderedTradeForOrder(enqResultId)?
        ├─ YES: Already executed, skip
        └─ NO: Continue
        ↓
STATE.SETTINGS.executeInlineWithBot && isLiveExecution?
        ├─ YES: executionQueue.push(order)
        └─ NO: Queued, skip inline execution
        ↓
runExecutionWorker(page)
        ├── Dequeue orders from executionQueue
        ├── executeOneOrder(database, order, config)
        │   ├── Fetch current payout from page
        │   ├── Click asset, set direction (CALL/PUT)
        │   ├── Enter trade amount
        │   ├── Click SEND ORDER
        │   ├── Wait for confirmation
        │   ├── Update order status = EXECUTED
        │   └── insertOrderedTrade(asset, direction, amount, entry_price, payout)
        └── Log execution result
```

---

## MCP Orders Worker (Parallel)

```
Every 5 seconds: runMcpOrdersWorker(page)
        ↓
SELECT * FROM mcp_orders WHERE status = 'PENDING'
        ↓
For each pending manual order:
    ├── Atomic claim: UPDATE status = SKIPPED, reason = 'claimed-for-execution'
    ├── isAssetBlocked(asset)?
    │   └─ If blocked: UPDATE status = SKIPPED, reason = 'asset-blocked'
    ├── Otherwise: executeOneOrder(shimDb, order, config)
    │   └── Same execution path as bot-generated signals
    └── UPDATE status = EXECUTED (or FAILED on error)
```

---

## Validation Loop (Every 5 minutes)

```
runValidation()
        ↓
validatePendingSignals(database, lookAheadSeconds=60, tradeAmount, options)
        ↓
SELECT signals WHERE strategyUsed LIKE 'ML_REVERSAL_GATE%'
  AND timestamp <= NOW - 60 (past 5m expiry)
  AND signal_id NOT IN signal_outcomes (not yet validated)
        ↓
For each pending signal:
    ├── Load all candles (per-asset series, leak-proof)
    ├── validateDirection(signal) against fade logic
    │   └─ Must match: recent_move sign → direction
    │
    ├── If direction mismatch → SKIP (logged)
    │
    └─ If direction valid:
        ├── getOutcome15m(signal) → lookup 3 bars ahead
        ├── Compare: futurePrice vs entryPrice
        │   ├─ CALL: WIN if moved UP, LOSS if DOWN
        │   └─ PUT: WIN if moved DOWN, LOSS if UP
        ├── Calculate P/L: ±(tradeAmount × payoutRate)
        └── database.insertSignalOutcome(asset, ts, id, direction, 
                                          entry, exitTs, exitPrice, result, pl)
        ↓
Log: "📊 ML-Validation: X validated @ 15m, Y skipped (pending=Z)"
```

---

## Database Schema (Key Tables)

### candles
```
asset, timestamp (PK), open, high, low, close, volume
```

### indicators
```
asset, timestamp (PK), ma1, ma6, ma14, rsi_14, 
bb_upper, bb_lower, stoch_k, stoch_d, stc_value, cci_20, ...
```

### signals
```
id (PK), asset, timestamp, direction (CALL/PUT), 
strategyUsed (e.g., 'ML_REVERSAL_GATE_TREE'),
tier, reasons (JSON)
```

### orders_queue
```
id (PK), signal_id, asset, direction, timestamp, 
status (PENDING/EXECUTED/SKIPPED/FAILED),
status_reason
```

### orders_trades
```
id (PK), order_id, asset, direction, timestamp,
entry_price, payout_rate, amount, win_loss (WIN/LOSS/DRAW)
```

### signal_outcomes
```
signal_id (PK), asset, direction, entry_price,
exit_timestamp, exit_price, result (WIN/LOSS),
profit_loss
```

### mcp_orders (in mcp.db)
```
id (PK), asset, direction, amount, signal_ts,
status (PENDING/EXECUTED/SKIPPED/FAILED),
created_at, updated_at
```

---

## Error Handling & Guards

### 1. Stale Feed Guard (line 871)
```javascript
const _isStale = _prevCandle && _prevCandle[0] === signalTimestamp;
if (_isStale) → BLOCK signal (feed frozen)
```
**Protects:** Against repeated signals on same candle when WebSocket dies

### 2. Asset Block Guard (line 890)
```javascript
const blockEntry = await isAssetBlocked(asset);
if (blockEntry) → SKIP order (asset blocked by MCP/user)
```
**Protects:** Against trading blocked assets during volatility spikes

### 3. In-Flight Order Guard (line 882)
```javascript
const inFlight = await database.hasAssetInFlightLiveOrder(asset);
if (inFlight) → SKIP (one trade per asset at a time)
```
**Protects:** Against overlapping orders on same asset

### 4. Duplicate Order Guard (line 888)
```javascript
const shouldExecute = !(await database.hasOrderedTradeForOrder(enqResultId));
if (!shouldExecute) → SKIP (already executed)
```
**Protects:** Against re-executing same order on reconnect

### 5. Direction Validation (validate_ml_signals.js)
```javascript
const fadeDir = validateDirection(sig, byAsset, posByKey);
if (fadeDir !== sig.direction) → SKIP outcome (direction doesn't match fade logic)
```
**Protects:** Against direction errors in outcome calculation

---

## Signal Generation Entry Points

| Path | Trigger | Location | Frequency |
|------|---------|----------|-----------|
| **History Backfill** | WebSocket history data | line 698 | Once per asset (on connect) |
| **Real-time Finalize** | Candle period rollover | line 858 | Every 5 minutes per asset |
| **Status Display** | 30s display refresh | line 1082 | Every 30 seconds |

---

## Indicator Calculation (Indicators.js)

### Minimum Candles Required
```javascript
getMinCandles() → 20 (for SMA6, SMA14, RSI14, etc.)
```

### Feature Calculation Order
1. **First pass:** Calculate on latest candle
2. **Backfill:** Recalculate for all prior bars (20+ only)
3. **STC history clear:** Reset `_lastSchaffValues[asset]` before backfill
4. **STC restore:** Set to current bar's value after backfill (avoid delta leakage)

---

## ML Gate Integration (ml-gate.js)

### Inputs
- `indicatorData`: { close, bb_upper, bb_lower, cci_20, stc_value, stoch_k, stoch_d }
- `payout`: Live broker payout (0.80 = 80%)

### Outputs
- `tree.approved`: true if score ≥ 0.85 AND payout ≥ 0.70
- `logreg.approved`: true if score ≥ 0.85 AND payout ≥ 0.78
- `features`: { BB_Deviation, CCI_Velocity, Stoch_Divergence, STC_Momentum }

### Per-Asset State
- `cci_history[]`: Last 3 CCI values (for velocity calc)
- `stc_history[]`: Last 2 STC values (for momentum calc)
- Auto-initialized on first evaluateGate() call per asset

---

## Config Defaults (config.js)

```javascript
CONFIG.execution = {
    enabled: true,
    tradeAmount: 1,
    minPayout: 0.70,
    maxDailyTrades: 20,
    expirationSec: 900 (15m)
}

CONFIG.candle = {
    period: 300 (5m),
    lookAheadSeconds: 60
}

STATE.SETTINGS = {
    executeInlineWithBot: true,
    enableValidationLoop: true,
    validationLoopIntervalMs: 300000 (5m)
}
```

---

## Summary: Signal Life Cycle

```
1. GENERATION (Real-time or backfill)
   └─ Indicators → ML Gate → Direction → Signal stored

2. QUEUEING
   └─ Order created in orders_queue

3. EXECUTION
   └─ Order executor clicks on broker UI → Trade executed

4. VALIDATION (Every 5 minutes)
   └─ Lookup 15m outcome → WIN/LOSS → Signal_outcomes written

5. ANALYSIS (MCP tools)
   └─ po_trades_ordered, po_performance, po_rolling_summary
```

---

## Known Limitations & TODOs

- ⚠️ **Direction**: Pure fade logic (no ML direction scoring)
- ⚠️ **Validation**: 15m only (not 5m/10m granular)
- ⚠️ **Payout**: Hardcoded 0.80 (not dynamic from broker)
- ⚠️ **Config**: Not hot-reloadable during bot execution
- ✓ **Stale feed**: Protected by candle timestamp guard
- ✓ **Asset blocks**: Enforced before execution
- ✓ **Leak-proof**: Per-asset series in validation loop
