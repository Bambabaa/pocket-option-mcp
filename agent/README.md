# agent/

Standalone data-collection layer for Pocket Option. Uses Puppeteer + CDP to intercept the live WebSocket feed, compute all 14 indicators, and persist candles + indicators to a local SQLite database (`agent.db`).

This is **separate from the main bot** (`bot/pocket-option-bot.js`). It writes to its own database and is used for backtesting, research, and the Claude agent trading system. It does not place trades (yet — Phase 3).

See [`claude-agent-trading-plan.md`](claude-agent-trading-plan.md) for the full system design.

---

## Directory Layout

```
agent/
├── claude-agent-trading-plan.md  ← full system design + build sequence
├── data/
│   └── agent.db                  ← SQLite database (auto-created on first run)
├── test/
│   ├── fetch_history.cjs         ← 24h backfill via loadHistoryPeriod → agent.db (recommended)
│   └── test_chart.cjs            ← manual scroll / subscribe dump → agent.db (legacy)
└── websocket/
    ├── client.cjs                ← live WebSocket client (continuous — tick → 5m OHLC → indicators)
    ├── direct-ws.cjs             ← direct Node.js EIO v4 WS connection (bypasses browser socket)
    ├── history.cjs               ← loadHistoryPeriod protocol (emit, parse, pagination)
    ├── store.cjs                 ← DB schema + batch candle/indicator writes
    ├── indicators.cjs            ← pure indicator math (14 indicators, PO platform defaults)
    ├── config.json               ← shared config: period, URL, history, indicators
    └── setup-db.cjs              ← one-time DB schema creator (run before client.cjs)
```

---

## Quick Start

### 1. Fetch 24h historical data (recommended)

```
node agent/test/fetch_history.cjs                    # auto-detect assets from UI clicks
node agent/test/fetch_history.cjs EURUSD_otc         # explicit asset list
node agent/test/fetch_history.cjs EURUSD_otc GBPUSD_otc
```

**Flow:**
1. Browser opens — log in (real or demo account)
2. If no CLI assets: click assets in the PO UI — each click is auto-detected
3. Press **Enter** in the terminal
4. Fetches 288 × 5m bars per asset (~4 min/asset at 800ms delay), writes to `agent/data/agent.db`, exits

If no login session is detected, the script automatically navigates to the guest demo (`/en/cabinet/try-demo/`) — no login required.

Uses the Pocket Option `loadHistoryPeriod` WebSocket API. No chart scrolling required.

### 2. Run the live client (continuous)

```
node agent/websocket/client.cjs
```

1. Browser opens — log in (real or demo account)
2. Open the trading chart and click assets you want to track
3. Press **Enter** in the terminal
4. Client runs indefinitely — bars close every 5 minutes, indicators computed on each close
5. Press **Ctrl+C** to stop

The schema is auto-created on first run — no need to run `setup-db.cjs` separately.

**Recommended workflow:** Run `fetch_history.cjs` first to backfill 24h of history, then start `client.cjs` for live updates. The live client's history dump only seeds ~99 bars on subscribe; `fetch_history.cjs` gives 225 bars (288 fetched, 62 warmup dropped).

### 3. Fetch historical data (manual scroll — legacy)

```
node agent/test/test_chart.cjs
```

1. Browser opens — log in to Pocket Option
2. Click each asset, scroll the chart left to load history
3. Press Enter — script computes indicators and writes to `agent.db`

---

## Files

### `test/fetch_history.cjs`

Recommended 24h backfill via **`loadHistoryPeriod`** (not `changeSymbol` subscribe dumps).

**What it does:**
- Opens Puppeteer + CDP WebSocket interception (port 9225)
- Captures auth SSID from the browser's outbound WS frames (supports real account `session` field and demo `token` field)
- Auto-detects assets from the user's UI clicks via `changeSymbol` CDP events (or uses CLI args)
- For each asset: emits `loadHistoryPeriod` via a direct Node.js WS connection → correlates binary-event responses by `index` → paginates backward
- Merges OHLC into memory, then `store.cjs` writes candles + indicators + warmup drop

**Config** (`websocket/config.json` → `history`):
- `target_hours`: 24 (default) — set lower for fewer bars
- `batch_size`: 288 — **do not change** (PO requires this offset value)
- `request_timeout_ms`, `stall_limit`, `inter_request_delay_ms`

**Expected yield:** ~225 candles per asset at `candle_period_seconds: 300` (288 fetched, 62 warmup bars dropped for STC validity).

---

### `websocket/direct-ws.cjs`

Direct Node.js WebSocket to PO's server — bypasses the browser's socket.io entirely.

**Why it exists:** PO's socket.io connection runs inside a cross-origin iframe. `page.evaluate`, `Runtime.evaluate`, and CDP `Network.sendWebSocketFrame` all fail to reach it. The solution: capture the auth SSID from the browser's own outbound CDP frames, then open a second WS connection from Node.js using that SSID.

**Protocol:** EIO v4 + Socket.IO
- Handles EIO ping/pong (`2` → `3`) keepalive
- Sends `42["ps"]` application-level keepalive every 15s (prevents PO dropping the connection after ~90s)
- Handles Socket.IO binary events (`451-[...]`): the binary attachment arrives as a plain JSON string and is forwarded to the response dispatcher

**Exports:** `createDirectWs({ log, onFrame })` → `{ connect, emit, close }`

---

### `websocket/history.cjs`

Shared module: parse Socket.IO frames, emit `loadHistoryPeriod`, pagination loop, candle store merge. Used by `fetch_history.cjs`.

---

### `websocket/store.cjs`

Shared module: `openAgentDb()`, `storeBarsAndIndicators()` — batch inserts, indicator backfill, STC warmup drop.

---

### `websocket/client.cjs`

Continuous live client. Connects to PO via Puppeteer + CDP, subscribes to price streams, aggregates ticks into 5m OHLC bars, computes indicators on every bar close.

| Message type | Format | What happens |
|---|---|---|
| History dump | `{ asset, candles, history, period }` | Seeds in-memory candle array; backfills indicators for all seeded bars |
| Live tick | `[[asset, timestamp, price]]` | Builds current OHLC bar; on period rollover → finalises bar, computes + stores indicators |

**History on subscribe:** PO pushes ~99 bars per asset when you open the chart. Run `fetch_history.cjs` first for full 24h coverage.

**Order execution (Phase 3):** Polls `agent_orders` every 2 seconds for `PENDING` rows. Currently uses `page.evaluate → sock.emit('openOrder')` which fails due to PO's cross-origin iframe — will be ported to `direct-ws.cjs` in Phase 3.

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

**Warmup:** STC needs ~62 bars of history. `computeAll` returns `null` below this threshold. Warmup bars are dropped from `agent.db` automatically.

---

### `websocket/config.json`

Shared config read by all scripts.

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

**`batch_size` must stay at 288** — this is the `offset` parameter sent to PO's `loadHistoryPeriod` API. Lower values cause the server to return no data.

Change `candle_period_seconds` to switch timeframes (e.g. `60` for 1m). `target_hours` controls how many bars are fetched.

---

### `websocket/setup-db.cjs`

One-time schema creator for `agent.db`. Safe to re-run (`CREATE TABLE IF NOT EXISTS`).

```
node agent/websocket/setup-db.cjs
```

`fetch_history.cjs` and `test_chart.cjs` auto-create the schema on every run, so you only need this before running `client.cjs`.

---

## Database Schema (`agent/data/agent.db`)

```sql
candles        (asset, timestamp PK, open, high, low, close)
indicators     (asset, timestamp PK, sma_10..psar_is_bullish)   -- 35 columns
agent_orders   (id PK, asset, direction, amount, expiry_seconds, status, result, ...)
agent_log      (id PK, cycle_id, asset, decision, direction, score, reason, ...)
```

All timestamps are **Unix seconds** (UTC). `candles.timestamp` is the bar **open** time aligned to the period boundary (`ts % 300 === 0` for 5m bars).

---

## Notes

- **No Python** — `agent.db` is a `better-sqlite3` database. Opening it with Python's `sqlite3` while the JS process is running can corrupt WAL files.
- **`INSERT OR IGNORE` on candles** — running backfill multiple times accumulates bars safely without duplicates.
- **Warmup bars are auto-dropped** — any bar where `stc_value IS NULL` is deleted after computation. Both `candles` and `indicators` rows are removed.
- **Debug ports** — bot 9222, `client.cjs` 9223, `test_chart.cjs` 9224, `fetch_history.cjs` 9225. Run one at a time or ports will conflict.
- **Demo support** — `fetch_history.cjs` accepts demo token auth (`{"token":"...","isFastHistory":true}`). PO uses Socket.IO binary events (`loadHistoryPeriodFast`) for demo accounts; the client handles both formats.
