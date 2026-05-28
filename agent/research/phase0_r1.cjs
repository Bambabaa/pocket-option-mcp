'use strict';
// Phase 0 Round 3 — R.1 signal capture with 3-class labelling.
//
// For each candidate gate: scan indicator+derived_features, apply 3-bar independence,
// assign chronological 70/30 fold per asset, look up forward 5/10/15/20m closes,
// label WIN/LOSS/FLAT under PO economics (flats refunded → excluded from denominator),
// write rows to backtest_signals.
//
//   win_* = 1 WIN, 0 LOSS, NULL FLAT   → SUM(win) = wins, COUNT(win) = wins+losses
//   flat_* = 1 if FLAT else 0
//
//   node agent/research/phase0_r1.cjs

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/phase0_research.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const log = (m) => console.log(`[r1] ${m}`);

const EXPIRIES = { 5: 1, 10: 2, 15: 3, 20: 4 }; // minutes → bars (5m candles)
const INDEP_BARS = 3;                            // min gap between same-gate fires
const TRAIN_FRAC = 0.70;

// helper: non-null number, else NaN (NaN comparisons are always false — safe guard)
const N = (x) => (x == null ? NaN : x);

// ---- gate inventory ---------------------------------------------------------
const GATES = [
    // ---- original 12 CALL ----
    { name: 'stc_floor',        dir: 'CALL', f: r => N(r.stc_value) <= 25 },
    { name: 'stc_deep_floor',   dir: 'CALL', f: r => N(r.stc_value) <= 10 },
    { name: 'stc_rising',       dir: 'CALL', f: r => N(r.stc_delta) > 0 },
    { name: 'rsi_below_50',     dir: 'CALL', f: r => N(r.rsi_14) < 50 },
    { name: 'rsi_oversold',     dir: 'CALL', f: r => N(r.rsi_14) < 30 },
    { name: 'stoch_os_cross',   dir: 'CALL', f: r => N(r.stoch_k) < 20 && N(r.stoch_k) > N(r.stoch_d) },
    { name: 'di_plus_dominant', dir: 'CALL', f: r => N(r.plus_di) > N(r.minus_di) && N(r.adx) > 20 },
    { name: 'cci_oversold',     dir: 'CALL', f: r => N(r.cci_20) < -100 },
    { name: 'williams_os',      dir: 'CALL', f: r => N(r.williams_r) < -80 },
    { name: 'macd_hist_pos',    dir: 'CALL', f: r => N(r.macd_histogram) > 0 },
    { name: 'psar_bullish',     dir: 'CALL', f: r => r.psar_is_bullish === 1 },
    { name: 'bb_squeeze_call',  dir: 'CALL', f: r => N(r.bb_width_bps) <= 5 },
    // ---- original 12 PUT ----
    { name: 'stc_ceiling',      dir: 'PUT',  f: r => N(r.stc_value) >= 75 },
    { name: 'stc_deep_ceiling', dir: 'PUT',  f: r => N(r.stc_value) >= 90 },
    { name: 'stc_falling',      dir: 'PUT',  f: r => N(r.stc_delta) < 0 },
    { name: 'rsi_above_50',     dir: 'PUT',  f: r => N(r.rsi_14) > 50 },
    { name: 'rsi_overbought',   dir: 'PUT',  f: r => N(r.rsi_14) > 70 },
    { name: 'stoch_ob_cross',   dir: 'PUT',  f: r => N(r.stoch_k) > 80 && N(r.stoch_k) < N(r.stoch_d) },
    { name: 'di_minus_dominant',dir: 'PUT',  f: r => N(r.minus_di) > N(r.plus_di) && N(r.adx) > 20 },
    { name: 'cci_overbought',   dir: 'PUT',  f: r => N(r.cci_20) > 100 },
    { name: 'williams_ob',      dir: 'PUT',  f: r => N(r.williams_r) > -20 },
    { name: 'macd_hist_neg',    dir: 'PUT',  f: r => N(r.macd_histogram) < 0 },
    { name: 'psar_bearish',     dir: 'PUT',  f: r => r.psar_is_bullish === 0 },
    { name: 'bb_squeeze_put',   dir: 'PUT',  f: r => N(r.bb_width_bps) <= 5 },
    // ---- pre-registered carried-over gate (single-test, BH-exempt in R.3) ----
    { name: 'di_oversold_bounce', dir: 'CALL', f: r =>
        (N(r.plus_di) - N(r.minus_di)) < -25.6 && N(r.cci_20) < -65 &&
        N(r.bb_width_bps) >= 13.7 && N(r.bb_width_bps) <= 37.7 },
    // ---- report v2 derived (candidates, no special treatment) ----
    { name: 'REGIME_EU_LOW',    dir: 'PUT',  f: r => r.session === 'European' && r.vol_regime === 'LOW' },
    { name: 'REGIME_US_LOW',    dir: 'PUT',  f: r => r.session === 'American' && r.vol_regime === 'LOW' },
    { name: 'REGIME_ASIAN_LOW', dir: 'PUT',  f: r => r.session === 'Asian'    && r.vol_regime === 'LOW' },
    { name: 'ML_HL_PIVOT_CLEAN_BAR', dir: 'CALL', f: r =>
        r.hl === 1 && N(r.body_atr) <= 0.29 && N(r.dnwick_atr) <= 0.70 && r.bos_up === 1 },
    { name: 'ML_LH_DOWN_BIAS',  dir: 'PUT',  f: r =>
        r.hl === 0 && r.ll === 0 && r.lh === 1 && N(r.ret_1) > -1e-4 },
    { name: 'ML_LL_WILLIAMS_CALL', dir: 'CALL', f: r =>
        r.hl === 0 && r.ll === 1 && N(r.williams_r) <= -67.3 },
    { name: 'HL_LOW_BODY_BREAK', dir: 'CALL', f: r =>
        r.hl === 1 && N(r.body_atr) <= 0.29 && N(r.dnwick_atr) <= 0.70 },
    { name: 'SMC_SWEEP_LOW_OB',  dir: 'CALL', f: (r, ctx) => r.sweep_low === 1 && ctx.bull_ob_recent === 1 },
    { name: 'SMC_SWEEP_HIGH_OB', dir: 'PUT',  f: (r, ctx) => r.sweep_high === 1 && ctx.bear_ob_recent === 1 },
    { name: 'SMC_PREMIUM_REJECT', dir: 'PUT', f: r => r.zone === 'PREMIUM' && N(r.upwick_atr) > 1.0 },
    { name: 'SMC_DISCOUNT_REJECT', dir: 'CALL', f: r => r.zone === 'DISCOUNT' && N(r.dnwick_atr) > 1.0 },
    { name: 'DISPLACEMENT_UP',   dir: 'CALL', f: r => r.displacement === 1 && r.is_bull_bar === 1 && r.bos_up === 1 },
    { name: 'DISPLACEMENT_DOWN', dir: 'PUT',  f: r => r.displacement === 1 && r.is_bull_bar === 0 && r.bos_down === 1 },
];

// ---- schema -----------------------------------------------------------------
db.exec(`
DROP TABLE IF EXISTS backtest_signals;
CREATE TABLE backtest_signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    gate        TEXT NOT NULL,
    direction   TEXT NOT NULL,
    fold        INTEGER NOT NULL,
    entry_close REAL,
    exit_5m REAL, exit_10m REAL, exit_15m REAL, exit_20m REAL,
    win_5m INTEGER, win_10m INTEGER, win_15m INTEGER, win_20m INTEGER,
    flat_5m INTEGER, flat_10m INTEGER, flat_15m INTEGER, flat_20m INTEGER,
    session TEXT, vol_regime TEXT, zone TEXT
);
`);

const insert = db.prepare(`
INSERT INTO backtest_signals (
    asset, timestamp, gate, direction, fold, entry_close,
    exit_5m, exit_10m, exit_15m, exit_20m,
    win_5m, win_10m, win_15m, win_20m,
    flat_5m, flat_10m, flat_15m, flat_20m,
    session, vol_regime, zone
) VALUES (
    @asset, @timestamp, @gate, @direction, @fold, @entry_close,
    @exit_5m, @exit_10m, @exit_15m, @exit_20m,
    @win_5m, @win_10m, @win_15m, @win_20m,
    @flat_5m, @flat_10m, @flat_15m, @flat_20m,
    @session, @vol_regime, @zone
)`);
const writeAll = db.transaction((rows) => { for (const r of rows) insert.run(r); });

function label(dir, entry, exit) {
    if (exit == null) return { win: null, flat: 0 };
    if (exit === entry) return { win: null, flat: 1 };
    const up = exit > entry;
    const winBool = dir === 'CALL' ? up : !up;
    return { win: winBool ? 1 : 0, flat: 0 };
}

const assets = db.prepare('SELECT DISTINCT asset FROM candles ORDER BY asset').all().map(r => r.asset);

let scannedBars = 0, totalSignals = 0, rejectedIndep = 0, trainSignals = 0, testSignals = 0;
const fireCount = {}, sigCount = {}, flatCount = {};

for (const asset of assets) {
    const bars = db.prepare(`
        SELECT c.timestamp ts, c.close,
               i.stc_value, i.stc_delta, i.rsi_14, i.stoch_k, i.stoch_d,
               i.plus_di, i.minus_di, i.adx, i.cci_20, i.williams_r,
               i.macd_histogram, i.psar_is_bullish, i.bb_width_bps,
               d.body_atr, d.upwick_atr, d.dnwick_atr, d.is_bull_bar,
               d.ret_1, d.hh, d.hl, d.lh, d.ll, d.zone,
               d.sweep_low, d.sweep_high, d.bull_ob, d.bear_ob,
               d.bos_up, d.bos_down, d.displacement, d.vol_regime, d.session
        FROM candles c
        JOIN indicators i       ON i.asset = c.asset AND i.timestamp = c.timestamp
        JOIN derived_features d ON d.asset = c.asset AND d.timestamp = c.timestamp
        WHERE c.asset = ?
        ORDER BY c.timestamp ASC
    `).all(asset);

    const n = bars.length;
    const cutoff = Math.floor(n * TRAIN_FRAC);
    const lastFireIdx = {};
    const rows = [];

    for (let i = 0; i < n; i++) {
        const r = bars[i];
        scannedBars++;

        let bull_ob_recent = 0, bear_ob_recent = 0;
        for (let j = Math.max(0, i - 4); j <= i; j++) {
            if (bars[j].bull_ob === 1) bull_ob_recent = 1;
            if (bars[j].bear_ob === 1) bear_ob_recent = 1;
        }
        const ctx = { bull_ob_recent, bear_ob_recent };

        for (const g of GATES) {
            let fires = false;
            try { fires = !!g.f(r, ctx); } catch (_) { fires = false; }
            if (!fires) continue;
            fireCount[g.name] = (fireCount[g.name] || 0) + 1;

            const last = lastFireIdx[g.name];
            if (last != null && (i - last) < INDEP_BARS) { rejectedIndep++; continue; }
            lastFireIdx[g.name] = i;

            const fold = i < cutoff ? 0 : 1;
            const entry = r.close;
            const rec = { asset, timestamp: r.ts, gate: g.name, direction: g.dir, fold, entry_close: entry,
                session: r.session, vol_regime: r.vol_regime, zone: r.zone };

            for (const [min, barsAhead] of Object.entries(EXPIRIES)) {
                const exitIdx = i + barsAhead;
                const exit = exitIdx < n ? bars[exitIdx].close : null;
                const lab = label(g.dir, entry, exit);
                rec[`exit_${min}m`] = exit;
                rec[`win_${min}m`]  = lab.win;
                rec[`flat_${min}m`] = lab.flat;
            }
            rows.push(rec);
            sigCount[g.name] = (sigCount[g.name] || 0) + 1;
            if (rec.flat_15m === 1) flatCount[g.name] = (flatCount[g.name] || 0) + 1;
            if (fold === 0) trainSignals++; else testSignals++;
            totalSignals++;
        }
    }
    writeAll(rows);
    log(`${asset}: ${rows.length} signals (train cutoff idx=${cutoff}/${n})`);
}

// ---- summary + sanity -------------------------------------------------------
log('--- totals ---');
log(`signals written: ${totalSignals}  (train ${trainSignals} / test ${testSignals})`);
log(`fold split: train ${(trainSignals/totalSignals*100).toFixed(1)}% / test ${(testSignals/totalSignals*100).toFixed(1)}%`);
log(`3-bar independence rejected: ${rejectedIndep} fires`);

log('--- per-gate signals & flat rate (15m) ---');
console.log('  ' + 'gate'.padEnd(24) + 'dir'.padEnd(6) + 'signals'.padStart(8) + 'flat15'.padStart(8) + 'flat%'.padStart(8) + '  firePct');
for (const g of GATES) {
    const sig = sigCount[g.name] || 0;
    const fl = flatCount[g.name] || 0;
    const flpct = sig ? (fl / sig * 100).toFixed(1) + '%' : '-';
    const firePct = ((fireCount[g.name] || 0) / scannedBars * 100).toFixed(2) + '%';
    console.log('  ' + g.name.padEnd(24) + g.dir.padEnd(6) + String(sig).padStart(8) + String(fl).padStart(8) + flpct.padStart(8) + '  ' + firePct);
}

log('--- sanity checks ---');
const sc = [];
const rsiOsFire = (fireCount['rsi_oversold']||0)/scannedBars*100;
sc.push(['rsi_oversold fire rate 5-15%', rsiOsFire.toFixed(2)+'%', rsiOsFire>=4 && rsiOsFire<=18]);
const bbFire = (fireCount['bb_squeeze_call']||0)/scannedBars*100;
sc.push(['bb_squeeze fire rate (info)', bbFire.toFixed(2)+'%', true]);
const trainPct = trainSignals/totalSignals*100;
sc.push(['train fold ~70%', trainPct.toFixed(1)+'%', trainPct>=65 && trainPct<=75]);
let fails=0;
for (const [name,val,ok] of sc){ if(!ok) fails++; console.log(`  [${ok?'PASS':'FAIL'}] ${name.padEnd(32)} = ${val}`); }
log(fails===0 ? 'sanity checks passed' : `${fails} sanity check(s) flagged`);

db.close();
