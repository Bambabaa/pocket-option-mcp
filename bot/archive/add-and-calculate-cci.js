// Add CCI(8) column, calculate, and populate all existing indicator rows.
// 
// CCI (Commodity Channel Index) formula:
//   Typical Price (TP) = (High + Low + Close) / 3
//   CCI = (TP - SMA(TP, period)) / (0.015 * Mean Deviation)
//   Mean Deviation = average of |TP - SMA(TP)| over period
//
// Usage: node bot/scripts/add-and-calculate-cci.js [path/to/db]
//        defaults to data/trading_data.db relative to repo root.
//
// Safe to run while the bot is stopped. Do not run concurrently with the live bot.

const path = require('path');
const { TradingDatabase } = require('../database');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'trading_data.db');

const CCI_PERIOD = 8;
const CCI_CONSTANT = 0.015;

/**
 * Calculate CCI(period) given candle array
 * Candle format: [timestamp, open, close, high, low] or {timestamp, open, close, high, low}
 */
function calculateCCI(candles, period = CCI_PERIOD) {
    if (!candles || candles.length < period) {
        return null;
    }

    // Extract last 'period' candles
    const window = candles.slice(-period);

    // Calculate Typical Prices
    const typicalPrices = window.map(c => {
        const high = Array.isArray(c) ? c[3] : c.high;
        const low = Array.isArray(c) ? c[4] : c.low;
        const close = Array.isArray(c) ? c[2] : c.close;
        return (high + low + close) / 3;
    });

    // SMA of Typical Prices
    const smaTP = typicalPrices.reduce((sum, tp) => sum + tp, 0) / period;

    // Mean Deviation
    const meanDeviation = typicalPrices.reduce((sum, tp) => sum + Math.abs(tp - smaTP), 0) / period;

    if (meanDeviation === 0) {
        return 0; // Avoid division by zero
    }

    // CCI formula
    const currentTP = typicalPrices[typicalPrices.length - 1];
    const cci = (currentTP - smaTP) / (CCI_CONSTANT * meanDeviation);

    return cci;
}

(async () => {
    const db = new TradingDatabase(DB_PATH);
    await db.initialize();

    console.log('=== CCI(8) SETUP ===\n');

    // Step 1: Add column if it doesn't exist
    console.log('Step 1: Adding cci_8 column...');
    const columns = await db.all('PRAGMA table_info(indicators)');
    const hasColumn = columns.some(c => c.name === 'cci_8');

    if (hasColumn) {
        console.log('  ✓ Column cci_8 already exists');
    } else {
        await db.run('ALTER TABLE indicators ADD COLUMN cci_8 REAL');
        console.log('  ✓ Column cci_8 added successfully');
    }

    // Step 2: Calculate and populate
    console.log('\nStep 2: Calculating CCI values...\n');

    const assets = (await db.all('SELECT DISTINCT asset FROM candles ORDER BY asset')).map(r => r.asset);
    console.log(`Processing ${assets.length} assets (period=${CCI_PERIOD})\n`);

    let totalUpdated = 0, totalNull = 0, totalNoRow = 0;

    for (const asset of assets) {
        // Load full candle history in ascending order
        const candles = await db.all(
            'SELECT timestamp, open, close, high, low FROM candles WHERE asset = ? ORDER BY timestamp ASC',
            [asset]
        );

        // Load set of timestamps that have an indicators row (only update those)
        const indicatorTs = new Set(
            (await db.all('SELECT timestamp FROM indicators WHERE asset = ?', [asset])).map(r => r.timestamp)
        );

        // Candle array shape: [ts, open, close, high, low]
        const arr = candles.map(c => [c.timestamp, c.open, c.close, c.high, c.low]);

        let updated = 0, nulled = 0, noRow = 0;

        for (let i = 0; i < arr.length; i++) {
            const ts = arr[i][0];
            if (!indicatorTs.has(ts)) {
                noRow++;
                continue;
            }

            if (i < CCI_PERIOD - 1) {
                // Not enough history — set null
                await db.run(
                    'UPDATE indicators SET cci_8 = NULL WHERE asset = ? AND timestamp = ?',
                    [asset, ts]
                );
                nulled++;
                continue;
            }

            // Feed the window ending at this candle into the calculator
            const window = arr.slice(0, i + 1);
            const value = calculateCCI(window, CCI_PERIOD);

            await db.run(
                'UPDATE indicators SET cci_8 = ? WHERE asset = ? AND timestamp = ?',
                [value, asset, ts]
            );
            updated++;
        }

        totalUpdated += updated;
        totalNull += nulled;
        totalNoRow += noRow;
        console.log(`  ${asset.padEnd(12)} updated=${String(updated).padStart(5)}  nulled=${String(nulled).padStart(3)}  no_row=${String(noRow).padStart(4)}`);
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total updated:  ${totalUpdated}`);
    console.log(`Total nulled:   ${totalNull} (warmup period)`);
    console.log(`No indicator:   ${totalNoRow} (candles without indicator rows)`);

    // Step 3: Verify results
    console.log('\n=== VERIFICATION ===\n');

    const overall = await db.get(`
        SELECT 
            COUNT(*) as total_rows,
            COUNT(cci_8) as rows_with_cci,
            MIN(cci_8) as global_min,
            MAX(cci_8) as global_max,
            AVG(cci_8) as global_avg
        FROM indicators
    `);

    console.log(`Total indicator rows: ${overall.total_rows}`);
    console.log(`Rows with CCI:        ${overall.rows_with_cci} (${(overall.rows_with_cci / overall.total_rows * 100).toFixed(1)}%)`);
    console.log(`CCI range:            ${overall.global_min?.toFixed(2)} to ${overall.global_max?.toFixed(2)}`);
    console.log(`CCI average:          ${overall.global_avg?.toFixed(2)}`);

    // Sample from one asset
    const sampleAsset = assets[0];
    const samples = await db.all(`
        SELECT 
            timestamp,
            cci_8,
            rsi_5,
            schaff_value
        FROM indicators
        WHERE asset = ? AND cci_8 IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 5
    `, [sampleAsset]);

    console.log(`\nSample values (${sampleAsset}):`);
    samples.forEach(r => {
        const date = new Date(r.timestamp * 1000).toISOString().slice(0, 16);
        console.log(`  ${date}  CCI=${String(r.cci_8?.toFixed(1)).padStart(7)}  RSI=${String(r.rsi_5?.toFixed(1)).padStart(5)}  STC=${String(r.schaff_value?.toFixed(1)).padStart(5)}`);
    });

    await db.close();
    console.log('\n✓ Done\n');
})().catch(err => {
    console.error('add-and-calculate-cci failed:', err);
    process.exit(1);
});
