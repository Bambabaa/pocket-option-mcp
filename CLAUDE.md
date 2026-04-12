# pocket-option-mcp

MCP server that connects Claude Code to a running `pocket-option-bot.js` instance via SQLite.

## Prerequisites

- `pocket-option-bot.js` must be running (in `../socket_option/determ/`)
- DB is at `../socket_option/determ/data/trading_data.db` by default

## Configure in Claude Code

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "pocket-option": {
      "command": "node",
      "args": ["C:/Users/msonk/Documents/GitHub/pocket-option-mcp/src/server.js"],
      "env": {
        "PO_DB_PATH": "C:/Users/msonk/Documents/GitHub/socket_option/determ/data/trading_data.db"
      }
    }
  }
}
```

## Tool reference (22 tools)

| Tool | What it does |
|---|---|
| `po_health` | Check DB connection + bot liveness — call first |
| `po_tracked_assets` | List all assets bot has data for |
| `po_prices` | Latest price for one or all assets |
| `po_candles` | OHLC bars (use `summary=true`) |
| `po_price_history` | Tick prices over a time range |
| `po_indicators` | MA/RSI/BB/Stochastic/Keltner/Schaff values |
| `po_signals` | CALL/PUT signals from KT strategy |
| `po_pending_signals` | Signals past expiry, not yet validated |
| `po_trade` | **Enqueue a manual CALL/PUT trade** |
| `po_cancel_order` | Cancel a PENDING order |
| `po_orders` | View execution queue |
| `po_trades_ordered` | Executed live trades with results |
| `po_pnl_summary` | P/L by asset |
| `po_rolling_summary` | Rolling win rate + P/L (`days=0` = all-time) |
| `po_performance` | Daily performance table |
| `po_hourly_breakdown` | P/L by hour of day |
| `po_qualified_assets` | Bot's trading allow-list |
| `po_asset_streaks` | Consecutive win streaks |
| `po_streak_leaderboard` | Rank assets by streak |
| `po_qualification_outcomes` | Full signal validation history |
| `po_asset_trades` | Outcomes for qualified assets only |
| `po_validation_stats` | Aggregate win rate from validation |

## Architecture

```
Claude Code <--> pocket-option-mcp (MCP stdio)
                      |
              SQLite read (readonly)     SQLite write (enqueue/cancel)
                      |                         |
              trading_data.db  <----  pocket-option-bot.js (running)
                                            |
                                    Puppeteer → pocketoption.com
```

`po_trade` writes to `orders_queue` with status `PENDING`.
The bot's execution worker picks it up, places the DOM click, updates status to `EXECUTED`.
Result sync later updates `trades_ordered` with `WIN`/`LOSS`.
