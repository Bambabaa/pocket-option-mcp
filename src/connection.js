/**
 * connection.js — re-exports bot-db helpers for backward compatibility.
 * All core modules (data, assets, validation, performance, health) import from here.
 *
 * Bot DB = READONLY  (bot-db.js)
 * MCP DB = writable  (mcp-db.js)  — used only by core/orders.js
 */

export { all, get, BOT_DB_PATH as DB_PATH } from './bot-db.js';

import { all, get, BOT_DB_PATH } from './bot-db.js';

export async function healthCheck() {
  const candles  = await get('SELECT COUNT(*) as n FROM candles');
  const prices   = await get('SELECT COUNT(*) as n FROM prices');
  const signals  = await get('SELECT COUNT(*) as n FROM signals');
  const orders   = await get('SELECT COUNT(*) as n FROM orders_queue');
  const qualified = await get('SELECT COUNT(*) as n FROM qualified_assets');
  const latestPrice  = await get('SELECT asset, price, timestamp FROM prices ORDER BY timestamp DESC LIMIT 1');
  const latestCandle = await get('SELECT asset, timestamp FROM candles ORDER BY timestamp DESC LIMIT 1');

  return {
    bot_db_path: BOT_DB_PATH,
    db_accessible: true,
    candle_count:   candles?.n  ?? 0,
    price_count:    prices?.n   ?? 0,
    signal_count:   signals?.n  ?? 0,
    order_count:    orders?.n   ?? 0,
    qualified_asset_count: qualified?.n ?? 0,
    latest_price:  latestPrice  || null,
    latest_candle: latestCandle || null,
  };
}
