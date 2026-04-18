# pocket-option-mcp

MCP (Model Context Protocol) server that connects Claude Code to a live **Pocket Option trading bot**. Read real-time market data, analyze strategy performance, and enqueue trades — all from a Claude conversation.

## How It Works

The bot (`pocket-option-bot.js`) runs in the background, intercepts Pocket Option WebSocket data via Puppeteer/CDP, builds OHLC candles, calculates indicators, generates signals, and executes trades by clicking the DOM. It writes everything to a local SQLite database.

This MCP server is **fully self-contained** — it owns its own database (`data/mcp.db`) for any writes, and only reads from the bot's database. The bot's DB is never modified by this server.

```
Claude Code  ←→  pocket-option-mcp (MCP stdio)
                        │
              ┌─────────┴────────────────┐
              │                          │
         bot-db.js                  mcp-db.js
         READONLY                   WRITABLE
         (bot's trading_data.db)    (data/mcp.db — owned by MCP)
              │                          │
              └──────────┬───────────────┘
                         │
              pocket-option-bot.js  ←→  pocketoption.com
              (Puppeteer + CDP)
```

**Trade execution flow:**
`po_trade` → writes `PENDING` to `mcp_orders` in `mcp.db` → bot execution worker reads `mcp_orders` → clicks CALL/PUT on the Pocket Option page → updates `status` to `EXECUTED` → result sync writes WIN/LOSS back to `mcp_orders`

## Prerequisites

- Node.js 18+
- `pocket-option-bot.js` running (from `socket_option/determ/`)
- A valid Pocket Option account (the bot handles browser login)

## Installation

```bash
git clone https://github.com/Bambabaa/pocket-option-mcp
cd pocket-option-mcp
npm install
```

## Bot DB path

Both databases live inside this repo under `data/`:

```
pocket-option-mcp/
└── data/
    ├── trading_data.db   ← bot writes here, MCP reads here
    └── mcp.db            ← MCP writes here, bot reads here
```

Configure `pocket-option-bot.js` to write to `pocket-option-mcp/data/trading_data.db`:

```js
// In pocket-option-bot.js, update the database path:
const database = new TradingDatabase('/path/to/pocket-option-mcp/data/trading_data.db');
```

## Configuration

Add to `~/.claude/settings.json` — no env vars needed:

```json
{
  "mcpServers": {
    "pocket-option": {
      "command": "node",
      "args": ["/path/to/pocket-option-mcp/src/server.js"]
    }
  }
}
```

| Env var | Default | Description |
|---|---|---|
| `PO_DB_PATH` | `data/trading_data.db` (inside this repo) | Override bot DB path only if needed |
| `MCP_DB_PATH` | `data/mcp.db` (inside this repo) | Override MCP DB path only if needed |

## Quick Start

Once Claude Code is restarted with the MCP server registered:

```
po_health                                      # confirm both DBs accessible, check bot liveness
po_tracked_assets                              # see what assets are live
po_prices                                      # latest price for all assets
po_signals                                     # recent CALL/PUT signals from bot strategy
po_rolling_summary days=0                      # all-time P/L
po_trade asset=EURUSD_otc direction=CALL       # enqueue a manual trade
po_mcp_orders                                  # check your manual order status
```

## Tools (23)

### Health

| Tool | Description |
|---|---|
| `po_health` | Check both DBs (bot + MCP) and bot liveness. Returns row counts, latest price timestamp, staleness. **Call this first.** |

### Market Data *(reads bot DB — readonly)*

| Tool | Parameters | Description |
|---|---|---|
| `po_tracked_assets` | — | List all assets the bot has candle data for |
| `po_prices` | `asset?` | Latest price for one asset, or all assets if omitted |
| `po_candles` | `asset`, `limit?`, `summary?` | OHLC bars. Use `summary=true` for a compact stats view |
| `po_price_history` | `asset`, `from_timestamp`, `to_timestamp`, `limit?` | Tick-level price history over a time window |
| `po_indicators` | `asset`, `limit?` | Calculated indicators: MA1/MA2/MA3, RSI, Bollinger Bands, Stochastic, Keltner, Schaff |
| `po_signals` | `asset?`, `limit?`, `direction?` | CALL/PUT signals from the KT strategy pipeline |

### Trade Execution

| Tool | Parameters | Description | DB |
|---|---|---|---|
| `po_trade` | `asset`, `direction`, `amount?`, `signal_timestamp?` | **Enqueue a manual CALL or PUT.** Bot picks it up on its next execution cycle. | writes MCP DB |
| `po_cancel_order` | `order_id` | Cancel a PENDING manual order before it executes | writes MCP DB |
| `po_mcp_orders` | `status?`, `limit?` | View manual orders you placed via `po_trade` | reads MCP DB |
| `po_bot_orders` | `status?`, `limit?` | View bot-generated execution queue | reads bot DB |
| `po_trades_ordered` | `asset?`, `result?`, `limit?` | Executed live trades with WIN/LOSS/DRAW results | reads bot DB |
| `po_pnl_summary` | — | P/L breakdown by asset | reads bot DB |

### Performance *(reads bot DB — readonly)*

| Tool | Parameters | Description |
|---|---|---|
| `po_rolling_summary` | `days?` | Win rate, P/L, ROI, best/worst trade. `days=0` = all-time |
| `po_performance` | `days?` | Daily performance records from the performance table |
| `po_hourly_breakdown` | — | Trade distribution and P/L by hour of day (UTC) |

### Qualification & Validation *(reads bot DB — readonly)*

| Tool | Parameters | Description |
|---|---|---|
| `po_qualified_assets` | — | Assets on the bot's trading allow-list (2+ consecutive wins) |
| `po_asset_streaks` | `asset?` | Current consecutive win streak per asset |
| `po_streak_leaderboard` | `min_wins?` | Rank assets by active win streak |
| `po_qualification_outcomes` | `asset?`, `limit?` | Full signal validation history (entry/exit price, WIN/LOSS) |
| `po_asset_trades` | `asset?`, `limit?` | Trade outcomes for qualified assets only, with win rate |
| `po_validation_stats` | `asset?` | Aggregate win rate and P/L from the validation layer |
| `po_pending_signals` | `look_ahead_seconds?`, `limit?` | Signals past expiry with no validation outcome yet |

## Architecture

```
src/
├── server.js              MCP server entry point — registers all tools
├── bot-db.js              Readonly connection to the bot's trading_data.db
├── mcp-db.js              Writable connection to data/mcp.db (owned by this server)
├── connection.js          Re-exports bot-db helpers + health check
├── core/
│   ├── health.js          Checks both bot DB and MCP DB
│   ├── data.js            Candles, prices, indicators, signals  [bot DB]
│   ├── assets.js          Qualified assets, streaks, outcomes   [bot DB]
│   ├── orders.js          Bot orders + MCP orders + P/L         [bot DB read / mcp DB write]
│   ├── validation.js      Pending signals, validation stats     [bot DB]
│   └── performance.js     Daily records, rolling summary        [bot DB]
└── tools/
    ├── _format.js         jsonResult() helper
    ├── health.js
    ├── data.js
    ├── assets.js
    ├── orders.js
    ├── validation.js
    └── performance.js

data/
└── mcp.db                 Auto-created on first run. Gitignored.
```

## Database Isolation

| Table | Location | Who writes | Who reads |
|---|---|---|---|
| `candles` | bot DB | bot | `po_candles` |
| `prices` | bot DB | bot | `po_prices`, `po_price_history` |
| `indicators` | bot DB | bot | `po_indicators` |
| `signals` | bot DB | bot | `po_signals` |
| `orders_queue` | bot DB | bot | `po_bot_orders` |
| `trades_ordered` | bot DB | bot | `po_trades_ordered`, `po_pnl_summary` |
| `qualification_outcomes` | bot DB | bot | `po_qualification_outcomes`, `po_validation_stats` |
| `qualified_assets` | bot DB | bot | `po_qualified_assets` |
| `asset_streaks` | bot DB | bot | `po_asset_streaks`, `po_streak_leaderboard` |
| `assets_trades` | bot DB | bot | `po_asset_trades` |
| `performance` | bot DB | bot | `po_performance` |
| `mcp_orders` | **MCP DB** | **MCP server** | `po_mcp_orders`, bot execution worker |

The MCP server has **zero write access** to the bot's database.

## Documentation

| Doc | Description |
|---|---|
| [docs/cli.md](docs/cli.md) | Full CLI reference — every command, flag, and jq pattern |
| [docs/outputs.md](docs/outputs.md) | Exact JSON output shape for every tool and command |

## Disclaimer

This tool is for personal use with your own Pocket Option account. It does not bypass any authentication, paywall, or security control. Ensure your usage complies with Pocket Option's Terms of Service. Binary options trading carries significant financial risk — use at your own discretion.
