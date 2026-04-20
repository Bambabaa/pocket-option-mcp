// Backfill missing indicator rows from existing candles.
// One-shot: for every (asset, ts) in `candles` that lacks a row in `indicators`
// AND has >= getMinCandlesForKT prior candles for that asset, compute and insert.
//
// Usage: node bot/scripts/backfill-indicators.js [path/to/db]
//        defaults to data/trading_data.db relative to repo root.

const path = require('path');
const { TradingDatabase } = require('../database');
const Indicators = require('../indicators');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'trading_data.db');

(async () => {
    const db = new TradingDatabase(DB_PATH);
    await db.initialize();
    const indicators = new Indicators();
    const minCandles = Indicators.getMinCandlesForKT({});

    const assets = (await db.all(`SELECT DISTINCT asset FROM candles ORDER BY asset`)).map(r => r.asset);
    console.log(`backfill: ${assets.length} assets, min lookback ${minCandles} candles`);

    let totalInserted = 0;
    let totalSkippedWarmup = 0;
    let totalAlready = 0;

    for (const asset of assets) {
        const candles = await db.all(
            `SELECT timestamp, open, close, high, low FROM candles WHERE asset = ? ORDER BY timestamp ASC`,
            [asset]
        );
        const existing = new Set(
            (await db.all(`SELECT timestamp FROM indicators WHERE asset = ?`, [asset])).map(r => r.timestamp)
        );

        // STATE.CANDLES shape: [ts, open, close, high, low]
        const arr = candles.map(c => [c.timestamp, c.open, c.close, c.high, c.low]);

        let inserted = 0, skippedWarmup = 0, already = 0;
        for (let i = 0; i < arr.length; i++) {
            const ts = arr[i][0];
            if (existing.has(ts)) { already++; continue; }
            if (i + 1 < minCandles) { skippedWarmup++; continue; }
            const window = arr.slice(0, i + 1);
            const data = indicators.calculateAll(asset, window, {});
            if (!data) { skippedWarmup++; continue; }
            try {
                await db.insertIndicators(asset, ts, data);
                inserted++;
            } catch (err) {
                console.error(`  ${asset} @ ${ts}: ${err.message}`);
            }
        }

        console.log(`  ${asset.padEnd(22)} candles=${arr.length}  inserted=${inserted}  warmup-skipped=${skippedWarmup}  already=${already}`);
        totalInserted += inserted;
        totalSkippedWarmup += skippedWarmup;
        totalAlready += already;
    }

    console.log(`\nTOTAL  inserted=${totalInserted}  warmup-skipped=${totalSkippedWarmup}  already=${totalAlready}`);

    // Verify alignment
    const orphan = await db.get(
        `SELECT COUNT(*) AS n FROM indicators i
         LEFT JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
         WHERE c.asset IS NULL`
    );
    const missing = await db.get(
        `SELECT COUNT(*) AS n FROM candles c
         LEFT JOIN indicators i ON i.asset = c.asset AND i.timestamp = c.timestamp
         WHERE i.asset IS NULL`
    );
    console.log(`\nVerify: orphan indicator rows = ${orphan.n}  (expected 0)`);
    console.log(`Verify: candles without indicator = ${missing.n}  (expected ~${minCandles - 1} per asset = ${(minCandles - 1) * assets.length} warmup)`);

    await db.close();
})().catch(err => { console.error(err); process.exit(1); });
