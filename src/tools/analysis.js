import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/analysis.js';

export function registerAnalysisTools(server) {
  server.tool(
    'po_replay_candles',
    'Candle-by-candle replay of MODE D patterns across ALL historical candles. Fires simulated CALL (K Flash Crash) and PUT (Late Overbought) signals, validates against the NEXT candle close, and returns win rates, P/L, and gate rejection counts. Same engine as tests/test_patterns.js. Use this to see what the strategy would have produced on historical data.',
    {
      asset: z.string().optional().describe('Filter to one asset (omit for all assets)'),
      amount: z.coerce.number().positive().optional().default(500).describe('Trade amount for P/L calc (default 500)'),
    },
    async ({ asset, amount }) => {
      try { return jsonResult(core.replayCandles(asset || null, { amount })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_replay_signal',
    'Reconstruct ALL gate values for a specific historical signal. Shows RSI, Stochastic K/D, MA gaps, and lookback values at the exact moment the signal fired. Compares CALL and PUT gate results against actual trade outcome.',
    {
      signal_id: z.coerce.number().describe('Signal ID from po_signals'),
    },
    async ({ signal_id }) => {
      try { return jsonResult(core.replaySignal(signal_id)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_find_edge',
    'Deep analysis of ALL historical signals and live trades. Breaks down win rate by: RSI range, Stochastic K range, MA gap range, BB width (flat/weak/marginal/good), hour of day, asset (with per-direction breakdown), and all 4 strategy patterns (CALL_REVERSAL=OVERSOLD, PUT_REVERSAL=OVERBOUGHT, CALL_CONTINUATION=UP TREND, PUT_CONTINUATION=DOWN TREND). Pattern data is sourced from live trades_ordered joined to signals table — shows real executed win rates per pattern, not just replay estimates.',
    {},
    async () => {
      try { return jsonResult(core.findEdge()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_optimize_gates',
    'Grid search over MODE D gate thresholds. Tests different RSI thresholds, K crash sizes, D lagging levels, MA gaps, and RSI velocities against historical replay data. Shows which threshold values produce the highest win rates.',
    {
      direction: z.enum(['call', 'put', 'both']).optional().default('both').describe('Which direction to optimize (default both)'),
    },
    async ({ direction }) => {
      try { return jsonResult(core.optimizeGates(direction)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
