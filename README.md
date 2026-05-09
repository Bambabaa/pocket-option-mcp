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
- `pocket-option-bot.js`
- A valid Pocket Option account (the bot handles browser login)

## Installation

```bash
git clone https://github.com/bambabaa/pocket-option-mcp
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
po_signals                                     # recent CALL/PUT signals from 8GSR strategy
po_rolling_summary days=0                      # all-time P/L
po_trade asset=EURUSD_otc direction=PUT        # enqueue a manual trade
po_mcp_orders                                  # check your manual order status
```

## Tools (47)

### Health & Market State

| Tool | Description |
|---|---|
| `po_health` | Check both DBs (bot + MCP) and bot liveness. **Call this first.** |
| `po_market_state` | Active assets, signal rate, today P/L, top assets |
| `po_tracked_assets` | List all assets the bot has candle data for |
| `po_prices` | Latest price for one asset, or all assets if omitted |

### Market Data *(reads bot DB — readonly)*

| Tool | Description |
|---|---|
| `po_candles` | OHLC bars. Use `summary=true` for compact view. |
| `po_price_history` | Tick-level price history over a time window |
| `po_indicators` | Latest MA6/14, RSI-5, BB, Stochastic K/D v2, Keltner, Schaff values |
| `po_signals` | CALL/PUT signals from the 8GSR pipeline (STC_CALL_8GSR / STC_PUT_8GSR) |
| `po_pending_signals` | Signals past expiry with no validation outcome yet |

### Intelligence — Agentic One-Call Tools

| Tool | Description |
|---|---|
| `po_scan_all` | Score all assets by indicator alignment — price, signal, streak, WR, ranked |
| `po_recommend` | "What should I trade?" — ranked picks filtered by precision + WR + bias |
| `po_risk_check` | Pre-trade audit → score 0-100 + GOOD/CAUTION/RISKY/AVOID |
| `po_asset_bias` | Per-asset CALL vs PUT WR history. Flags preferred direction and flat assets. |
| `po_asset_volatility` | Rank assets by BB width bps — find flat/pegged assets to block |

### Analysis & Backtesting

| Tool | Description |
|---|---|
| `po_replay_candles` | Full candle replay — fires 8GSR gates bar-by-bar, validates at 60s AND 120s |
| `po_replay_signal` | Reconstruct all gate values for a specific historical signal |
| `po_find_edge` | Win rate breakdown across 17 dimensions + z_score/p_value/wilson_95ci + cross-validation |
| `po_simulate` | A/B test: baseline vs modified thresholds side-by-side |
| `po_grid_search` | Multivariate search: tests all parameter combinations, ranked by 120s WR |
| `po_walk_forward` | Rolling N-fold WR validation — STABLE/MODERATE/UNSTABLE verdict across time |
| `po_score_calibration` | Maps coincidence score (0-5) → actual WR → Kelly sizing multiplier |
| `po_loss_attribution` | Per-gate margin analysis on losses — identifies the leaky gate |
| `po_gate_interaction` | 2D WR heatmap for any two dimensions — finds winning combinations |
| `po_optimize_gates` | Legacy single-parameter grid search |
| `po_significance` | Binomial test + Wilson CI + Kelly fraction per slice |

### Trade Execution

| Tool | Description | DB |
|---|---|---|
| `po_trade` | Enqueue a manual CALL or PUT. Bot picks it up on its next cycle. | writes MCP DB |
| `po_cancel_order` | Cancel a PENDING manual order before it executes | writes MCP DB |
| `po_mcp_orders` | View manual orders placed via `po_trade` | reads MCP DB |
| `po_bot_orders` | View bot-generated execution queue | reads bot DB |

### Results & Performance *(reads bot DB — readonly)*

| Tool | Description |
|---|---|
| `po_trades_ordered` | Executed live trades with WIN/LOSS results |
| `po_pnl_summary` | P/L breakdown by asset |
| `po_rolling_summary` | Win rate + P/L. `days=0` = all-time. |
| `po_performance` | Daily performance table |
| `po_hourly_breakdown` | Trade distribution and P/L by hour of day (descriptive — OTC has no sessions) |

### Asset Analytics

| Tool | Description |
|---|---|
| `po_asset_analytics` | What drives wins/losses per asset: STC zone, RSI, direction, BB width breakdown |
| `po_asset_streaks` | Current win/loss streak per asset |
| `po_streak_leaderboard` | Rank assets by consecutive wins |
| `po_signal_outcomes` | Signal validation history — entry/exit price, WIN/LOSS |
| `po_asset_trades` | Trade outcomes per asset |
| `po_validation_stats` | Aggregate win rate from validation history |

### Asset Controls

| Tool | Description |
|---|---|
| `po_block_asset` | Block an asset — bot skips all orders for it |
| `po_unblock_asset` | Remove an active block |
| `po_auto_block_sweep` | Block all assets with current BB < 5 bps at session start |
| `po_auto_block_check` | Check one asset for auto-block conditions |

### Multi-Agent Pipeline

| Tool | Description |
|---|---|
| `po_signal_context` | Full 4-bar indicator + candle + signal snapshot (for Analyst agent) |
| `po_drawdown_check` | GO/PAUSE/STOP verdict: today P/L, consecutive losses, bot liveness |
| `po_session_log_write` | Write an agent decision to the audit trail |
| `po_session_log_read` | Read full agent decision history |

## Architecture

```
src/
├── server.js              MCP server entry point — 43 tools registered
├── connection.js          Dual-DB: bot-db (READONLY) + mcp-db (writable)
├── core/
│   ├── health.js          Check both DBs + bot liveness
│   ├── data.js            Candles, prices, indicators, signals
│   ├── analysis.js        Replay engine, find_edge, simulate, grid_search
│   ├── intelligence.js    scan_all, recommend, risk_check, asset_bias
│   ├── agent-tools.js     signal_context, drawdown_check, session_log, blocks
│   ├── orders.js          Bot orders + MCP orders + P/L
│   ├── performance.js     Daily records, rolling summary
│   ├── assets.js          Asset analytics, streaks, outcomes
│   └── validation.js      Pending signals, validation stats
└── tools/                 One file per tool group

data/
├── trading_data.db        Bot writes (READONLY to MCP)
└── mcp.db                 MCP writes — orders, blocks, agent logs
```

## Database Isolation

| Table | Location | Who writes | Who reads |
|---|---|---|---|
| `candles` | bot DB | bot | `po_candles` |
| `prices` | bot DB | bot | `po_prices`, `po_price_history`, replay engine |
| `indicators` | bot DB | bot | `po_indicators`, replay engine |
| `signals` | bot DB | bot | `po_signals` |
| `orders_queue` | bot DB | bot | `po_bot_orders` |
| `trades_ordered` | bot DB | bot | `po_trades_ordered`, `po_pnl_summary` |
| `mcp_orders` | **MCP DB** | **MCP server** | `po_mcp_orders`, bot execution worker |
| `asset_controls` | **MCP DB** | **MCP server** | bot (checks before every order) |
| `session_log` | **MCP DB** | **MCP server** | `po_session_log_read` |

The MCP server has **zero write access** to the bot's database.

## Documentation

| Doc | Description |
|---|---|
| [docs/cli.md](docs/cli.md) | Full CLI reference — every command, flag, and jq pattern |
| [docs/outputs.md](docs/outputs.md) | Exact JSON output shape for every tool and command |

## Disclaimer

This tool is for personal use with your own Pocket Option account. It does not bypass any authentication, paywall, or security control. Ensure your usage complies with Pocket Option's Terms of Service. Binary options trading carries significant financial risk — use at your own discretion.
