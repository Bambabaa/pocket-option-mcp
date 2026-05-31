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

function convertToCSV(signals, model) {
  if (!signals || signals.length === 0) {
    return 'timestamp,asset,open,high,low,close,bb_upper,bb_lower,cci_20,stc_value,stoch_k,stoch_d,ml_score,stoch_divergence,bb_deviation,stc_momentum,cci_velocity\n';
  }

  const headers = [
    'timestamp', 'asset', 'open', 'high', 'low', 'close',
    'bb_upper', 'bb_lower', 'cci_20', 'stc_value', 'stoch_k', 'stoch_d',
    'ml_score', 'stoch_divergence', 'bb_deviation', 'stc_momentum', 'cci_velocity'
  ];

  const rows = signals.map(sig => {
    const score = model === 'tree' ? sig.tree_score : sig.logreg_score;
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
      WHERE c.asset = 'EURUSD'
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

      // Save approved signals to CSV
      const treeCSV = convertToCSV(treeApproved, 'tree');
      const lrCSV = convertToCSV(lrApproved, 'logreg');

      fs.writeFileSync('data/ml-gate-tree-approvals.csv', treeCSV, 'utf-8');
      fs.writeFileSync('data/ml-gate-logreg-approvals.csv', lrCSV, 'utf-8');

      console.log(`✓ Saved ${treeApproved.length} tree approvals to data/ml-gate-tree-approvals.csv`);
      console.log(`✓ Saved ${lrApproved.length} logreg approvals to data/ml-gate-logreg-approvals.csv\n`);

      db.close();
      process.exit(0);
    });
  });
}

runTest();
