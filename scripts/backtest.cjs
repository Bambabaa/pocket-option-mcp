const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const Indicators = require('../bot/indicators');

const DB_PATH = path.join(__dirname, '../data/trading_data.db');
const MIN_CANDLES = 60;
const LOOKAHEAD = 1; // candles to wait for result

// ── Settings ──
const SETTINGS = {
    ktStrategy: 'video2',
    minPayout: 70,
};

// ── Helpers ──
function formatTime(ts) {
    return new Date(ts * 1000).toLocaleString('en-US', {
        timeZone: 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
}

async function backtest() {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

    // Fetch all candles ordered by asset + timestamp
    const candles = await new Promise((resolve, reject) => {
        db.all('SELECT asset, timestamp, open, high, low, close FROM candles ORDER BY asset ASC, timestamp ASC', (err, rows) => {
            err ? reject(err) : resolve(rows);
        });
    });

    // Group by asset
    const byAsset = {};
    candles.forEach(c => {
        if (!byAsset[c.asset]) byAsset[c.asset] = [];
        byAsset[c.asset].push([c.timestamp, c.open, c.close, c.high, c.low]);
    });

    const indicators = new Indicators();
    const signals = [];
    const results = { CALL: { win: 0, loss: 0, total: 0 }, PUT: { win: 0, loss: 0, total: 0 } };

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  POCKET OPTION BACKTEST — KT Video2 Strategy (Relaxed)');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Assets: ${Object.keys(byAsset).length}`);
    console.log(`  Total candles: ${candles.length}`);
    console.log(`  Lookahead: ${LOOKAHEAD} candle(s) for WIN/LOSS`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const [asset, candleArr] of Object.entries(byAsset)) {
        if (candleArr.length < MIN_CANDLES) {
            console.log(`  ⏭️  ${asset}: only ${candleArr.length} candles (need ${MIN_CANDLES})`);
            continue;
        }

        let assetSignals = 0;
        for (let i = MIN_CANDLES; i < candleArr.length - LOOKAHEAD; i++) {
            const slice = candleArr.slice(0, i + 1);
            const calc = indicators.calculateAll(asset, slice, SETTINGS);
            if (!calc || !calc.signals) continue;

            const sig = calc.signals;
            if (sig.direction !== 'CALL' && sig.direction !== 'PUT') continue;

            assetSignals++;

            // Determine outcome: compare entry close to LOOKAHEAD-candle-ahead close
            const entryClose = candleArr[i][2];
            const exitClose = candleArr[i + LOOKAHEAD][2];

            let outcome;
            if (sig.direction === 'CALL') {
                outcome = exitClose > entryClose ? 'WIN' : 'LOSS';
            } else {
                outcome = exitClose < entryClose ? 'WIN' : 'LOSS';
            }

            results[sig.direction].total++;
            results[sig.direction][outcome.toLowerCase()]++;

            signals.push({
                asset,
                time: formatTime(candleArr[i][0]),
                direction: sig.direction,
                entry: entryClose,
                exit: exitClose,
                outcome,
                reasons: sig.reasons.join(' | '),
                rsi: calc.rsi_5?.toFixed(1),
                k: calc.stochastic_k?.toFixed(1),
                d: calc.stochastic_d?.toFixed(1),
            });
        }

        if (assetSignals > 0) {
            console.log(`  ✅ ${asset}: ${assetSignals} signals generated`);
        }
    }

    // ── Print Results ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════════════');

    const totalSignals = results.CALL.total + results.PUT.total;
    const totalWins = results.CALL.win + results.PUT.win;
    const winRate = totalSignals > 0 ? ((totalWins / totalSignals) * 100).toFixed(1) : '0.0';

    console.log(`  CALL: ${results.CALL.win}W / ${results.CALL.loss}L  (${results.CALL.total} total, ${results.CALL.total > 0 ? ((results.CALL.win / results.CALL.total) * 100).toFixed(1) : 0}% win rate)`);
    console.log(`  PUT:  ${results.PUT.win}W / ${results.PUT.loss}L  (${results.PUT.total} total, ${results.PUT.total > 0 ? ((results.PUT.win / results.PUT.total) * 100).toFixed(1) : 0}% win rate)`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  TOTAL: ${totalWins}W / ${totalSignals - totalWins}L  (${totalSignals} signals, ${winRate}% win rate)`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ── Replay Mode ──
    if (signals.length === 0) {
        console.log('  No signals generated. Consider relaxing thresholds further.\n');
    } else {
        console.log('  SIGNAL REPLAY (first 20):\n');
        const show = signals.slice(0, 20);
        show.forEach((s, idx) => {
            const emoji = s.outcome === 'WIN' ? '✅' : '❌';
            const arrow = s.direction === 'CALL' ? '▲' : '▼';
            console.log(`  ${emoji} [${idx + 1}] ${s.time} | ${s.asset} ${arrow} ${s.direction} | RSI=${s.rsi} K=${s.k} D=${s.d}`);
            console.log(`        Entry: ${s.entry} → Exit: ${s.exit} → ${s.outcome}`);
            console.log(`        ${s.reasons}`);
            console.log('');
        });

        if (signals.length > 20) {
            console.log(`  ... and ${signals.length - 20} more signals\n`);
        }
    }

    db.close();
}

backtest().catch(err => {
    console.error('Backtest error:', err);
    process.exit(1);
});
