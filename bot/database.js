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

            // 2. Indicators table - KT-only: MA1/2/3, RSI, bands, stochastic (v1+v2), Keltner, Schaff
            `CREATE TABLE IF NOT EXISTS indicators (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                ma1 REAL,
                ma2 REAL,
                ma3 REAL,
                rsi REAL,
                rsi_5 REAL,
                rsi_8 REAL,
                bb_upper REAL,
                bb_middle REAL,
                bb_lower REAL,
                stochastic_k REAL,
                stochastic_d REAL,
                keltner_upper REAL,
                keltner_lower REAL,
                schaff_value REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp)
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
                UNIQUE(asset, timestamp)
            )`,

            // 4. Trades table - stores executed trades
            `CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                entry_timestamp INTEGER NOT NULL,
                exit_timestamp INTEGER,
                direction TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL,
                amount REAL NOT NULL,
                signal_strength INTEGER,
                result TEXT,
                profit_loss REAL,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

            // 6. Performance table - stores performance metrics
            `CREATE TABLE IF NOT EXISTS performance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                losing_trades INTEGER DEFAULT 0,
                win_rate REAL DEFAULT 0,
                total_profit_loss REAL DEFAULT 0,
                best_trade REAL DEFAULT 0,
                worst_trade REAL DEFAULT 0,
                average_profit REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date)
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
                UNIQUE(asset, signal_timestamp)
            )`,

            // Migration: add updated_at to signal_outcomes if missing (safe, idempotent)
            `ALTER TABLE signal_outcomes ADD COLUMN updated_at INTEGER`,

            // KT indicators remodel: add columns for cascade (video1 → video2 → video3)
            `ALTER TABLE indicators ADD COLUMN keltner_upper REAL`,
            `ALTER TABLE indicators ADD COLUMN keltner_lower REAL`,
            `ALTER TABLE indicators ADD COLUMN ma1 REAL`,
            `ALTER TABLE indicators ADD COLUMN ma2 REAL`,
            `ALTER TABLE indicators ADD COLUMN ma3 REAL`,
            // `ALTER TABLE indicators ADD COLUMN rsi_kt REAL`, // Legacy - removed in favor of rsi_5 / rsi_8
            `ALTER TABLE indicators ADD COLUMN rsi_5 REAL`,
            `ALTER TABLE indicators ADD COLUMN rsi_8 REAL`,
            `ALTER TABLE indicators ADD COLUMN schaff_value REAL`,

            // Add strategy_used directly to signals table
            `ALTER TABLE signals ADD COLUMN strategy_used TEXT`,

            // Video2 stochastic (5,3,3) — separate columns to avoid overwriting Video1 (13,3,3)
            `ALTER TABLE indicators ADD COLUMN stochastic_k_v2 REAL`,
            `ALTER TABLE indicators ADD COLUMN stochastic_d_v2 REAL`,

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
            'CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset)',
            'CREATE INDEX IF NOT EXISTS idx_trades_result ON trades(result)',
            'CREATE INDEX IF NOT EXISTS idx_performance_date ON performance(date DESC)',
            'CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset ON signal_outcomes(asset)',
            'CREATE INDEX IF NOT EXISTS idx_signal_outcomes_signal_ts ON signal_outcomes(signal_timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_orders_queue_status_created ON orders_queue(status, created_at)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_order_id ON trades_ordered(order_id)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_signal_id ON trades_ordered(signal_id)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_result ON trades_ordered(result)',
            'CREATE INDEX IF NOT EXISTS idx_trades_ordered_entry_ts ON trades_ordered(entry_timestamp DESC)'
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

            // Schema migrations: drop deprecated columns from indicators/signals tables if present
            await this.migrateIndicatorsDropLegacyColumns();
            await this.migrateSignalsDropStrengthColumns();

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
        const sql = `INSERT OR REPLACE INTO candles
                     (asset, timestamp, open, high, low, close, volume)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;

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
     * Insert indicator data (KT cascade: video3 → video2 → video1).
     * Indicator table features (KT-only columns):
     *   ma1, ma2, ma3     — Video 2 SMAs (6, 50, 14)
     *   rsi               — RSI (v2 period 5 or v3 period 8)
     *   bb_upper, bb_middle, bb_lower — Bollinger/Keltner bands (Video 3 / Video 1)
     *   stochastic_k, stochastic_d     — Video 1 Stochastic (13,3,3)
     *   stochastic_k_v2, stochastic_d_v2 — Video 2 Stochastic (5,3,3)
     *   keltner_upper, keltner_lower   — Video 1 Keltner channel
     *   schaff_value      — Video 3 Schaff Trend Cycle
     * Unset values are stored as null (no legacy strength/ADX columns).
     */
    async insertIndicators(asset, timestamp, indicators) {
        const keltner = indicators.keltner;
        const stoch = indicators.stochasticKT;
        const bb = indicators.bollingerKT || indicators.bollinger;
        const rsiKT = indicators.rsiKT_v2 != null ? indicators.rsiKT_v2 : (indicators.rsiKT_v3 != null ? indicators.rsiKT_v3 : indicators.rsiKT);
        const schaff = indicators.schaffTrendCycle;

        const sql = `INSERT OR REPLACE INTO indicators
                     (asset, timestamp,
                      ma1, ma2, ma3,
                      rsi, rsi_5, rsi_8,
                      bb_upper, bb_middle, bb_lower,
                      stochastic_k, stochastic_d,
                      stochastic_k_v2, stochastic_d_v2,
                      keltner_upper, keltner_lower,
                      schaff_value)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const params = [
            asset,
            timestamp,
            // KT Video 2: MA1, MA2, MA3 (6, 50, 14) — null when not yet available
            indicators.ma1 ?? indicators.ma6,   // ma1 // ?? null
            indicators.ma2 ?? indicators.ma50,  // ma2 // ?? null
            indicators.ma3 ?? indicators.ma14,  // ma3 // ?? null
            rsiKT ?? indicators.rsi,            // rsi (legacy/fallback)
            indicators.rsi_5,                   // rsi_5
            indicators.rsi_8,                   // rsi_8
            // KT Video 1 & 3 bands — null when not available
            bb?.upper ?? keltner?.upper,        // bb_upper // ?? null
            bb?.middle ?? keltner?.middle,      // bb_middle // ?? null
            bb?.lower ?? keltner?.lower,        // bb_lower // ?? null
            // KT Video 1 stochastic (13,3,3) — null when not available
            stoch?.k ?? null,                      // stochastic_k
            stoch?.d ?? null,                      // stochastic_d
            // KT Video 2 stochastic (5,3,3) — flat properties set in indicators.js
            indicators.stochastic_k ?? null,       // stochastic_k_v2
            indicators.stochastic_d ?? null,       // stochastic_d_v2
            // keltner/schaff — null when not available
            keltner?.upper,   // ?? null
            keltner?.lower,   // ?? null
            schaff?.value     // ?? null
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
        if (strategy === 'video2') strategy = 'Fast Trend Follower';
        if (strategy === 'video3') strategy = 'Cyclical Sniper';

        const sql = `INSERT OR IGNORE INTO signals
                     (asset, timestamp, direction, strategy_used, reasons)
                     VALUES (?, ?, ?, ?, ?)`;

        const params = [
            asset,
            timestamp,
            signal.direction,
            strategy,
            JSON.stringify(signal.reasons || [])
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
     * Get signals with minimum strength
     */
    async getSignalsByStrength(minStrength, limit = 100) {
        const sql = `SELECT * FROM signals
                     WHERE direction != 'NEUTRAL'
                     ORDER BY timestamp DESC
                     LIMIT ?`;

        const rows = await this.all(sql, [limit]);

        return rows.map(row => ({
            ...row,
            reasons: JSON.parse(row.reasons)
        }));
    }

    /**
     * Get signals generated during strong trends (ADX >= 25)
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

            // New KT-only schema: asset, timestamp, direction, reasons, created_at
            await this.run(`CREATE TABLE IF NOT EXISTS signals_tmp (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                direction TEXT NOT NULL,
                reasons TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(asset, timestamp)
            )`);

            await this.run(`INSERT INTO signals_tmp (id, asset, timestamp, direction, reasons, created_at)
                            SELECT id, asset, timestamp, direction, reasons, created_at FROM signals`);

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
     * Migration: drop legacy non-KT columns from indicators table using ALTER TABLE DROP COLUMN.
     * Safe to run multiple times; ignores errors when columns are already gone or DROP COLUMN is unsupported.
     */
    async migrateIndicatorsDropLegacyColumns() {
        const deprecated = [
            'fast_ma', 'slow_ma',
            'macd_value', 'macd_signal', 'macd_histogram',
            'adx_value', 'adx_plus_di', 'adx_minus_di',
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

    // ==================== TRADE OPERATIONS ====================

    /**
     * Insert trade execution
     */
    async insertTrade(asset, entryTimestamp, direction, entryPrice, amount, signalStrength = null, notes = null) {
        const sql = `INSERT INTO trades
                     (asset, entry_timestamp, direction, entry_price, amount, signal_strength, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;

        try {
            const result = await this.run(sql, [asset, entryTimestamp, direction, entryPrice, amount, signalStrength, notes]);
            return result.id; // Return trade ID
        } catch (error) {
            console.error('Error inserting trade:', error.message);
            throw error;
        }
    }

    /**
     * Update trade with exit information
     */
    async updateTradeExit(tradeId, exitTimestamp, exitPrice, result, profitLoss) {
        const sql = `UPDATE trades
                     SET exit_timestamp = ?, exit_price = ?, result = ?, profit_loss = ?
                     WHERE id = ?`;

        try {
            await this.run(sql, [exitTimestamp, exitPrice, result, profitLoss, tradeId]);
        } catch (error) {
            console.error('Error updating trade:', error.message);
            throw error;
        }
    }

    /**
     * Get all trades
     */
    async getTrades(asset = null, limit = 100) {
        let sql;
        let params = [];

        if (asset) {
            sql = `SELECT * FROM trades WHERE asset = ? ORDER BY entry_timestamp DESC LIMIT ?`;
            params = [asset, limit];
        } else {
            sql = `SELECT * FROM trades ORDER BY entry_timestamp DESC LIMIT ?`;
            params = [limit];
        }

        return await this.all(sql, params);
    }

    /**
     * Get open trades (not yet closed)
     */
    async getOpenTrades(asset = null) {
        let sql;
        let params = [];

        if (asset) {
            sql = `SELECT * FROM trades WHERE asset = ? AND exit_timestamp IS NULL ORDER BY entry_timestamp DESC`;
            params = [asset];
        } else {
            sql = `SELECT * FROM trades WHERE exit_timestamp IS NULL ORDER BY entry_timestamp DESC`;
        }

        return await this.all(sql, params);
    }

    /**
     * Get trade performance statistics
     */
    async getTradeStats(asset = null) {
        let sql;
        let params = [];

        if (asset) {
            sql = `SELECT
                       COUNT(*) as total_trades,
                       SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as winning_trades,
                       SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) as losing_trades,
                       ROUND(AVG(CASE WHEN result = 'WIN' THEN 1.0 ELSE 0 END) * 100, 2) as win_rate,
                       SUM(profit_loss) as total_profit_loss,
                       MAX(profit_loss) as best_trade,
                       MIN(profit_loss) as worst_trade,
                       AVG(profit_loss) as avg_profit
                   FROM trades
                   WHERE asset = ? AND result IS NOT NULL`;
            params = [asset];
        } else {
            sql = `SELECT
                       COUNT(*) as total_trades,
                       SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as winning_trades,
                       SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) as losing_trades,
                       ROUND(AVG(CASE WHEN result = 'WIN' THEN 1.0 ELSE 0 END) * 100, 2) as win_rate,
                       SUM(profit_loss) as total_profit_loss,
                       MAX(profit_loss) as best_trade,
                       MIN(profit_loss) as worst_trade,
                       AVG(profit_loss) as avg_profit
                   FROM trades
                   WHERE result IS NOT NULL`;
        }

        return await this.get(sql, params);
    }

    // ==================== PERFORMANCE OPERATIONS ====================

    /**
     * Update daily performance metrics
     */
    async updateDailyPerformance(date, metrics) {
        const sql = `INSERT OR REPLACE INTO performance
                     (date, total_trades, winning_trades, losing_trades,
                      win_rate, total_profit_loss, best_trade, worst_trade, average_profit)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const params = [
            date,
            metrics.totalTrades || 0,
            metrics.winningTrades || 0,
            metrics.losingTrades || 0,
            metrics.winRate || 0,
            metrics.totalProfitLoss || 0,
            metrics.bestTrade || 0,
            metrics.worstTrade || 0,
            metrics.averageProfit || 0
        ];

        try {
            await this.run(sql, params);
        } catch (error) {
            console.error('Error updating performance:', error.message);
            throw error;
        }
    }

    /**
     * Get performance history
     */
    async getPerformanceHistory(limit = 30) {
        const sql = `SELECT * FROM performance ORDER BY date DESC LIMIT ?`;
        return await this.all(sql, [limit]);
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
        stats.trades = await this.get('SELECT COUNT(*) as count FROM trades');
        stats.performance = await this.get('SELECT COUNT(*) as count FROM performance');

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
                strength: signal.strength,
                entryPrice,
                exitPrice,
                priceChange,
                result,
                adx: signal.adx_value,
                inStrongTrend: signal.in_strong_trend
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
        const now = Math.floor(Date.now() / 1000);
        await this.run(
            `INSERT OR IGNORE INTO signal_outcomes
             (asset, signal_timestamp, signal_id, direction, entry_price, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [asset, signalTimestamp, signalId, direction, entryPrice, now]
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
    async getExecutedOrdersAwaitingResultSync(limit = 20, expirySeconds = 65) {
        const sec = Math.max(60, parseInt(expirySeconds, 10) || 65);
        return await this.all(
            `SELECT oq.id, oq.signal_id, oq.asset, oq.signal_timestamp, oq.direction, oq.status_reason, oq.last_update_at, oq.created_at
             FROM orders_queue oq
             LEFT JOIN trades_ordered t ON t.order_id = oq.id
             WHERE oq.status = 'EXECUTED' AND t.id IS NULL
               AND (oq.status_reason LIKE 'placed_via=live%' OR oq.status_reason LIKE 'placed_via=dry%')
               AND (
                 (oq.last_update_at IS NOT NULL AND datetime(oq.last_update_at) < datetime('now', '-' || ? || ' seconds'))
                 OR (oq.last_update_at IS NULL AND oq.signal_timestamp < ?)
               )
             ORDER BY oq.last_update_at DESC, oq.signal_timestamp DESC
             LIMIT ?`,
            [sec, Math.floor(Date.now() / 1000) - sec, limit]
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
                     (signal_id, asset, direction, signal_timestamp, status) 
                     VALUES (?, ?, ?, ?, 'PENDING')`;
        try {
            const result = await this.run(sql, [signalId, asset, direction, signalTimestamp]);
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
                      exit_timestamp, exit_price, result, profit_loss, payout, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        try {
            await this.run(sql, [orderId, signalId, asset, entryTimestamp, direction, amount, entryPrice, exitTimestamp, exitPrice, result, profitLoss, payout, notes]);
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

        if (indicators.length === 0) {
            return 'timestamp,datetime,asset,ma1,ma2,ma3,rsi,rsi_5,rsi_8,bb_upper,bb_middle,bb_lower,stochastic_k,stochastic_d,strategy_used,keltner_upper,keltner_lower,schaff_value\n';
        }

        const header = 'timestamp,datetime,asset,ma1,ma2,ma3,rsi,rsi_5,rsi_8,bb_upper,bb_middle,bb_lower,stochastic_k,stochastic_d,strategy_used,keltner_upper,keltner_lower,schaff_value\n';
        const rows = indicators.reverse().map(i => {
            const datetime = new Date(i.timestamp * 1000).toISOString();
            return `${i.timestamp},${datetime},${i.asset},${i.ma1 || ''},${i.ma2 || ''},${i.ma3 || ''},${i.rsi || ''},${i.rsi_5 || ''},${i.rsi_8 || ''},${i.bb_upper || ''},${i.bb_middle || ''},${i.bb_lower || ''},${i.stochastic_k || ''},${i.stochastic_d || ''},${i.strategy_used || ''},${i.keltner_upper || ''},${i.keltner_lower || ''},${i.schaff_value || ''}`;
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

module.exports = { TradingDatabase, getAssetOtcVariants };
