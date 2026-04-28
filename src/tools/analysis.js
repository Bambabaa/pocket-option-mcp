import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/analysis.js';

export function registerAnalysisTools(server) {
  server.tool(
    'po_replay_candles',
    'Candle-by-candle replay of   patterns across ALL historical candles. Fires simulated CALL (K Flash Crash) and PUT (Late Overbought) signals, validates against the NEXT candle close, and returns win rates, P/L, and gate rejection counts. Same engine as tests/test_patterns.js. Use this to see what the strategy would have produced on historical data.',
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
    'Deep analysis of ALL historical signals and live trades. Breaks down win rate by: RSI range, Stochastic K range, MA6/MA14 gap range, BB width, hour of day, asset (with per-direction breakdown), all 4 strategy patterns, AND 4 new retracement/context dimensions: (1) retracement depth — how overbought/oversold RSI was in the 10 bars before entry; (2) K extension duration — how many consecutive bars K was extended before the crash; (3) MA gap trend — was the MA6/MA14 gap narrowing (exhaustion) or widening at signal time; (4) BB expansion state — was volatility rising or falling when the signal fired.',
    {},
    async () => {
      try { return jsonResult(core.findEdge()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_optimize_gates',
    'Grid search over   gate thresholds. Tests different RSI thresholds, K crash sizes, D lagging levels, MA gaps, and RSI velocities against historical replay data. Shows which threshold values produce the highest win rates.',
    {
      direction: z.enum(['call', 'put', 'both']).optional().default('both').describe('Which direction to optimize (default both)'),
    },
    async ({ direction }) => {
      try { return jsonResult(core.optimizeGates(direction)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_simulate',
    'Replay historical candles with custom   gate thresholds and compare results against the baseline (current live defaults). Shows side-by-side: signal count, win rate, P/L for CALL and PUT — plus delta. Use this to test a gate change before modifying the bot. Example: "what if I raised call_k_crash_min from 25 to 35?" or "what if I added min_bb_bps=5 to skip flat assets?".',
    {
      call_rsi_max: z.coerce.number().optional().describe('Max RSI for CALL entry (default 40)'),
      call_k_crash_min: z.coerce.number().optional().describe('Min K drop size for CALL (default 25)'),
      call_k_oversold_max: z.coerce.number().optional().describe('Max K at bar0 for CALL (default 25)'),
      call_k_was_mid_min: z.coerce.number().optional().describe('Min K at barM1 for CALL (default 50)'),
      call_ma_trend_min: z.coerce.number().optional().describe('Min MA6 vs MA14 gap bps for CALL (default -20, negative = MA6 below MA14)'),
      put_d_min: z.coerce.number().optional().describe('Min stoch D for PUT entry (default 80)'),
      put_rsi_velocity_min: z.coerce.number().optional().describe('Min RSI velocity for PUT (default -12)'),
      put_ma_trend_max: z.coerce.number().optional().describe('Max MA6 vs MA14 gap bps for PUT (default 20, positive = MA6 above MA14)'),
      put_k_turn_d_min: z.coerce.number().optional().describe('Min K at barM1 for PUT turn gate (default 65)'),
      min_bb_bps: z.coerce.number().optional().default(0).describe('Skip assets with avg BB width below this bps (asset-level filter, default 0 = no filter).'),
      bar_bb_bps_min: z.coerce.number().optional().default(0).describe('Skip individual bars where BB width is below this bps (bar-level filter, default 0 = no filter). Set to 10 to require real volatility at entry. More precise than min_bb_bps.'),
      amount: z.coerce.number().positive().optional().default(500).describe('Trade amount for P/L calc (default 500)'),
    },
    async (p) => {
      try { return jsonResult(core.simulateGates(p)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
