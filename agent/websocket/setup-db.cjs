'use strict';
// Run once to create agent/data/agent.db schema
// Usage: node agent/websocket/setup-db.cjs

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/agent.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS candles (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,   -- unix seconds, bar open time (5m boundary)
    open       REAL    NOT NULL,
    high       REAL    NOT NULL,
    low        REAL    NOT NULL,
    close      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS indicators (
    asset              TEXT    NOT NULL,
    timestamp          INTEGER NOT NULL,
    -- SMA (PO defaults: 10, 20, 50)
    sma_10             REAL,
    sma_20             REAL,
    sma_50             REAL,
    -- EMA (PO defaults: 12, 26)
    ema_12             REAL,
    ema_26             REAL,
    -- RSI (Wilder, period=14)
    rsi_14             REAL,
    -- MACD (fast=12, slow=26, signal=9)
    macd_line          REAL,
    macd_signal        REAL,
    macd_histogram     REAL,
    -- Bollinger Bands (period=20, stdDev=2)
    bb_upper           REAL,
    bb_middle          REAL,
    bb_lower           REAL,
    bb_width_bps       REAL,
    -- Stochastic (K=5, D=3, smooth=3)
    stoch_k            REAL,
    stoch_d            REAL,
    stoch_prev_d       REAL,
    -- Keltner Channel (ema=20, atr=10, mult=2)
    keltner_upper      REAL,
    keltner_middle     REAL,
    keltner_lower      REAL,
    -- Zig Zag (deviation=5%, minBars=4)
    zigzag_direction   INTEGER,   -- +1 up, -1 down
    zigzag_reversal    INTEGER,   -- 1 if this bar is a recent pivot
    zigzag_pivot       REAL,      -- price at last pivot
    -- Schaff Trend Cycle (emaFast=23, emaSlow=50, cycle=10, smooth1=3, smooth2=3)
    stc_value          REAL,
    stc_signal         REAL,
    stc_prev           REAL,
    stc_delta          REAL,
    -- ADX (period=14)
    adx                REAL,
    plus_di            REAL,
    minus_di           REAL,
    -- CCI (period=20)
    cci_20             REAL,
    -- Williams %R (period=14)
    williams_r         REAL,
    -- ATR (period=14)
    atr_14             REAL,
    -- Parabolic SAR (acceleration=0.02, max=0.2)
    psar_value         REAL,
    psar_trend         INTEGER,   -- +1 bullish, -1 bearish
    psar_is_bullish    INTEGER,   -- 1 / 0
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
    closed_at      INTEGER,
    entry_price    REAL,
    exit_price     REAL,
    status         TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING','EXECUTED','CLOSED','FAILED','CANCELLED')),
    result         TEXT    CHECK(result IN ('WIN','LOSS','DRAW',NULL)),
    profit_loss    REAL,
    cycle_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_orders_status ON agent_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_orders_asset  ON agent_orders(asset);

CREATE TABLE IF NOT EXISTS prices (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,   -- unix seconds (per-tick)
    price      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_prices_asset_ts ON prices(asset, timestamp);

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
`);

db.close();
console.log(`agent.db created at ${DB_PATH}`);
