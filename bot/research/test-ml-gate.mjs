'use strict';

/**
 * ML Gate Test Suite  (corrected — per-asset series, leak-proof)
 *
 * Loads candles + indicators (all assets) from agent.db, feeds each closed bar
 * through ml-gate.evaluateGate(), records approvals, then assigns direction and
 * outcomes using PER-ASSET ordered series so no lookup can ever cross assets.
 *
 * FIX vs prior version:
 *   The old query ordered by timestamp only, so `rows` interleaved all 13 assets.
 *   `orderedRows[i-3]` then stepped back into a DIFFERENT asset at the same
 *   timestamp (e.g. EURUSD.close - EURAUD.close), making the recent-move sign
 *   meaningless. Here we group rows into one ordered array per asset and index
 *   by position within that asset, so direction = fade(close[t] - close[t-3])
 *   is always same-asset, and outcome lookups (t+1,t+2,t+3) are same-asset too.
 *
 * Data source: sqlite3 if available, else data/candles.json (Python dump).
 */

import fs from 'fs';
import mlGate from './ml-gate.js';
const { evaluateGate, getStats, recordEvaluation } = mlGate;

// ── Data loading (sqlite3 primary, JSON fallback) ───────────────────────────
async function loadRows() {
  try {
    const sqlite3Module = await import('sqlite3');
    const sqlite3 = sqlite3Module.default.verbose();
    return await new Promise((resolve, reject) => {
      const db = new sqlite3.Database('data/agent.db', (err) => { if (err) reject(err); });
      db.all(`
        SELECT c.timestamp, c.asset, c.open, c.high, c.low, c.close, c.volume,
               i.bb_upper, i.bb_lower, i.cci_20, i.stc_value, i.stoch_k, i.stoch_d
        FROM candles c
        LEFT JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        ORDER BY c.asset ASC, c.timestamp ASC
      `, (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
    });
  } catch (e) {
    console.log('(sqlite3 unavailable — loading data/candles.json fallback)');
    const raw = JSON.parse(fs.readFileSync('data/candles.json', 'utf-8'));
    // ensure per-asset, per-time ordering regardless of dump order
    raw.sort((a, b) => a.asset < b.asset ? -1 : a.asset > b.asset ? 1
                       : a.timestamp - b.timestamp);
    return raw;
  }
}

// ── Per-asset series (Option B): leak-proof structure ───────────────────────
function buildAssetSeries(rows) {
  const byAsset = new Map();      // asset -> ordered array of rows
  for (const r of rows) {
    if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
    byAsset.get(r.asset).push(r);
  }
  // guarantee time order within each asset
  for (const arr of byAsset.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  const posByKey = new Map();     // "asset|timestamp" -> position within its asset array
  for (const [a, arr] of byAsset) arr.forEach((r, p) => posByKey.set(`${a}|${r.timestamp}`, p));
  return { byAsset, posByKey };
}

// ── Direction: fade the recent 3-bar move (same-asset, gap-safe) ────────────
function determineDirection(sig, byAsset, posByKey) {
  const arr = byAsset.get(sig.asset);
  const p = posByKey.get(`${sig.asset}|${sig.timestamp}`);
  if (arr == null || p == null || p < 3) return null;   // not enough history
  const recentMove = sig.close - arr[p - 3].close;       // SAME asset, 3 bars back
  if (recentMove === 0) return null;                     // flat → ambiguous
  return recentMove > 0 ? 'PUT' : 'CALL';                // fade it
}

// ── CSV with per-asset outcome lookups ──────────────────────────────────────
function convertToCSV(signals, model, byAsset, posByKey) {
  const headers = [
    'timestamp', 'asset', 'open', 'high', 'low', 'close',
    'bb_upper', 'bb_lower', 'cci_20', 'stc_value', 'stoch_k', 'stoch_d',
    'ml_score', 'stoch_divergence', 'bb_deviation', 'stc_momentum', 'cci_velocity',
    'direction', 'recent_move', 'price_5m', 'outcome_5m', 'price_10m', 'outcome_10m',
    'price_15m', 'outcome_15m', 'wr_5m', 'wr_10m', 'wr_15m',
  ];
  if (!signals || signals.length === 0) return headers.join(',') + '\n';

  const getOutcome = (futurePrice, dir, entry) => {
    if (futurePrice == null) return 'N/A';
    const moved = futurePrice > entry;
    return (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';
  };

  const lines = signals.map(sig => {
    const score = model === 'tree' ? sig.tree_score : sig.logreg_score;
    const arr = byAsset.get(sig.asset);
    const p = posByKey.get(`${sig.asset}|${sig.timestamp}`);
    const direction = determineDirection(sig, byAsset, posByKey);
    const recentMove = (p != null && p >= 3) ? sig.close - arr[p - 3].close : null;

    // SAME-asset forward bars by position (gap-safe; never crosses assets)
    const c5  = (p != null && p + 1 < arr.length) ? arr[p + 1] : null;
    const c10 = (p != null && p + 2 < arr.length) ? arr[p + 2] : null;
    const c15 = (p != null && p + 3 < arr.length) ? arr[p + 3] : null;

    const o5  = getOutcome(c5?.close,  direction, sig.close);
    const o10 = getOutcome(c10?.close, direction, sig.close);
    const o15 = getOutcome(c15?.close, direction, sig.close);

    return [
      new Date(sig.timestamp * 1000).toISOString(),
      sig.asset,
      (sig.open ?? sig.close).toFixed(6),
      (sig.high ?? sig.close).toFixed(6),
      (sig.low ?? sig.close).toFixed(6),
      sig.close.toFixed(6),
      sig.bb_upper.toFixed(6),
      sig.bb_lower.toFixed(6),
      sig.cci_20.toFixed(2),
      sig.stc_value.toFixed(2),
      sig.stoch_k.toFixed(2),
      sig.stoch_d.toFixed(2),
      score.toFixed(6),
      sig.features.Stoch_Divergence.toFixed(4),
      sig.features.BB_Deviation.toFixed(4),
      sig.features.STC_Momentum.toFixed(4),
      sig.features.CCI_Velocity.toFixed(4),
      direction ?? 'N/A',
      recentMove == null ? 'N/A' : recentMove.toFixed(6),
      c5?.close?.toFixed(6) ?? 'N/A',  o5,
      c10?.close?.toFixed(6) ?? 'N/A', o10,
      c15?.close?.toFixed(6) ?? 'N/A', o15,
      (o5  === 'WIN' ? 1 : o5  === 'LOSS' ? 0 : ''),
      (o10 === 'WIN' ? 1 : o10 === 'LOSS' ? 0 : ''),
      (o15 === 'WIN' ? 1 : o15 === 'LOSS' ? 0 : ''),
    ].join(',');
  });
  return [headers.join(','), ...lines].join('\n') + '\n';
}

// ── WR helper (per-asset, by horizon) ───────────────────────────────────────
function winRate(signals, byAsset, posByKey, stepsAhead) {
  const outs = [];
  for (const sig of signals) {
    const arr = byAsset.get(sig.asset);
    const p = posByKey.get(`${sig.asset}|${sig.timestamp}`);
    if (arr == null || p == null) continue;
    const dir = determineDirection(sig, byAsset, posByKey);
    if (!dir) continue;
    const fut = (p + stepsAhead < arr.length) ? arr[p + stepsAhead] : null;
    if (!fut) continue;
    const win = (dir === 'CALL' && fut.close > sig.close) ||
                (dir === 'PUT'  && fut.close < sig.close);
    outs.push(win ? 1 : 0);
  }
  return outs.length ? { wr: (outs.reduce((a, b) => a + b, 0) / outs.length * 100), n: outs.length }
                     : { wr: null, n: 0 };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function runTest() {
  const rows = await loadRows();
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  ML REVERSAL GATE TEST — ALL ASSETS (corrected)            ║');
  console.log('║  Decision Tree + Logistic Regression @ 0.85               ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`Loaded ${rows.length.toLocaleString()} candles across ` +
              `${new Set(rows.map(r => r.asset)).size} assets\n`);

  const { byAsset, posByKey } = buildAssetSeries(rows);

  const treeApproved = [];
  const lrApproved = [];
  const livePayout = 0.80;

  for (const row of rows) {
    if (row.bb_upper == null || row.cci_20 == null || row.stc_value == null || row.stoch_k == null) continue;
    const ind = {
      asset: row.asset, close: row.close,
      bb_upper: row.bb_upper, bb_lower: row.bb_lower,
      cci_20: row.cci_20, stc_value: row.stc_value,
      stoch_k: row.stoch_k, stoch_d: row.stoch_d,
    };
    const result = evaluateGate(ind, livePayout);
    if (!result) continue;
    recordEvaluation(result);
    if (result.tree.approved)
      treeApproved.push({ ...row, tree_score: result.tree.score, features: result.features });
    if (result.logreg.approved)
      lrApproved.push({ ...row, logreg_score: result.logreg.score, features: result.features });
  }

  const stats = getStats();
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Total candles evaluated:    ${stats.total_evaluated.toLocaleString()}`);
  console.log(`Decision Tree @ 0.85:       ${stats.tree_approved} approved (${stats.tree_approval_rate})`);
  console.log(`Logistic Regression @ 0.85: ${stats.logreg_approved} approved (${stats.logreg_approval_rate})`);
  console.log(`Consensus (both agree):     ${stats.consensus_approved} approved (${stats.consensus_approval_rate})`);
  console.log('\n═══════════════════════════════════════════════════════════\n');

  // realized WR per horizon, correct per-asset direction
  for (const [label, sigs] of [['TREE', treeApproved], ['LOGREG', lrApproved]]) {
    const w5 = winRate(sigs, byAsset, posByKey, 1);
    const w10 = winRate(sigs, byAsset, posByKey, 2);
    const w15 = winRate(sigs, byAsset, posByKey, 3);
    const fmt = (w) => w.wr == null ? 'N/A' : `${w.wr.toFixed(1)}% (n=${w.n})`;
    console.log(`${label} realized WR — 5m: ${fmt(w5)}  10m: ${fmt(w10)}  15m: ${fmt(w15)}`);
    // direction split
    const dirs = sigs.map(s => determineDirection(s, byAsset, posByKey)).filter(Boolean);
    const calls = dirs.filter(d => d === 'CALL').length;
    console.log(`   direction split: CALL=${calls}  PUT=${dirs.length - calls}  (skipped=${sigs.length - dirs.length})`);
  }
  console.log('');

  const treeCSV = convertToCSV(treeApproved, 'tree', byAsset, posByKey);
  const lrCSV = convertToCSV(lrApproved, 'logreg', byAsset, posByKey);
  fs.writeFileSync('data/ml-gate-tree-approvals.csv', treeCSV, 'utf-8');
  fs.writeFileSync('data/ml-gate-logreg-approvals.csv', lrCSV, 'utf-8');
  console.log(`✓ Saved ${treeApproved.length} tree approvals → data/ml-gate-tree-approvals.csv`);
  console.log(`✓ Saved ${lrApproved.length} logreg approvals → data/ml-gate-logreg-approvals.csv\n`);
}

runTest().catch(e => { console.error(e); process.exit(1); });
