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
│   └── test_chart.cjs        ← Manual-run script: fetch history → compute indicators → write DB
└── websocket/
    ├── client.cjs            ← Live WebSocket client (continuous — for future use)
    ├── indicators.cjs        ← Pure indicator math (14 indicators, PO platform defaults)
    ├── config.json           ← Shared config: period, URL, indicator parameters
    └── setup-db.cjs          ← One-time DB schema creator (run before client.cjs)
```

---

## Quick Start

### 1. Fetch historical data (one-shot)

```
node agent/test/test_chart.cjs
```

1. Browser opens — log in to Pocket Option
2. Click each asset you want data for (any chart period — script auto-switches to 300s)
3. Scroll the chart left to load more historical bars
4. Press Enter in the terminal
5. Script computes all indicators and writes to `agent/data/agent.db`, then exits

### 2. Run the live client (continuous)

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
  "indicators": { ... }
}
```

Change `candle_period_seconds` to switch between timeframes (e.g. `60` for 1m, `300` for 5m).

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
- **Port 9224** — `test_chart.cjs` launches Chrome on remote debugging port 9224. If you also run `client.cjs` (port 9223) or the main bot (port 9222), they won't conflict.
