# pocket-option-mcp

MCP server that connects Claude to a running `pocket-option-bot.js` instance via SQLite.

## Prerequisites

- `pocket-option-bot.js` must be running (in `bot/pocket-option-bot.js`)
- Bot DB: `data/trading_data.db` (readonly — bot writes, MCP reads)
- MCP DB: `data/mcp.db` (writable — MCP writes orders/blocks/logs, bot reads)
- Session monitor should be running (in `src/scripts/session-monitor.js`) — autonomous block/unblock loop

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
│   ├── pocket-option-bot.js    ← MCP orders worker + isAssetBlocked() guard + stale-feed guards
│   ├── indicators.js           ←   MODE D only — BB width gate live at 10 bps
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
│   ├── tools/                  ← one file per tool group, registers with MCP server
│   └── scripts/
│       └── session-monitor.js  ← autonomous block/unblock monitor (run alongside bot)
├── docs/
│   ├── user-guide.md           ← full tool reference + sample questions + strategy reference
│   └── bb_width_report.md      ← BB gate validation report (135 signals, threshold decision)
└── agents/
    ├── market-scanner.md
    ├── trade-analyst.md
    └── trade-executor.md
```

## MODE D Strategy — STC Reversal Gates (active as of 2026-04-28)

Replaced K Flash Crash / Late Overbought Reversal with STC (Schaff Trend Cycle) reversal strategy.
STC params: (12, 25, 5, 3, 3) — recalibrated 2026-04-28 via `bot/scripts/recalculate-schaff.js`.
Use **120s expiry** — 60s is not statistically viable for either direction.

| Column | Indicator | Role |
|---|---|---|
| `ma1` | MA6 | Fast MA — context |
| `ma3` | MA14 | Slow MA — context |
| `ma2` | MA50 | NOT used in gates |
| `schaff_value` | STC (12,25,5,3,3) | Primary timing signal |
| `stochastic_k_v2` | Stoch K (5,3,3) | Confirmation |
| `stochastic_d_v2` | Stoch D (5,3,3) | Confirmation signal line |
| `rsi_5` | RSI period 5 | Momentum depth gate |
| `bb_upper/lower/middle` | BB (20,2) | Volatility gate |

**STC zone interpretation:**
- ≤ 25 = floor (CALL reversal zone — cycle exhausted to downside)
- ≥ 90 = ceiling (PUT reversal zone — cycle exhausted to upside, validated)
- Rising STC (bar0 > barM1) = cycle turning bullish
- Falling STC (bar0 < barM1) = cycle turning bearish

### CALL — STC Floor Bounce (5 gates) — validated p=0.048, n=61, WR=60.7% at 120s
- g1: schaff_value ≤ 25 (STC at floor)
- g2: schaff_value > prev_schaff (STC curling upward)
- g3: RSI < 30 ← **deeply oversold only (tightened from 40)**
- g4: K > D AND K < 50 (stoch bullish cross, not overbought)
- g5: BB width ≥ 10 bps (not a flat/dead market)

### PUT — STC Ceiling Rollover (5 gates) — validated p=0.024, n=31, WR=67.7% at 120s
- g1: schaff_value ≥ 90 ← **deep overbought only (tightened from 75)**
- g2: schaff_value < prev_schaff (STC rolling downward)
- g3: RSI > 70 ← **deeply overbought only (tightened from 60)**
- g4: K < D AND K > 50 (stoch bearish cross, not oversold)
- g5: BB width ≥ 10 bps (not a flat/dead market)

## Tool Reference (43 tools)

### Health & Market
| Tool | What it does |
|---|---|
| `po_health` | Check both DBs + bot liveness — call first |
| `po_market_state` | Active assets, signal rate, today P/L, top assets |
| `po_tracked_assets` | Assets bot is monitoring |
| `po_prices` | Latest price for one or all assets |

### Market Data
| Tool | What it does |
|---|---|
| `po_candles` | OHLC bars for an asset (use summary=true unless you need individual bars) |
| `po_price_history` | Tick-level prices over a time window |
| `po_indicators` | Latest MA1/2/3, RSI, Bollinger Bands, Stochastic values |
| `po_signals` | CALL/PUT signals from the strategy pipeline (filter by asset or direction) |
| `po_pending_signals` | Signals past expiry that haven't been validated yet |

### Intelligence
| Tool | What it does |
|---|---|
| `po_scan_all` | Score all assets by 7 indicator layers — ranked list |
| `po_recommend` | Ranked trade picks filtered by precision + WR + bias |
| `po_risk_check` | Pre-trade audit → score 0-100 + GOOD/CAUTION/RISKY/AVOID |
| `po_asset_bias` | Per-asset CALL vs PUT WR history, flags flat/AVOID assets |
| `po_asset_volatility` | Rank assets by BB width bps — identify flat assets to block |

### Analysis & Backtesting
| Tool | What it does |
|---|---|
| `po_replay_candles` | Full candle replay — fires STC gates, validates at 60s AND 120s via prices table |
| `po_replay_signal` | Reconstruct all gate values for a specific historical signal |
| `po_find_edge` | Win rate breakdown across 11 dimensions + dual 60s/120s expiry |
| `po_optimize_gates` | Grid search over STC gate thresholds |
| `po_simulate` | Baseline vs modified thresholds side-by-side — test before touching bot |
| `po_significance` | Binomial significance test — p-values, z-scores, Wilson CI, Kelly fraction per slice |

### Asset Controls
| Tool | What it does |
|---|---|
| `po_block_asset` | Block asset — bot skips all orders for it |
| `po_unblock_asset` | Remove active block |
| `po_auto_block_check` | Check all tracked assets for volatility + streak and auto-block bad ones |
| `po_auto_block_sweep` | Unblock assets that were auto-blocked if they now pass conditions |

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

- **STC gates validated 2026-04-28** via binomial significance test (35,302 rows, STC recalibrated to 12,25,5,3,3):
  - CALL 120s: n=61, WR=60.7%, p=0.048 → SIGNIFICANT_95, Kelly=17.9%
  - PUT  120s: n=31, WR=67.7%, p=0.024 → SIGNIFICANT_95, Kelly=32.7%
  - PUT STC 95–100 zone at 120s: n=75, WR=61.3%, p=0.032 → SIGNIFICANT_95
- **60s expiry is not viable** — CALL 60s 46.2% (LOSING), PUT 60s 50.0% (coin flip). Use 120s only.
- **PUT has more edge than CALL** — RSI > 70 + STC ≥ 90 is the highest-quality setup
- **BB < 10 bps = losing zone**: 45.8% WR validated. Gate live at 10 bps.
- **Flat assets (BB < 5 bps) must be identified dynamically** — use `po_auto_block_sweep` at session start.
- **Qualification layer disabled** (`useQualifiedAssetsLayer: false`) — every signal trades
- **`po_significance` tool** — run after accumulating new live trades to track whether edge holds
