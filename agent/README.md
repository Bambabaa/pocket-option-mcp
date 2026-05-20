# agent/

Standalone data-collection layer for Pocket Option. Uses Puppeteer to intercept the live WebSocket feed, compute all 14 indicators, and persist candles + indicators to a local SQLite database (`agent.db`).

This is **separate from the main bot** (`bot/pocket-option-bot.js`). It writes to its own database and is used for backtesting, research, and analysis only. It does not place trades.

---

## Directory Layout

```
agent/
├── data/
│   └── agent.db              ← SQLite database (auto-created on first run)
├── test/
│   ├── fetch_history.cjs     ← 24h history via loadHistoryPeriod → agent.db (recommended)
│   └── test_chart.cjs        ← Manual scroll / subscribe dump → agent.db
└── websocket/
    ├── client.cjs            ← Live WebSocket client (continuous — for future use)
    ├── history.cjs           ← loadHistoryPeriod protocol (emit, parse, pagination)
    ├── store.cjs             ← DB schema + batch candle/indicator writes
    ├── indicators.cjs        ← Pure indicator math (14 indicators, PO platform defaults)
    ├── config.json           ← Shared config: period, URL, history, indicators
    └── setup-db.cjs          ← One-time DB schema creator (run before client.cjs)
```

---

## Quick Start

### 1. Fetch 24h historical data (recommended)

```
node agent/test/fetch_history.cjs EURUSD_otc
node agent/test/fetch_history.cjs EURUSD_otc GBPUSD_otc
```

1. Browser opens — log in and open the **trading chart**
2. Press **Enter** in the terminal
3. Fetches 24h (288 × 5m bars), writes to `agent/data/agent.db`, exits

Uses the Pocket Option `loadHistoryPeriod` WebSocket API (same protocol as [BinaryOptionsTools-v2 get_candles.rs](https://github.com/ChipaDevTeam/BinaryOptionsTools-v2/blob/master/crates/binary_options_tools/src/pocketoption/modules/get_candles.rs)). No chart scrolling required.

### 2. Fetch historical data (manual scroll — legacy)

```
node agent/test/test_chart.cjs
```

1. Browser opens — log in to Pocket Option
2. Click each asset you want data for (any chart period — script auto-switches to 300s)
3. Scroll the chart left to load more historical bars
4. Press Enter in the terminal
5. Script computes all indicators and writes to `agent/data/agent.db`, then exits

### 3. Run the live client (continuous)

First create the schema if `agent.db` doesn't exist yet:

```
node agent/websocket/setup-db.cjs
```

Then start the live client:

```
node agent/websocket/client.cjs
```

Browser opens, log in, select assets. The client runs until you press Ctrl+C, accumulating candles and indicators in real time.

---

## Files

### `test/fetch_history.cjs`

Dedicated 24h backfill via **`loadHistoryPeriod`** (not `changeSymbol` subscribe dumps).

**What it does:**
- Opens Puppeteer + CDP WebSocket interception (port 9225)
- For each asset: `sock.emit('loadHistoryPeriod', { asset, period, time, index, offset })`
- Correlates responses by `index`; paginates with earlier `time` if fewer than target bars
- Merges OHLC into memory, then `store.cjs` writes candles + indicators + warmup drop

**Config** (`websocket/config.json` → `history`):
- `target_hours`: 24 (default)
- `batch_size`: 288 (bars per request; derived from period × hours)
- `request_timeout_ms`, `stall_limit`, `inter_request_delay_ms`

**Expected yield:** ~288 candles per asset at `candle_period_seconds: 300` (24h of 5m bars).

### `websocket/history.cjs`

Shared module: parse Socket.IO frames, emit `loadHistoryPeriod`, pagination loop, candle store merge. Used by `fetch_history.cjs`.

### `websocket/store.cjs`

Shared module: `openAgentDb()`, `storeBarsAndIndicators()` — batch inserts, indicator backfill, STC warmup drop.

### `test/test_chart.cjs`

Manual-run historical fetcher. Designed for backtesting data collection — not for live trading.

**What it does:**
- Opens a Puppeteer browser and navigates to Pocket Option
- Intercepts WebSocket history dumps via Chrome DevTools Protocol (CDP)
- Detects wrong-period data and auto-corrects via `changeSymbol(asset, 300)` — no manual 5m selection needed
- Aggregates raw ticks into proper OHLC bars (open/high/low/close per 300s bucket)
- Merges server-provided OHLC candles with tick-derived candles (deduped by timestamp)
- Computes all 14 indicators for every bar (full backfill)
- Drops warmup bars where `stc_value IS NULL` (STC needs ~62 bars of lookback to produce valid values)
- Target: **1000 bars per asset** after warmup removal

**Socket spy:** The script injects a `window.io` spy before the page loads (via `evaluateOnNewDocument`). Every outgoing socket event appears in the terminal as `[SOCK] emit "eventName" ...`. This is used to discover PO's history-request API when you scroll the chart.

**DB writes:**
- `candles` — `INSERT OR IGNORE` (safe to run multiple times; accumulates across runs)
- `indicators` — `INSERT OR REPLACE` (always uses latest computed values)

---

### `websocket/client.cjs`

Continuous live client — mirrors the bot's two-message WebSocket pattern exactly.

| Message type | Format | What happens |
|---|---|---|
| History dump | `{ asset, candles, history, period }` | Seeds in-memory candle array; backfills indicators for all seeded bars |
| Live tick | `[[asset, timestamp, price]]` | Stored to `prices` table (batched); builds current OHLC bar; on period rollover → finalises bar, computes + stores indicators |

**Order execution:** Polls `agent_orders` table every 2 seconds for `PENDING` rows and executes them via `socket.emit('openOrder', ...)`.

---

### `websocket/indicators.cjs`

Pure math module — no side effects, no database access. All 14 indicators at Pocket Option's platform defaults.

| Indicator | Parameters |
|---|---|
| SMA | periods: 10, 20, 50 |
| EMA | periods: 12, 26 |
| RSI (Wilder) | period: 14 |
| MACD | fast: 12, slow: 26, signal: 9 |
| Bollinger Bands | period: 20, stdDev: 2 |
| Stochastic | K: 5, D: 3, smooth: 3 |
| Keltner Channel | EMA: 20, ATR: 10, mult: 2 |
| Zig Zag | deviation: 5%, minBars: 4 |
| STC (Schaff Trend Cycle) | emaFast: 23, emaSlow: 50, cycle: 10, smooth1: 3, smooth2: 3 |
| ADX | period: 14 |
| CCI | period: 20 |
| Williams %R | period: 14 |
| ATR | period: 14 |
| Parabolic SAR | acceleration: 0.02, max: 0.2 |

**Candle format:** `[timestamp, open, close, high, low]`

**Entry point:**
```js
const { computeAll } = require('./indicators.cjs');
const ind = computeAll(candles, cfg, prevStcValue);
// ind → { sma_10, sma_20, ..., stc_value, stc_delta, adx, ... }
// ind === null when there is insufficient data (warmup period)
```

**Warmup:** STC is the last indicator to become valid (`ema_slow = 50` requires ~62 bars of history). `computeAll` returns `null` for bars below this threshold.

---

### `websocket/config.json`

Shared config read by both `client.cjs` and `test_chart.cjs`.

```json
{
  "candle_period_seconds": 300,
  "pocket_option_url": "https://pocketoption.com",
  "history": {
    "target_hours": 24,
    "batch_size": 288,
    "request_timeout_ms": 12000,
    "stall_limit": 6,
    "inter_request_delay_ms": 800
  },
  "indicators": { ... }
}
```

Change `candle_period_seconds` to switch between timeframes (e.g. `60` for 1m, `300` for 5m). `target_hours` × period determines how many bars `fetch_history.cjs` requests.

---

### `websocket/setup-db.cjs`

One-time schema creator for `agent.db`. Safe to re-run (uses `CREATE TABLE IF NOT EXISTS`).

```
node agent/websocket/setup-db.cjs
```

`test_chart.cjs` auto-creates the schema on every run, so you only need this before running `client.cjs`.

---

## Database Schema (`agent/data/agent.db`)

```sql
candles        (asset, timestamp PK, open, high, low, close)
indicators     (asset, timestamp PK, sma_10..psar_is_bullish)   -- 35 columns
prices         (asset, timestamp PK, price)                     -- per-tick
agent_orders   (id PK, asset, direction, amount, expiry_seconds, status, result, ...)
agent_log      (id PK, cycle_id, asset, decision, direction, score, reason, ...)
```

All timestamps are **Unix seconds** (UTC). `candles.timestamp` is the bar **open** time aligned to the period boundary (e.g. `ts % 300 === 0` for 5m bars).

---

## Notes

- **No Python** — `agent.db` is a `better-sqlite3` database. Opening it with Python's `sqlite3` while the JS process is running can corrupt WAL files.
- **INSERT OR IGNORE on candles** — running `test_chart.cjs` multiple times accumulates bars across sessions safely.
- **Warmup bars are auto-dropped** — `test_chart.cjs` deletes any bar where `stc_value IS NULL` immediately after computation. Both `candles` and `indicators` rows are removed.
- **Debug ports** — bot 9222, `client.cjs` 9223, `test_chart.cjs` 9224, `fetch_history.cjs` 9225. Run one at a time or ports will conflict.
