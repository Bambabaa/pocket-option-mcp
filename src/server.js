import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerDataTools } from './tools/data.js';
import { registerAssetTools } from './tools/assets.js';
import { registerOrderTools } from './tools/orders.js';
import { registerValidationTools } from './tools/validation.js';
import { registerPerformanceTools } from './tools/performance.js';
import { registerIntelligenceTools } from './tools/intelligence.js';
import { registerAnalysisTools } from './tools/analysis.js';
import { registerAgentTools } from './tools/agent-tools.js';

const server = new McpServer(
  {
    name: 'pocket-option-mcp',
    version: '1.0.0',
    description: 'MCP server for Pocket Option trading bot — read live data, enqueue trades, analyze performance',
  },
  {
    instructions: `Pocket Option MCP — 39 tools for reading, analyzing, and controlling a live Pocket Option trading bot.

DATABASE MODEL:
- Bot DB (readonly): candles, prices, indicators, signals, orders_queue, trades_ordered, qualification data
- MCP DB (writable): mcp_orders — manual trades Claude enqueues, separate from bot-generated signals

IMPORTANT: The bot (pocket-option-bot.js) must be running for live data. Use po_health first to confirm.

TOOL SELECTION GUIDE:

Starting out:
- po_health → check both DBs and whether bot is live (call first, always)
- po_market_state → overall market health: active assets, signal rate, today's P/L, top assets
- po_tracked_assets → see which assets the bot is monitoring
- po_prices → get current price for one or all assets

Intelligence (agentic — one call replaces many):
- po_scan_all → scan ALL assets at once: price, signal, streak, win rate, score — ranked
- po_recommend → "what should I trade right now?" — ranked list with confidence scores
- po_risk_check → "is this trade safe?" — checks qualification, streak, recent performance

Analysis & Backtesting (AI research — find the edge):
- po_replay_signal → reconstruct ALL gate values for a historical signal (RSI, K crash, MA gaps, etc.)
- po_find_edge → analyze ALL historical trades: win rate by RSI range, stoch range, MA gap, hour, asset, direction
- po_optimize_gates → grid search: what RSI/K-crash/D thresholds would produce the best win rate?
- po_simulate → replay historical candles with custom MODE D params — "what if I used RSI < 35 instead of 40?"

Reading market data:
- po_candles → OHLC bars. Use summary=true unless you need individual bars
- po_price_history → tick-level prices over a time window
- po_indicators → latest MA1/2/3, RSI, Bollinger Bands, Stochastic, Keltner, Schaff values

Reading signals:
- po_signals → CALL/PUT signals from the KT strategy pipeline (filter by asset or direction)
- po_pending_signals → signals past expiry that haven't been validated yet

Placing trades (requires bot running with execution.enabled=true):
- po_trade → enqueue a manual CALL or PUT into MCP DB — bot picks it up and clicks Pocket Option
- po_cancel_order → cancel a PENDING manual order (MCP DB only, does not touch bot DB)
- po_mcp_orders → view manual orders you placed via po_trade
- po_bot_orders → view bot-generated execution queue from bot DB (readonly)

Results and performance:
- po_trades_ordered → executed live trades with WIN/LOSS results (bot DB)
- po_pnl_summary → P/L breakdown by asset
- po_rolling_summary → rolling win rate and P/L (pass days=0 for all-time)
- po_performance → daily performance table
- po_hourly_breakdown → which hours of day are most profitable

Qualification layer:
- po_qualified_assets → assets currently on the bot's trading allow-list
- po_asset_streaks → current win streak per asset
- po_streak_leaderboard → rank assets by consecutive wins
- po_signal_outcomes → signal validation history (entry/exit price, WIN/LOSS)
- po_asset_trades → trade outcomes for qualified assets only
- po_validation_stats → aggregate win rate from validation history

Multi-agent system (autonomous trading pipeline):
- /auto-trade skill → spawns Scanner → Analyst → Executor agents in sequence
- po_signal_context → full indicator + candle + signal snapshot for one asset (one call, for Analyst agent)
- po_drawdown_check → session safety gate: today P/L, consecutive losses, bot liveness (for Executor agent)
- po_session_log_write → agent writes a decision to the audit trail (scanner/analyst/executor/orchestrator)
- po_session_log_read → read the full agent decision history — what was scanned, approved, placed, blocked
- po_asset_bias → per-asset CALL vs PUT win rate history — shows preferred direction, BLOCK_RECOMMENDED for flat assets, AVOID for consistent losers
- po_block_asset → block an asset from being traded (writes to asset_controls; bot checks before every order)
- po_unblock_asset → remove an active block so the bot can trade that asset again
- po_asset_volatility → rank all assets by BB width bps — find flat/pegged assets to block, identify best setups

CONTEXT TIPS:
- Always call po_health first to confirm the bot is running
- Use po_scan_all instead of calling po_prices + po_signals + po_asset_streaks individually
- Use po_recommend to get ranked trade suggestions before manually placing trades
- Use po_risk_check before po_trade to avoid bad entries
- Use po_find_edge to discover what conditions produce the best win rates
- Use po_optimize_gates to find better gate thresholds than the current defaults
- Use summary=true on po_candles to save context
- po_rolling_summary days=0 gives all-time stats
- po_trade writes to MCP DB only — bot DB is never modified by this server`,
  }
);

registerHealthTools(server);
registerDataTools(server);
registerAssetTools(server);
registerOrderTools(server);
registerValidationTools(server);
registerPerformanceTools(server);
registerIntelligenceTools(server);
registerAnalysisTools(server);
registerAgentTools(server);

process.stderr.write('pocket-option-mcp | Connects to pocket-option-bot.js via SQLite.\n');
process.stderr.write(`Bot DB: ${process.env.PO_DB_PATH || 'data/trading_data.db (default)'}\n\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
