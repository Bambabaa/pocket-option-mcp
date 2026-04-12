import { healthCheck as dbHealth, DB_PATH } from '../connection.js';
import { MCP_DB_PATH, getMcpDb } from '../mcp-db.js';

export async function healthCheck() {
  const result = await dbHealth();
  const ageSeconds = result.latest_price
    ? Math.floor(Date.now() / 1000) - result.latest_price.timestamp
    : null;

  // Verify MCP DB is accessible (initialises it if first run)
  let mcpDbOk = false;
  let mcpOrderCount = 0;
  try {
    const db = await getMcpDb();
    await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as n FROM mcp_orders', (err, row) => {
        if (err) reject(err);
        else { mcpOrderCount = row?.n ?? 0; resolve(); }
      });
    });
    mcpDbOk = true;
  } catch (e) {
    // non-fatal
  }

  return {
    success: true,
    bot_db_path: DB_PATH,
    bot_db_accessible: result.db_accessible,
    mcp_db_path: MCP_DB_PATH,
    mcp_db_accessible: mcpDbOk,
    mcp_order_count: mcpOrderCount,
    candle_count: result.candle_count,
    price_count: result.price_count,
    signal_count: result.signal_count,
    bot_order_count: result.order_count,
    qualified_asset_count: result.qualified_asset_count,
    latest_price: result.latest_price,
    latest_candle: result.latest_candle,
    latest_price_age_seconds: ageSeconds,
    bot_status: ageSeconds !== null && ageSeconds < 30
      ? 'live — price data is fresh'
      : ageSeconds !== null
        ? `stale — last price ${ageSeconds}s ago (bot may not be running)`
        : 'no price data yet',
  };
}
