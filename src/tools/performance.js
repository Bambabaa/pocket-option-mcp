import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/performance.js';

export function registerPerformanceTools(server) {
  server.tool(
    'po_performance',
    'Get daily performance records from the performance table.',
    {
      days: z.coerce.number().min(1).max(365).optional().default(30).describe('Number of days to return (default 30)'),
    },
    async ({ days }) => {
      try { return jsonResult(core.getDailyPerformance(days)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_rolling_summary',
    'Get a rolling P/L and win rate summary computed directly from trades_ordered. More up-to-date than the performance table.',
    {
      days: z.coerce.number().min(0).max(365).optional().default(7).describe('Look-back window in days (0 = all time)'),
    },
    async ({ days }) => {
      try { return jsonResult(core.getRollingSummary(days)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_hourly_breakdown',
    'Get trade distribution by hour (UTC). Shows which hours of day have the most trades and best P/L.',
    {},
    async () => {
      try { return jsonResult(core.getHourlyBreakdown()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
