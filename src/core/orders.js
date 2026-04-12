/**
 * Orders core.
 *
 * READS:  bot DB (readonly) — orders_queue, trades_ordered, P/L history
 * WRITES: MCP DB only       — mcp_orders table (manual trades enqueued via po_trade)
 *
 * The bot's pocket-option-bot.js reads mcp_orders (PENDING rows) on its execution
 * cycle and updates status to EXECUTED/FAILED/SKIPPED after placing the DOM click.
 */

import { all, get } from '../connection.js';
import { mcpRun, mcpGet, mcpAll, MCP_DB_PATH } from '../mcp-db.js';

// ─── Bot DB reads ────────────────────────────────────────────────────────────

export async function getOrders(status = null, limit = 50) {
  let sql = 'SELECT * FROM orders_queue WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  return { source: 'bot_db', count: rows.length, orders: rows };
}

export async function getTradesOrdered(asset = null, result = null, limit = 50) {
  let sql = 'SELECT * FROM trades_ordered WHERE 1=1';
  const params = [];
  if (asset)  { sql += ' AND asset = ?';  params.push(asset); }
  if (result) { sql += ' AND result = ?'; params.push(result); }
  sql += ' ORDER BY entry_timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  const wins   = rows.filter(r => r.result === 'WIN').length;
  const losses = rows.filter(r => r.result === 'LOSS').length;
  const totalPL = rows.reduce((acc, r) => acc + (r.profit_loss || 0), 0);

  return {
    count: rows.length,
    wins,
    losses,
    win_rate: rows.length ? ((wins / rows.length) * 100).toFixed(1) + '%' : 'N/A',
    total_profit_loss: parseFloat(totalPL.toFixed(2)),
    trades: rows,
  };
}

export async function getPnlSummary() {
  const rows = await all(
    `SELECT asset,
            COUNT(*) as total_trades,
            SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
            ROUND(SUM(profit_loss), 2) as total_pnl,
            ROUND(AVG(profit_loss), 2) as avg_pnl
     FROM trades_ordered
     WHERE result IN ('WIN','LOSS','DRAW')
     GROUP BY asset
     ORDER BY total_pnl DESC`
  );
  const totals = await get(
    `SELECT COUNT(*) as total_trades,
            SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
            ROUND(SUM(profit_loss), 2) as total_pnl
     FROM trades_ordered WHERE result IN ('WIN','LOSS','DRAW')`
  );
  return { summary: totals, by_asset: rows };
}

// ─── MCP DB writes ────────────────────────────────────────────────────────────

/**
 * Enqueue a manual trade into the MCP's own mcp_orders table.
 * The bot's execution worker reads this table (PENDING rows) and places the DOM click.
 *
 * Nothing is written to the bot's DB.
 */
export async function enqueueManualTrade(asset, direction, signalTimestamp, amount = null) {
  if (direction !== 'CALL' && direction !== 'PUT') {
    throw new Error(`direction must be CALL or PUT, got: ${direction}`);
  }

  const result = await mcpRun(
    `INSERT INTO mcp_orders (asset, direction, amount, signal_ts, status)
     VALUES (?, ?, ?, ?, 'PENDING')`,
    [asset, direction, amount, signalTimestamp]
  );

  return {
    success: true,
    order_id: result.lastID,
    asset,
    direction,
    amount,
    signal_timestamp: signalTimestamp,
    status: 'PENDING',
    mcp_db: MCP_DB_PATH,
    note: 'Order written to MCP DB — bot execution worker will place this trade on next cycle',
  };
}

/**
 * Cancel a PENDING manual order in the MCP DB.
 */
export async function cancelOrder(orderId) {
  const row = await mcpGet('SELECT * FROM mcp_orders WHERE id = ?', [orderId]);
  if (!row) throw new Error(`MCP order ${orderId} not found`);
  if (row.status !== 'PENDING') {
    return { success: false, error: `Cannot cancel order in status: ${row.status}` };
  }
  await mcpRun(
    `UPDATE mcp_orders
     SET status='CANCELLED', status_reason='cancelled-via-mcp',
         updated_at=strftime('%s','now')
     WHERE id = ?`,
    [orderId]
  );
  return { success: true, order_id: orderId, new_status: 'CANCELLED' };
}

/**
 * Get manual orders from the MCP DB.
 */
export async function getMcpOrders(status = null, limit = 50) {
  let sql = 'SELECT * FROM mcp_orders WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = await mcpAll(sql, params);
  return { source: 'mcp_db', count: rows.length, orders: rows };
}
