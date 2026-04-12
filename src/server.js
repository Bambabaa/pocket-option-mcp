import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health.js';
import { registerDataTools } from './tools/data.js';
import { registerAssetTools } from './tools/assets.js';
import { registerOrderTools } from './tools/orders.js';
import { registerValidationTools } from './tools/validation.js';
import { registerPerformanceTools } from './tools/performance.js';
import { registerIntelligenceTools } from './tools/intelligence.js';

const server = new McpServer(
  {
    name: 'pocket-option-mcp',
    version: '1.0.0',
    description: 'MCP server for Pocket Option trading bot — read live data, enqueue trades, analyze performance',
  },
  {
    instructions: `Pocket Option MCP — 27 tools for reading and controlling a live Pocket Option trading bot.

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
- po_qualification_outcomes → full signal validation history
- po_asset_trades → trade outcomes for qualified assets only
- po_validation_stats → aggregate win rate from validation history

CONTEXT TIPS:
- Always call po_health first to confirm the bot is running
- Use po_scan_all instead of calling po_prices + po_signals + po_asset_streaks individually
- Use po_recommend to get ranked trade suggestions before manually placing trades
- Use po_risk_check before po_trade to avoid bad entries
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

process.stderr.write('pocket-option-mcp | Connects to pocket-option-bot.js via SQLite.\n');
process.stderr.write(`Bot DB: ${process.env.PO_DB_PATH || 'data/trading_data.db (default)'}\n\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
