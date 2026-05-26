'use strict';
// Import ForexSB 5m CSV files into agent.db
//
//   node agent/test/import_csv.cjs                        ← all CSVs in agent/forex_5m/
//   node agent/test/import_csv.cjs EURUSD GBPJPY          ← specific pairs

const fs   = require('fs');
const path = require('path');
const { openAgentDb } = require('../websocket/store.cjs');
const { computeAll }  = require('../websocket/indicators.cjs');

const CFG      = JSON.parse(fs.readFileSync(path.join(__dirname, '../websocket/config.json'), 'utf8'));
const CSV_DIR  = path.join(__dirname, '../forex_5m');
const DB_PATH  = path.join(__dirname, '../data/agent.db');
const TZ_OFFSET = 18000; // GMT-05:00 → UTC  (+5h in seconds)
const WINDOW   = 300;    // sliding indicator window — enough for all indicators to converge

const log = (m) => console.log(`[import_csv] ${m}`);

// ── CLI args ──────────────────────────────────────────────────────────────────
const cliPairs = process.argv.slice(2).flatMap(a => a.split(',')).map(s => s.trim().toUpperCase()).filter(Boolean);

// ── Parse one CSV line ────────────────────────────────────────────────────────
// Format: "2026-04-02 06:25,1.15127,1.15141,1.15108,1.15113,541"
// Columns: datetime, open, high, low, close, volume
function parseLine(line) {
    const parts = line.split(',');
    if (parts.length < 5) return null;
    const [datetime, openStr, highStr, lowStr, closeStr, volumeStr] = parts;
    const open   = parseFloat(openStr);
    const high   = parseFloat(highStr);
    const low    = parseFloat(lowStr);
    const close  = parseFloat(closeStr);
    const volume = volumeStr !== undefined ? parseFloat(volumeStr) : null;
    if ([open, high, low, close].some(isNaN)) return null;
    if (high < low || open <= 0 || close <= 0) return null;

    // Parse datetime as UTC then apply timezone offset
    const dt = new Date(datetime.replace(' ', 'T') + 'Z');
    const ts  = Math.floor(dt.getTime() / 1000) + TZ_OFFSET;
    if (!ts || ts <= 0) return null;

    // [ts, open, close, high, low, volume] — volume appended for storage
    return [ts, open, close, high, low, isNaN(volume) ? null : volume];
}

// ── Load and parse a CSV file ─────────────────────────────────────────────────
function loadCsv(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const bars  = [];
    let skipped = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        const bar = parseLine(line);
        if (!bar) { skipped++; continue; }
        bars.push(bar);
    }
    // Sort ascending by timestamp (should already be, but ensure)
    bars.sort((a, b) => a[0] - b[0]);
    return { bars, skipped };
}

// ── Compute indicators with sliding window (O(n) not O(n²)) ──────────────────
function computeIndicators(bars, asset) {
    let prevStc = null;
    const indRows = [];

    for (let i = 0; i < bars.length; i++) {
        const start = Math.max(0, i - WINDOW + 1);
        const slice = bars.slice(start, i + 1);
        const ind   = computeAll(slice, CFG.indicators, prevStc);
        if (!ind) continue;
        prevStc = ind.stc_value;
        indRows.push({ asset, timestamp: bars[i][0], ...ind });
    }
    return indRows;
}

// ── DB writers ────────────────────────────────────────────────────────────────
function prepareStmts(db) {
    const insertCandle = db.prepare(`
        INSERT OR REPLACE INTO candles (asset, timestamp, open, high, low, close, volume)
        VALUES (@asset, @timestamp, @open, @high, @low, @close, @volume)
    `);

    const insertIndicator = db.prepare(`
        INSERT OR REPLACE INTO indicators (
            asset, timestamp,
            sma_10, sma_20, sma_50, ema_12, ema_26, rsi_14,
            macd_line, macd_signal, macd_histogram,
            bb_upper, bb_middle, bb_lower, bb_width_bps,
            stoch_k, stoch_d, stoch_prev_d,
            keltner_upper, keltner_middle, keltner_lower,
            zigzag_direction, zigzag_reversal, zigzag_pivot,
            stc_value, stc_signal, stc_prev, stc_delta,
            adx, plus_di, minus_di,
            cci_20, williams_r, atr_14,
            psar_value, psar_trend, psar_is_bullish
        ) VALUES (
            @asset, @timestamp,
            @sma_10, @sma_20, @sma_50, @ema_12, @ema_26, @rsi_14,
            @macd_line, @macd_signal, @macd_histogram,
            @bb_upper, @bb_middle, @bb_lower, @bb_width_bps,
            @stoch_k, @stoch_d, @stoch_prev_d,
            @keltner_upper, @keltner_middle, @keltner_lower,
            @zigzag_direction, @zigzag_reversal, @zigzag_pivot,
            @stc_value, @stc_signal, @stc_prev, @stc_delta,
            @adx, @plus_di, @minus_di,
            @cci_20, @williams_r, @atr_14,
            @psar_value, @psar_trend, @psar_is_bullish
        )
    `);

    const writeCandleBatch = db.transaction((rows) => {
        for (const r of rows) insertCandle.run(r);
    });

    const writeIndicatorBatch = db.transaction((rows) => {
        for (const r of rows) insertIndicator.run(r);
    });

    const dropWarmup = db.transaction((asset) => {
        const { changes } = db.prepare(
            `DELETE FROM indicators WHERE asset = ? AND stc_value IS NULL`
        ).run(asset);
        db.prepare(
            `DELETE FROM candles WHERE asset = ? AND timestamp NOT IN (
                SELECT timestamp FROM indicators WHERE asset = ?
            )`
        ).run(asset, asset);
        return changes;
    });

    return { writeCandleBatch, writeIndicatorBatch, dropWarmup };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
    // Open (or create) agent.db with full schema
    const db = openAgentDb(DB_PATH);
    const { writeCandleBatch, writeIndicatorBatch, dropWarmup } = prepareStmts(db);

    // Resolve which CSVs to process
    const allFiles = fs.readdirSync(CSV_DIR).filter(f => f.endsWith('_M5.csv'));
    const files = cliPairs.length > 0
        ? allFiles.filter(f => cliPairs.includes(f.replace('_M5.csv', '')))
        : allFiles;

    if (files.length === 0) {
        log('No CSV files found. Check agent/forex_5m/ directory.');
        process.exit(1);
    }

    log(`DB: ${DB_PATH}`);
    log(`Processing ${files.length} pair(s): ${files.map(f => f.replace('_M5.csv','')).join(', ')}`);

    const started = Date.now();
    let totalBars = 0, totalInd = 0;

    for (const file of files) {
        const asset    = file.replace('_M5.csv', '');
        const filePath = path.join(CSV_DIR, file);
        const t0       = Date.now();

        // Parse CSV
        const { bars, skipped } = loadCsv(filePath);
        if (bars.length === 0) {
            log(`${asset}: no valid bars — skipped`);
            continue;
        }

        const flatCount = bars.filter(b => b[1] === b[2] && b[2] === b[3] && b[3] === b[4]).length;
        log(`${asset}: ${bars.length} bars parsed (${skipped} invalid, ${flatCount} flat kept)`);

        // Write candles
        const candleRows = bars.map(([ts, open, close, high, low, volume]) => ({
            asset, timestamp: ts, open, high, low, close, volume: volume ?? null,
        }));
        writeCandleBatch(candleRows);

        const candleCount = db.prepare('SELECT COUNT(*) AS n FROM candles WHERE asset = ?').get(asset).n;
        log(`${asset}: ${candleCount} candles in DB`);

        // Compute indicators with sliding window
        const indRows = computeIndicators(bars, asset);
        writeIndicatorBatch(indRows);

        const warmupDropped = dropWarmup(asset);
        if (warmupDropped > 0) log(`${asset}: dropped ${warmupDropped} warmup rows (stc_value IS NULL)`);

        const indCount = db.prepare('SELECT COUNT(*) AS n FROM indicators WHERE asset = ?').get(asset).n;
        const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
        log(`${asset}: ${indCount} valid indicator rows in DB — ${elapsed}s`);

        totalBars += candleCount;
        totalInd  += indCount;
    }

    const totalElapsed = ((Date.now() - started) / 1000).toFixed(1);
    log(`done — ${totalBars.toLocaleString()} candles, ${totalInd.toLocaleString()} indicator rows, ${totalElapsed}s total`);
    log(`DB → ${DB_PATH}`);

    db.close();
}

main();
