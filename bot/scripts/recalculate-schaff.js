// Recalculate schaff_value for all existing indicator rows using the new STC params (12, 25, 5, 3, 3).
// Previously stored values used (30, 55, 8, 4, 3) — this migration overwrites them in place.
//
// Usage: node bot/scripts/recalculate-schaff.js [path/to/db]
//        defaults to data/trading_data.db relative to repo root.
//
// Safe to run while the bot is stopped. Do not run concurrently with the live bot.

const path = require('path');
const { TradingDatabase } = require('../database');
const Indicators = require('../indicators');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'trading_data.db');

// New STC params — must match INDICATOR_CONFIG in indicators.js
const STC_EMA_FAST  = 12;
const STC_EMA_SLOW  = 25;
const STC_CYCLE     = 5;
const STC_SMOOTH1   = 3;
const STC_SMOOTH2   = 3;

// Minimum candles needed before STC can produce a value
const STC_MIN = STC_EMA_SLOW + STC_CYCLE + Math.max(STC_SMOOTH1, STC_SMOOTH2);

(async () => {
    const db = new TradingDatabase(DB_PATH);
    await db.initialize();
    const ind = new Indicators();

    const assets = (await db.all('SELECT DISTINCT asset FROM candles ORDER BY asset')).map(r => r.asset);
    console.log(`recalculate-schaff: ${assets.length} assets  params=(${STC_EMA_FAST},${STC_EMA_SLOW},${STC_CYCLE},${STC_SMOOTH1},${STC_SMOOTH2})  min_candles=${STC_MIN}`);

    let totalUpdated = 0, totalNull = 0, totalNoRow = 0;

    for (const asset of assets) {
        // Load full candle history in ascending order — STC needs the full window
        const candles = await db.all(
            'SELECT timestamp, open, close, high, low FROM candles WHERE asset = ? ORDER BY timestamp ASC',
            [asset]
        );

        // Load set of timestamps that have an indicators row (only update those)
        const indicatorTs = new Set(
            (await db.all('SELECT timestamp FROM indicators WHERE asset = ?', [asset])).map(r => r.timestamp)
        );

        // Candle array shape expected by calculateSchaffTrendCycle: [ts, open, close, high, low]
        const arr = candles.map(c => [c.timestamp, c.open, c.close, c.high, c.low]);

        let updated = 0, nulled = 0, noRow = 0;

        for (let i = 0; i < arr.length; i++) {
            const ts = arr[i][0];
            if (!indicatorTs.has(ts)) { noRow++; continue; }

            if (i < STC_MIN) {
                // Not enough history — set null so stale value doesn't mislead simulation
                await db.run(
                    'UPDATE indicators SET schaff_value = NULL WHERE asset = ? AND timestamp = ?',
                    [asset, ts]
                );
                nulled++;
                continue;
            }

            // Feed the window ending at this candle into the calculator
            const window = arr.slice(0, i + 1);
            const result = ind.calculateSchaffTrendCycle(window, STC_EMA_FAST, STC_EMA_SLOW, STC_CYCLE, STC_SMOOTH1, STC_SMOOTH2);

            const value = result?.value ?? null;
            await db.run(
                'UPDATE indicators SET schaff_value = ? WHERE asset = ? AND timestamp = ?',
                [value, asset, ts]
            );
            updated++;
        }

        totalUpdated += updated;
        totalNull    += nulled;
        totalNoRow   += noRow;
        console.log(`  ${asset}: updated=${updated}  nulled_warmup=${nulled}  no_ind_row=${noRow}`);
    }

    console.log(`\ndone  total_updated=${totalUpdated}  total_nulled=${totalNull}  total_no_row=${totalNoRow}`);
    await db.close();
})().catch(err => {
    console.error('recalculate-schaff failed:', err);
    process.exit(1);
});
