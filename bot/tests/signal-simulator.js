'use strict';

/**
 * FAST Signal Simulator — Writes to trading_data.db as bot would
 *
 * Phase 1: Load candles + indicators from agent.db
 * Phase 2: Generate signals via ML gate cascade
 * Phase 3: Write signals to trading_data.db (like bot does)
 * Phase 4: Validate outcomes at 15m horizon
 * Phase 5: Report results
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const mlGate = require('../ml-gate');
const { TradingDatabase } = require('../database');

const AGENT_DB_PATH = path.join(__dirname, '../../agent/data/agent_hist.db');
const TRADING_DB_PATH = path.join(__dirname, '../../data/trading_data.db');

function log(m) { console.log(m); }
function dbAll(db, sql, params = []) {
    return new Promise((r, j) => db.all(sql, params, (e, rows) => e ? j(e) : r(rows || [])));
}
function dbRun(db, sql, params = []) {
    return new Promise((r, j) => db.run(sql, params, function(e) { e ? j(e) : r(this); }));
}

function computeDirection(candles, index) {
    if (!candles || index < 3) return null;
    const move = candles[index][2] - candles[index - 3][2]; // close - close
    return move === 0 ? null : move > 0 ? 'PUT' : 'CALL';
}

async function main() {
    log('\n╔════════════════════════════════════════════════════════════╗');
    log('║        SIGNAL SIMULATOR — Writing to trading_data.db      ║');
    log('╚════════════════════════════════════════════════════════════╝\n');

    const agentDb = await new Promise((r, j) => {
        const x = new sqlite3.Database(AGENT_DB_PATH, sqlite3.OPEN_READONLY, e => e ? j(e) : r(x));
    });

    const tradingDb = new TradingDatabase(TRADING_DB_PATH);
    await tradingDb.initialize();

    // PHASE 1: Load all candles + indicators from agent.db
    log('✅ Loading candles + indicators from agent.db...');
    const rows = await dbAll(agentDb, `
        SELECT c.timestamp, c.asset, c.open, c.high, c.low, c.close,
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

    // PHASE 3: Generate signals & write to trading_data.db
    log('🔄 Generating and storing signals in trading_data.db...');
    let treeCount = 0, lrCount = 0;
    const generatedSignals = [];

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

        // Cascade: tree → logreg
        let modelUsed, score;
        if (result.tree?.approved) {
            modelUsed = 'ML_REVERSAL_GATE_TREE';
            score = result.tree.score;
            treeCount++;
        } else if (result.logreg?.approved) {
            modelUsed = 'ML_REVERSAL_GATE_LOGREG';
            score = result.logreg.score;
            lrCount++;
        } else {
            continue;
        }

        // Direction: fade 3-bar move
        const arr = byAsset.get(row.asset);
        const idx = arr.findIndex(r => r.timestamp === row.timestamp);
        if (idx < 3) continue;

        const direction = computeDirection(arr.map(r => [r.timestamp, r.open, r.close, r.high, r.low]), idx);
        if (!direction) continue;

        // Create signal object
        const signal = {
            direction,
            strategyUsed: modelUsed,
            tier: 1,
            ml_score: score,
            ml_model: modelUsed.includes('TREE') ? 'tree' : 'logreg',
            reasons: [
                `[ML-GATE] ${modelUsed}`,
                `Score: ${score.toFixed(4)}, Payout: 80.0%`,
                `Expected WR @ 15m: ${modelUsed.includes('TREE') ? '84.6%' : '60.7%'}`
            ]
        };

        // Write to trading_data.db
        try {
            await tradingDb.insertSignal(row.asset, row.timestamp, signal);
            generatedSignals.push({ asset: row.asset, timestamp: row.timestamp, close: row.close, ...signal });
        } catch (e) {
            if (!e.message?.includes('UNIQUE constraint')) {
                console.error(`   ❌ Error inserting signal for ${row.asset}:`, e.message);
            }
        }
    }

    log(`✅ Tree: ${treeCount}, LogReg: ${lrCount}\n`);

    // PHASE 4: Validate (look 3 bars ahead for 15m outcome)
    log('⚙️  Validating outcomes at 15m horizon...');
    const results = { TREE: { total: 0, wins: 0 }, LOGREG: { total: 0, wins: 0 } };
    const outcomeWrites = [];

    for (const sig of generatedSignals) {
        const arr = byAsset.get(sig.asset);
        const idx = arr.findIndex(r => r.timestamp === sig.timestamp);
        if (idx < 0 || idx + 3 >= arr.length) continue;

        const dir = computeDirection(arr.map(r => [r.timestamp, r.open, r.close, r.high, r.low]), idx);
        if (!dir) continue;

        const futurePrice = arr[idx + 3].close;
        const entryPrice = arr[idx].close;
        const moved = futurePrice > entryPrice;

        // CALL wins if UP, PUT wins if DOWN
        const result = (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';

        const modelKey = sig.ml_model.toUpperCase();
        results[modelKey].total++;
        if (result === 'WIN') results[modelKey].wins++;

        outcomeWrites.push({ asset: sig.asset, timestamp: sig.timestamp, direction: sig.direction, entry_price: sig.close, result });
    }

    log(`📝 Writing ${outcomeWrites.length} signal outcomes to trading_data.db...`);
    let outcomeCount = 0;
    for (const outcome of outcomeWrites) {
        try {
            const now = Math.floor(Date.now() / 1000);
            await tradingDb.run(
                `INSERT INTO signal_outcomes
                 (asset, signal_timestamp, direction, entry_price, result, profit_loss, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [outcome.asset, outcome.timestamp, outcome.direction, outcome.entry_price, outcome.result, outcome.result === 'WIN' ? 1 : -1, now]
            );
            outcomeCount++;
        } catch (e) {
            console.error(`   ❌ Error storing outcome for ${outcome.asset} @ ${outcome.timestamp}:`, e.message);
        }
    }
    log(`✅ Wrote ${outcomeCount}/${outcomeWrites.length} outcomes`);

    agentDb.close();
    tradingDb.close();

    // PHASE 5: Report
    const tWR = results.TREE.total > 0 ? ((results.TREE.wins / results.TREE.total) * 100).toFixed(1) : 'N/A';
    const lWR = results.LOGREG.total > 0 ? ((results.LOGREG.wins / results.LOGREG.total) * 100).toFixed(1) : 'N/A';
    const bWR = (results.TREE.total + results.LOGREG.total) > 0 ?
        (((results.TREE.wins + results.LOGREG.wins) / (results.TREE.total + results.LOGREG.total)) * 100).toFixed(1) : 'N/A';

    log('\n╔════════════════════════════════════════════════════════════╗');
    log('║           RESULTS — Signals stored in trading_data.db      ║');
    log('╠════════════════════════════════════════════════════════════╣');
    log(`║  TREE          ${String(results.TREE.total).padStart(3)} signals | ${String(results.TREE.wins).padStart(3)} wins | ${String(tWR).padStart(5)}%  ║`);
    log(`║  LOGREG        ${String(results.LOGREG.total).padStart(3)} signals | ${String(results.LOGREG.wins).padStart(3)} wins | ${String(lWR).padStart(5)}%  ║`);
    log('╠════════════════════════════════════════════════════════════╣');
    log(`║  BLENDED       ${String(results.TREE.total + results.LOGREG.total).padStart(3)} signals | ${String(results.TREE.wins + results.LOGREG.wins).padStart(3)} wins | ${String(bWR).padStart(5)}%  ║`);
    log('╠════════════════════════════════════════════════════════════╣');
    log('║  Expected (test-ml-gate.mjs @ 15m):                       ║');
    log('║  Tree: 84.6%, LogReg: 60.7%                              ║');
    log('║                                                            ║');
    log('║  ✅ All signals written to trading_data.db                ║');
    log('║  ✅ Query: SELECT COUNT(*) FROM signals                   ║');
    log('║     WHERE strategy_used LIKE \'ML_REVERSAL_GATE%\'        ║');
    log('╚════════════════════════════════════════════════════════════╝\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
