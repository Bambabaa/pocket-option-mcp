/**
 * SQLite Database Module for Pocket Option Trading Bot
 *
 * This module handles all database operations including:
 * - Storing candle data (OHLC + timestamp)
 * - Storing indicator calculations
 * - Storing trading signals
 * - Storing trade executions
 * - Querying historical data for analysis
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * OTC vs non-OTC: WebSocket can send CADCHF or CADCHF_otc for same pair.
 * Returns [asset, alternate] for lookup (e.g. [CADCHF, CADCHF_otc] or [CADCHF_otc, CADCHF]).
 */
function getAssetOtcVariants(asset) {
    if (!asset || typeof asset !== 'string') return [asset];
    const s = asset.trim();
    const lower = s.toLowerCase();
    if (lower.endsWith('_otc')) {
        const base = s.slice(0, -4); // preserve case: CADCHF_otc -> CADCHF
        if (base.length === 6) return [s, base];
    } else if (/^[a-zA-Z0-9]{6}$/.test(s)) {
        return [s, s + '_otc']; // CADCHF <-> CADCHF_otc (preserve case)
    }
    return [s];
}

class TradingDatabase {
    constructor(dbPath = require('path').join(__dirname, 'data/trading_data.db')) {
        this.dbPath = dbPath;
        this.db = null;
    }

    /**
     * Initialize database connection and create tables
     */
    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Error opening database:', err.message);
                    reject(err);
                } else {
                    console.log(`✅ Connected to SQLite database: ${this.dbPath}`);

                    // Increase busy timeout to 60s to handle concurrent batch writes
                    this.db.run('PRAGMA busy_timeout = 60000');
                    // Enable WAL mode to allow concurrent reads from the dashboard
                    this.db.run('PRAGMA journal_mode = WAL');
                    this.db.run('PRAGMA synchronous = NORMAL');

                    this.createTables()
                        .then(() => resolve())
                        .catch(reject);
                }
            });
        });
    }

    /**
     * Create all necessary tables
     */
    async createTables() {
        const tables = [
            // 1. Candles table - stores OHLC data
            `CREATE TABLE IF NOT EXISTS candles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp)
            )`,

            // 2. Indicators table — clean schema matching indicators.cjs reference naming
            `CREATE TABLE IF NOT EXISTS indicators (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                candle_id INTEGER,
                sma_10 REAL,
                sma_20 REAL,
                sma_50 REAL,
                rsi_14 REAL,
                stoch_k REAL,
                stoch_d REAL,
                stoch_prev_d REAL,
                bb_upper REAL,
                bb_middle REAL,
                bb_lower REAL,
                bb_width_bps REAL,
                stc_value REAL,
                stc_signal REAL,
                stc_prev REAL,
                stc_delta REAL,
                cci_20 REAL,
                ema_12 REAL,
                ema_26 REAL,
                macd_macd REAL,
                macd_signal REAL,
                macd_hist REAL,
                kc_upper REAL,
                kc_middle REAL,
                kc_lower REAL,
                adx_14 REAL,
                adx_plus_di REAL,
                adx_minus_di REAL,
                williams_14 REAL,
                atr_14 REAL,
                atr_pct REAL,
                psar REAL,
                psar_bull INTEGER,
                zz_direction TEXT,
                zz_pivot REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp),
                FOREIGN KEY (asset, timestamp) REFERENCES candles(asset, timestamp)
            )`,

            // 3. Signals table - stores trading signals (KT-only: direction + reasons + strategy)
            `CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                direction TEXT NOT NULL,
                strategy_used TEXT,
                reasons TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp),
                FOREIGN KEY (asset, timestamp) REFERENCES candles(asset, timestamp)
            )`,

            // 5. Prices table - stores real-time price updates (every second)
            `CREATE TABLE IF NOT EXISTS prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                price REAL NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp)
            )`,

            // 7. Signal outcomes — every validated signal (validation loop writes here for analysis)
            `CREATE TABLE IF NOT EXISTS signal_outcomes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                signal_timestamp INTEGER NOT NULL,
                signal_id INTEGER,
                direction TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_timestamp INTEGER,
                exit_price REAL,
                result TEXT,
                profit_loss REAL,
                updated_at INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, signal_timestamp),
                FOREIGN KEY (signal_id) REFERENCES signals(id)
            )`,

            // Migration: add updated_at to signal_outcomes if missing (safe, idempotent)
            `ALTER TABLE signal_outcomes ADD COLUMN updated_at INTEGER`,

            // Add strategy_used directly to signals table
            `ALTER TABLE signals ADD COLUMN strategy_used TEXT`,

            // candle_id soft FK → candles.id. Stable now that insertCandle uses ON CONFLICT DO UPDATE.
            // Backfilled by migrateBackfillCandleId(); populated on new inserts by app code.
            // Note: indicators.candle_id is baked into CREATE TABLE above — ALTER is a no-op on new DBs.
            `ALTER TABLE signals          ADD COLUMN candle_id INTEGER`,
            `ALTER TABLE signal_outcomes  ADD COLUMN candle_id INTEGER`,
            `ALTER TABLE orders_queue     ADD COLUMN candle_id INTEGER`,
            `ALTER TABLE trades_ordered   ADD COLUMN candle_id INTEGER`,

            // 8. Orders queue - two-process executor: bot enqueues, executor claims and executes
            `CREATE TABLE IF NOT EXISTS orders_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                signal_id INTEGER NOT NULL,
                asset TEXT NOT NULL,
                direction TEXT NOT NULL,
                signal_timestamp INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT NOT NULL DEFAULT 'PENDING',
                status_reason TEXT,
                last_update_at DATETIME,
                UNIQUE(asset, signal_timestamp),
                FOREIGN KEY (signal_id) REFERENCES signals(id)
            )`,

            // 12. trades_ordered - order-executor only (live/stub execution records)
            `CREATE TABLE IF NOT EXISTS trades_ordered (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                signal_id INTEGER,
                asset TEXT NOT NULL,
                entry_timestamp INTEGER NOT NULL,
                direction TEXT NOT NULL,
                amount REAL NOT NULL,
                entry_price REAL,
                exit_timestamp INTEGER,
                exit_price REAL,
                result TEXT,
                profit_loss REAL,
                payout REAL,
                notes TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders_queue(id),
                FOREIGN KEY (signal_id) REFERENCES signals(id),
                UNIQUE(order_id)
            )`
        ];

        // Create indexes for faster queries
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_candles_asset_timestamp ON candles(asset, timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_indicators_asset_timestamp ON indicators(asset, timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_signals_asset_timestamp ON signals(asset, timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals(direction)',
            'CREATE INDEX IF NOT EXISTS idx_prices_asset_timestamp ON prices(asset, timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset ON signal_outcomes(asset)',
            'CREATE INDEX IF NOT EXISTS idx_signal_outcomes_signal_ts ON signal_outcomes(signal_timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_orders_queue_status_created ON orders_queue(status, created_at)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_order_id ON trades_ordered(order_id)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_signal_id ON trades_ordered(signal_id)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_result ON trades_ordered(result)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_entry_ts ON trades_ordered(entry_timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_indicators_candle_id      ON indicators(candle_id)',
            'CREATE INDEX IF NOT EXISTS idx_signals_candle_id         ON signals(candle_id)',
            'CREATE INDEX IF NOT EXISTS idx_signal_outcomes_candle_id ON signal_outcomes(candle_id)',
            'CREATE INDEX IF NOT EXISTS idx_orders_queue_candle_id    ON orders_queue(candle_id)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_candle_id  ON trades_ordered(candle_id)'
        ];

        // Separate ALTER TABLE migrations (idempotent: silently ignored if column already exists)
        const migrations = tables.filter(s => s.trimStart().toUpperCase().startsWith('ALTER'));
        const ddl = tables.filter(s => !s.trimStart().toUpperCase().startsWith('ALTER'));

        try {
            // Create tables
            for (const sql of ddl) {
                await this.run(sql);
            }
            console.log('✅ All database tables created successfully');

            // Run migrations (ALTER TABLE) – ignore "duplicate column" errors silently
            for (const sql of migrations) {
                try {
                    await this.run(sql);
                } catch (e) {
                    // "duplicate column name" is expected when DB already has the column
                    if (!e.message || !e.message.includes('duplicate column name')) {
                        console.warn(`   ⚠️  Migration warning: ${e.message}`);
                    }
                }
            }

            // Cleanup: asset_controls belongs in mcp.db only — drop it from trading_data.db if present
            try { await this.run(`DROP TABLE IF EXISTS asset_controls`); } catch (_) { }
            try { await this.run(`DROP INDEX IF EXISTS idx_asset_controls_asset`); } catch (_) { }

            // Schema migrations: rebuild indicators to new schema if old one detected, then drop legacy columns
            await this.migrateIndicatorsRebuildSchema();
            await this.migrateIndicatorsDropLegacyColumns();
            await this.migrateIndicatorsAddExtendedColumns();
            await this.migrateSignalsDropStrengthColumns();

            // Backfill candle_id on rows inserted before the soft-FK column existed.
            // No-op after first successful run (every UPDATE has WHERE candle_id IS NULL).
            await this.migrateBackfillCandleId();

            // Create indexes
            for (const sql of indexes) {
                await this.run(sql);
            }
            console.log('✅ All database indexes created successfully');
        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    /**
     * Helper method to run SQL queries
     */
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    /**
     * Helper method to get single row
     */
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Helper method to get all rows
     */
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // ==================== CANDLE OPERATIONS ====================

    /**
     * Insert candle data
     */
    async insertCandle(asset, timestamp, open, high, low, close, volume = 0) {
        // ON CONFLICT DO UPDATE keeps candles.id stable across re-inserts so that
        // FK columns (indicators.candle_id, signals.candle_id, etc.) never dangle.
        // INSERT OR REPLACE deletes-and-reinserts → id changes → FKs break.
        const sql = `INSERT INTO candles (asset, timestamp, open, high, low, close, volume)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(asset, timestamp) DO UPDATE SET
                       open = excluded.open,
                       high = excluded.high,
                       low = excluded.low,
                       close = excluded.close,
                       volume = excluded.volume`;

        try {
            const result = await this.run(sql, [asset, timestamp, open, high, low, close, volume]);
            return result;
        } catch (error) {
            console.error('Error inserting candle:', error.message);
            throw error;
        }
    }

    /**
     * Get latest N candles for an asset
     */
    // NOTE: returns rows newest-first (DESC). Do NOT pipe directly into indicator
    // calculations — those require chronological (ASC) order. The live bot uses
    // STATE.CANDLES which is built chronologically via push.
    async getCandles(asset, limit = 100) {
        const sql = `SELECT * FROM candles
                     WHERE asset = ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        return await this.all(sql, [asset, limit]);
    }

    /**
     * Get candles in a time range
     */
    async getCandlesInRange(asset, startTime, endTime) {
        const sql = `SELECT * FROM candles
                     WHERE asset = ?
                     AND timestamp BETWEEN ? AND ?
                     ORDER BY timestamp ASC`;

        return await this.all(sql, [asset, startTime, endTime]);
    }

    /**
     * Update existing candle (for updating high/low prices)
     */
    async updateCandle(asset, timestamp, high, low, close) {
        const sql = `UPDATE candles
                     SET high = ?, low = ?, close = ?
                     WHERE asset = ? AND timestamp = ?`;

        try {
            const result = await this.run(sql, [high, low, close, asset, timestamp]);
            return result;
        } catch (error) {
            console.error('Error updating candle:', error.message);
            throw error;
        }
    }

    // ==================== PRICE OPERATIONS ====================

    /**
     * Insert price update (real-time price data)
     */
    async insertPrice(asset, timestamp, price) {
        const sql = `INSERT OR REPLACE INTO prices
                     (asset, timestamp, price)
                     VALUES (?, ?, ?)`;

        try {
            const result = await this.run(sql, [asset, timestamp, price]);
            return result;
        } catch (error) {
            console.error('Error inserting price:', error.message);
            throw error;
        }
    }

    /**
     * Batch insert price updates for efficiency.
     * @param {Array<{asset: string, timestamp: number, price: number}>} items
     */
    async insertPriceBatch(items) {
        if (!items || items.length === 0) return;
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN IMMEDIATE'); // Lock early for the batch
                const stmt = this.db.prepare('INSERT OR REPLACE INTO prices (asset, timestamp, price) VALUES (?, ?, ?)');
                for (const item of items) {
                    stmt.run([item.asset, item.timestamp, item.price]);
                }
                stmt.finalize();
                this.db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }

    /**
     * Get latest N prices for an asset
     */
    async getPrices(asset, limit = 100) {
        const sql = `SELECT * FROM prices
                     WHERE asset = ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        return await this.all(sql, [asset, limit]);
    }

    /**
     * Get prices in a time range
     */
    async getPricesInRange(asset, startTime, endTime) {
        const sql = `SELECT * FROM prices
                     WHERE asset = ?
                     AND timestamp BETWEEN ? AND ?
                     ORDER BY timestamp ASC`;

        return await this.all(sql, [asset, startTime, endTime]);
    }

    /**
     * Get price at a specific timestamp (or closest within tolerance)
     * Returns the exact price if found, or the closest price within tolerance
     * 
     * @param {string} asset - Asset symbol
     * @param {number} timestamp - Target timestamp
     * @param {number} tolerance - Maximum time difference in seconds (default: 5)
     * @param {number} minTimestamp - Minimum allowed timestamp (prevents looking before entry time)
     */
    async getPriceAtTimestamp(asset, timestamp, tolerance = 5, minTimestamp = null) {
        // First try exact match (but ensure it's not before minTimestamp)
        const exact = await this.get(
            'SELECT * FROM prices WHERE asset = ? AND timestamp = ?' +
            (minTimestamp !== null ? ' AND timestamp >= ?' : ''),
            minTimestamp !== null
                ? [asset, timestamp, minTimestamp]
                : [asset, timestamp]
        );

        if (exact) {
            return exact;
        }

        // If no exact match, find closest within tolerance
        // Ensure we don't look before minTimestamp (entry time)
        const minBound = minTimestamp !== null
            ? Math.max(timestamp - tolerance, minTimestamp)
            : timestamp - tolerance;
        const maxBound = timestamp + tolerance;

        const closest = await this.get(
            `SELECT * FROM prices
             WHERE asset = ?
             AND timestamp >= ?
             AND timestamp <= ?
             ORDER BY ABS(timestamp - ?) ASC
             LIMIT 1`,
            [asset, minBound, maxBound, timestamp]
        );

        return closest;
    }

    // ==================== INDICATOR OPERATIONS ====================

    /**
     * Insert indicator data 
     * Indicator table features (KT-only columns):
     *   ma1, ma2, ma3     — Video 2 SMAs (6, 50, 14)
     *   rsi               — RSI (v2 period 5 or v3 period 8)
     *   bb_upper, bb_middle, bb_lower — Bollinger/Keltner bands (Video 3 / Video 1)
     *   stochastic_k, stochastic_d     — Video 1 Stochastic (13,3,3)
     *   stochastic_k_v2, stochastic_d_v2 — Video 2 Stochastic (5,3,3)
     *   keltner_upper, keltner_lower   — Video 1 Keltner channel
    /**
     * Insert indicator data — columns match indicators.cjs reference naming:
     *   sma_10, sma_20, sma_50        — SMA trio (10, 20, 50 period)
     *   rsi_14                         — RSI Wilder's, period 14
     *   stoch_k, stoch_d, stoch_prev_d — Stochastic (5,3,3): K, D, previous D
     *   bb_upper/middle/lower          — Bollinger Bands (20, 2)
     *   bb_width_bps                   — BB width as basis points ((upper-lower)/middle * 10000)
     *   stc_value, stc_signal          — Schaff Trend Cycle (23,50,10,3,3)
     *   stc_prev, stc_delta            — STC previous bar value + momentum delta
     *   cci_20                         — CCI period 20 (Gate 3)
     */
    async insertIndicators(asset, timestamp, indicators) {
        const sql = `INSERT INTO indicators
                     (asset, timestamp, candle_id,
                      sma_10, sma_20, sma_50,
                      rsi_14,
                      stoch_k, stoch_d, stoch_prev_d,
                      bb_upper, bb_middle, bb_lower, bb_width_bps,
                      stc_value, stc_signal, stc_prev, stc_delta,
                      cci_20,
                      ema_12, ema_26,
                      macd_macd, macd_signal, macd_hist,
                      kc_upper, kc_middle, kc_lower,
                      atr_14, atr_pct,
                      adx_14, adx_plus_di, adx_minus_di,
                      williams_14,
                      psar, psar_bull,
                      zz_direction, zz_pivot)
                     VALUES (?, ?,
                             (SELECT id FROM candles WHERE asset = ? AND timestamp = ?),
                             ?, ?, ?,
                             ?,
                             ?, ?, ?,
                             ?, ?, ?, ?,
                             ?, ?, ?, ?,
                             ?,
                             ?, ?,
                             ?, ?, ?,
                             ?, ?, ?,
                             ?, ?,
                             ?, ?, ?,
                             ?,
                             ?,
                             ?,
                             ?, ?)
                     ON CONFLICT(asset, timestamp) DO UPDATE SET
                         candle_id    = excluded.candle_id,
                         sma_10       = excluded.sma_10,
                         sma_20       = excluded.sma_20,
                         sma_50       = excluded.sma_50,
                         rsi_14       = excluded.rsi_14,
                         stoch_k      = excluded.stoch_k,
                         stoch_d      = excluded.stoch_d,
                         stoch_prev_d = excluded.stoch_prev_d,
                         bb_upper     = excluded.bb_upper,
                         bb_middle    = excluded.bb_middle,
                         bb_lower     = excluded.bb_lower,
                         bb_width_bps = excluded.bb_width_bps,
                         stc_value    = excluded.stc_value,
                         stc_signal   = excluded.stc_signal,
                         stc_prev     = excluded.stc_prev,
                         stc_delta    = excluded.stc_delta,
                         cci_20       = excluded.cci_20,
                         ema_12       = excluded.ema_12,
                         ema_26       = excluded.ema_26,
                         macd_macd    = excluded.macd_macd,
                         macd_signal  = excluded.macd_signal,
                         macd_hist    = excluded.macd_hist,
                         kc_upper     = excluded.kc_upper,
                         kc_middle    = excluded.kc_middle,
                         kc_lower     = excluded.kc_lower,
                         atr_14       = excluded.atr_14,
                         atr_pct      = excluded.atr_pct,
                      adx_14       = excluded.adx_14,
                         adx_plus_di  = excluded.adx_plus_di,
                         adx_minus_di = excluded.adx_minus_di,
                         williams_14  = excluded.williams_14,
                         psar         = excluded.psar,
                         psar_bull    = excluded.psar_bull,
                         zz_direction = excluded.zz_direction,
                         zz_pivot     = excluded.zz_pivot`;

        const params = [
            asset, timestamp,
            asset, timestamp,               // candle_id subquery
            indicators.sma_10       ?? null,
            indicators.sma_20       ?? null,
            indicators.sma_50       ?? null,
            indicators.rsi_14       ?? null,
            indicators.stoch_k      ?? null,
            indicators.stoch_d      ?? null,
            indicators.stoch_prev_d ?? null,
            indicators.bb_upper     ?? null,
            indicators.bb_middle    ?? null,
            indicators.bb_lower     ?? null,
            indicators.bb_width_bps ?? null,
            indicators.stc_value    ?? null,
            indicators.stc_signal   ?? null,
            indicators.stc_prev     ?? null,
            indicators.stc_delta    ?? null,
            indicators.cci_20       ?? null,
            indicators.ema_12       ?? null,
            indicators.ema_26       ?? null,
            indicators.macd_macd    ?? null,
            indicators.macd_signal  ?? null,
            indicators.macd_hist    ?? null,
            indicators.kc_upper     ?? null,
            indicators.kc_middle    ?? null,
            indicators.kc_lower     ?? null,
            indicators.atr_14       ?? null,
            indicators.atr_pct      ?? null,
            indicators.adx_14       ?? null,
            indicators.adx_plus_di  ?? null,
            indicators.adx_minus_di ?? null,
            indicators.williams_14  ?? null,
            indicators.psar         ?? null,
            indicators.psar_bull    ?? null,
            indicators.zz_direction ?? null,
            indicators.zz_pivot     ?? null,
        ];

        try {
            const result = await this.run(sql, params);
            return result;
        } catch (error) {
            console.error('Error inserting indicators:', error.message);
            throw error;
        }
    }

    /**
     * Get latest indicators for an asset
     */
    async getIndicators(asset, limit = 100) {
        const sql = `SELECT * FROM indicators
                     WHERE asset = ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        return await this.all(sql, [asset, limit]);
    }

    // ==================== SIGNAL OPERATIONS ====================

    /**
     * Insert signal data
     */
    async insertSignal(asset, timestamp, signal) {
        let strategy = signal.strategyUsed || null;
        if (strategy === 'video1') strategy = 'Mean Reversion';
        if (strategy === 'video2 ') strategy = 'Fast Trend Follower';
        if (strategy === 'video3') strategy = 'Cyclical Sniper';

        const sql = `INSERT OR IGNORE INTO signals
                     (asset, timestamp, direction, strategy_used, reasons, candle_id)
                     VALUES (?, ?, ?, ?, ?,
                             (SELECT id FROM candles WHERE asset = ? AND timestamp = ?))`;

        const params = [
            asset,
            timestamp,
            signal.direction,
            strategy,
            JSON.stringify(signal.reasons || []),
            asset, timestamp  // ← subquery params for candle_id
        ];

        try {
            const result = await this.run(sql, params);
            // On duplicate (INSERT OR IGNORE skips), lastID is 0. Fetch the real id.
            if (result.id && result.id > 0) return result;
            const existing = await this.get('SELECT id FROM signals WHERE asset = ? AND timestamp = ?', [asset, timestamp]);
            return existing ? { id: existing.id, changes: 0 } : result;
        } catch (error) {
            console.error('Error inserting signal:', error.message);
            throw error;
        }
    }

    /**
     * Get signals for an asset
     */
    async getSignals(asset, limit = 100) {
        const sql = `SELECT * FROM signals
                     WHERE asset = ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        const rows = await this.all(sql, [asset, limit]);

        // Parse reasons JSON
        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get signals by direction (CALL or PUT)
     */
    async getSignalsByDirection(direction, limit = 100) {
        const sql = `SELECT * FROM signals
                     WHERE direction = ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        const rows = await this.all(sql, [direction, limit]);

        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get signals for a specific asset
     */
    async getSignalsByAsset(asset, limit = 100) {
        const sql = `SELECT * FROM signals
                     WHERE asset = ? AND direction != 'NEUTRAL'
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        const rows = await this.all(sql, [asset, limit]);

        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get signals with minimum number of gate reasons (proxy for strength)
     */
    async getSignalsByStrength(minStrength, limit = 100) {
        const sql = `SELECT * FROM signals
                     WHERE direction != 'NEUTRAL'
                       AND json_array_length(reasons) >= ?
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        const rows = await this.all(sql, [minStrength ?? 0, limit]);

        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get recent non-neutral signals, optionally filtered by asset
     */
    async getStrongTrendSignals(asset = null, limit = 100) {
        let sql;
        let params;

        if (asset) {
            sql = `SELECT * FROM signals
                   WHERE asset = ? AND direction != 'NEUTRAL'
                   ORDER BY timestamp DESC
                   LIMIT ?`;
            params = [asset, limit];
        } else {
            sql = `SELECT * FROM signals
                   WHERE direction != 'NEUTRAL'
                   ORDER BY timestamp DESC
                   LIMIT ?`;
            params = [limit];
        }

        const rows = await this.all(sql, params);

        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get signal statistics
     */
    async getSignalStats(asset = null) {
        let sql;
        let params = [];

        if (asset) {
            sql = `SELECT
                       direction,
                       COUNT(*) as count,
                       1.0 as avg_strength,
                       1 as min_strength,
                       1 as max_strength
                   FROM signals
                   WHERE asset = ?
                   GROUP BY direction`;
            params = [asset];
        } else {
            sql = `SELECT
                       direction,
                       COUNT(*) as count,
                       1.0 as avg_strength,
                       1 as min_strength,
                       1 as max_strength
                   FROM signals
                   GROUP BY direction`;
        }

        return await this.all(sql, params);
    }

    /**
     * Migration: drop deprecated strength/ADX columns from signals table by recreating it.
     * Safe to run multiple times; only runs when old columns are present.
     */
    async migrateSignalsDropStrengthColumns() {
        try {
            const cols = await this.all('PRAGMA table_info(signals)');
            if (!cols || !Array.isArray(cols)) return;
            const deprecated = ['strength', 'buy_strength', 'sell_strength', 'adx_value', 'in_strong_trend'];
            const hasDeprecated = cols.some(c => deprecated.includes(c.name));
            if (!hasDeprecated) return;

            console.log('🔄 Migrating signals table to drop strength/ADX columns...');

            await this.run('BEGIN TRANSACTION');

            // Preserve all current live columns; drop only deprecated strength/ADX columns
            await this.run(`CREATE TABLE IF NOT EXISTS signals_tmp (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                direction TEXT NOT NULL,
                strategy_used TEXT,
                reasons TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                candle_id INTEGER,
                UNIQUE(asset, timestamp)
            )`);

            await this.run(`INSERT INTO signals_tmp (id, asset, timestamp, direction, strategy_used, reasons, created_at, candle_id)
                            SELECT id, asset, timestamp, direction, strategy_used, reasons, created_at, candle_id FROM signals`);

            await this.run('DROP TABLE signals');
            await this.run('ALTER TABLE signals_tmp RENAME TO signals');

            await this.run('COMMIT');
            console.log('✅ Signals table migration completed');
        } catch (e) {
            console.error('⚠️ Signals table migration failed:', e.message);
            try {
                await this.run('ROLLBACK');
            } catch (_) {
                // ignore rollback errors
            }
        }
    }

    /**
     * Backfill candle_id on rows that pre-date the soft-FK column.
     * Each UPDATE filters WHERE candle_id IS NULL → no-op on subsequent startups.
     * Indicators/signals join candles by (asset, timestamp); downstream tables
     * (signal_outcomes, orders_queue, trades_ordered) prefer the signal_id path
     * with a natural-key fallback for any rows whose signal_id is missing.
     */
    async migrateBackfillCandleId() {
        const start = Date.now();
        const stmts = [
            // Tier 1: direct natural-key resolution
            `UPDATE indicators SET candle_id = (SELECT id FROM candles
                  WHERE candles.asset = indicators.asset AND candles.timestamp = indicators.timestamp)
              WHERE candle_id IS NULL`,
            `UPDATE signals SET candle_id = (SELECT id FROM candles
                  WHERE candles.asset = signals.asset AND candles.timestamp = signals.timestamp)
              WHERE candle_id IS NULL`,

            // Tier 2: downstream via signal_id → signals.candle_id
            `UPDATE signal_outcomes SET candle_id = (SELECT s.candle_id FROM signals s
                  WHERE s.id = signal_outcomes.signal_id)
              WHERE candle_id IS NULL AND signal_id IS NOT NULL`,
            `UPDATE signal_outcomes SET candle_id = (SELECT id FROM candles
                  WHERE candles.asset = signal_outcomes.asset AND candles.timestamp = signal_outcomes.signal_timestamp)
              WHERE candle_id IS NULL`,

            `UPDATE orders_queue SET candle_id = (SELECT s.candle_id FROM signals s
                  WHERE s.id = orders_queue.signal_id)
              WHERE candle_id IS NULL`,
            `UPDATE orders_queue SET candle_id = (SELECT id FROM candles
                  WHERE candles.asset = orders_queue.asset AND candles.timestamp = orders_queue.signal_timestamp)
              WHERE candle_id IS NULL`,

            `UPDATE trades_ordered SET candle_id = (SELECT s.candle_id FROM signals s
                  WHERE s.id = trades_ordered.signal_id)
              WHERE candle_id IS NULL AND signal_id IS NOT NULL`,
            `UPDATE trades_ordered SET candle_id = (SELECT oq.candle_id FROM orders_queue oq
                  WHERE oq.id = trades_ordered.order_id)
              WHERE candle_id IS NULL AND order_id IS NOT NULL`,
        ];

        let totalChanged = 0;
        for (const sql of stmts) {
            try {
                const r = await this.run(sql);
                totalChanged += (r.changes || 0);
            } catch (e) {
                // Likely "no such column" on the very first run before ALTER TABLE landed,
                // or on DBs missing one of the downstream tables. Safe to ignore — a later
                // startup (after ALTERs are applied) will backfill.
                if (!/no such column|no such table/i.test(e.message || '')) {
                    console.warn(`   ⚠️  candle_id backfill: ${e.message}`);
                }
            }
        }
        if (totalChanged > 0) {
            console.log(`✅ candle_id backfill: ${totalChanged} rows updated in ${Date.now() - start}ms`);
        }
    }

    /**
     * Migration: rebuild indicators table from old schema (ma1/schaff_value) to new flat schema.
     * Detects old schema by presence of 'ma1' or 'schaff_value' column.
     * Maps old column values to new names, drops old table, renames rebuilt table.
     * No-op if new schema (sma_10) already present.
     */
    async migrateIndicatorsRebuildSchema() {
        const cols = await this.all('PRAGMA table_info(indicators)');
        if (!cols || !Array.isArray(cols)) return;
        const colNames = cols.map(c => c.name);

        // Already on new schema — nothing to do
        if (colNames.includes('sma_10')) return;
        // Neither old nor new schema — fresh DB, CREATE TABLE already handled it
        if (!colNames.includes('ma1') && !colNames.includes('schaff_value')) return;

        console.log('🔄 indicators: old schema detected — rebuilding to new clean schema...');
        await this.run('BEGIN TRANSACTION');
        try {
            await this.run(`CREATE TABLE indicators_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                candle_id INTEGER,
                sma_10 REAL, sma_20 REAL, sma_50 REAL,
                rsi_14 REAL,
                stoch_k REAL, stoch_d REAL, stoch_prev_d REAL,
                bb_upper REAL, bb_middle REAL, bb_lower REAL, bb_width_bps REAL,
                stc_value REAL, stc_signal REAL, stc_prev REAL, stc_delta REAL,
                cci_20 REAL,
                ema_12 REAL, ema_26 REAL,
                macd_macd REAL, macd_signal REAL, macd_hist REAL,
                kc_upper REAL, kc_middle REAL, kc_lower REAL,
                adx_14 REAL, adx_plus_di REAL, adx_minus_di REAL,
                williams_14 REAL,
                atr_14 REAL,
                atr_pct REAL,
                psar REAL,
                zz_direction TEXT, zz_pivot REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp)
            )`);

            // Column mapping: old names → new names (rsi_5 stored rsi_14 values; cci_8 stored cci_20 values)
            const srcRsi     = colNames.includes('rsi_5')            ? 'rsi_5'             : 'NULL';
            const srcStochK  = colNames.includes('stochastic_k_v2') ? 'stochastic_k_v2'   : colNames.includes('stochastic_k') ? 'stochastic_k' : 'NULL';
            const srcStochD  = colNames.includes('stochastic_d_v2') ? 'stochastic_d_v2'   : colNames.includes('stochastic_d') ? 'stochastic_d' : 'NULL';
            const srcSchaff  = colNames.includes('schaff_value')    ? 'schaff_value'       : 'NULL';
            const srcCci     = colNames.includes('cci_8')           ? 'cci_8'              : 'NULL';
            const srcMa1     = colNames.includes('ma1')             ? 'ma1'                : 'NULL';
            const srcMa2     = colNames.includes('ma2')             ? 'ma2'                : 'NULL';
            const srcMa3     = colNames.includes('ma3')             ? 'ma3'                : 'NULL';
            const srcCandleId = colNames.includes('candle_id')      ? 'candle_id'          : 'NULL';

            await this.run(`INSERT INTO indicators_new
                (id, asset, timestamp, candle_id,
                 sma_10, sma_20, sma_50,
                 rsi_14,
                 stoch_k, stoch_d,
                 bb_upper, bb_middle, bb_lower,
                 stc_value,
                 cci_20,
                 created_at)
                SELECT id, asset, timestamp, ${srcCandleId},
                       ${srcMa1}, ${srcMa2}, ${srcMa3},
                       ${srcRsi},
                       ${srcStochK}, ${srcStochD},
                       bb_upper, bb_middle, bb_lower,
                       ${srcSchaff},
                       ${srcCci},
                       created_at
                FROM indicators`);

            await this.run('DROP TABLE indicators');
            await this.run('ALTER TABLE indicators_new RENAME TO indicators');
            await this.run('COMMIT');
            console.log('✅ indicators table rebuilt with new schema');
        } catch (err) {
            await this.run('ROLLBACK').catch(() => {});
            console.error('❌ indicators rebuild failed, rolling back:', err.message);
            throw err;
        }
    }

    /**
     * Safe to run multiple times; ignores errors when columns are already gone or DROP COLUMN is unsupported.
     */
    async migrateIndicatorsDropLegacyColumns() {
        // macd_signal, adx_plus_di, adx_minus_di are KEPT — now valid extended columns
        const deprecated = [
            'fast_ma', 'slow_ma',
            'macd_value', 'macd_histogram',
            'adx_value',
            'cci', 'williams_r',
            'sar_value', 'sar_trend', 'atr'
        ];
        for (const name of deprecated) {
            try {
                await this.run(`ALTER TABLE indicators DROP COLUMN ${name}`);
            } catch (e) {
                // Ignore if column does not exist or DROP COLUMN not supported.
            }
        }
    }

    /**
     * Additive migration: safely adds the 16 extended indicator columns to existing DBs.
     * No-op when columns already exist. Safe to call on every startup.
     */
    async migrateIndicatorsAddExtendedColumns() {
        const newCols = [
            ['ema_12',       'REAL'],
            ['ema_26',       'REAL'],
            ['macd_macd',    'REAL'],
            ['macd_signal',  'REAL'],
            ['macd_hist',    'REAL'],
            ['kc_upper',     'REAL'],
            ['kc_middle',    'REAL'],
            ['kc_lower',     'REAL'],
            ['adx_14',       'REAL'],
            ['adx_plus_di',  'REAL'],
            ['adx_minus_di', 'REAL'],
            ['williams_14',  'REAL'],
            ['atr_14',       'REAL'],
            ['atr_pct',     'REAL'],
            ['psar',         'REAL'],
            ['psar_bull', 'INTEGER'],
            ['zz_direction', 'TEXT'],
            ['zz_pivot',     'REAL'],
        ];
        for (const [col, type] of newCols) {
            try {
                await this.run(`ALTER TABLE indicators ADD COLUMN ${col} ${type}`);
            } catch (_) {
                // Column already exists — no-op
            }
        }
    }

    // ==================== UTILITY OPERATIONS ====================

    /**
     * Get database statistics
     */
    async getDatabaseStats() {
        const stats = {};

        stats.candles = await this.get('SELECT COUNT(*) as count FROM candles');
        stats.indicators = await this.get('SELECT COUNT(*) as count FROM indicators');
        stats.signals = await this.get('SELECT COUNT(*) as count FROM signals');

        return stats;
    }

    /**
     * Get list of all tracked assets
     */
    async getAssetList() {
        const sql = `SELECT DISTINCT asset FROM candles ORDER BY asset`;
        const rows = await this.all(sql);
        return rows.map(row => row.asset);
    }

    /**
     * Get signal with future candles for backtesting
     */
    async getSignalWithFutureCandles(asset, signalTimestamp, lookAheadSeconds = 60) {
        // Get the signal
        const signal = await this.get(
            `SELECT * FROM signals WHERE asset = ? AND timestamp = ?`,
            [asset, signalTimestamp]
        );

        if (!signal) {
            return null;
        }

        // Parse reasons
        signal.reasons = JSON.parse(signal.reasons);

        // Get future candles
        const endTime = signalTimestamp + lookAheadSeconds;
        const futureCandles = await this.all(
            `SELECT * FROM candles
             WHERE asset = ? AND timestamp > ? AND timestamp <= ?
             ORDER BY timestamp ASC`,
            [asset, signalTimestamp, endTime]
        );

        return {
            signal,
            futureCandles
        };
    }

    /**
     * Backtest signals for an asset
     */
    async backtestSignals(asset = null, startTime = null, endTime = null, lookAheadSeconds = 60) {
        let sql = `SELECT * FROM signals WHERE direction != 'NEUTRAL'`;
        const params = [];

        if (asset) {
            sql += ` AND asset = ?`;
            params.push(asset);
        }

        if (startTime) {
            sql += ` AND timestamp >= ?`;
            params.push(startTime);
        }

        if (endTime) {
            sql += ` AND timestamp <= ?`;
            params.push(endTime);
        }

        sql += ` ORDER BY timestamp ASC`;

        const signals = await this.all(sql, params);
        const results = [];

        for (const signal of signals) {
            // Get entry candle
            const entryCandle = await this.get(
                `SELECT * FROM candles WHERE asset = ? AND timestamp = ?`,
                [signal.asset, signal.timestamp]
            );

            if (!entryCandle) continue;

            // Get exit candle (lookAheadSeconds later)
            const exitCandle = await this.get(
                `SELECT * FROM candles
                 WHERE asset = ? AND timestamp > ? AND timestamp <= ?
                 ORDER BY timestamp ASC
                 LIMIT 1`,
                [signal.asset, signal.timestamp, signal.timestamp + lookAheadSeconds]
            );

            if (!exitCandle) continue;

            // Determine win/loss
            const entryPrice = entryCandle.close;
            const exitPrice = exitCandle.close;
            const priceChange = exitPrice - entryPrice;

            let result = 'DRAW';
            if (signal.direction === 'CALL' && priceChange > 0) result = 'WIN';
            else if (signal.direction === 'CALL' && priceChange < 0) result = 'LOSS';
            else if (signal.direction === 'PUT' && priceChange < 0) result = 'WIN';
            else if (signal.direction === 'PUT' && priceChange > 0) result = 'LOSS';

            results.push({
                asset: signal.asset,
                timestamp: signal.timestamp,
                direction: signal.direction,
                strategyUsed: signal.strategy_used,
                entryPrice,
                exitPrice,
                priceChange,
                result
            });
        }

        // Calculate statistics
        const totalSignals = results.length;
        const wins = results.filter(r => r.result === 'WIN').length;
        const losses = results.filter(r => r.result === 'LOSS').length;
        const draws = results.filter(r => r.result === 'DRAW').length;
        const winRate = totalSignals > 0 ? ((wins / totalSignals) * 100).toFixed(2) : 0;

        return {
            results,
            statistics: {
                totalSignals,
                wins,
                losses,
                draws,
                winRate: parseFloat(winRate)
            }
        };
    }

    /**
     * Get hourly signal distribution
     */
    async getHourlySignalDistribution(asset = null) {
        let sql = `
            SELECT
                strftime('%H', datetime(timestamp, 'unixepoch')) as hour,
                direction,
                COUNT(*) as count
            FROM signals
            WHERE direction != 'NEUTRAL'
        `;

        const params = [];
        if (asset) {
            sql += ` AND asset = ?`;
            params.push(asset);
        }

        sql += ` GROUP BY hour, direction ORDER BY hour`;

        return await this.all(sql, params);
    }

    // ==================== VALIDATION LAYER (pending signals) ====================

    /**
     * Find signals past expiry that don't yet have a signal_outcome.
     * Excludes assets with an in-flight live order (EXECUTED but no trades_ordered yet).
     * @param {number} lookAheadSeconds - Option expiry (e.g. 60)
     * @param {number} nowSeconds       - Reference "now" in seconds
     * @param {number} [staleHours=0]   - When >0, EXECUTED orders older than N hours are not excluded (stale)
     */
    async getPendingSignalsPastExpiry(lookAheadSeconds, nowSeconds, staleHours = 0) {
        const expiryCutoff = nowSeconds - lookAheadSeconds;
        let inFlightSubquery = `SELECT oq.asset FROM orders_queue oq
                       LEFT JOIN trades_ordered t ON t.order_id = oq.id
                       WHERE oq.status = 'EXECUTED' AND t.id IS NULL
                         AND (oq.status_reason LIKE 'placed_via=live%' OR oq.status_reason LIKE 'placed_via=dry%')`;
        const hours = Math.max(0, parseInt(staleHours, 10) || 0);
        if (hours > 0) {
            inFlightSubquery += ` AND (oq.last_update_at IS NULL OR oq.last_update_at >= datetime('now', '-${hours} hours'))`;
        }
        const sql = `SELECT s.* FROM signals s
                     LEFT JOIN signal_outcomes q ON s.asset = q.asset AND s.timestamp = q.signal_timestamp
                     WHERE q.id IS NULL AND s.direction != 'NEUTRAL'
                     AND (s.timestamp <= ? OR (s.timestamp > 10000000000 AND s.timestamp / 1000 <= ?))
                     AND s.asset NOT IN (${inFlightSubquery})
                     ORDER BY s.timestamp ASC`;
        return this.all(sql, [expiryCutoff, expiryCutoff]);
    }

    /**
     * Diagnostics for why getPendingSignalsPastExpiry might return empty.
     */
    async getPendingSignalsDiagnostics(lookAheadSeconds, nowSeconds) {
        const expiryCutoff = nowSeconds - lookAheadSeconds;
        const totalCallPut = await this.get(
            `SELECT COUNT(*) as c FROM signals WHERE direction IN ('CALL', 'PUT')`
        ).then(r => (r && r.c != null) ? r.c : 0);
        const withOutcome = await this.get(
            `SELECT COUNT(*) as c FROM signals s
             INNER JOIN signal_outcomes q ON s.asset = q.asset AND s.timestamp = q.signal_timestamp
             WHERE s.direction IN ('CALL', 'PUT')`
        ).then(r => (r && r.c != null) ? r.c : 0);
        const pastExpiry = await this.get(
            `SELECT COUNT(*) as c FROM signals WHERE direction IN ('CALL', 'PUT')
             AND (timestamp <= ? OR (timestamp > 10000000000 AND timestamp / 1000 <= ?))`,
            [expiryCutoff, expiryCutoff]
        ).then(r => (r && r.c != null) ? r.c : 0);
        const pending = await this.get(
            `SELECT COUNT(*) as c FROM signals s
             LEFT JOIN signal_outcomes q ON s.asset = q.asset AND s.timestamp = q.signal_timestamp
             WHERE q.id IS NULL AND s.direction != 'NEUTRAL'
             AND (s.timestamp <= ? OR (s.timestamp > 10000000000 AND s.timestamp / 1000 <= ?))`,
            [expiryCutoff, expiryCutoff]
        ).then(r => (r && r.c != null) ? r.c : 0);
        const sample = await this.get(
            `SELECT timestamp FROM signals WHERE direction IN ('CALL', 'PUT') ORDER BY timestamp DESC LIMIT 1`
        );
        return { totalCallPut, withOutcome, pastExpiry, pending, sampleTimestamp: sample ? sample.timestamp : null, nowSeconds, expiryCutoff };
    }

    // ==================== QUALIFICATION LAYER ====================

    /**
     * Get the maximum signal timestamp (CALL/PUT). Used as "reference now" when system
     * clock is behind data (e.g. replaying CSVs or running in a different timezone).
     */
    async getMaxSignalTimestamp() {
        const row = await this.get(
            `SELECT MAX(timestamp) as ts FROM signals WHERE direction IN ('CALL', 'PUT')`
        );
        return row && row.ts != null ? row.ts : null;
    }

    /**
     * Get signal row by id (e.g. for risk_score gating in executor).
     */
    async getSignalById(signalId) {
        return this.get('SELECT * FROM signals WHERE id = ?', [signalId]);
    }

    /**
     * True if a trade already exists for this order (avoid double execution).
     */
    async hasOrderedTradeForOrder(orderId) {
        const row = await this.get('SELECT 1 FROM trades_ordered WHERE order_id = ? LIMIT 1', [orderId]);
        return !!row;
    }

    /**
     * True if asset has an EXECUTED live/dry-run order awaiting result sync (no trades_ordered yet).
     * First-signal-only flow: skip enqueue for this asset until the order closes.
     * Treats OTC variants as same: CADCHF and CADCHF_otc block each other.
     */
    async hasAssetInFlightLiveOrder(asset) {
        const variants = getAssetOtcVariants(asset);
        const placeholders = variants.map(() => '?').join(',');
        const row = await this.get(
            `SELECT 1 FROM orders_queue oq
             LEFT JOIN trades_ordered t ON t.order_id = oq.id
             WHERE oq.asset IN (${placeholders}) AND oq.status IN ('PENDING', 'CLAIMED', 'EXECUTED') AND t.id IS NULL
               AND (oq.status_reason LIKE 'placed_via=live%' OR oq.status_reason LIKE 'placed_via=dry%' OR oq.status = 'PENDING' OR oq.status = 'CLAIMED')
             LIMIT 1`,
            variants
        );
        return !!row;
    }

    /**
     * Insert or update a signal outcome (validation loop writes here for analysis).
     * INSERT OR IGNORE so first write wins, then UPDATE only fills in non-null result fields.
     */
    async insertSignalOutcome(asset, signalTimestamp, signalId, direction, entryPrice, exitTimestamp, exitPrice, result, profitLoss) {
        // Timestamps already converted to local time at original insert
        // (signals via insertSignal, exit via order-executor).
        // Pass through as-is — don't double-convert.
        const now = Math.floor(Date.now() / 1000);
        await this.run(
            `INSERT OR IGNORE INTO signal_outcomes
             (asset, signal_timestamp, signal_id, direction, entry_price, updated_at, candle_id)
             VALUES (?, ?, ?, ?, ?, ?,
                     COALESCE((SELECT candle_id FROM signals WHERE id = ?),
                              (SELECT id FROM candles WHERE asset = ? AND timestamp = ?)))`,
            [asset, signalTimestamp, signalId, direction, entryPrice, now,
                signalId, asset, signalTimestamp]
        );
        if (result != null) {
            await this.run(
                `UPDATE signal_outcomes SET
                 result = ?, profit_loss = ?, exit_timestamp = ?, exit_price = ?, updated_at = ?
                 WHERE asset = ? AND signal_timestamp = ? AND (result IS NULL OR result = '')`,
                [result, profitLoss, exitTimestamp, exitPrice, now, asset, signalTimestamp]
            );
        }
    }

    /**
     * Executes logic synchronously via transaction lock in SQLite (serialized)
     */
    runInTransaction(fn) {
        return new Promise((resolve, reject) => {
            this.db.serialize(async () => {
                try {
                    await this.run('BEGIN TRANSACTION');
                    const res = await fn();
                    await this.run('COMMIT');
                    resolve(res);
                } catch (err) {
                    await this.run('ROLLBACK').catch(() => { });
                    console.error('Transaction rollback:', err.message);
                    reject(err);
                }
            });
        });
    }

    /**
     * Get executed orders awaiting result sync
     */
    async getExecutedOrdersAwaitingResultSync(limit = 20, expirySeconds = 900, staleWindowSec = null) {
        const sec = Math.max(60, parseInt(expirySeconds, 10) || 900);
        // stale ceiling: don't retry syncing orders that are far past expiry (default: expiry + 2h)
        const staleSec = staleWindowSec != null ? Math.max(sec + 60, parseInt(staleWindowSec, 10)) : sec + 60;
        return await this.all(
            `SELECT oq.id, oq.signal_id, oq.asset, oq.signal_timestamp, oq.direction, oq.status_reason, oq.last_update_at, oq.created_at
             FROM orders_queue oq
             LEFT JOIN trades_ordered t ON t.order_id = oq.id
             WHERE oq.status = 'EXECUTED' AND t.id IS NULL
               AND (oq.status_reason LIKE 'placed_via=live%' OR oq.status_reason LIKE 'placed_via=dry%')
               AND (
                 (oq.last_update_at IS NOT NULL
                   AND datetime(oq.last_update_at) < datetime('now', '-' || ? || ' seconds')
                   AND datetime(oq.last_update_at) > datetime('now', '-' || ? || ' seconds'))
                 OR (oq.last_update_at IS NULL
                   AND oq.signal_timestamp < ?
                   AND oq.signal_timestamp > ?)
               )
             ORDER BY oq.last_update_at DESC, oq.signal_timestamp DESC
             LIMIT ?`,
            [sec, staleSec, Math.floor(Date.now() / 1000) - sec, Math.floor(Date.now() / 1000) - staleSec, limit]
        );
    }

    // ==================== EXECUTION PIPELINE QUEUE ====================

    /**
     * Enqueue a signal for live execution
     * @param {number} signalId - ID from signals table
     * @param {string} asset - Asset symbol
     * @param {string} direction - 'CALL' or 'PUT'
     * @param {number} signalTimestamp - UNIX timestamp of signal
     * @returns {Promise<number>} - ID of inserted queue item
     */
    async enqueueOrder(signalId, asset, direction, signalTimestamp) {
        const sql = `INSERT OR IGNORE INTO orders_queue
                     (signal_id, asset, direction, signal_timestamp, status, candle_id)
                     VALUES (?, ?, ?, ?, 'PENDING',
                             COALESCE((SELECT candle_id FROM signals WHERE id = ?),
                                      (SELECT id FROM candles WHERE asset = ? AND timestamp = ?)))`;
        try {
            const result = await this.run(sql, [signalId, asset, direction, signalTimestamp,
                signalId, asset, signalTimestamp]);
            if (!result.id || result.id === 0) {
                const row = await this.get('SELECT id FROM orders_queue WHERE asset = ? AND signal_timestamp = ?', [asset, signalTimestamp]);
                if (row) return row.id;
            }
            return result.id;
        } catch (error) {
            console.error('Error in enqueueOrder:', error.message);
            throw error;
        }
    }

    /**
     * Get pending orders from the queue
     * @param {number} limit 
     */
    async getPendingOrders(limit = 10) {
        const sql = `SELECT * FROM orders_queue WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?`;
        return await this.all(sql, [limit]);
    }

    /**
     * Update order queue status
     * @param {number} orderId 
     * @param {string} status 
     * @param {string} reason 
     */
    async updateOrderStatus(orderId, status, reason = null) {
        const datetimeStr = new Date().toISOString();
        let sql = `UPDATE orders_queue SET status = ?, last_update_at = ?`;
        let params = [status, datetimeStr];

        if (reason !== null) {
            sql += `, status_reason = ?`;
            params.push(reason);
        }

        sql += ` WHERE id = ?`;
        params.push(orderId);

        try {
            await this.run(sql, params);
        } catch (error) {
            console.error('Error updating order queue status:', error.message);
            throw error;
        }
    }

    /**
     * Link an executed order in trades_ordered
     */
    async insertOrderedTradeClosed(orderId, signalId, asset, entryTimestamp, direction, amount, entryPrice, exitTimestamp, exitPrice, result, profitLoss, payout, notes) {
        const sql = `INSERT OR IGNORE INTO trades_ordered
                     (order_id, signal_id, asset, entry_timestamp, direction, amount, entry_price,
                      exit_timestamp, exit_price, result, profit_loss, payout, notes, candle_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                             COALESCE((SELECT candle_id FROM signals WHERE id = ?),
                                      (SELECT candle_id FROM orders_queue WHERE id = ?)))`;
        try {
            await this.run(sql, [orderId, signalId, asset, entryTimestamp, direction, amount, entryPrice, exitTimestamp, exitPrice, result, profitLoss, payout, notes,
                signalId, orderId]);
        } catch (error) {
            console.error('Error inserting ordered trade:', error.message);
            throw error;
        }
    }

    // ==================== EXPORT OPERATIONS ====================

    /**
     * Export candles to CSV format
     */
    async exportCandlesToCSV(asset, limit = 1000) {
        const candles = await this.getCandles(asset, limit);

        if (candles.length === 0) {
            return 'timestamp,open,high,low,close,volume\n';
        }

        const header = 'timestamp,datetime,open,high,low,close,volume\n';
        const rows = candles.reverse().map(c => {
            const datetime = new Date(c.timestamp * 1000).toISOString();
            return `${c.timestamp},${datetime},${c.open},${c.high},${c.low},${c.close},${c.volume}`;
        }).join('\n');

        return header + rows;
    }

    /**
     * Export signals to CSV format
     */
    async exportSignalsToCSV(asset = null, limit = 1000) {
        let signals;
        if (asset) {
            signals = await this.getSignalsByAsset(asset, limit);
        } else {
            const sql = `SELECT * FROM signals WHERE direction != 'NEUTRAL' ORDER BY timestamp DESC LIMIT ?`;
            const rows = await this.all(sql, [limit]);
            signals = rows.map(row => ({
                ...row,
                reasons: JSON.parse(row.reasons)
            }));
        }

        if (signals.length === 0) {
            return 'timestamp,datetime,asset,direction,reasons\n';
        }

        const header = 'timestamp,datetime,asset,direction,reasons\n';
        const rows = signals.reverse().map(s => {
            const datetime = new Date(s.timestamp * 1000).toISOString();
            const reasons = s.reasons.join('; ');
            return `${s.timestamp},${datetime},${s.asset},${s.direction},"${reasons}"`;
        }).join('\n');

        return header + rows;
    }

    /**
     * Export indicators to CSV format
     */
    async exportIndicatorsToCSV(asset, limit = 1000) {
        const indicators = await this.getIndicators(asset, limit);

        const header = 'timestamp,datetime,asset,sma_10,sma_20,sma_50,rsi_14,stoch_k,stoch_d,stoch_prev_d,bb_upper,bb_middle,bb_lower,bb_width_bps,stc_value,stc_signal,stc_prev,stc_delta,cci_20,ema_12,ema_26,macd_macd,macd_signal,macd_hist,kc_upper,kc_middle,kc_lower,adx_14,adx_plus_di,adx_minus_di,williams_14,atr_14,atr_pct,psar,zz_direction,zz_pivot\n';

        if (indicators.length === 0) return header;

        const rows = indicators.reverse().map(i => {
            const dt = new Date(i.timestamp * 1000).toISOString();
            return [
                i.timestamp, dt, i.asset,
                i.sma_10 ?? '', i.sma_20 ?? '', i.sma_50 ?? '',
                i.rsi_14 ?? '',
                i.stoch_k ?? '', i.stoch_d ?? '', i.stoch_prev_d ?? '',
                i.bb_upper ?? '', i.bb_middle ?? '', i.bb_lower ?? '', i.bb_width_bps ?? '',
                i.stc_value ?? '', i.stc_signal ?? '', i.stc_prev ?? '', i.stc_delta ?? '',
                i.cci_20 ?? '',
                i.ema_12 ?? '', i.ema_26 ?? '',
                i.macd_macd ?? '', i.macd_signal ?? '', i.macd_hist ?? '',
                i.kc_upper ?? '', i.kc_middle ?? '', i.kc_lower ?? '',
                i.adx_14 ?? '', i.adx_plus_di ?? '', i.adx_minus_di ?? '',
                i.williams_14 ?? '',
                i.atr_14 ?? '',
                i.psar ?? '',
                i.zz_direction ?? '', i.zz_pivot ?? '',
            ].join(',');
        }).join('\n');

        return header + rows;
    }

    /**
     * Close database connection
     */
    close() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err.message);
                        reject(err);
                    } else {
                        console.log('✅ Database connection closed');
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

/**
 * Ensure mcp.db has the required schema.
 * Called by the bot at startup so the tables exist before any worker query runs.
 * Safe to call on an existing DB — all statements use IF NOT EXISTS / ignore duplicate columns.
 */
function initMcpSchema(mcpDbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(mcpDbPath, (err) => {
            if (err) return reject(new Error(`[MCP-SCHEMA] Cannot open ${mcpDbPath}: ${err.message}`));

            const stmts = [
                `CREATE TABLE IF NOT EXISTS mcp_orders (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    asset        TEXT NOT NULL,
                    direction    TEXT NOT NULL CHECK(direction IN ('CALL','PUT')),
                    amount       REAL,
                    signal_ts    INTEGER NOT NULL,
                    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                    status       TEXT NOT NULL DEFAULT 'PENDING'
                                     CHECK(status IN ('PENDING','EXECUTED','SKIPPED','FAILED','CANCELLED')),
                    status_reason TEXT,
                    updated_at   INTEGER
                )`,
                `CREATE INDEX IF NOT EXISTS idx_mcp_orders_status ON mcp_orders(status, created_at)`,
                `CREATE INDEX IF NOT EXISTS idx_mcp_orders_asset  ON mcp_orders(asset)`,
                `CREATE TABLE IF NOT EXISTS asset_controls (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    asset      TEXT NOT NULL,
                    action     TEXT NOT NULL DEFAULT 'BLOCK',
                    reason     TEXT,
                    source     TEXT,
                    expires_at INTEGER,
                    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                    active     INTEGER NOT NULL DEFAULT 1
                )`,
                `CREATE INDEX IF NOT EXISTS idx_asset_controls_asset ON asset_controls(asset, active)`,
                `CREATE TABLE IF NOT EXISTS agent_session_log (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent      TEXT NOT NULL,
                    action     TEXT NOT NULL,
                    asset      TEXT,
                    direction  TEXT,
                    score      REAL,
                    verdict    TEXT,
                    reasoning  TEXT,
                    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
                )`,
                `CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_session_log(created_at)`,
            ];

            let i = 0;
            function next() {
                if (i >= stmts.length) {
                    db.close();
                    return resolve();
                }
                db.run(stmts[i++], (err) => {
                    if (err) console.warn(`[MCP-SCHEMA] ${err.message}`); // non-fatal
                    next();
                });
            }
            next();
        });
    });
}

module.exports = { TradingDatabase, getAssetOtcVariants, initMcpSchema };
