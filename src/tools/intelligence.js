import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/intelligence.js';

export function registerIntelligenceTools(server) {
  server.tool(
    'po_scan_all',
    'Scan ALL tracked assets and score them by KT video2 strategy precision. Evaluates 7 indicator layers in real-time: MA cross, gap expansion, SMA alignment, slope harmony, RSI strength, RSI ignition, stochastic trigger. Returns ranked list with layer-by-layer breakdown. NOT based on luck/streaks — based on how cleanly indicators align right now.',
    {},
    async () => {
      try { return jsonResult(core.scanAllAssets()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_recommend',
    'Get ranked trade recommendations based on indicator precision. Only includes assets where the 7 KT video2 layers are aligned (MA cross, SMA stack, RSI zone, stochastic cross, etc.) AND recent win rate meets threshold. Returns ranked list with precision scores and layer details.',
    {
      min_precision_score: z.coerce.number().min(0).max(100).optional().default(50).describe('Minimum precision score 0-100 (default 50)'),
      min_win_rate: z.coerce.number().min(0).max(100).optional().default(55).describe('Minimum recent win rate % (default 55)'),
    },
    async ({ min_precision_score, min_win_rate }) => {
      try { return jsonResult(core.recommendTrades(min_precision_score, min_win_rate)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_risk_check',
    'Pre-trade audit for an asset. Evaluates all 4 MODE D patterns against current bar data, scores each (gates passed, gates failed, strength), and returns: verdict GOOD/CAUTION/RISKY/AVOID, score 0-100, trade_verdict (one sentence on the requested direction\'s pattern), mode_d.ranked_verdicts (strongest pattern first with verdict_summary), lookback_narrative (how the setup formed), and warnings. Lead field for the Analyst is trade_verdict — reads pattern verdicts, not raw numbers.',
    {
      asset: z.string().describe('Asset symbol to check, e.g. EURUSD_otc'),
      direction: z.enum(['CALL', 'PUT']).optional().describe('Trade direction to check against precision score direction'),
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

  server.tool(
    'po_asset_bias',
    'Analyse historical win rate per asset per direction (CALL vs PUT). Shows which direction each asset historically wins in, flags flat/pegged assets as BLOCK_RECOMMENDED, and identifies assets to avoid entirely. Use this before po_recommend to know which direction to filter per asset, or before po_block_asset to see which assets need blocking.',
    {
      min_trades: z.coerce.number().int().min(1).optional().default(3).describe('Minimum trades required to include an asset (default 3)'),
    },
    async ({ min_trades }) => {
      try { return jsonResult(core.assetBias(min_trades ?? 3)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
