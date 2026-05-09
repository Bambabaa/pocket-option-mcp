/**
 * session-monitor.js — Autonomous asset block/unblock monitor
 *
 * Restart this script = new session (clears all source='session' hard blocks).
 *
 * Timers:
 *   Every 2 min  — loss monitor: warn at 2 consec losses, session-block at 3
 *   Every 10 min — unblock sweep: unblock assets where BB >= 10bps + fresh + no streak
 *
 * Reads:  data/trading_data.db  (via src/bot-db.js  — READONLY)
 * Writes: data/mcp.db           (via src/mcp-db.js  — writable)
 *
 * Usage: node src/scripts/session-monitor.js
 */

import { all, get } from '../bot-db.js';
import { mcpRun, mcpAll } from '../mcp-db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function todayStart() {
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - (nowSec % 86400); // UTC midnight
}

// ─── Startup: clear session blocks from prior run ─────────────────────────────
//
// source='session' blocks are written by the loss monitor when an asset hits
// 3 consecutive losses. They have no expiry — only cleared here on restart.
// This makes script restart the session boundary.

async function clearSessionBlocks() {
  try {
    const result = await mcpRun(
      `UPDATE asset_controls SET active = 0 WHERE source = 'session' AND active = 1`
    );
    if (result.changes > 0)
      log(`[STARTUP] Cleared ${result.changes} session block(s) from prior run.`);
    else
      log(`[STARTUP] No session blocks to clear — clean start.`);
  } catch (e) {
    log(`[STARTUP] Session block cleanup error: ${e.message}`);
  }
}

// ─── 2-min: Loss Monitor ──────────────────────────────────────────────────────
//
// For every asset that has traded today:
//   - 2 consecutive losses → log WARNING (give it a chance)
//   - 3+ consecutive losses → write source='session' block (no expiry)
//
// Already-blocked assets are skipped — no duplicate rows.

async function runLossMonitor() {
  const nowSec = Math.floor(Date.now() / 1000);
  const start  = todayStart();

  let assets;
  try {
    assets = await all(
      `SELECT DISTINCT asset FROM trades_ordered
       WHERE entry_timestamp >= ? AND result IN ('WIN','LOSS')`,
      [start]
    );
  } catch (e) {
    log(`[LOSS-MONITOR] DB error fetching assets: ${e.message}`);
    return;
  }

  for (const { asset } of assets) {
    try {
      // Skip if already blocked (any source)
      const existing = await mcpAll(
        `SELECT id FROM asset_controls
         WHERE asset = ? AND active = 1
           AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
        [asset, nowSec]
      );
      if (existing.length) continue;

      // Fetch today's trades newest-first
      const trades = await all(
        `SELECT result FROM trades_ordered
         WHERE asset = ? AND entry_timestamp >= ? AND result IN ('WIN','LOSS')
         ORDER BY entry_timestamp DESC`,
        [asset, start]
      );
      if (!trades.length) continue;

      // Count trailing consecutive losses
      let streak = 0;
      for (const t of trades) {
        if (t.result === 'LOSS') streak++;
        else break;
      }

      if (streak >= 3) {
        const reason = `loss-monitor: ${streak} consecutive losses — session block`;
        await mcpRun(
          `INSERT INTO asset_controls (asset, action, reason, source, expires_at, active)
           VALUES (?, 'BLOCK', ?, 'session', NULL, 1)`,
          [asset, reason]
        );
        log(`[LOSS-MONITOR] BLOCKED ${asset} — ${reason}`);
      } else if (streak === 2) {
        log(`[LOSS-MONITOR] WARNING ${asset} — 2 consecutive losses (1 more = session block)`);
      }
    } catch (e) {
      log(`[LOSS-MONITOR] Error on ${asset}: ${e.message}`);
    }
  }
}

// ─── 10-min: Unblock Sweep ────────────────────────────────────────────────────
//
// Re-evaluates all non-session active blocks. Unblocks if ALL pass:
//   (1) BB width >= 10 bps
//   (2) Indicator data fresh (< 5 min old)
//   (3) < 3 consecutive losses today
//
// Never touches source='session' (session blocks clear only on restart).
// Never touches asset='ALL' (emergency stop — manual only).

async function runUnblockSweep() {
  const nowSec      = Math.floor(Date.now() / 1000);
  const start       = todayStart();
  const staleCutoff = nowSec - (5 * 60); // indicator must be < 5 min old

  let blocks;
  try {
    blocks = await mcpAll(
      `SELECT id, asset, source FROM asset_controls
       WHERE active = 1 AND source != 'session'
         AND (expires_at IS NULL OR expires_at > ?)`,
      [nowSec]
    );
  } catch (e) {
    log(`[UNBLOCK-SWEEP] DB error: ${e.message}`);
    return;
  }

  if (!blocks.length) return;
  log(`[UNBLOCK-SWEEP] Checking ${blocks.length} blocked asset(s)...`);

  const seen = new Set();
  for (const { asset } of blocks) {
    if (asset === 'ALL' || seen.has(asset)) continue;
    seen.add(asset);

    const reasons = [];
    try {
      // Condition 1: BB width >= 10 bps, indicator data fresh
      const ind = await get(
        `SELECT bb_upper, bb_lower, bb_middle, timestamp
         FROM indicators WHERE asset = ? AND bb_middle > 0
         ORDER BY timestamp DESC LIMIT 1`,
        [asset]
      );

      if (!ind) {
        reasons.push('no indicator data');
      } else if (ind.timestamp < staleCutoff) {
        reasons.push(`indicator stale (${Math.round((nowSec - ind.timestamp) / 60)}min old)`);
      } else {
        const bbBps = (ind.bb_upper - ind.bb_lower) / ind.bb_middle * 10000;
        if (!isFinite(bbBps)) reasons.push('BB width calculation invalid (zero/near-zero bb_middle)');
        else if (bbBps < 10) reasons.push(`BB ${bbBps.toFixed(1)} bps < 10 threshold`);
      }

      // Condition 2: < 3 consecutive losses today
      const trades = await all(
        `SELECT result FROM trades_ordered
         WHERE asset = ? AND entry_timestamp >= ? AND result IN ('WIN','LOSS')
         ORDER BY entry_timestamp DESC LIMIT 10`,
        [asset, start]
      );
      let streak = 0;
      for (const t of trades) {
        if (t.result === 'LOSS') streak++;
        else break;
      }
      if (streak >= 3) reasons.push(`${streak} consecutive losses today`);

      // Decision
      if (reasons.length === 0) {
        await mcpRun(
          `UPDATE asset_controls SET active = 0
           WHERE asset = ? AND active = 1 AND source != 'session'`,
          [asset]
        );
        log(`[UNBLOCK-SWEEP] UNBLOCKED ${asset} — all conditions passed`);
      } else {
        log(`[UNBLOCK-SWEEP] ${asset} stays blocked: ${reasons.join('; ')}`);
      }
    } catch (e) {
      log(`[UNBLOCK-SWEEP] Error on ${asset}: ${e.message}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('[SESSION-MONITOR] Starting...');
  await clearSessionBlocks();
  log('[SESSION-MONITOR] Running. Loss check every 2min, unblock sweep every 10min.');
  log('[SESSION-MONITOR] Restart this script to start a new session.\n');

  // Run both immediately on startup (after block cleanup)
  await runLossMonitor();
  await runUnblockSweep();

  setInterval(async () => {
    try { await runLossMonitor(); }
    catch (e) { log(`[LOSS-MONITOR] Uncaught: ${e.message}`); }
  }, 2 * 60 * 1000);

  setInterval(async () => {
    try { await runUnblockSweep(); }
    catch (e) { log(`[UNBLOCK-SWEEP] Uncaught: ${e.message}`); }
  }, 10 * 60 * 1000);
}

main().catch(e => {
  process.stderr.write(`[SESSION-MONITOR] Fatal: ${e.message}\n`);
  process.exit(1);
});
