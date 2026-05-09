import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/analysis.js';

export function registerAnalysisTools(server) {
  server.tool(
    'po_replay_candles',
    'Candle-by-candle replay of STC reversal patterns across ALL historical candles. Fires simulated CALL (STC_CALL_REVERSAL: STC ≤25 curling up, RSI <40, Stoch bull cross) and PUT (STC_PUT_REVERSAL: STC ≥75 rolling down, RSI >60, Stoch bear cross) signals. Validates each signal at both T+60s and T+120s using the prices table (tick-level) with bar-close fallback. Returns win rates, P/L, and gate rejection counts for both expiry windows.',
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
    'Reconstruct ALL gate values for a specific historical signal. Shows STC value, RSI, Stochastic K/D, MA gaps, and BB width at the exact moment the signal fired. Returns validated exit prices and results at both T+60s and T+120s expiry windows.',
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
    'Deep analysis of ALL historical STC reversal signals. Breaks down win rate at both 60s and 120s expiry by: STC value range, RSI range, Stochastic K range, MA6/MA14 gap range, BB width, hour of day, asset, direction, AND 4 context dimensions: (1) retracement depth — how oversold/overbought RSI was in the prior 10 bars; (2) K extension duration — consecutive bars K was extended before reversal; (3) MA gap trend — narrowing or widening at signal time; (4) BB expansion state — volatility rising or falling at entry.',
    {},
    async () => {
      try { return jsonResult(core.findEdge()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_optimize_gates',
    'Grid search over STC reversal gate thresholds. Tests different STC floor/ceiling levels, RSI thresholds, and BB width minimums against historical replay data. Shows which threshold values produce the highest win rates at both 60s and 120s expiry.',
    {
      direction: z.enum(['call', 'put', 'both']).optional().default('both').describe('Which direction to optimize (default both)'),
    },
    async ({ direction }) => {
      try { return jsonResult(core.optimizeGates(direction)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_gate_interaction',
    'Two-dimensional WR heatmap: cross any two po_find_edge dimensions to find combinations that univariate analysis misses. Returns an N×M grid where each cell shows trades + WR at the intersection of bucket_a and bucket_b. Highlights best_combination (highest WR, n≥5) and worst_combination. Available dimensions: stc_prev, stc_delta, g1_bars_ago, g3_depth, g3_cross_bars_ago, bb_width, coincidence_score, regime, bars_since_last_signal.',
    {
      dim_a:     z.enum(['stc_prev','stc_delta','g1_bars_ago','g3_depth','g3_cross_bars_ago','bb_width','coincidence_score','regime','bars_since_last_signal']).describe('First dimension (rows)'),
      dim_b:     z.enum(['stc_prev','stc_delta','g1_bars_ago','g3_depth','g3_cross_bars_ago','bb_width','coincidence_score','regime','bars_since_last_signal']).describe('Second dimension (columns)'),
      direction: z.enum(['call','put','both']).optional().default('both').describe('Filter to one direction or both (default both)'),
    },
    async ({ dim_a, dim_b, direction }) => {
      try { return jsonResult(core.gateInteraction(dim_a, dim_b, direction)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_grid_search',
    'Multivariate grid search over 8GSR gate thresholds. Captures a loose signal pool (STC ≤30/≥70, delta ±1.0, G3 depth ±100) then post-filters across all combinations of stc_prev × stc_delta × g3_depth × g1_bars_ago. Returns top 20 parameter sets per direction with n≥20 at 120s expiry, ranked by win rate. Each result includes: win rate, net PnL, profit factor, avg win, avg loss, avg W/L ratio, z-score, p-value (one-tailed vs 50%), and Wilson 95% confidence interval.',
    {
      direction: z.enum(['call', 'put', 'both']).optional().default('both').describe('Which direction to search (default both)'),
    },
    async ({ direction }) => {
      try { return jsonResult(core.gridSearch(direction)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_walk_forward',
    'Walk-forward validation of 8GSR strategy. Splits 120s validated signals into N equal time-ordered folds and computes win rate per fold. Returns per-fold WR, out-of-sample aggregate, and a stability verdict (STABLE/MODERATE/UNSTABLE). A stable edge shows consistent WR across all time windows, not just the overall average.',
    {
      direction: z.enum(['call', 'put', 'both']).optional().default('both').describe('Filter to one direction or both (default both)'),
      folds:     z.coerce.number().int().min(3).max(10).optional().default(5).describe('Number of time folds to split into (default 5, min 3, max 10)'),
    },
    async ({ direction, folds }) => {
      try { return jsonResult(core.walkForward(direction, folds)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_score_calibration',
    'Maps coincidence score (0-5) to actual 120s win rate and a Kelly-derived trade sizing multiplier. Shows whether high-score signals genuinely outperform low-score signals. If the score is predictive, use recommended_multiplier to scale trade amount per signal — e.g. score=5 gets 1.5× base amount, score=2 gets 0.75×. Returns calibration_verdict: SCORE IS PREDICTIVE or SCORE NOT YET DIFFERENTIATED.',
    {},
    async () => {
      try { return jsonResult(core.scoreCalibration()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_loss_attribution',
    'For every 120s LOSS, compute each gate\'s margin-from-threshold at signal time. The gate with the smallest average margin is the leaky gate letting bad trades through. Returns attribution ranked by times_weakest (how often each gate was the closest to failing on a loss), avg margin on losses vs wins, and margin_gap (positive = tightening this gate would filter more losses than wins). Ends with a leakiest_gate recommendation and suggested po_simulate command.',
    {},
    async () => {
      try { return jsonResult(core.lossAttribution()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_simulate',
    'Replay historical candles with custom 8GSR gate thresholds and compare against baseline defaults. Shows side-by-side: signal count, win rate, P/L for CALL and PUT at both 60s and 120s expiry — plus delta vs baseline. Use this to test a gate change before modifying the bot. Example: "what if I tightened call_stc_floor to 20?" or "what if I raised call_delta_max to 0.3?".',
    {
      call_stc_floor:    z.coerce.number().optional().describe('G4 CALL: max stcPrev allowed (default 25)'),
      put_stc_ceiling:   z.coerce.number().optional().describe('G4 PUT: min stcPrev required (default 75)'),
      call_delta_max:    z.coerce.number().optional().describe('G4 CALL: max STC hook size — stcDelta < this (default 0.5)'),
      put_delta_min:     z.coerce.number().optional().describe('G4 PUT: min STC hook size — stcDelta > this (default -0.5)'),
      call_g3_depth_min: z.coerce.number().optional().describe('G3 CALL: CCI depth must be below this value (default -150)'),
      put_g3_depth_max:  z.coerce.number().optional().describe('G3 PUT: CCI depth must be above this value (default 150)'),
      amount:            z.coerce.number().positive().optional().default(500).describe('Trade amount for P/L calc (default 500)'),
    },
    async (p) => {
      try { return jsonResult(core.simulateGates(p)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
