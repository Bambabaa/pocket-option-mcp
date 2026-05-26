'use strict';
// DB schema bootstrap + batch candle/indicator writes for agent scripts.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeAll } = require('./indicators.cjs');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candles (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,
    open       REAL    NOT NULL,
    high       REAL    NOT NULL,
    low        REAL    NOT NULL,
    close      REAL    NOT NULL,
    volume     REAL,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS indicators (
    asset              TEXT    NOT NULL,
    timestamp          INTEGER NOT NULL,
    sma_10             REAL, sma_20 REAL, sma_50 REAL,
    ema_12             REAL, ema_26 REAL,
    rsi_14             REAL,
    macd_line          REAL, macd_signal REAL, macd_histogram REAL,
    bb_upper           REAL, bb_middle REAL, bb_lower REAL, bb_width_bps REAL,
    stoch_k            REAL, stoch_d REAL, stoch_prev_d REAL,
    keltner_upper      REAL, keltner_middle REAL, keltner_lower REAL,
    zigzag_direction   INTEGER, zigzag_reversal INTEGER, zigzag_pivot REAL,
    stc_value          REAL, stc_signal REAL, stc_prev REAL, stc_delta REAL,
    adx                REAL, plus_di REAL, minus_di REAL,
    cci_20             REAL, williams_r REAL, atr_14 REAL,
    psar_value         REAL, psar_trend INTEGER, psar_is_bullish INTEGER,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS prices (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,
    price      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS agent_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    asset          TEXT    NOT NULL,
    direction      TEXT    NOT NULL CHECK(direction IN ('CALL','PUT')),
    amount         REAL    NOT NULL,
    expiry_seconds INTEGER NOT NULL DEFAULT 300,
    signal_ts      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    executed_at    INTEGER,
    status         TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING','EXECUTED','CLOSED','FAILED','CANCELLED')),
    result         TEXT    CHECK(result IN ('WIN','LOSS','DRAW',NULL)),
    profit_loss    REAL
);

CREATE TABLE IF NOT EXISTS agent_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id   TEXT    NOT NULL,
    cycle_ts   INTEGER NOT NULL,
    asset      TEXT,
    decision   TEXT    NOT NULL CHECK(decision IN ('TRADE','SKIP','PAUSE','STOP')),
    direction  TEXT,
    expiry_min INTEGER,
    score      REAL,
    reason     TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_prices_asset_ts ON prices(asset, timestamp);
`;

/**
 * Open agent.db, ensure schema exists.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function openAgentDb(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    // Add volume column to existing DBs that predate this field
    try { db.exec('ALTER TABLE candles ADD COLUMN volume REAL'); } catch (_) {}
    return db;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function prepareWriters(db) {
    const stmtInsertCandle = db.prepare(`
        INSERT OR IGNORE INTO candles (asset, timestamp, open, high, low, close)
        VALUES (@asset, @timestamp, @open, @high, @low, @close)
    `);
    const stmtInsertIndicators = db.prepare(`
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
        for (const r of rows) stmtInsertCandle.run(r);
    });
    const writeIndicatorBatch = db.transaction((rows) => {
        for (const r of rows) stmtInsertIndicators.run(r);
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

/**
 * bars: [[ts, open, close, high, low], ...] sorted ascending
 * @returns {{ barsWritten: number, indicatorsWritten: number, warmupDropped: number }}
 */
function storeBarsAndIndicators(db, asset, bars, indicatorCfg, log = () => {}) {
    const { writeCandleBatch, writeIndicatorBatch, dropWarmup } = prepareWriters(db);

    const candleRows = bars.map(([ts, open, close, high, low]) => ({
        asset,
        timestamp: ts,
        open,
        high,
        low,
        close,
    }));
    writeCandleBatch(candleRows);
    log(`${asset}: ${bars.length} bars written to candles`);

    // Sliding window O(n) — cap each computeAll slice at 300 bars (same as import_csv)
    const WINDOW = 300;
    let prevStc = null;
    const indRows = [];
    for (let i = 0; i < bars.length; i++) {
        const start = Math.max(0, i - WINDOW + 1);
        const slice = bars.slice(start, i + 1);
        const ind = computeAll(slice, indicatorCfg, prevStc);
        if (!ind) continue;
        prevStc = ind.stc_value;
        indRows.push({ asset, timestamp: bars[i][0], ...ind });
    }
    writeIndicatorBatch(indRows);
    log(`${asset}: indicators computed for ${indRows.length} bars`);

    const warmupDropped = dropWarmup(asset);
    if (warmupDropped > 0) log(`${asset}: dropped ${warmupDropped} warmup bars`);

    const finalCount = db.prepare(
        `SELECT COUNT(*) AS n FROM candles WHERE asset = ?`
    ).get(asset).n;

    return {
        barsWritten: bars.length,
        indicatorsWritten: indRows.length,
        warmupDropped,
        finalCandleCount: finalCount,
    };
}

module.exports = {
    openAgentDb,
    storeBarsAndIndicators,
    SCHEMA_SQL,
};
