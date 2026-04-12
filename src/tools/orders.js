import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/orders.js';

export function registerOrderTools(server) {
  server.tool(
    'po_bot_orders',
    'Get orders from the bot\'s execution queue (bot DB, readonly). Filter by status to see pending, executed, failed, or skipped bot-generated orders.',
    {
      status: z.enum(['PENDING', 'EXECUTED', 'SKIPPED', 'FAILED']).optional().describe('Filter by status (omit for all)'),
      limit: z.coerce.number().min(1).max(200).optional().default(50),
    },
    async ({ status, limit }) => {
      try { return jsonResult(await core.getOrders(status || null, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_mcp_orders',
    'Get manual orders enqueued via po_trade (MCP\'s own DB). These are orders Claude placed, separate from bot-generated signals.',
    {
      status: z.enum(['PENDING', 'EXECUTED', 'SKIPPED', 'FAILED', 'CANCELLED']).optional().describe('Filter by status (omit for all)'),
      limit: z.coerce.number().min(1).max(200).optional().default(50),
    },
    async ({ status, limit }) => {
      try { return jsonResult(await core.getMcpOrders(status || null, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_trades_ordered',
    'Get executed live trades with WIN/LOSS/DRAW results from the bot\'s trades_ordered table. Includes P/L summary.',
    {
      asset: z.string().optional().describe('Filter by asset'),
      result: z.enum(['WIN', 'LOSS', 'DRAW', 'STUB']).optional().describe('Filter by result'),
      limit: z.coerce.number().min(1).max(500).optional().default(50),
    },
    async ({ asset, result, limit }) => {
      try { return jsonResult(await core.getTradesOrdered(asset || null, result || null, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_pnl_summary',
    'Get profit/loss summary broken down by asset from the bot\'s trades_ordered table.',
    {},
    async () => {
      try { return jsonResult(await core.getPnlSummary()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_trade',
    'Enqueue a manual CALL or PUT trade into the MCP\'s own database. The bot\'s execution worker reads this and places the order on Pocket Option. Nothing is written to the bot\'s DB.',
    {
      asset: z.string().describe('Asset symbol, e.g. EURUSD_otc'),
      direction: z.enum(['CALL', 'PUT']).describe('Trade direction'),
      amount: z.coerce.number().positive().optional().describe('Trade amount in USD (bot uses its configured amount if omitted)'),
      signal_timestamp: z.coerce.number().optional().describe('Signal timestamp unix seconds (defaults to now)'),
    },
    async ({ asset, direction, amount, signal_timestamp }) => {
      try {
        const ts = signal_timestamp || Math.floor(Date.now() / 1000);
        return jsonResult(await core.enqueueManualTrade(asset, direction, ts, amount || null));
      }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_cancel_order',
    'Cancel a PENDING manual order (from MCP DB) before the bot executes it.',
    {
      order_id: z.coerce.number().describe('Order ID from po_mcp_orders'),
    },
    async ({ order_id }) => {
      try { return jsonResult(await core.cancelOrder(order_id)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
