'use strict';

/**
 * FAST Signal Simulator — Matches test-ml-gate.mjs exactly
 *
 * Loads pre-calculated indicators from agent.db (not recalculating)
 * Evaluates ML gate, validates outcomes, compares vs baseline
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const mlGate = require('../ml-gate');

const AGENT_DB_PATH = path.join(__dirname, '../../data/agent.db');

function log(m) { console.log(m); }
function dbAll(db, sql, params = []) {
    return new Promise((r, j) => db.all(sql, params, (e, rows) => e ? j(e) : r(rows || [])));
}

function computeDirection(candles, index) {
    if (!candles || index < 3) return null;
    const move = candles[index][2] - candles[index - 3][2]; // close - close
    return move === 0 ? null : move > 0 ? 'PUT' : 'CALL';
}

async function main() {
    log('\n╔════════════════════════════════════════════════════════════╗');
    log('║        SIGNAL SIMULATOR — Fast In-Memory Test             ║');
    log('╚════════════════════════════════════════════════════════════╝\n');

    const db = await new Promise((r, j) => {
        const x = new sqlite3.Database(AGENT_DB_PATH, sqlite3.OPEN_READONLY, e => e ? j(e) : r(x));
    });

    // PHASE 1: Load all candles + indicators (pre-calculated, like test-ml-gate.mjs)
    log('✅ Loading candles + indicators from agent.db...');
    const rows = await dbAll(db, `
        SELECT c.timestamp, c.asset, c.open, c.high, c.low, c.close, c.volume,
               i.bb_upper, i.bb_lower, i.cci_20, i.stc_value, i.stoch_k, i.stoch_d
        FROM candles c
        LEFT JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        ORDER BY c.asset ASC, c.timestamp ASC
    `);

    log(`📋 Loaded ${rows.length} rows across ${new Set(rows.map(r => r.asset)).size} assets\n`);

    // PHASE 2: Group by asset (per-asset ordered series, leak-proof)
    const byAsset = new Map();
    for (const r of rows) {
        if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
        byAsset.get(r.asset).push(r);
    }
    for (const arr of byAsset.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    // PHASE 3: Evaluate ML gate on all rows
    log('🔄 Evaluating ML gate...');
    const treeSignals = [];
    const lrSignals = [];

    for (const row of rows) {
        if (row.bb_upper == null || row.cci_20 == null || row.stc_value == null || row.stoch_k == null) continue;

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

        const result = mlGate.evaluateGate(ind, 0.80);
        if (!result) continue;

        if (result.tree.approved) {
            treeSignals.push({ ...row, score: result.tree.score });
        }
        if (result.logreg.approved) {
            lrSignals.push({ ...row, score: result.logreg.score });
        }
    }

    log(`✅ Tree: ${treeSignals.length}, LogReg: ${lrSignals.length}\n`);

    // PHASE 4: Validate (look 3 bars ahead for 15m outcome)
    log('⚙️  Validating outcomes...');
    const results = { TREE: { total: 0, wins: 0 }, LOGREG: { total: 0, wins: 0 } };

    for (const sig of treeSignals) {
        const arr = byAsset.get(sig.asset);
        const idx = arr.findIndex(r => r.timestamp === sig.timestamp);
        if (idx < 0 || idx + 3 >= arr.length) continue;

        const dir = computeDirection(arr.map(r => [r.timestamp, r.open, r.close, r.high, r.low]), idx);
        if (!dir) continue;

        const futurePrice = arr[idx + 3].close;
        const entryPrice = arr[idx].close;
        const moved = futurePrice > entryPrice;

        // CALL wins if UP, PUT wins if DOWN (matches test-ml-gate.mjs)
        const result = (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';

        results.TREE.total++;
        if (result === 'WIN') results.TREE.wins++;
    }

    for (const sig of lrSignals) {
        const arr = byAsset.get(sig.asset);
        const idx = arr.findIndex(r => r.timestamp === sig.timestamp);
        if (idx < 0 || idx + 3 >= arr.length) continue;

        const dir = computeDirection(arr.map(r => [r.timestamp, r.open, r.close, r.high, r.low]), idx);
        if (!dir) continue;

        const futurePrice = arr[idx + 3].close;
        const entryPrice = arr[idx].close;
        const moved = futurePrice > entryPrice;

        const result = (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';

        results.LOGREG.total++;
        if (result === 'WIN') results.LOGREG.wins++;
    }

    db.close();

    // PHASE 5: Report
    const tWR = results.TREE.total > 0 ? ((results.TREE.wins / results.TREE.total) * 100).toFixed(1) : 'N/A';
    const lWR = results.LOGREG.total > 0 ? ((results.LOGREG.wins / results.LOGREG.total) * 100).toFixed(1) : 'N/A';
    const bWR = (results.TREE.total + results.LOGREG.total) > 0 ?
        (((results.TREE.wins + results.LOGREG.wins) / (results.TREE.total + results.LOGREG.total)) * 100).toFixed(1) : 'N/A';

    log('\n╔════════════════════════════════════════════════════════════╗');
    log('║           5M BASELINE RESULTS (agent.db)                  ║');
    log('╠════════════════════════════════════════════════════════════╣');
    log(`║  TREE          ${String(results.TREE.total).padStart(3)} signals | ${String(results.TREE.wins).padStart(3)} wins | ${String(tWR).padStart(5)}%  ║`);
    log(`║  LOGREG        ${String(results.LOGREG.total).padStart(3)} signals | ${String(results.LOGREG.wins).padStart(3)} wins | ${String(lWR).padStart(5)}%  ║`);
    log('╠════════════════════════════════════════════════════════════╣');
    log(`║  BLENDED       ${String(results.TREE.total + results.LOGREG.total).padStart(3)} signals | ${String(results.TREE.wins + results.LOGREG.wins).padStart(3)} wins | ${String(bWR).padStart(5)}%  ║`);
    log('╠════════════════════════════════════════════════════════════╣');
    log('║  Expected (test-ml-gate.mjs @ 15m):                       ║');
    log('║  Tree: 84.6%, LogReg: 60.7%                              ║');
    log('╚════════════════════════════════════════════════════════════╝\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
