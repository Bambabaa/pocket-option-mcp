# pocket-option-mcp

MCP server that connects Claude to a running `pocket-option-bot.js` instance via SQLite.

## Prerequisites

- `pocket-option-bot.js` must be running (in `bot/pocket-option-bot.js`)
- Bot DB: `data/trading_data.db` (readonly — bot writes, MCP reads)
- MCP DB: `data/mcp.db` (writable — MCP writes orders/blocks/logs, bot reads)

## Configure in Claude Code

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "pocket-option": {
      "command": "node",
      "args": ["C:/Users/msonk/Documents/GitHub/pocket-option-mcp/src/server.js"],
      "env": {
        "PO_DB_PATH": "C:/Users/msonk/Documents/GitHub/pocket-option-mcp/data/trading_data.db"
      }
    }
  }
}
```

## Critical Rules

- **NEVER write to `socket_option/determ/`** — read-only source. All bot modifications go in `pocket-option-mcp/bot/`
- **No Python** — corrupts SQLite when conflicting with the JS process. Use sqlite3 CLI only.
- **Always validate with `po_simulate` before changing live gates** — data-first, then sync to `bot/indicators.js`
- **MA50 is NOT used in MODE D decision logic** — only MA6 (`ma1`) and MA14 (`ma3`)
- **Use stochastic_k_v2 / stochastic_d_v2** — NOT stochastic_k / stochastic_d (video1)

## Architecture

```
Claude (MCP client)
       │
pocket-option-mcp (MCP stdio server — src/server.js)
       │
       ├── SQLite READONLY  →  data/trading_data.db  ←  bot writes candles/signals/trades
       └── SQLite WRITABLE  →  data/mcp.db           ←  MCP writes orders/blocks/agent logs
                                                              ↑
                                                      bot reads before executing
```

## File Layout

```
pocket-option-mcp/
├── bot/                        ← COPY of determ scripts — ALL modifications go here
│   ├── pocket-option-bot.js    ← MCP orders worker + isAssetBlocked() guard
│   ├── indicators.js           ← video2 MODE D only — BB width gate live at 10 bps
│   ├── database.js
│   └── scripts/
│       ├── order-executor.js
│       └── validate-signals.js
├── data/
│   ├── trading_data.db         ← bot writes (READONLY to MCP)
│   └── mcp.db                  ← MCP writes (orders, blocks, agent logs)
├── src/
│   ├── server.js               ← 40 tools registered
│   ├── connection.js           ← dual-DB: bot-db (READONLY) + mcp-db (writable)
│   ├── core/
│   │   ├── intelligence.js     ← scan_all, recommend, risk_check, market_state, asset_bias
│   │   ├── analysis.js         ← replay_candles, find_edge, optimize_gates, simulate_gates
│   │   ├── agent-tools.js      ← signal_context, drawdown_check, session_log, block/unblock, volatility
│   │   ├── performance.js
│   │   ├── health.js
│   │   ├── data.js
│   │   ├── orders.js
│   │   ├── assets.js
│   │   └── validation.js
│   └── tools/                  ← one file per tool group, registers with MCP server
├── docs/
│   ├── user-guide.md           ← full tool reference + sample questions + strategy reference
│   └── bb_width_report.md      ← BB gate validation report (135 signals, threshold decision)
└── agents/
    ├── market-scanner.md
    ├── trade-analyst.md
    └── trade-executor.md
```

## MODE D Strategy — Indicator Mapping

Only active strategy. Modes A, B, C disabled (`if (false)`).

| Column | Indicator | Role |
|---|---|---|
| `ma1` | MA6 | Fast — early trend catch |
| `ma3` | MA14 | Slow — trend confirmation |
| `ma2` | MA50 | NOT used in MODE D gates |
| `stochastic_k_v2` | Stoch K (5,3,3) | Video2 stochastic |
| `stochastic_d_v2` | Stoch D (5,3,3) | Video2 stochastic signal line |
| `rsi_5` | RSI period 5 | Momentum |
| `bb_upper/lower/middle` | BB (20,2) | Width gate + price position |

**maTrendBps = (ma1 - ma3) / ma3 × 10000**
Positive = MA6 above MA14 = uptrend. Negative = downtrend.

**BB width bps = (bb_upper - bb_lower) / bb_middle × 10000**
< 10 bps = flat/dead market = losing zone (45.8% WR validated on 135 signals).

### CALL — K Flash Crash Bounce (7 gates)
- g1: ma1 < ma3
- g2: K_prev − K_curr > 25
- g3: K_curr < 25
- g4: K_prev >= 50
- g5: RSI < 40
- g6: maTrendBps > −20
- g7: BB width >= 10 bps ← **validated gate, live in bot**

### PUT — Late Overbought Reversal (8 gates)
- g1: RSI[−2] > 70, RSI[−1] > 70, exclude [75,80)
- g2: RSI falling, in [38,70), exclude [55,65), velocity > −12, close >= BB mid
- g3: K_prev > 65, K falling, K_curr in [55,80)
- g4: D_curr >= 80
- g5: ma1 > ma3
- g6: K−D spread < −3
- g7: maTrendBps < 20
- g8: BB width >= 10 bps ← **validated gate, live in bot**

## Tool Reference (40 tools)

### Health & Market
| Tool | What it does |
|---|---|
| `po_health` | Check both DBs + bot liveness — call first |
| `po_market_state` | Active assets, signal rate, today P/L, top assets |
| `po_tracked_assets` | Assets bot is monitoring |
| `po_prices` | Latest price for one or all assets |

### Intelligence
| Tool | What it does |
|---|---|
| `po_scan_all` | Score all assets by 7 indicator layers — ranked list |
| `po_recommend` | Ranked trade picks filtered by precision + WR + bias |
| `po_risk_check` | Pre-trade audit → score 0-100 + GOOD/CAUTION/RISKY/AVOID |
| `po_market_state` | Overall market health snapshot |
| `po_asset_bias` | Per-asset CALL vs PUT WR history, flags flat/AVOID assets |
| `po_asset_volatility` | Rank assets by BB width bps — identify flat assets to block |

### Analysis & Backtesting
| Tool | What it does |
|---|---|
| `po_replay_candles` | Full candle replay — fires all MODE D signals, validates vs next bar |
| `po_replay_signal` | Reconstruct all gate values for a specific historical signal |
| `po_find_edge` | Win rate breakdown across 11 dimensions including retracement context |
| `po_optimize_gates` | Grid search over gate thresholds |
| `po_simulate` | Baseline vs modified thresholds side-by-side — test before touching bot |

### Asset Controls
| Tool | What it does |
|---|---|
| `po_block_asset` | Block asset — bot skips all orders for it |
| `po_unblock_asset` | Remove active block |

### Trading
| Tool | What it does |
|---|---|
| `po_trade` | Enqueue manual CALL/PUT → mcp.db → bot executes |
| `po_cancel_order` | Cancel PENDING manual order |
| `po_mcp_orders` | View manual orders placed via po_trade |
| `po_bot_orders` | View bot-generated execution queue (readonly) |

### Performance
| Tool | What it does |
|---|---|
| `po_trades_ordered` | Executed trades with WIN/LOSS results |
| `po_pnl_summary` | P/L by asset |
| `po_rolling_summary` | Rolling WR + P/L (days=0 = all-time) |
| `po_performance` | Daily performance table |
| `po_hourly_breakdown` | P/L by hour of day |

### Multi-Agent
| Tool | What it does |
|---|---|
| `po_signal_context` | Full 4-bar snapshot for Analyst agent |
| `po_drawdown_check` | GO/PAUSE/STOP verdict for Executor agent |
| `po_session_log_write` | Write agent decision to audit trail |
| `po_session_log_read` | Read full agent decision history |

### Qualification
| Tool | What it does |
|---|---|
| `po_qualified_assets` | Bot trading allow-list |
| `po_asset_streaks` | Win streak per asset |
| `po_streak_leaderboard` | Assets ranked by streak |
| `po_signal_outcomes` | Signal validation history |
| `po_asset_trades` | Outcomes for qualified assets |
| `po_validation_stats` | Aggregate WR from validation |

## Research Workflow

```
1. po_health                        → confirm bot is live
2. po_asset_bias                    → check directional edge per asset
3. po_asset_volatility              → identify flat assets to block
4. po_block_asset [flat assets]     → remove noise
5. po_replay_candles                → full historical replay with context
6. po_find_edge                     → analyse all 11 dimensions
7. po_simulate [param changes]      → test gate changes before touching bot
8. po_optimize_gates                → grid search for best thresholds
9. → sync validated threshold to bot/indicators.js
10. po_recommend                    → live trade suggestions
11. po_risk_check asset direction   → confirm before placing
12. po_trade asset direction amount → place trade
```

## Known Validated Facts

- **BB < 10 bps = losing zone**: 45.8% WR, -$3,580 P&L on 135 signals. Gate live in bot at 10 bps.
- **8 flat assets to block** (BB < 5 bps): EURTRY, JODCNY, USDCNH, USDPHP, USDTHB, SARCNY, BHDCNY, USDRUB
- **Qualification layer disabled** (`useQualifiedAssetsLayer: false`) — every signal trades
- **PUT has more edge than CALL**: PUT 59.8% WR vs CALL 42.1% WR baseline
- **Signal reasons string** contains exact pattern label + gate values — used by `parsePatternFromReasons()` to identify all 4 patterns
