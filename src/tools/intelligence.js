import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/intelligence.js';

export function registerIntelligenceTools(server) {
  server.tool(
    'po_scan_all',
    'Scan ALL tracked assets in one call. Returns every asset scored by: qualification status, fresh signals, win streak, recent win rate, and recent P/L. Sorted by score descending. Replaces calling po_prices + po_signals + po_indicators + po_asset_streaks individually.',
    {},
    async () => {
      try { return jsonResult(core.scanAllAssets()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_recommend',
    'Get ranked trade recommendations right now. Scans all assets and returns only those that are qualified, have a fresh signal, meet win rate and streak thresholds. Returns ranked list with confidence scores and reasons.',
    {
      min_win_rate: z.coerce.number().min(0).max(100).optional().default(60).describe('Minimum recent win rate % (default 60)'),
      min_streak: z.coerce.number().min(0).optional().default(2).describe('Minimum consecutive wins streak (default 2)'),
      max_signal_age_sec: z.coerce.number().min(10).max(600).optional().default(120).describe('Max age of signal in seconds to consider "fresh" (default 120)'),
    },
    async ({ min_win_rate, min_streak, max_signal_age_sec }) => {
      try { return jsonResult(core.recommendTrades(min_win_rate, min_streak, max_signal_age_sec)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_risk_check',
    'Check the risk level before trading an asset. Evaluates: qualification status, current streak, recent win rate, matching signal, consecutive losses. Returns a score 0-100 and verdict: GOOD / CAUTION / RISKY / AVOID.',
    {
      asset: z.string().describe('Asset symbol to check, e.g. EURUSD_otc'),
      direction: z.enum(['CALL', 'PUT']).optional().describe('Trade direction to check against latest signal'),
    },
    async ({ asset, direction }) => {
      try { return jsonResult(core.riskCheck(asset, direction || null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_market_state',
    'Get overall market health: active asset count, signal frequency in last hour, today\'s P/L and win rate, top performing assets today, all-time stats. Call this to understand the broader context before trading.',
    {},
    async () => {
      try { return jsonResult(core.marketState()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
