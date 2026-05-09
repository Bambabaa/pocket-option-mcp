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



**STC zone interpretation:**
- ≤ 25 = floor (CALL reversal zone — cycle exhausted to downside)
- ≥ 90 = ceiling (PUT reversal zone — cycle exhausted to upside, validated)
- Rising STC (bar0 > barM1) = cycle turning bullish
- Falling STC (bar0 < barM1) = cycle turning bearish

### CALL — STC Floor Bounce (7 gates)
- g1: schaff_value ≤ 25 (STC at floor)
- g2: schaff_value > prev_schaff (STC curling upward)
- g3: RSI < 30 (deeply oversold only)
- g4: K > D AND K < 50 (stoch bullish cross, not overbought)
- g5: BB width ≥ 10 bps (not a flat/dead market)
- g6: bb_expanding = true ← reversal only valid when volatility is releasing
- g7: ma_gap_trend ≠ narrowing ← trend momentum must be intact

### PUT — STC Ceiling Rollover (6 gates)
- g1: schaff_value ≥ 90 (deep overbought only)
- g2: schaff_value < prev_schaff (STC rolling downward)
- g3: RSI > 70 (deeply overbought only)
- g4: K < D AND K > 50 (stoch bearish cross, not oversold)
- g5: BB width ≥ 10 bps (not a flat/dead market)
- g6: ma_gap_trend ≠ narrowing ← bb_expanding not added (shrinks n too much)

## Tool Reference

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
| `po_find_edge` | Win rate breakdown across 17 dimensions + dual 60s/120s expiry + cross-validation |
| `po_optimize_gates` | Grid search over STC gate thresholds |
| `po_simulate` | Baseline vs modified thresholds side-by-side — test before touching bot |
| `po_grid_search` | Multivariate grid search — tests all parameter combinations, ranked by 120s WR |
| `po_walk_forward` | Rolling N-fold WR validation — STABLE/MODERATE/UNSTABLE verdict across time |
| `po_score_calibration` | Maps coincidence score (0-5) → WR → Kelly sizing multiplier |
| `po_loss_attribution` | Per-gate margin analysis on losses — identifies the leaky gate |
| `po_gate_interaction` | 2D WR heatmap for any two dimensions — finds winning combinations |
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

### Validation
| Tool | What it does |
|---|---|
| `po_signal_outcomes` | Signal validation history |
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

