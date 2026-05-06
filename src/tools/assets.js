import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/assets.js';

export function registerAssetTools(server) {
  server.tool(
    'po_asset_analytics',
    'Analyse what drives wins and losses for an asset. Returns win rate by direction, STC zone (floor/ceiling/middle), RSI zone (oversold/neutral/overbought), BB width zone, and hour of day. Omit asset for a leaderboard across all assets.',
    {
      asset: z.string().optional().describe('Asset symbol (omit for all-asset leaderboard)'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.getAssetAnalytics(asset || null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_asset_streaks',
    'Get the current consecutive win streak for one or all assets, computed live from trades_ordered.',
    {
      asset: z.string().optional().describe('Asset symbol (omit for all assets)'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.getAssetStreaks(asset || null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_signal_outcomes',
    'Get signal validation history — entry/exit price, WIN/LOSS results from signal_outcomes table.',
    {
      asset: z.string().optional().describe('Filter by asset (omit for all)'),
      limit: z.coerce.number().min(1).max(500).optional().default(50),
    },
    async ({ asset, limit }) => {
      try { return jsonResult(core.getSignalOutcomes(asset || null, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_asset_trades',
    'Get executed trade outcomes from trades_ordered. Includes win rate and P/L.',
    {
      asset: z.string().optional().describe('Filter by asset (omit for all)'),
      limit: z.coerce.number().min(1).max(500).optional().default(50),
    },
    async ({ asset, limit }) => {
      try { return jsonResult(core.getAssetTrades(asset || null, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
