# Pocket Option MCP — Full System Workflow

## Architecture Overview

```
PocketOption.com  ←→  pocket-option-bot.js (Puppeteer, 24/7)  ←→  trading_data.db
                                                                    │
Claude Code  ←→  MCP Server (stdio, 27 tools)  ←→  trading_data.db (READONLY)
                                                       mcp.db (READ-WRITE)
```

### Two Databases

| Database | Path | Access | Purpose |
|---|---|---|---|
| `trading_data.db` | `data/trading_data.db` | MCP reads only | Bot writes all live data: prices, candles, indicators, signals, trades |
| `mcp.db` | `data/mcp.db` | MCP reads + writes | Manual orders from Claude, session state, watchlists |

### Critical Rule

**NEVER write to `socket_option/determ/`** — that directory is the read-only source. All bot script modifications live in `pocket-option-mcp/bot/`.

---

## Layer 1: Data Ingestion (Bot — Runs 24/7)

The bot (`pocket-option-bot.js`) runs independently as a Puppeteer browser automation process.

### What the Bot Does

```
┌─────────────────────────────────────────────────────────────┐
│              pocket-option-bot.js                            │
│                                                              │
│  1. Opens PocketOption.com in headless Chrome                │
│  2. Subscribes to 77 assets (EURUSD_otc, GBPUSD_otc, ...)   │
│  3. Every tick:         writes price    → prices table       │
│  4. Every candle close: writes OHLC     → candles table      │
│  5. Every tick:         calculates      → indicators table   │
│                          MA6/14/50, RSI-5/8/80,              │
│                          Stoch 13-3-3, BB 20-2,              │
│                          Keltner, Schaff 30-55-8             │
│  6. Runs KT video2 strategy → generates signals              │
│                          → writes to signals table           │
│  7. Executes qualified signals via DOM clicks                │
│     → writes to orders_queue → trades_ordered (WIN/LOSS)     │
│  8. MCP Orders Worker (every 5s):                            │
│     → polls mcp.db for PENDING manual orders                 │
│     → claims atomically (SKIPPED status)                     │
│     → executes via DOM click                                 │
│     → updates status to EXECUTED or FAILED                   │
└─────────────────────────────────────────────────────────────┘
```

### Data Accumulated

| Data | Volume |
|---|---|
| Assets tracked | 77 |
| Candles | 135,000+ |
| Tick prices | 6.5M+ |
| Indicators | MA/RSI/BB/Stoch/Keltner/Schaff per asset |
| Signals | KT video2 CALL/PUT |

---

## Layer 2: MCP Read Tools (23 Tools)

### Health Check

| Tool | Purpose |
|---|---|
| `po_health` | DB connection, row counts, bot liveness (price age < 30s = live) |

### Market Data

| Tool | Purpose |
|---|---|
| `po_prices(asset?)` | Latest price for one asset, or all assets if omitted |
| `po_candles(asset, limit, summary?)` | OHLC bars — use `summary=true` for compact stats |
| `po_price_history(asset, from, to, limit)` | Tick-level prices over a time range |
| `po_indicators(asset, limit)` | MA/RSI/BB/Stoch/Keltner/Schaff values |

### Signals

| Tool | Purpose |
|---|---|
| `po_signals(asset?, limit, direction?)` | Recent CALL/PUT signals from KT strategy |
| `po_pending_signals(lookAheadSeconds)` | Signals past expiry not yet validated |

### Orders & Trades

| Tool | Purpose |
|---|---|
| `po_bot_orders(status?, limit)` | Bot-generated execution queue (readonly) |
| `po_mcp_orders(status?, limit)` | Manual orders Claude placed via `po_trade` |
| `po_trades_ordered(asset?, result?, limit)` | Executed trades with WIN/LOSS results |
| `po_pnl_summary` | P/L breakdown by asset |

### Performance

| Tool | Purpose |
|---|---|
| `po_rolling_summary(days)` | Rolling win rate, ROI, max streak (`days=0` = all-time) |
| `po_performance(days)` | Daily performance table |
| `po_hourly_breakdown` | P/L by hour of day (UTC) |

### Trade Execution (Write)

| Tool | Purpose |
|---|---|
| `po_trade(asset, direction, amount?, signal_timestamp?)` | Enqueue manual trade → writes PENDING to `mcp.db` |
| `po_cancel_order(order_id)` | Cancel a PENDING manual order |

---

## Layer 3: Intelligence Layer (4 Tools)

### `po_scan_all` — One Call Replaces Eight

Scans all 77 assets in parallel and returns a ranked list.

**What it gathers per asset:**

- Latest price + age
- Fresh signal (last 5 minutes)
- Current win streak
- Qualification status
- Recent win rate (last 10 trades)
- Recent P/L

**Scoring algorithm:**

```
Score = qualified(25pts)
      + fresh_signal(30pts)
      + streak(15pts, scaled to max streak 10)
      + win_rate(20pts)
      + recent_form(10pts)
```

**Returns:** All assets sorted by score descending, with top 5 highlighted.

### `po_recommend` — "What Should I Trade Right Now?"

Runs `po_scan_all` then filters by:

- Asset is qualified
- Fresh signal (< 2 min old, configurable)
- Win rate >= 60% (configurable)
- Streak >= 2 (configurable)

**Returns:** Ranked list with confidence scores, direction, and reasons.

### `po_risk_check` — "Is This Trade Safe?"

Pre-trade risk audit that checks:

1. Asset tracked? (if no → BLOCKED)
2. Qualified? (-25pts if no)
3. Streak status (-10 if zero, bonus if hot)
4. Recent win rate (-25 if <40%, +5 if >=70%)
5. Signal matches direction? (-20 if opposite, +10 if match)
6. Consecutive losses? (-20 if 3+ in a row)

**Returns:** Score 0-100, verdict (GOOD / CAUTION / RISKY / AVOID), and recommendation.

### `po_market_state` — "How's the Market?"

**Returns:**

- Active assets (candles in last 5 min)
- Signals in last hour (by CALL/PUT direction)
- Today's trades: count, win rate, P/L, ROI
- Top 3 performing assets today
- All-time: total trades, overall win rate

---

## Layer 4: Trade Execution Flow

### Bot-Generated Trade (Automatic)

```
Bot detects signal on Pocket Option
  → validates against qualification rules
  → writes to orders_queue (PENDING)
  → execution worker picks it up
  → DOM click on Pocket Option
  → updates status to EXECUTED
  → later: result sync → trades_ordered (WIN/LOSS)
```

### Claude-Generated Trade (Manual)

```
1. Claude calls po_recommend()
   → gets ranked trade picks

2. Claude calls po_risk_check("EURUSD_otc", "CALL")
   → gets score 78, verdict GOOD

3. Claude calls po_trade("EURUSD_otc", "CALL")
   → writes PENDING order to mcp.db

4. Bot's MCP Orders Worker (every 5s):
   → SELECT * FROM mcp_orders WHERE status='PENDING'
   → atomic claim: UPDATE SET status='SKIPPED',
     reason='claimed-for-execution'
     (check .changes to prevent double-pickup)
   → builds shimDb that redirects orders_queue SQL → mcp_orders
   → calls executeOneOrder(order, page, shimDb)
   → DOM click on Pocket Option
   → updates status to EXECUTED or FAILED

5. Later: result sync → trades_ordered updated with WIN/LOSS
```

**Why SKIPPED not EXECUTED for claim:** `executeOneOrder` has a guard `if (status === 'EXECUTED') return 'EXECUTED'` — claiming as EXECUTED before running would cause the trade to never fire.

---

## Typical Claude Sessions

### Reactive Mode (Individual Tools)

```
User: "What's happening with EURUSD?"

Claude calls:
  1. po_health → bot is live ✓
  2. po_prices("EURUSD_otc") → $1.08234
  3. po_signals("EURUSD_otc") → CALL signal 30s ago
  4. po_indicators("EURUSD_otc") → RSI 72, BB upper hit
  5. po_asset_streaks("EURUSD_otc") → streak 4

Claude responds: "EURUSD has a CALL signal fired 30s ago,
  streak of 4 wins, RSI at 72 (overbought), Bollinger upper
  band hit. Strong setup."
```

### Agentic Mode (Intelligence Layer)

```
User: "What's the market look?"

Claude calls:
  1. po_market_state → "32 assets active, 8 signals/hour, today +$47"
  2. po_recommend → "Top pick: EURUSD_otc CALL, score 82, streak 5"
  3. po_risk_check("EURUSD_otc", "CALL") → "GOOD, score 78"

Claude responds: "Market is active with 32 assets. Top recommendation:
  EURUSD_otc CALL — score 82, on a 5-win streak, 78% recent win rate.
  Risk check says GOOD. Want me to place the trade?"
```

### Monitoring Mode

```
User: "Keep an eye on the market"

Claude periodically calls:
  po_scan_all → detects changes between calls
  → "EURUSD streak just broke at 6"
  → "GBPUSD new PUT signal, score 71"
  → "USDJPY just got qualified"
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    PocketOption.com                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ Puppeteer (DOM reads + clicks)
                       ▼
┌────────────────────────────────────────────────────────────┐
│              pocket-option-bot.js (24/7)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Scrape   │  │ Indicate │  │ Signal   │  │ Execute    │  │
│  │ prices   │  │ rs       │  │ Gen      │  │ trades     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
└───────┼─────────────┼─────────────┼──────────────┼─────────┘
        ▼             ▼             ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│              trading_data.db (READONLY for MCP)             │
│  prices │ candles │ indicators │ signals │ orders_queue     │
│  trades_ordered │                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP Server (27 tools)                          │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────────┐  │
│  │ Read Tools │  │ Write      │  │ Intelligence Layer    │  │
│  │ (23 tools) │  │ (2 tools)  │  │ (4 tools)             │  │
│  │ prices,    │  │ po_trade   │  │ po_scan_all           │  │
│  │ candles,   │  │ po_cancel  │  │ po_recommend          │  │
│  │ signals    │  │            │  │ po_risk_check         │  │
│  │ ...        │  │            │  │ po_market_state       │  │
│  └────────────┘  └────────────┘  └───────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdio (MCP protocol)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code                              │
│  "Scan the market" → po_scan_all → ranked list              │
│  "What should I trade?" → po_recommend → top picks          │
│  "Is this safe?" → po_risk_check → score + verdict          │
│  "Place it" → po_trade → mcp.db → bot executes              │
└─────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
pocket-option-mcp/
├── bot/                          ← Copy of determ scripts (modifications here)
│   ├── pocket-option-bot.js      ← + MCP orders worker
│   ├── database.js               ← unchanged
│   ├── indicators.js             ← video1/v3 decision functions removed
│   └── scripts/
│       ├── order-executor.js     ← unchanged
│       └── validate-signals.js   ← unchanged
├── data/
│   ├── trading_data.db           ← bot writes, MCP reads (READONLY)
│   └── mcp.db                    ← MCP writes, bot reads
├── src/
│   ├── server.js                 ← 27 tools registered
│   ├── connection.js             ← bot-db readonly connection
│   ├── mcp-db.js                 ← mcp.db read-write connection
│   ├── core/
│   │   ├── health.js
│   │   ├── data.js
│   │   ├── orders.js
│   │   ├── assets.js
│   │   ├── validation.js
│   │   ├── performance.js
│   │   └── intelligence.js       ← NEW: scan_all, recommend, risk_check, market_state
│   └── tools/
│       ├── _format.js            ← shared jsonResult helper
│       ├── health.js
│       ├── data.js
│       ├── orders.js
│       ├── assets.js
│       ├── validation.js
│       ├── performance.js
│       └── intelligence.js       ← NEW: register 4 intelligence tools
└── docs/
    ├── workflow.md               ← this file
    ├── cli.md
    └── outputs.md
```

---

## Tool Count: 27 Total

| Category | Count | Tools |
|---|---|---|
| Health | 1 | `po_health` |
| Market Data | 4 | `po_prices`, `po_candles`, `po_price_history`, `po_indicators` |
| Signals | 2 | `po_signals`, `po_pending_signals` |
| Assets | 4 | `po_tracked_assets`, `po_qualified_assets`, `po_asset_streaks`, `po_streak_leaderboard` |
| Orders | 4 | `po_bot_orders`, `po_mcp_orders`, `po_trades_ordered`, `po_pnl_summary` |
| Trade Execution | 2 | `po_trade`, `po_cancel_order` |
| Performance | 3 | `po_rolling_summary`, `po_performance`, `po_hourly_breakdown` |
| **Intelligence** | **4** | `po_scan_all`, `po_recommend`, `po_risk_check`, `po_market_state` |
