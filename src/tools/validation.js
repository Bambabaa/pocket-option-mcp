import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/validation.js';

export function registerValidationTools(server) {
  server.tool(
    'po_pending_signals',
    'Get signals that have passed their expiry window but haven\'t been validated yet (no entry in signal_outcomes).',
    {
      look_ahead_seconds: z.coerce.number().optional().default(60).describe('Option expiry window in seconds (default 60)'),
      limit: z.coerce.number().min(1).max(200).optional().default(50),
    },
    async ({ look_ahead_seconds, limit }) => {
      try { return jsonResult(core.getPendingSignals(look_ahead_seconds, limit)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_validation_stats',
    'Get signal validation statistics — win rate, P/L, and per-asset breakdown from signal_outcomes.',
    {
      asset: z.string().optional().describe('Filter by asset (omit for aggregate stats)'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.getValidationStats(asset || null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_streak_leaderboard',
    'Get the current win streak leaderboard — which assets are on a winning run and their qualification status.',
    {
      min_wins: z.coerce.number().optional().default(1).describe('Minimum consecutive wins to include (default 1)'),
    },
    async ({ min_wins }) => {
      try { return jsonResult(core.getStreakLeaderboard(min_wins)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
