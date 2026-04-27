# MCP Pipeline Architecture Review

**Date:** 2026-04-27  
**Reviewer:** Codebase Investigator  
**Status:** ✅ Production-ready dual-database architecture with clean separation

---

## Executive Summary

The pocket-option-mcp server implements a **bidirectional data pipeline** connecting Claude AI to a live Pocket Option trading bot through SQLite. The architecture enforces strict database isolation: **bot DB is readonly to MCP**, **MCP DB is writable only by MCP** and read by the bot's execution worker.

### Key Strengths
- ✅ **Zero write access** to bot DB from MCP → eliminates corruption risk
- ✅ **Atomic order claiming** with transitional status prevents double-execution
- ✅ **Asset blocking** respected by both bot-generated and manual orders
- ✅ **43 tools** organized into 9 logical groups with clear responsibilities
- ✅ **Execution mutex** serializes live trades, preventing race conditions
- ✅ **Session calibration** (amount/expiration set once) speeds up multi-asset trading

### Architecture Pattern
```
Claude (MCP client)
    │
    ├─ stdio transport ─→ pocket-option-mcp/src/server.js
    │                           │
    │                     ┌─────┴──────┐
    │                     │            │
    │              bot-db.js       mcp-db.js
    │              READONLY        WRITABLE
    │          (trading_data.db)   (mcp.db)
    │                     │            │
    │                     └──────┬─────┘
    │                            │
    └──────────────────→ pocket-option-bot.js
                            (Puppeteer + CDP)
                                  │
                          pocketoption.com
```

---

## 1. Data Flow Architecture

### 1.1 Read Pipeline (Bot → MCP → Claude)

**Entry Point:** `src/bot-db.js`

```javascript
// Readonly connection enforced at SQLite level
_db = new sqlite3.Database(BOT_DB_PATH, sqlite3.OPEN_READONLY)
```

**Flow:**
1. Bot writes candles/signals/trades to `data/trading_data.db`
2. MCP tools call `all(sql)` or `get(sql)` from `bot-db.js`
3. Core modules (`data.js`, `assets.js`, `performance.js`) aggregate data
4. Tool wrappers format results as JSON for Claude

**Data Sources (Bot DB):**
| Table | Tool Access | Purpose |
|---|---|---|
| `candles` | `po_candles` | OHLC bars for backtesting/replay |
| `prices` | `po_prices`, `po_price_history` | Live tick data |
| `indicators` | `po_indicators` | MA1/2/3, RSI, BB, Stochastic v2 |
| `signals` | `po_signals` | MODE D strategy CALL/PUT signals |
| `orders_queue` | `po_bot_orders` | Bot-generated execution queue |
| `trades_ordered` | `po_trades_ordered`, `po_pnl_summary` | WIN/LOSS results |
| `qualified_assets` | `po_qualified_assets` | Bot trading allow-list |

---

### 1.2 Write Pipeline (Claude → MCP → Bot)

**Entry Point:** `src/mcp-db.js`

```javascript
// Writable connection with WAL mode for concurrent access
await run(_db, 'PRAGMA journal_mode = WAL');
await run(_db, 'PRAGMA busy_timeout = 10000');
```

**Flow:**
1. Claude calls `po_trade asset=EURUSD_otc direction=CALL`
2. Tool writes `PENDING` row to `mcp_orders` table
3. Bot's `runMcpOrdersWorker()` polls every cycle (lines 66-164 in bot)
4. Worker atomically claims order with transitional status
5. Executes via `executeOneOrder()` → clicks DOM
6. Updates status to `EXECUTED`/`SKIPPED`/`FAILED`

**Critical Tables (MCP DB):**
| Table | Writer | Reader | Purpose |
|---|---|---|---|
| `mcp_orders` | MCP tools | Bot worker | Manual trade queue |
| `asset_controls` | Agent tools | Bot guard | Block/unblock assets |
| `agent_session_log` | Agent tools | Audit trail | Decision history |

---

## 2. Tool Organization

### 2.1 Tool Registration (server.js)

```javascript
const server = new McpServer({ name: 'pocket-option-mcp', version: '1.0.0' });

registerHealthTools(server);      // 2 tools
registerDataTools(server);         // 6 tools
registerAssetTools(server);        // 9 tools
registerOrderTools(server);        // 5 tools
registerValidationTools(server);   // 2 tools
registerPerformanceTools(server);  // 4 tools
registerIntelligenceTools(server); // 5 tools
registerAnalysisTools(server);     // 5 tools
registerAgentTools(server);        // 5 tools
```

**Total:** 43 tools across 9 categories

### 2.2 Tool → Core Module Mapping

| Tool File | Core Module | Database | Responsibility |
|---|---|---|---|
| `tools/health.js` | `core/health.js` | Both | Liveness checks, stale data detection |
| `tools/data.js` | `core/data.js` | Bot (R) | Candles, prices, indicators, signals |
| `tools/assets.js` | `core/assets.js` | Bot (R) | Qualification, streaks, outcomes |
| `tools/orders.js` | `core/orders.js` | Both | Bot orders (R), MCP orders (RW), P/L |
| `tools/validation.js` | `core/validation.js` | Bot (R) | Pending signals, validation stats |
| `tools/performance.js` | `core/performance.js` | Bot (R) | Daily records, rolling summary |
| `tools/intelligence.js` | `core/intelligence.js` | Bot (R) | Multi-asset scoring, risk checks |
| `tools/analysis.js` | `core/analysis.js` | Bot (R) | Replay, find_edge, optimize_gates |
| `tools/agent-tools.js` | `core/agent-tools.js` | Both | Signal context, drawdown, session log |

---

## 3. Critical Execution Paths

### 3.1 Manual Order Execution (MCP → Bot)

**File:** `bot/pocket-option-bot.js` (lines 66-164)

```javascript
async function runMcpOrdersWorker(page) {
    // 1. Fetch PENDING orders
    const pending = await mcpDbAll(
        `SELECT * FROM mcp_orders WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 5`
    );

    for (const row of pending) {
        // 2. Atomic claim (prevents double-pickup)
        const claim = await mcpDbRun(
            `UPDATE mcp_orders SET status = 'SKIPPED', status_reason = 'claimed-for-execution' 
             WHERE id = ? AND status = 'PENDING'`,
            [row.id]
        );
        if (!claim.changes) continue;

        // 3. Asset block check
        const blockEntry = await isAssetBlocked(row.asset);
        if (blockEntry) {
            await mcpDbRun(
                `UPDATE mcp_orders SET status = 'SKIPPED', status_reason = ? WHERE id = ?`,
                [`asset-blocked: ${blockEntry.reason}`, row.id]
            );
            continue;
        }

        // 4. Execute via shim DB (delegates price lookups to bot DB)
        const shimDb = {
            get: async (sql, params) => { /* redirect orders_queue check to mcp_orders */ },
            updateOrderStatus: async (id, status, reason) => { /* write to mcp_orders */ },
            // ... other delegates to real bot DB
        };

        const result = await executeOneOrder(shimDb, order, config);
    }
}
```

**Safety Mechanisms:**
- ✅ **Transitional status** (`claimed-for-execution`) prevents double-pickup across poll cycles
- ✅ **Asset block guard** respects `asset_controls` table (shared by bot and agents)
- ✅ **Shim DB** intercepts status checks so `executeOneOrder()` sees correct state
- ✅ **Manual orders bypass qualification** (`skipQualifiedGate: true`)

---

### 3.2 Asset Blocking (Agent → Bot)

**Write Flow:**
```javascript
// tools/agent-tools.js → po_block_asset
await mcpRun(
    `INSERT INTO asset_controls (asset, action, reason, source, expires_at, active)
     VALUES (?, 'BLOCK', ?, ?, ?, 1)`,
    [asset, reason, source, expires_at]
);
```

**Read Guard (Bot):**
```javascript
// bot/pocket-option-bot.js (line 53-64)
async function isAssetBlocked(asset) {
    const now = Math.floor(Date.now() / 1000);
    const rows = await mcpDbAll(
        `SELECT reason FROM asset_controls
         WHERE active = 1
           AND (asset = ? OR asset = 'ALL')
           AND (expires_at IS NULL OR expires_at > ?)`,
        [asset, now]
    );
    return rows[0] || null;
}
```

**Applied In:**
- ✅ MCP order worker (line 112-120)
- ✅ Bot signal enqueuing (checked before adding to `orders_queue`)

---

### 3.3 Intelligence Layer (MODE D Scoring)

**File:** `src/core/intelligence.js`

**Pattern Recognition:**
| Pattern | Direction | Gates | File Location |
|---|---|---|---|
| K Flash Crash Bounce | CALL | 7 | `bot/indicators.js` lines 450-465 |
| Late Overbought Reversal | PUT | 9 | `bot/indicators.js` lines 467-502 |
| K Reversal Early Entry | CALL | 8 | `bot/indicators.js` lines 504-530 |
| Flat Keltner Volume Trap | CALL/PUT | 6 | `bot/indicators.js` lines 532-558 |

**Scoring Methodology:**
```javascript
// scorePrecision() — 7 layer weights (lines 23-31)
const LAYER_WEIGHTS = {
    maCross: 20,       // MA6 crossed MA14
    gapExpansion: 15,  // MA6-MA14 gap widening
    bbPosition: 15,    // Price vs BB bands
    slopeHarmony: 15,  // Price vs MAs
    rsiStrength: 15,   // RSI in signal zone
    rsiIgnition: 10,   // RSI near 50
    stochTrigger: 10   // K/D v2 crossover
};
```

**Key Tools:**
- `po_scan_all` → scores all assets in parallel
- `po_recommend` → filters by `min_precision_score` + `min_win_rate`
- `po_risk_check` → evaluates all 4 patterns, ranks by strength

---

## 4. Database Schema

### 4.1 Bot DB (trading_data.db) — READONLY to MCP

**Core Tables:**
```sql
CREATE TABLE candles (
    id INTEGER PRIMARY KEY,
    asset TEXT,
    timestamp INTEGER,
    open REAL, high REAL, low REAL, close REAL,
    is_closed INTEGER DEFAULT 0
);

CREATE TABLE indicators (
    id INTEGER PRIMARY KEY,
    asset TEXT,
    timestamp INTEGER,
    ma1 REAL,        -- MA6 (fast)
    ma3 REAL,        -- MA14 (slow)
    ma2 REAL,        -- MA50 (not used in MODE D)
    rsi_5 REAL,
    stochastic_k_v2 REAL,  -- Video2 stochastic (5,3,3)
    stochastic_d_v2 REAL,
    bb_upper REAL, bb_middle REAL, bb_lower REAL
);

CREATE TABLE signals (
    id INTEGER PRIMARY KEY,
    asset TEXT,
    timestamp INTEGER,
    direction TEXT,        -- 'CALL' or 'PUT'
    strategy_used TEXT,    -- 'MODE_D'
    reasons TEXT,          -- JSON string with pattern name + gate values
    price REAL
);

CREATE TABLE trades_ordered (
    id INTEGER PRIMARY KEY,
    order_id TEXT,
    asset TEXT,
    direction TEXT,
    amount REAL,
    entry_price REAL,
    entry_timestamp INTEGER,
    exit_price REAL,
    exit_timestamp INTEGER,
    result TEXT,           -- 'WIN' or 'LOSS' or 'DRAW'
    payout REAL,
    roi REAL
);
```

---

### 4.2 MCP DB (mcp.db) — WRITABLE by MCP

**Core Tables:**
```sql
CREATE TABLE mcp_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('CALL','PUT')),
    amount REAL,
    signal_ts INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN ('PENDING','EXECUTED','SKIPPED','FAILED','CANCELLED')),
    status_reason TEXT,
    updated_at INTEGER
);

CREATE TABLE asset_controls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'BLOCK',
    reason TEXT,
    source TEXT,               -- 'agent', 'manual', 'auto-block'
    expires_at INTEGER,        -- NULL = permanent
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,       -- 'scanner', 'analyst', 'executor'
    action TEXT NOT NULL,      -- 'scan', 'approve', 'reject', 'block', 'place'
    asset TEXT,
    direction TEXT,
    score REAL,
    verdict TEXT,
    reasoning TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

---

## 5. Execution Guards & Safety

### 5.1 Execution Mutex (order-executor.js)

```javascript
// Serializes live placement so only one order uses page at a time
let _executionLock = Promise.resolve();

async function executeOneOrder(database, order, config) {
    return _executionLock = _executionLock.then(async () => {
        // Critical section: select asset → click CALL/PUT
        await selectAsset(page, order.asset);
        await clickCallOrPut(page, order.direction);
    }).catch(err => {
        console.error(`Execution failed: ${err}`);
    });
}
```

---

### 5.2 Session Calibration (order-executor.js)

```javascript
// Set amount and expiration ONCE per session
let _sessionCalibrated = { amount: null, expirationSec: null };

async function calibrateTradingPanelIfNeeded(page, { tradeAmount, expirationSec }) {
    if (_sessionCalibrated.amount === tradeAmount && 
        _sessionCalibrated.expirationSec === expirationSec) {
        return; // Already calibrated
    }
    await setTradeAmount(page, tradeAmount);
    await setExpiration(page, expirationSec);
    _sessionCalibrated = { amount: tradeAmount, expirationSec };
}
```

**Performance Impact:** Reduces per-trade execution time from ~8s to ~3s (virtual keyboard overhead eliminated)

---

### 5.3 Stale Feed Guards (bot main loop)

**Price Staleness Check:**
```javascript
const latestPriceTs = await database.get(
    `SELECT MAX(timestamp) as ts FROM prices WHERE asset = ?`, [asset]
);
const ageMs = Date.now() - (latestPriceTs?.ts || 0) * 1000;
if (ageMs > 30000) { // 30 seconds
    log(`[STALE-FEED] ${asset} price is ${Math.round(ageMs/1000)}s old — skipping signal`, 'yellow');
    continue;
}
```

**Applied To:**
- Signal enqueuing from MODE D strategy
- MCP order execution (checked inside `executeOneOrder`)

---

## 6. Agent Integration

### 6.1 Multi-Agent Pipeline

**Orchestration:** `/auto-trade` skill (separate agent spawn)

**Flow:**
1. **Market Scanner** → `po_scan_all` → ranks all assets by precision score
2. **Trade Analyst** → `po_signal_context` + `po_risk_check` → approves/rejects
3. **Trade Executor** → `po_drawdown_check` → GO/PAUSE/STOP verdict
4. **Execution** → `po_trade` → enqueues to `mcp_orders`

**Audit Trail:** All decisions logged to `agent_session_log`

---

### 6.2 Agent-Specific Tools

| Tool | Agent | Purpose |
|---|---|---|
| `po_signal_context` | Analyst | Full 4-bar snapshot (candles + indicators + recent signals) |
| `po_drawdown_check` | Executor | Session safety: P/L, consecutive losses, bot liveness |
| `po_session_log_write` | All | Write decision to audit trail |
| `po_session_log_read` | Orchestrator | Read full decision history |
| `po_block_asset` | Any | Write to `asset_controls` (respected by bot) |
| `po_asset_bias` | Scanner | Per-asset CALL vs PUT WR history |

---

## 7. Performance Optimization

### 7.1 Batch Operations

**Price Buffer (bot):**
```javascript
const priceBatchBuffer = [];
const BATCH_SIZE_LIMIT = 200;
const BATCH_TIME_LIMIT_MS = 10000;

// Accumulate ticks, flush every 10s or 200 items
async function flushPriceBatch(database) {
    if (!priceBatchBuffer.length) return;
    const stmt = db.prepare(`INSERT INTO prices (asset, price, timestamp) VALUES (?, ?, ?)`);
    for (const [a, p, ts] of priceBatchBuffer) stmt.run(a, p, ts);
    stmt.finalize();
    priceBatchBuffer.length = 0;
}
```

---

### 7.2 Message Queue (bot)

```javascript
const messageTaskQueue = [];
let messageWorkerRunning = false;

// Prevents WebSocket flood from starving execution worker
async function runMessageWorker(page) {
    if (messageWorkerRunning || messageTaskQueue.length === 0) return;
    messageWorkerRunning = true;
    while (messageTaskQueue.length > 0) {
        const { payload, page } = messageTaskQueue.shift();
        await processWebSocketMessage(payload, page);
    }
    messageWorkerRunning = false;
}
```

---

## 8. Known Issues & Limitations

### 8.1 Addressed Issues
- ✅ **SQLite corruption from Python** → Python tools removed, sqlite3 CLI only
- ✅ **Double-execution** → Atomic claim with transitional status
- ✅ **Race conditions** → Execution mutex serializes DOM clicks
- ✅ **Virtual keyboard overhead** → Session calibration caches amount/expiration

### 8.2 Current Limitations
- ⚠️ **No retry logic** for failed executions (status set to `FAILED`, requires manual inspection)
- ⚠️ **No WebSocket reconnection** if bot disconnects (requires bot restart)
- ⚠️ **5-order limit** per poll cycle (prevents execution queue backlog)

---

## 9. Testing & Validation

### 9.1 Backtesting Tools

| Tool | Purpose | Data Source |
|---|---|---|
| `po_replay_candles` | Full candle replay with MODE D gates | Bot DB |
| `po_replay_signal` | Reconstruct all gate values for one historical signal | Bot DB |
| `po_find_edge` | Win rate breakdown across 11 dimensions | Bot DB |
| `po_optimize_gates` | Grid search for best thresholds | Bot DB |
| `po_simulate` | Baseline vs modified thresholds side-by-side | Bot DB |

---

### 9.2 Validation Workflow

```bash
# 1. Confirm connectivity
po_health

# 2. Check asset health
po_asset_bias
po_asset_volatility

# 3. Block flat assets
po_block_asset asset=GBPUSD_otc reason="BB < 5 bps"

# 4. Backtest gate changes
po_simulate min_bb_bps=20 min_rsi_call=20

# 5. If validated, sync to bot/indicators.js
# (manual code edit required — MCP does not auto-deploy)

# 6. Get live recommendations
po_recommend min_precision_score=60 min_win_rate=55

# 7. Risk check before placing
po_risk_check asset=EURUSD_otc direction=CALL

# 8. Place manual trade
po_trade asset=EURUSD_otc direction=CALL amount=1
```

---

## 10. Deployment Checklist

### 10.1 Initial Setup
- [ ] Install Node.js 18+
- [ ] Clone repo: `git clone https://github.com/bambabaa/pocket-option-mcp`
- [ ] Run `npm install`
- [ ] Configure bot to write to `pocket-option-mcp/data/trading_data.db`
- [ ] Add MCP server to `~/.claude/settings.json`
- [ ] Restart Claude Code

### 10.2 Pre-Session (Bot Operator)
- [ ] Start bot: `npm run bot`
- [ ] Verify login to Pocket Option
- [ ] Confirm WebSocket connection (watch console for price ticks)
- [ ] Wait for first candle close (bot builds OHLC)

### 10.3 Pre-Session (MCP User in Claude)
- [ ] Call `po_health` → check both DBs accessible
- [ ] Call `po_market_state` → confirm live data
- [ ] Call `po_auto_block_sweep` → unblock previously-blocked assets
- [ ] Call `po_auto_block_check` → block current flat assets
- [ ] Review `po_asset_bias` → identify directional edge

### 10.4 During Session
- [ ] Monitor `po_rolling_summary` for P/L drift
- [ ] Use `po_drawdown_check` before each trade (Executor agent)
- [ ] Review `po_session_log_read` for agent decisions

### 10.5 Post-Session
- [ ] Call `po_performance days=1` → daily summary
- [ ] Call `po_find_edge` → identify losing conditions
- [ ] Update gate thresholds in `bot/indicators.js` if edge found
- [ ] Restart bot to apply changes

---

## 11. Recommendations

### 11.1 Short-Term Improvements
1. **Add retry logic** for `FAILED` orders (exponential backoff, max 3 attempts)
2. **WebSocket reconnection** inside bot (detect disconnect, reload page)
3. **Auto-sync gate changes** from `po_simulate` to `bot/indicators.js` (requires file write permission)

### 11.2 Medium-Term Enhancements
1. **Real-time P/L dashboard** (expose WebSocket data via MCP tool)
2. **Pattern performance breakdown** (track which of the 4 MODE D patterns has best WR)
3. **Multi-timeframe analysis** (add 5m + 15m candles, not just 1m)

### 11.3 Long-Term Vision
1. **Self-optimizing gates** (nightly backtest → auto-adjust thresholds)
2. **Multi-account support** (parallel bot instances with separate DBs)
3. **Live signal streaming** (push notifications to Claude when high-confidence signal fires)

---

## 12. Conclusion

The pocket-option-mcp pipeline is **production-ready** with robust database isolation, atomic order execution, and comprehensive backtesting tools. The dual-database architecture eliminates SQLite corruption risk while enabling bidirectional data flow between Claude and the trading bot.

**Critical Success Factors:**
- ✅ **Database isolation** prevents accidental bot DB corruption
- ✅ **Atomic order claiming** prevents double-execution
- ✅ **Execution mutex** prevents DOM race conditions
- ✅ **Asset blocking** respected by both bot and MCP orders
- ✅ **43 tools** provide full observability + control

**Next Steps:**
1. Add retry logic for failed orders
2. Implement WebSocket reconnection
3. Build real-time P/L dashboard

---

**Review Status:** ✅ APPROVED  
**Reviewer Notes:** Architecture is sound. No blocking issues identified. Ready for production use with recommended enhancements tracked as future work.
