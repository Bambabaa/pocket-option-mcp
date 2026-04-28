/**
 * Agent Support Tools
 *
 * Three focused tools built specifically for the multi-agent trading system:
 *
 *   po_signal_context  — full indicator snapshot + 3 prior bars for a given asset,
 *                        in one call (replaces po_indicators + po_candles + po_signals)
 *   po_drawdown_check  — session safety gate: P/L today, consecutive losses, daily limit
 *   po_session_log     — write / read agent decision audit trail (mcp.db)
 */

import { all, get } from '../connection.js';
import { mcpRun, mcpAll, mcpGet } from '../mcp-db.js';
import { evaluateModeD } from './intelligence.js';

// ─── po_signal_context ────────────────────────────────────────────────────────
//
// Returns everything the Analyst agent needs in a single query:
//   - Latest 4 indicator rows (current bar + 3 history) with full column set
//   - Latest signal for this asset (direction + timestamp + reasons)
//   - Price age (is data fresh?)
//   - Recent 20-trade win rate and consecutive loss count
//
// Designed so the Analyst can make a complete decision without extra round-trips.

export async function getSignalContext(asset) {
  const nowSec = Math.floor(Date.now() / 1000);

  // 4 most recent indicator rows (current + 3 prior bars)
  const indRows = await all(
    `SELECT timestamp, ma1, ma2, ma3, rsi_5, rsi_8,
            stochastic_k_v2, stochastic_d_v2,
            stochastic_k, stochastic_d,
            bb_upper, bb_middle, bb_lower,
            keltner_upper, keltner_lower,
            schaff_value
     FROM indicators
     WHERE asset = ?
     ORDER BY timestamp DESC LIMIT 4`,
    [asset]
  );

  if (!indRows.length) {
    return { success: false, error: `No indicator data for asset: ${asset}` };
  }

  // Latest 4 candles (OHLC)
  const candles = await all(
    `SELECT timestamp, open, high, low, close
     FROM candles WHERE asset = ?
     ORDER BY timestamp DESC LIMIT 4`,
    [asset]
  );

  // Latest signal (last 10 min)
  const latestSignal = await get(
    `SELECT id, timestamp, direction, strategy_used, reasons
     FROM signals WHERE asset = ?
     ORDER BY timestamp DESC LIMIT 1`,
    [asset]
  );

  // Latest price
  const latestPrice = await get(
    `SELECT price, timestamp FROM prices WHERE asset = ?
     ORDER BY timestamp DESC LIMIT 1`,
    [asset]
  );

  // Recent trade history — win rate + consecutive losses
  const recentTrades = await all(
    `SELECT result, profit_loss, entry_timestamp
     FROM trades_ordered
     WHERE asset = ? AND result IN ('WIN','LOSS')
     ORDER BY entry_timestamp DESC LIMIT 20`,
    [asset]
  );

  const wins = recentTrades.filter(t => t.result === 'WIN').length;
  const recentWinRate = recentTrades.length > 0
    ? ((wins / recentTrades.length) * 100).toFixed(1) + '%'
    : 'N/A';

  let consecLosses = 0;
  for (const t of recentTrades) {
    if (t.result === 'LOSS') consecLosses++;
    else break;
  }

  const recentPL = recentTrades.reduce((a, t) => a + (t.profit_loss || 0), 0);

  const priceAge = latestPrice ? nowSec - latestPrice.timestamp : null;

  // current = indRows[0], bar-1 = indRows[1], bar-2 = indRows[2], bar-3 = indRows[3]
  const [bar0, barM1, barM2, barM3] = indRows;

  // Evaluate all 4   patterns against current bar window
  // bars array newest-first matches evaluateModeD() contract
  const modeD = evaluateModeD(indRows);

  return {
    success: true,
    asset,
    timestamp: new Date(nowSec * 1000).toISOString(),
    price: latestPrice?.price ?? null,
    price_age_sec: priceAge,
    data_fresh: priceAge !== null && priceAge < 30,

    // The 4-bar indicator window the   gates need
    bars: {
      current: bar0 || null,
      minus_1: barM1 || null,
      minus_2: barM2 || null,
      minus_3: barM3 || null,
    },

    // Candle OHLC for same bars
    candles: candles.reduce((m, c) => {
      if (!bar0 || c.timestamp === bar0.timestamp) m.current = c;
      else if (!barM1 || c.timestamp === barM1.timestamp) m.minus_1 = c;
      else if (!barM2 || c.timestamp === barM2.timestamp) m.minus_2 = c;
      return m;
    }, {}),

    // Latest signal fired on this asset
    latest_signal: latestSignal ? {
      id: latestSignal.id,
      direction: latestSignal.direction,
      age_sec: nowSec - latestSignal.timestamp,
      strategy: latestSignal.strategy_used,
      reasons: (() => { try { return JSON.parse(latestSignal.reasons); } catch { return []; } })(),
    } : null,

    // Recent performance context
    recent_trades: recentTrades.length,
    recent_win_rate: recentWinRate,
    consec_losses: consecLosses,
    recent_pl: parseFloat(recentPL.toFixed(2)),

    //   pattern evaluation — all 4 patterns scored against current bars
    mode_d: modeD.success ? {
      top_pattern: modeD.top_pattern,
      top_direction: modeD.top_direction,
      best_call: modeD.best_call,
      best_put: modeD.best_put,
      bb_bps: modeD.bb_bps,
      ma_gap_bps: modeD.ma_gap_bps,
      lookback: modeD.lookback,
      patterns: modeD.patterns,
    } : null,
  };
}

// ─── po_drawdown_check ────────────────────────────────────────────────────────
//
// Session safety gate called by the Executor agent before every trade.
// Returns a clear GO / PAUSE / STOP verdict with reasons.
//
// Checks:
//   1. Bot liveness (price age)
//   2. Today's P/L vs daily loss limit
//   3. Consecutive losses across ALL assets today
//   4. Total trades today vs session cap

export async function drawdownCheck(opts = {}) {
  const {
    dailyLossLimit = 2000,   // stop trading if today's loss exceeds this ($)
    maxConsecLosses = 4,      // stop if N losses in a row across all assets
    maxTradesPerDay = 50,     // hard cap on daily trade count
  } = opts;

  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = nowSec - (nowSec % 86400);

  // Today's trades
  const todayTrades = await all(
    `SELECT result, profit_loss, entry_timestamp, asset
     FROM trades_ordered
     WHERE entry_timestamp >= ? AND result IN ('WIN','LOSS','DRAW')
     ORDER BY entry_timestamp DESC`,
    [todayStart]
  );

  const todayPL = todayTrades.reduce((a, t) => a + (t.profit_loss || 0), 0);
  const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
  const todayLosses = todayTrades.filter(t => t.result === 'LOSS').length;
  const todayCount = todayTrades.length;

  // Consecutive losses across ALL assets (most recent trades first)
  let globalConsecLosses = 0;
  for (const t of todayTrades) {
    if (t.result === 'LOSS') globalConsecLosses++;
    else break;
  }

  // Bot liveness
  const latestPrice = await get(
    'SELECT timestamp FROM prices ORDER BY timestamp DESC LIMIT 1'
  );
  const priceAge = latestPrice ? nowSec - latestPrice.timestamp : null;
  const botLive = priceAge !== null && priceAge < 30;

  // Pending MCP orders (already queued, not yet executed)
  const pendingOrders = await all(
    "SELECT id, asset, direction FROM mcp_orders WHERE status = 'PENDING'"
  ).catch(() => []);

  // ── Verdict logic ──
  const blocks = [];

  if (!botLive) {
    blocks.push(`Bot is not live — last price ${priceAge ?? 'unknown'}s ago`);
  }
  if (todayPL <= -Math.abs(dailyLossLimit)) {
    blocks.push(`Daily loss limit hit: $${todayPL.toFixed(2)} (limit -$${dailyLossLimit})`);
  }
  if (globalConsecLosses >= maxConsecLosses) {
    blocks.push(`${globalConsecLosses} consecutive losses — cooling off`);
  }
  if (todayCount >= maxTradesPerDay) {
    blocks.push(`Daily trade cap reached: ${todayCount} trades (max ${maxTradesPerDay})`);
  }

  let verdict;
  if (blocks.length === 0) verdict = 'GO';
  else if (!botLive || todayPL <= -Math.abs(dailyLossLimit)) verdict = 'STOP';
  else verdict = 'PAUSE';

  return {
    success: true,
    verdict,              // GO | PAUSE | STOP
    safe_to_trade: verdict === 'GO',
    blocks,               // reasons for PAUSE/STOP
    today: {
      trades: todayCount,
      wins: todayWins,
      losses: todayLosses,
      pnl: parseFloat(todayPL.toFixed(2)),
      consec_losses: globalConsecLosses,
    },
    limits: {
      daily_loss_limit: dailyLossLimit,
      max_consec_losses: maxConsecLosses,
      max_trades_per_day: maxTradesPerDay,
    },
    bot_live: botLive,
    price_age_sec: priceAge,
    pending_orders: pendingOrders.length,
  };
}

// ─── po_session_log ───────────────────────────────────────────────────────────
//
// Audit trail for every agent decision.
// Agents write a log entry at each decision point so humans can see the full
// reasoning chain: what was scanned, what was recommended, why it was approved
// or rejected, whether the trade was placed.
//
// Table: agent_session_log (in mcp.db)
//   id, agent, action, asset, direction, score, verdict, reasoning, created_at

export async function writeSessionLog(entry) {
  const {
    agent,      // 'scanner' | 'analyst' | 'executor' | 'orchestrator'
    action,     // 'SCAN' | 'ANALYSE' | 'EXECUTE' | 'SKIP' | 'ABORT'
    asset = null,
    direction = null,
    score = null,
    verdict = null,
    reasoning = null,
  } = entry;

  const result = await mcpRun(
    `INSERT INTO agent_session_log
       (agent, action, asset, direction, score, verdict, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [agent, action, asset, direction, score, verdict,
      typeof reasoning === 'object' ? JSON.stringify(reasoning) : reasoning]
  );

  return { success: true, log_id: result.lastID };
}

export async function readSessionLog(limit = 50, agent = null) {
  let sql = 'SELECT * FROM agent_session_log WHERE 1=1';
  const params = [];
  if (agent) { sql += ' AND agent = ?'; params.push(agent); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = await mcpAll(sql, params);
  return {
    success: true,
    count: rows.length,
    logs: rows.map(r => ({
      ...r,
      reasoning: (() => { try { return JSON.parse(r.reasoning); } catch { return r.reasoning; } })(),
    })),
  };
}

// ─── po_block_asset ───────────────────────────────────────────────────────────
//
// Write an ACTIVE block entry for an asset into asset_controls (mcp.db).
// The bot checks this table before enqueuing any order — blocked assets are
// skipped with status SKIPPED and the block reason logged.
//
// asset = 'ALL' to block everything (emergency stop).
// duration_minutes = null → permanent until explicitly unblocked.

export async function blockAsset(asset, reason, source = 'claude', durationMinutes = null) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = durationMinutes ? now + durationMinutes * 60 : null;

  const result = await mcpRun(
    `INSERT INTO asset_controls (asset, action, reason, source, expires_at, active)
     VALUES (?, 'BLOCK', ?, ?, ?, 1)`,
    [asset, reason, source, expiresAt]
  );

  return {
    success: true,
    block_id: result.lastID,
    asset,
    reason,
    source,
    expires_at: expiresAt ? new Date(expiresAt * 1000).toISOString() : 'never (permanent)',
  };
}

// ─── po_unblock_asset ─────────────────────────────────────────────────────────
//
// Deactivate all active block entries for an asset.
// Sets active=0 on all matching rows — preserves history.

export async function unblockAsset(asset) {
  const result = await mcpRun(
    `UPDATE asset_controls SET active = 0 WHERE asset = ? AND active = 1`,
    [asset]
  );

  return {
    success: true,
    asset,
    blocks_cleared: result.changes,
  };
}

// ─── autoBlockCheck() ────────────────────────────────────────────────────────
//
// Called after every executed trade. Checks if the asset has hit an auto-block
// threshold and blocks it with a timed 120-minute expiry if so.
//
// Trigger A: >= 3 consecutive losses today on this asset
// Trigger B: win rate < 35% with >= 5 trades today on this asset
//
// Returns { blocked: true, trigger, reason } or { blocked: false }

export async function autoBlockCheck(asset) {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = nowSec - (nowSec % 86400);

  // Already blocked? Skip.
  const existing = await mcpAll(
    `SELECT id FROM asset_controls
     WHERE asset = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)
     LIMIT 1`,
    [asset, nowSec]
  );
  if (existing.length) return { blocked: false, already_blocked: true };

  // Today's trades for this asset
  const trades = await all(
    `SELECT result FROM trades_ordered
     WHERE asset = ? AND entry_timestamp >= ? AND result IN ('WIN','LOSS')
     ORDER BY entry_timestamp DESC`,
    [asset, todayStart]
  );

  if (!trades.length) return { blocked: false };

  // Trigger A: consecutive losses
  let consecLosses = 0;
  for (const t of trades) {
    if (t.result === 'LOSS') consecLosses++;
    else break;
  }

  if (consecLosses >= 3) {
    const reason = `auto-block: ${consecLosses} consecutive losses today`;
    await blockAsset(asset, reason, 'auto', 120);
    return { blocked: true, trigger: 'consecutive_losses', asset, reason, expires_min: 120 };
  }

  // Trigger B: win rate < 35% with >= 5 trades today
  if (trades.length >= 5) {
    const wins = trades.filter(t => t.result === 'WIN').length;
    const wr = (wins / trades.length) * 100;
    if (wr < 35) {
      const reason = `auto-block: win rate ${wr.toFixed(0)}% on ${trades.length} trades today`;
      await blockAsset(asset, reason, 'auto', 120);
      return { blocked: true, trigger: 'low_win_rate', asset, reason, win_rate: wr.toFixed(1), trades: trades.length, expires_min: 120 };
    }
  }

  return { blocked: false, asset, consec_losses: consecLosses, trades_today: trades.length };
}

// ─── autoBlockVolatilitySweep() ───────────────────────────────────────────────
//
// Scans all assets and auto-blocks any with avg BB width < 5 bps (flat/dead).
// Designed to run once at session start before the first trade.
// Permanent blocks — flat assets don't recover within a session.
//
// Returns { blocked_count, blocked_assets: [{ asset, reason, bb_bps }] }

export async function autoBlockVolatilitySweep() {
  const nowSec = Math.floor(Date.now() / 1000);

  // Get avg BB width per asset from last 100 bars
  const rows = await all(
    `SELECT asset,
            AVG((bb_upper - bb_lower) / bb_middle * 10000) as avg_bb_bps
     FROM indicators
     WHERE bb_upper IS NOT NULL AND bb_lower IS NOT NULL AND bb_middle IS NOT NULL AND bb_middle > 0
     GROUP BY asset
     HAVING avg_bb_bps IS NOT NULL`
  );

  // Get already-blocked assets
  const blockedRows = await mcpAll(
    `SELECT asset FROM asset_controls WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`,
    [nowSec]
  );
  const alreadyBlocked = new Set(blockedRows.map(r => r.asset));

  const blocked_assets = [];

  for (const row of rows) {
    if (row.avg_bb_bps < 5 && !alreadyBlocked.has(row.asset)) {
      const reason = `auto-block: BB ${row.avg_bb_bps.toFixed(2)} bps — flat asset (< 5 bps dead zone)`;
      await blockAsset(row.asset, reason, 'auto', null); // permanent
      blocked_assets.push({ asset: row.asset, reason, bb_bps: parseFloat(row.avg_bb_bps.toFixed(2)) });
    }
  }

  return {
    success: true,
    blocked_count: blocked_assets.length,
    blocked_assets,
    note: blocked_assets.length === 0
      ? 'No new flat assets found — all assets above 5 bps or already blocked'
      : `Auto-blocked ${blocked_assets.length} flat asset(s) — permanent blocks`,
  };
}

// ─── po_asset_volatility ──────────────────────────────────────────────────────
//
// Ranks all assets by average BB width (bps) from the indicators table.
// BB width = (bb_upper - bb_lower) / bb_middle * 10000
//
// Classification:
//   ≥ 10 bps  → GOOD     (healthy volatility,   gates work well)
//   5–10 bps  → MARGINAL (tradeable but borderline)
//   2–5 bps   → WEAK     (low volatility, poor signal quality)
//   < 2 bps   → FLAT     (pegged/broken, block this)
//
// Also shows: current block status, recent P/L from trades_ordered.

export async function getAssetVolatility(minBbBps = 0) {
  const now = Math.floor(Date.now() / 1000);

  // BB width per asset — use last 100 bars for a stable average
  const volRows = await all(
    `SELECT asset,
            AVG((bb_upper - bb_lower) / NULLIF(bb_middle, 0) * 10000) AS avg_bb_bps,
            COUNT(*) AS bar_count,
            MAX(timestamp) AS last_seen
     FROM (
       SELECT asset, bb_upper, bb_lower, bb_middle, timestamp,
              ROW_NUMBER() OVER (PARTITION BY asset ORDER BY timestamp DESC) AS rn
       FROM indicators
       WHERE bb_middle > 0
     ) sub
     WHERE rn <= 100
     GROUP BY asset
     HAVING avg_bb_bps >= ?
     ORDER BY avg_bb_bps DESC`,
    [minBbBps]
  );

  // Active blocks in mcp.db
  const blocks = await mcpAll(
    `SELECT asset, reason, source, expires_at, created_at
     FROM asset_controls
     WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`,
    [now]
  );
  const blockedSet = new Map(blocks.map(b => [b.asset, b]));

  // Recent P/L per asset (all time)
  const plRows = await all(
    `SELECT asset,
            SUM(profit_loss) AS total_pl,
            COUNT(*) AS total_trades,
            SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) AS losses
     FROM trades_ordered
     WHERE result IN ('WIN','LOSS')
     GROUP BY asset`
  );
  const plMap = new Map(plRows.map(r => [r.asset, r]));

  function classify(bps) {
    if (bps >= 10) return 'GOOD';
    if (bps >= 5) return 'MARGINAL';
    if (bps >= 2) return 'WEAK';
    return 'FLAT';
  }

  const assets = volRows.map(r => {
    const bps = parseFloat((r.avg_bb_bps || 0).toFixed(2));
    const perf = plMap.get(r.asset);
    const block = blockedSet.get(r.asset);

    return {
      asset: r.asset,
      avg_bb_bps: bps,
      vol_class: classify(bps),
      bars_sampled: r.bar_count,
      data_age_sec: now - r.last_seen,
      blocked: block ? true : false,
      block_reason: block?.reason ?? null,
      total_pl: perf ? parseFloat(perf.total_pl.toFixed(2)) : null,
      total_trades: perf?.total_trades ?? 0,
      win_rate: perf && perf.total_trades > 0
        ? parseFloat(((perf.wins / perf.total_trades) * 100).toFixed(1))
        : null,
    };
  });

  const summary = {
    good: assets.filter(a => a.vol_class === 'GOOD').length,
    marginal: assets.filter(a => a.vol_class === 'MARGINAL').length,
    weak: assets.filter(a => a.vol_class === 'WEAK').length,
    flat: assets.filter(a => a.vol_class === 'FLAT').length,
    blocked: assets.filter(a => a.blocked).length,
  };

  return {
    success: true,
    total: assets.length,
    summary,
    assets,
    note: 'BB width bps = (bb_upper - bb_lower) / bb_middle × 10000. GOOD ≥10, MARGINAL 5-10, WEAK 2-5, FLAT <2.',
  };
}
