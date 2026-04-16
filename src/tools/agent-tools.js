import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/agent-tools.js';

export function registerAgentTools(server) {

  server.tool(
    'po_signal_context',
    'Get the full MODE D pattern verdict + context for an asset in ONE call. Returns: setup_summary (one-line Analyst briefing), mode_d.ranked_verdicts (all 4 patterns ranked strongest-first with verdict_summary per pattern), lookback_narrative (how the setup formed over prior bars), best_call/best_put verdict, BB bps, recent win rate, consecutive losses, and raw bar data. Designed for the Analyst agent — reads pattern verdicts, not raw indicator numbers.',
    {
      asset: z.string().describe('Asset symbol, e.g. EURUSD_otc'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.getSignalContext(asset)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_drawdown_check',
    'Session safety gate — call this BEFORE every trade. Checks: bot liveness, today P/L vs daily loss limit, global consecutive losses, daily trade cap. Returns verdict: GO (safe to trade) | PAUSE (losses building, be selective) | STOP (hard limit hit, no more trades today).',
    {
      daily_loss_limit:   z.coerce.number().positive().optional().default(2000).describe('Max loss allowed today in $ before STOP (default 2000)'),
      max_consec_losses:  z.coerce.number().int().positive().optional().default(4).describe('Max consecutive losses before PAUSE (default 4)'),
      max_trades_per_day: z.coerce.number().int().positive().optional().default(50).describe('Max trades per day before STOP (default 50)'),
    },
    async ({ daily_loss_limit, max_consec_losses, max_trades_per_day }) => {
      try {
        return jsonResult(core.drawdownCheck({
          dailyLossLimit:  daily_loss_limit,
          maxConsecLosses: max_consec_losses,
          maxTradesPerDay: max_trades_per_day,
        }));
      }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_session_log_write',
    'Write an agent decision to the audit log. Call this at every decision point — scan results, analyst verdicts, executor actions, skips, aborts. Creates a full trail of the reasoning chain so humans can review what every agent decided and why.',
    {
      agent:     z.enum(['scanner', 'analyst', 'executor', 'orchestrator']).describe('Which agent is logging'),
      action:    z.enum(['SCAN', 'ANALYSE', 'EXECUTE', 'SKIP', 'ABORT']).describe('What decision was made'),
      asset:     z.string().optional().describe('Asset involved (if any)'),
      direction: z.enum(['CALL', 'PUT']).optional().describe('Trade direction (if any)'),
      score:     z.coerce.number().optional().describe('Precision or risk score (0-100) if applicable'),
      verdict:   z.string().optional().describe('Short verdict string, e.g. GOOD, RISKY, NO_SIGNAL'),
      reasoning: z.any().optional().describe('Full reasoning — object or string explaining the decision'),
    },
    async ({ agent, action, asset, direction, score, verdict, reasoning }) => {
      try {
        return jsonResult(core.writeSessionLog({ agent, action, asset, direction, score, verdict, reasoning }));
      }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_session_log_read',
    'Read the agent decision audit log. Shows the full reasoning chain from every agent: what was scanned, what was recommended, why trades were placed or skipped. Use this to review what the system did and why.',
    {
      limit: z.coerce.number().int().positive().optional().default(50).describe('Max entries to return (default 50)'),
      agent: z.enum(['scanner', 'analyst', 'executor', 'orchestrator']).optional().describe('Filter to one agent (omit for all)'),
    },
    async ({ limit, agent }) => {
      try { return jsonResult(core.readSessionLog(limit, agent || null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_block_asset',
    'Block an asset from being traded. Writes a BLOCK entry to asset_controls — the bot checks this before enqueuing any order and skips blocked assets. Use for flat/pegged assets with low volatility, broken indicators, or consistently losing assets. Use asset="ALL" to emergency-stop all trading.',
    {
      asset:            z.string().describe('Asset symbol to block, e.g. SARCNY_otc, or "ALL" to block everything'),
      reason:           z.string().describe('Why this asset is being blocked (logged for audit)'),
      source:           z.string().optional().default('claude').describe('Who is blocking it: claude, analyst, user (default: claude)'),
      duration_minutes: z.coerce.number().positive().optional().describe('Auto-expire block after N minutes (omit = permanent until unblocked)'),
    },
    async ({ asset, reason, source, duration_minutes }) => {
      try { return jsonResult(core.blockAsset(asset, reason, source ?? 'claude', duration_minutes ?? null)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_unblock_asset',
    'Remove an active block on an asset so the bot can trade it again. Deactivates all matching block entries — history is preserved. Use after investigating or resolving the issue that caused the block.',
    {
      asset: z.string().describe('Asset symbol to unblock, e.g. SARCNY_otc'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.unblockAsset(asset)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_asset_volatility',
    'Rank all assets by average Bollinger Band width (bps). BB width = (bb_upper − bb_lower) / bb_middle × 10000. GOOD ≥10 bps (healthy for MODE D), MARGINAL 5–10, WEAK 2–5, FLAT <2 (block these). Also shows current block status and all-time P/L per asset. Use this to find flat/pegged assets to block, or to find the most volatile assets to prioritize.',
    {
      min_bb_bps: z.coerce.number().min(0).optional().default(0).describe('Only return assets with avg BB width ≥ this value in bps (default 0 = all)'),
    },
    async ({ min_bb_bps }) => {
      try { return jsonResult(core.getAssetVolatility(min_bb_bps ?? 0)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_auto_block_check',
    'Check if an asset should be auto-blocked based on today\'s performance. Triggers: (A) 3+ consecutive losses today → 120-min block; (B) win rate < 35% with 5+ trades today → 120-min block. Call this after every confirmed trade result. Timed blocks auto-expire after the session — no manual cleanup needed.',
    {
      asset: z.string().describe('Asset symbol to check, e.g. EURUSD_otc'),
    },
    async ({ asset }) => {
      try { return jsonResult(core.autoBlockCheck(asset)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'po_auto_block_sweep',
    'Scan all assets and auto-block any with average BB width < 5 bps (flat/dead markets). Permanent blocks — flat assets do not recover within a session. Run once at session start before the first trade. Returns blocked_count and list of newly blocked assets with their BB width.',
    {},
    async () => {
      try { return jsonResult(core.autoBlockVolatilitySweep()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
