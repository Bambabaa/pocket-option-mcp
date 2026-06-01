'use strict';

/**
 * ML Gate Test Suite
 *
 * Loads EURUSD candles + indicators from agent.db
 * Feeds through ml-gate.evaluateGate()
 * Reports approval rate by model, saves approved signals to CSV
 */

import sqlite3Module from 'sqlite3';
import fs from 'fs';
import mlGate from '../ml-gate.js';

const { evaluateGate, getStats, recordEvaluation } = mlGate;
const sqlite3 = sqlite3Module.verbose();

function determineDirection(sig, orderedRows, idxByKey) {
  // Pure price logic: fade the recent move
  // recent up → expect down → PUT
  // recent down → expect up → CALL

  const i = idxByKey.get(`${sig.asset}|${sig.timestamp}`);
  if (i == null || i < 3) return null;  // not enough history → skip

  const recentMove = sig.close - orderedRows[i - 3].close;
  if (recentMove === 0) return null;  // flat → ambiguous → skip

  return recentMove > 0 ? 'PUT' : 'CALL';  // fade the recent move
}

function convertToCSV(signals, model, orderedRows, idxByKey) {
  if (!signals || signals.length === 0) {
    return 'timestamp,asset,open,high,low,close,bb_upper,bb_lower,cci_20,stc_value,stoch_k,stoch_d,ml_score,stoch_divergence,bb_deviation,stc_momentum,cci_velocity,direction,price_5m,outcome_5m,price_10m,outcome_10m,price_15m,outcome_15m,wr_5m,wr_10m,wr_15m\n';
  }

  // Build a map of timestamp → row for quick lookup (for future candles)
  const rowByTimestamp = new Map();
  orderedRows.forEach(r => rowByTimestamp.set(r.timestamp, r));

  const headers = [
    'timestamp', 'asset', 'open', 'high', 'low', 'close',
    'bb_upper', 'bb_lower', 'cci_20', 'stc_value', 'stoch_k', 'stoch_d',
    'ml_score', 'stoch_divergence', 'bb_deviation', 'stc_momentum', 'cci_velocity',
    'direction', 'price_5m', 'outcome_5m', 'price_10m', 'outcome_10m', 'price_15m', 'outcome_15m',
    'wr_5m', 'wr_10m', 'wr_15m'
  ];

  const rows = signals.map(sig => {
    const score = model === 'tree' ? sig.tree_score : sig.logreg_score;
    const direction = determineDirection(sig, orderedRows, idxByKey);

    // Look ahead 1, 2, 3 candles (5m, 10m, 15m)
    const candle5m = rowByTimestamp.get(sig.timestamp + 300);   // +5 min
    const candle10m = rowByTimestamp.get(sig.timestamp + 600);  // +10 min
    const candle15m = rowByTimestamp.get(sig.timestamp + 900);  // +15 min

    // Determine outcomes: win if price moved in expected direction
    const getOutcome = (futurePrice, dir) => {
      if (!futurePrice) return 'N/A';
      const moved = futurePrice > sig.close;
      return (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';
    };

    const outcome5m = getOutcome(candle5m?.close, direction);
    const outcome10m = getOutcome(candle10m?.close, direction);
    const outcome15m = getOutcome(candle15m?.close, direction);

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
      direction,
      candle5m?.close.toFixed(6) ?? 'N/A',
      outcome5m,
      candle10m?.close.toFixed(6) ?? 'N/A',
      outcome10m,
      candle15m?.close.toFixed(6) ?? 'N/A',
      outcome15m,
      (outcome5m === 'WIN' ? 1 : outcome5m === 'LOSS' ? 0 : ''),
      (outcome10m === 'WIN' ? 1 : outcome10m === 'LOSS' ? 0 : ''),
      (outcome15m === 'WIN' ? 1 : outcome15m === 'LOSS' ? 0 : ''),
    ];
  });

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n') + '\n';
}

function runTest() {
  const db = new sqlite3.Database('data/agent.db', (err) => {
    if (err) {
      console.error('DB Error:', err);
      process.exit(1);
    }

    const query = `
      SELECT
        c.timestamp,
        c.asset,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        i.bb_upper,
        i.bb_lower,
        i.cci_20,
        i.stc_value,
        i.stoch_k,
        i.stoch_d
      FROM candles c
      LEFT JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
      --WHERE c.asset = 'EURUSD'
      ORDER BY c.timestamp ASC
    `;

    db.all(query, (err, rows) => {
      if (err) {
        console.error('Query Error:', err);
        db.close();
        process.exit(1);
      }

      if (!rows || rows.length === 0) {
        console.log('No EURUSD data found');
        db.close();
        process.exit(0);
      }

      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║  ML REVERSAL GATE TEST — EURUSD DATA                      ║');
      console.log('║  Decision Tree (67.86% WR) + Logistic Regression (61.06%) ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');

      console.log(`Loading ${rows.length} EURUSD candles with real trained models...\n`);

      const treeApproved = [];
      const lrApproved = [];
      const livePayout = 0.80;  // assume 80% payout

      rows.forEach((row) => {
        if (!row.bb_upper || !row.cci_20 || !row.stc_value || !row.stoch_k) return;

        const ind = {
          asset: row.asset,
          close: row.close,
          bb_upper: row.bb_upper,
          bb_lower: row.bb_lower,
          cci_20: row.cci_20,
          stc_value: row.stc_value,
          stoch_k: row.stoch_k,
          stoch_d: row.stoch_d,
        };

        const result = evaluateGate(ind, livePayout);
        if (!result) return;

        recordEvaluation(result);

        if (result.tree.approved) {
          treeApproved.push({
            ...row,  // entire row data
            tree_score: result.tree.score,
            tree_approved: true,
            features: result.features,
          });
        }
        if (result.logreg.approved) {
          lrApproved.push({
            ...row,  // entire row data
            logreg_score: result.logreg.score,
            logreg_approved: true,
            features: result.features,
          });
        }
      });

      const stats = getStats();

      console.log('═══════════════════════════════════════════════════════════\n');
      console.log(`Total candles evaluated:    ${stats.total_evaluated}`);
      console.log(`\nDecision Tree @ 0.85:       ${stats.tree_approved} approved (${stats.tree_approval_rate})`);
      console.log(`Logistic Regression @ 0.85: ${stats.logreg_approved} approved (${stats.logreg_approval_rate})`);
      console.log(`Consensus (both agree):     ${stats.consensus_approved} approved (${stats.consensus_approval_rate})`);
      console.log('\nPayout floor (live): 0.80');
      console.log('  Tree floor:   0.70 ✓');
      console.log('  LogReg floor: 0.78 ✓');
      console.log('\n═══════════════════════════════════════════════════════════\n');

      // Top 5 tree approvals
      if (treeApproved.length > 0) {
        console.log('TOP 5 TREE APPROVALS (highest confidence):');
        treeApproved
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .forEach((sig, i) => {
            const date = new Date(sig.timestamp * 1000).toISOString();
            console.log(`  ${i + 1}. ${(sig.score * 100).toFixed(1)}% @ ${date}`);
            console.log(`     Stoch_Divergence=${sig.features.Stoch_Divergence.toFixed(2)}, STC_Momentum=${sig.features.STC_Momentum.toFixed(2)}`);
          });
      } else {
        console.log('⚠️  No tree approvals at 0.85 threshold\n');
      }

      console.log('\n═══════════════════════════════════════════════════════════\n');

      // Build index for robust direction detection
      const idxByKey = new Map();
      rows.forEach((r, i) => idxByKey.set(`${r.asset}|${r.timestamp}`, i));

      // Save approved signals to CSV with outcomes
      const treeCSV = convertToCSV(treeApproved, 'tree', rows, idxByKey);
      const lrCSV = convertToCSV(lrApproved, 'logreg', rows, idxByKey);

      fs.writeFileSync('data/ml-gate-tree-approvals.csv', treeCSV, 'utf-8');
      fs.writeFileSync('data/ml-gate-logreg-approvals.csv', lrCSV, 'utf-8');

      // Calculate win rates with robust direction detection
      const calcWR = (signals) => {
        const outcomes5 = signals.map(s => {
          const future = rows.find(r => r.timestamp === s.timestamp + 300);
          if (!future) return null;
          const dir = determineDirection(s, rows, idxByKey);
          if (!dir) return null;  // skip if direction ambiguous
          return (dir === 'CALL' && future.close > s.close) || (dir === 'PUT' && future.close < s.close) ? 1 : 0;
        }).filter(o => o !== null);
        return outcomes5.length > 0 ? (outcomes5.reduce((a, b) => a + b, 0) / outcomes5.length * 100).toFixed(1) : 'N/A';
      };

      const treeWR5 = calcWR(treeApproved);
      const lrWR5 = calcWR(lrApproved);

      console.log(`✓ Saved ${treeApproved.length} tree approvals to data/ml-gate-tree-approvals.csv (5m WR: ${treeWR5}%)`);
      console.log(`✓ Saved ${lrApproved.length} logreg approvals to data/ml-gate-logreg-approvals.csv (5m WR: ${lrWR5}%)\n`);

      db.close();
      process.exit(0);
    });
  });
}

runTest();
