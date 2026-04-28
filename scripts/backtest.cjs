const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const Indicators = require('../bot/indicators');

const DB_PATH = path.join(__dirname, '../data/trading_data.db');
const MIN_CANDLES = 60;

// ── Matches live bot settings ──
const SETTINGS = {
    Strategy: ' ',
    minPayout: 70,
    execution: { enabled: true },
    tradeAmount: 500,
};
const LOOKAHEAD_SECONDS = 60;   // Matches live bot: lookAheadSeconds: 60
const PRICE_TOLERANCE = 5;      // Matches live bot: ±5s tolerance

// ── Helpers ──
function formatTime(ts) {
    return new Date(ts * 1000).toLocaleString('en-US', {
        timeZone: 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
}

/**
 * Find exit price exactly like validate-signals.js:
 *   1. Look for price at (signalTs + lookAhead) ± tolerance
 *   2. Fallback: closest candle close within [signalTs, signalTs + lookAhead + 60]
 */
function findExitPrice(candleArr, signalTs, lookAhead = LOOKAHEAD_SECONDS) {
    const expirationTime = signalTs + lookAhead;
    const tolerance = Math.min(PRICE_TOLERANCE, Math.max(1, Math.floor(lookAhead / 2)));

    // Step 1: Find candle closest to expirationTime within tolerance
    let bestPrice = null;
    let bestTs = null;
    let bestDist = Infinity;
    for (const candle of candleArr) {
        const dist = Math.abs(candle[0] - expirationTime);
        if (dist <= tolerance && dist < bestDist) {
            bestDist = dist;
            bestPrice = candle[2]; // close
            bestTs = candle[0];
        }
    }
    if (bestPrice !== null) {
        return { price: bestPrice, timestamp: bestTs };
    }

    // Step 2: Fallback — closest candle close in range [signalTs, signalTs + lookAhead + 60]
    const maxTs = signalTs + lookAhead + 60;
    bestDist = Infinity;
    for (const candle of candleArr) {
        if (candle[0] >= signalTs && candle[0] <= maxTs) {
            const dist = Math.abs(candle[0] - expirationTime);
            if (dist < bestDist) {
                bestDist = dist;
                bestPrice = candle[2];
                bestTs = candle[0];
            }
        }
    }
    if (bestPrice !== null) {
        return { price: bestPrice, timestamp: bestTs };
    }

    return null; // no exit price found
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
    const results = { CALL: { win: 0, loss: 0, draw: 0, total: 0 }, PUT: { win: 0, loss: 0, draw: 0, total: 0 } };
    let skippedNoExit = 0;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  POCKET OPTION BACKTEST —   Strategy (Relaxed)');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Assets: ${Object.keys(byAsset).length}`);
    console.log(`  Total candles: ${candles.length}`);
    console.log(`  Expiry: ${LOOKAHEAD_SECONDS}s (matches live bot validation)`);
    console.log(`  Price tolerance: ±${PRICE_TOLERANCE}s`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const [asset, candleArr] of Object.entries(byAsset)) {
        if (candleArr.length < MIN_CANDLES) {
            console.log(`  ⏭️  ${asset}: only ${candleArr.length} candles (need ${MIN_CANDLES})`);
            continue;
        }

        let assetSignals = 0;
        for (let i = MIN_CANDLES; i < candleArr.length; i++) {
            const slice = candleArr.slice(0, i + 1);
            const calc = indicators.calculateAll(asset, slice, SETTINGS);
            if (!calc || !calc.signals) continue;

            const sig = calc.signals;
            if (sig.direction !== 'CALL' && sig.direction !== 'PUT') continue;

            const signalTs = candleArr[i][0]; // candle timestamp (signal fires at candle close)
            assetSignals++;

            // ── Exit price lookup (matches validate-signals.js logic) ──
            const exitData = findExitPrice(candleArr, signalTs, LOOKAHEAD_SECONDS);
            if (!exitData) {
                skippedNoExit++;
                continue; // no exit candle found — same as live bot "skipped: no_exit_price"
            }

            const entryPrice = candleArr[i][2]; // close = entry
            const exitPrice = exitData.price;
            const priceChange = exitPrice - entryPrice;

            // ── Determine result (matches validate-signals.js exactly) ──
            let result;
            if (sig.direction === 'CALL' && priceChange > 0) result = 'WIN';
            else if (sig.direction === 'CALL' && priceChange < 0) result = 'LOSS';
            else if (sig.direction === 'PUT' && priceChange < 0) result = 'WIN';
            else if (sig.direction === 'PUT' && priceChange > 0) result = 'LOSS';
            else result = 'DRAW';

            results[sig.direction].total++;
            results[sig.direction][result.toLowerCase()]++;

            signals.push({
                asset,
                time: formatTime(signalTs),
                direction: sig.direction,
                entry: entryPrice,
                exit: exitPrice,
                exitTime: formatTime(exitData.timestamp),
                outcome: result,
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
    const totalLosses = results.CALL.loss + results.PUT.loss;
    const totalDraws = results.CALL.draw + results.PUT.draw;
    const winRate = totalSignals > 0 ? ((totalWins / totalSignals) * 100).toFixed(1) : '0.0';

    console.log(`  CALL: ${results.CALL.win}W / ${results.CALL.loss}L / ${results.CALL.draw}D  (${results.CALL.total} total, ${results.CALL.total > 0 ? ((results.CALL.win / results.CALL.total) * 100).toFixed(1) : 0}% win rate)`);
    console.log(`  PUT:  ${results.PUT.win}W / ${results.PUT.loss}L / ${results.PUT.draw}D  (${results.PUT.total} total, ${results.PUT.total > 0 ? ((results.PUT.win / results.PUT.total) * 100).toFixed(1) : 0}% win rate)`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  TOTAL: ${totalWins}W / ${totalLosses}L / ${totalDraws}D  (${totalSignals} signals, ${winRate}% win rate)`);
    console.log(`  Skipped (no exit price): ${skippedNoExit}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ── Replay Mode ──
    if (signals.length === 0) {
        console.log('  No signals generated. Consider relaxing thresholds further.\n');
    } else {
        console.log('  SIGNAL REPLAY (first 20):\n');
        const show = signals.slice(0, 20);
        show.forEach((s, idx) => {
            const emoji = s.outcome === 'WIN' ? '✅' : s.outcome === 'LOSS' ? '❌' : '➖';
            const arrow = s.direction === 'CALL' ? '▲' : '▼';
            console.log(`  ${emoji} [${idx + 1}] ${s.time} | ${s.asset} ${arrow} ${s.direction} | RSI=${s.rsi} K=${s.k} D=${s.d}`);
            console.log(`        Entry: ${s.entry} → Exit: ${s.exit} (${s.exitTime}) → ${s.outcome}`);
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
