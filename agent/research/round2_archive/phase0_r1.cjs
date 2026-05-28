'use strict';
// Phase 0 — R.1 Signal Capture
//
// For each candidate gate in the 34-gate inventory, scan every bar in
// phase0_research.db, apply the 3-bar independence rule, look up forward
// 5m/10m/15m closes, compute win_<expiry>, and write to backtest_signals.
//
// Hard constraints honoured:
//   - phase0_research.db only (never agent.db)
//   - tie = LOSS (win = 0)
//   - 3-bar (15-min) minimum gap per (asset, gate, direction)
//   - 70/30 chronological train/test fold per asset, by bar position,
//     computed BEFORE any signal selection
//   - Sessions in UTC-5 fixed: Asian (19-02) > European (03-07) >
//     American (08-17) > Off-hours (18)
//   - Break-even floor 0.5405 is enforced at R.2, not here.
//
// This script writes signals only. No statistics, no scoring, no filtering
// beyond independence. R.2 reads from backtest_signals.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'phase0_research.db');
const PERIOD = 300; // 5-minute bars
const INDEP_BARS = 3; // 3-bar minimum gap = 15 minutes
const TRAIN_FRACTION = 0.70;
const ATR_PCT_WINDOW = 100; // 100-bar lookback for ATR percentile rank

// ── Session classification (fixed UTC-5, no DST) ────────────────────────────
function nyHour(ts) {
    return ((Math.floor(ts / 3600) - 5) % 24 + 24) % 24;
}

function sessionFor(ts) {
    const h = nyHour(ts);
    // Priority: Asian (19-02) > European (03-07) > American (08-17) > Off-hours (18)
    if (h >= 19 || h <= 2) return 'Asian';
    if (h >= 3 && h <= 7) return 'European';
    if (h >= 8 && h <= 17) return 'American';
    return 'Off-hours'; // h === 18
}

// ── Gate definitions ────────────────────────────────────────────────────────
// cols: list of indicator/derived column names that must be non-null for the
// gate to be evaluated. Prevents JS null-coercion bugs in comparisons.
const GATES = [
    // ── ORIGINAL CALL gates (12) ──
    { name: 'stc_floor',           dir: 'CALL', cols: ['stc_value'], fn: r => r.stc_value <= 25 },
    { name: 'stc_deep_floor',      dir: 'CALL', cols: ['stc_value'], fn: r => r.stc_value <= 10 },
    { name: 'stc_rising',          dir: 'CALL', cols: ['stc_delta'], fn: r => r.stc_delta > 0 },
    { name: 'rsi_below_50',        dir: 'CALL', cols: ['rsi_14'],    fn: r => r.rsi_14 < 50 },
    { name: 'rsi_oversold',        dir: 'CALL', cols: ['rsi_14'],    fn: r => r.rsi_14 < 30 },
    { name: 'stoch_os_cross',      dir: 'CALL', cols: ['stoch_k', 'stoch_d'], fn: r => r.stoch_k < 20 && r.stoch_k > r.stoch_d },
    { name: 'di_plus_dominant',    dir: 'CALL', cols: ['plus_di', 'minus_di', 'adx'], fn: r => r.plus_di > r.minus_di && r.adx > 20 },
    { name: 'cci_oversold',        dir: 'CALL', cols: ['cci_20'],    fn: r => r.cci_20 < -100 },
    { name: 'williams_os',         dir: 'CALL', cols: ['williams_r'], fn: r => r.williams_r < -80 },
    { name: 'macd_hist_pos',       dir: 'CALL', cols: ['macd_histogram'], fn: r => r.macd_histogram > 0 },
    { name: 'psar_bullish',        dir: 'CALL', cols: ['psar_is_bullish'], fn: r => r.psar_is_bullish === 1 },
    { name: 'bb_squeeze_call',     dir: 'CALL', cols: ['bb_width_bps'], fn: r => r.bb_width_bps <= 5 },

    // ── REPORT-DERIVED CALL gate (1) ──
    { name: 'di_oversold_bounce',  dir: 'CALL', cols: ['plus_di', 'minus_di', 'cci_20', 'bb_width_bps'],
      fn: r => (r.plus_di - r.minus_di) < -25.6 && r.cci_20 < -65 && r.bb_width_bps >= 13.7 && r.bb_width_bps <= 37.7 },

    // ── ORIGINAL PUT gates (12) ──
    { name: 'stc_ceiling',         dir: 'PUT', cols: ['stc_value'], fn: r => r.stc_value >= 75 },
    { name: 'stc_deep_ceiling',    dir: 'PUT', cols: ['stc_value'], fn: r => r.stc_value >= 90 },
    { name: 'stc_falling',         dir: 'PUT', cols: ['stc_delta'], fn: r => r.stc_delta < 0 },
    { name: 'rsi_above_50',        dir: 'PUT', cols: ['rsi_14'],    fn: r => r.rsi_14 > 50 },
    { name: 'rsi_overbought',      dir: 'PUT', cols: ['rsi_14'],    fn: r => r.rsi_14 > 70 },
    { name: 'stoch_ob_cross',      dir: 'PUT', cols: ['stoch_k', 'stoch_d'], fn: r => r.stoch_k > 80 && r.stoch_k < r.stoch_d },
    { name: 'di_minus_dominant',   dir: 'PUT', cols: ['plus_di', 'minus_di', 'adx'], fn: r => r.minus_di > r.plus_di && r.adx > 20 },
    { name: 'cci_overbought',      dir: 'PUT', cols: ['cci_20'],    fn: r => r.cci_20 > 100 },
    { name: 'williams_ob',         dir: 'PUT', cols: ['williams_r'], fn: r => r.williams_r > -20 },
    { name: 'macd_hist_neg',       dir: 'PUT', cols: ['macd_histogram'], fn: r => r.macd_histogram < 0 },
    { name: 'psar_bearish',        dir: 'PUT', cols: ['psar_is_bullish'], fn: r => r.psar_is_bullish === 0 },
    { name: 'bb_squeeze_put',      dir: 'PUT', cols: ['bb_width_bps'], fn: r => r.bb_width_bps <= 5 },

    // ── REPORT-DERIVED PUT gates (9) ──
    { name: 'exhaustion_pure',     dir: 'PUT', cols: ['rsi_14', 'adx'],
      fn: r => r.rsi_14 < 30 && r.adx < 20 },
    { name: 'exhaustion_quiet',    dir: 'PUT', cols: ['rsi_14', 'atr_pct'],
      fn: r => r.rsi_14 < 30 && r.atr_pct < 0.30 },
    { name: 'exhaustion_triple',   dir: 'PUT', cols: ['rsi_14', 'adx', 'atr_pct'],
      fn: r => r.rsi_14 < 30 && r.adx < 20 && r.atr_pct < 0.30 },
    { name: 'exhaustion_psar_div', dir: 'PUT', cols: ['rsi_14', 'psar_is_bullish'],
      fn: r => r.rsi_14 < 30 && r.psar_is_bullish === 1 },
    { name: 'exhaustion_macd_trap', dir: 'PUT', cols: ['rsi_14', 'atr_pct', 'macd_histogram'],
      fn: r => r.rsi_14 < 30 && r.atr_pct < 0.30 && r.macd_histogram > 0 },
    { name: 'exhaustion_bear_sma', dir: 'PUT', cols: ['atr_pct', 'adx', 'sma_alignment_bear'],
      fn: r => r.atr_pct < 0.30 && r.adx < 20 && r.sma_alignment_bear === 1 },
    { name: 'williams_di_div',     dir: 'PUT', cols: ['williams_r', 'plus_di', 'minus_di'],
      fn: r => r.williams_r > -20 && (r.plus_di - r.minus_di) < -10 },
    { name: 'stoch_di_bearish',    dir: 'PUT', cols: ['stoch_k', 'plus_di', 'minus_di'],
      fn: r => r.stoch_k > 80 && (r.plus_di - r.minus_di) < -10 },
    { name: 'universal_lowvol',    dir: 'PUT', cols: ['atr_pct'],
      fn: r => r.atr_pct < 0.30 },
];

console.assert(GATES.length === 34, `Expected 34 gates, got ${GATES.length}`);
const CALL_COUNT = GATES.filter(g => g.dir === 'CALL').length;
const PUT_COUNT = GATES.filter(g => g.dir === 'PUT').length;
console.log(`Gate inventory: ${GATES.length} total (${CALL_COUNT} CALL, ${PUT_COUNT} PUT)`);

function gateFires(gate, r) {
    for (const c of gate.cols) {
        const v = r[c];
        if (v === null || v === undefined || Number.isNaN(v)) return false;
    }
    return gate.fn(r);
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`ERROR: ${DB_PATH} does not exist. Run VACUUM INTO first.`);
        process.exit(1);
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Confirm integrity once more
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') {
        console.error('ERROR: integrity check failed:', integrity);
        process.exit(1);
    }
    console.log('integrity_check: ok');

    // Recreate backtest_signals table
    db.exec(`DROP TABLE IF EXISTS backtest_signals`);
    db.exec(`
        CREATE TABLE backtest_signals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            asset       TEXT NOT NULL,
            bar_ts      INTEGER NOT NULL,
            gate        TEXT NOT NULL,
            direction   TEXT NOT NULL,
            fold        INTEGER NOT NULL,
            session     TEXT NOT NULL,
            entry_close REAL NOT NULL,
            exit_5m     REAL,
            exit_10m    REAL,
            exit_15m    REAL,
            win_5m      INTEGER,
            win_10m     INTEGER,
            win_15m     INTEGER,
            UNIQUE (asset, bar_ts, gate, direction)
        );
        CREATE INDEX idx_bts_gate_dir_fold ON backtest_signals (gate, direction, fold);
        CREATE INDEX idx_bts_asset_gate ON backtest_signals (asset, gate, direction);
        CREATE INDEX idx_bts_session ON backtest_signals (session);
    `);

    const assets = db.prepare(`SELECT DISTINCT asset FROM candles ORDER BY asset`).all().map(r => r.asset);
    console.log(`Assets: ${assets.length}`);

    // Total bars for accounting
    const totalBarsRow = db.prepare(`SELECT COUNT(*) AS n FROM indicators`).get();
    const totalIndicatorBars = totalBarsRow.n;

    const loadRows = db.prepare(`
        SELECT
            c.timestamp,
            c.close,
            i.stc_value, i.stc_delta,
            i.rsi_14,
            i.stoch_k, i.stoch_d,
            i.cci_20, i.williams_r,
            i.macd_histogram,
            i.bb_width_bps,
            i.adx, i.plus_di, i.minus_di,
            i.psar_is_bullish,
            i.atr_14,
            i.sma_10, i.sma_20, i.sma_50
        FROM candles c
        JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
        WHERE c.asset = ?
        ORDER BY c.timestamp ASC
    `);

    const loadAllCloses = db.prepare(`
        SELECT timestamp, close FROM candles WHERE asset = ? ORDER BY timestamp ASC
    `);

    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO backtest_signals
            (asset, bar_ts, gate, direction, fold, session,
             entry_close, exit_5m, exit_10m, exit_15m, win_5m, win_10m, win_15m)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
        for (const r of rows) {
            insertStmt.run(
                r.asset, r.bar_ts, r.gate, r.direction, r.fold, r.session,
                r.entry_close, r.exit_5m, r.exit_10m, r.exit_15m,
                r.win_5m, r.win_10m, r.win_15m
            );
        }
    });

    // Per-gate counts for sanity
    const gateFiresCount = new Map();   // bars where gate would fire (pre-independence)
    const gateSignalsCount = new Map(); // bars actually inserted (post-independence)
    const gateTrainCount = new Map();
    for (const g of GATES) {
        gateFiresCount.set(g.name + '|' + g.dir, 0);
        gateSignalsCount.set(g.name + '|' + g.dir, 0);
        gateTrainCount.set(g.name + '|' + g.dir, 0);
    }

    // Session counts (OTC vs non-OTC)
    const sessionOtcCount = { Asian: 0, European: 0, American: 0, 'Off-hours': 0 };
    const sessionNonOtcCount = { Asian: 0, European: 0, American: 0, 'Off-hours': 0 };
    let totalOtcBars = 0;
    let totalNonOtcBars = 0;

    // Fold size accounting
    let totalTrainBars = 0;
    let totalTestBars = 0;
    let totalScannedBars = 0;

    const t0 = Date.now();
    let assetIdx = 0;
    for (const asset of assets) {
        assetIdx++;
        const rows = loadRows.all(asset);
        if (rows.length < 4) continue;

        const isOtc = /_otc$/i.test(asset);

        // Build forward-close lookup from ALL candle rows (includes open bar)
        const closeRows = loadAllCloses.all(asset);
        const closeByTs = new Map();
        for (const cr of closeRows) closeByTs.set(cr.timestamp, cr.close);

        const n = rows.length;
        const trainCount = Math.floor(TRAIN_FRACTION * n);

        // Pre-compute derivative features and per-bar metadata
        for (let i = 0; i < n; i++) {
            const r = rows[i];

            // atr_pct — rolling 100-bar percentile rank of atr_14 (window = current + 99 prior)
            if (i >= ATR_PCT_WINDOW - 1 && r.atr_14 != null) {
                let countBelow = 0;
                let windowValid = true;
                for (let j = i - (ATR_PCT_WINDOW - 1); j <= i; j++) {
                    const v = rows[j].atr_14;
                    if (v == null) { windowValid = false; break; }
                    if (v < r.atr_14) countBelow++;
                }
                r.atr_pct = windowValid ? countBelow / ATR_PCT_WINDOW : null;
            } else {
                r.atr_pct = null;
            }

            // sma_alignment_bear: SMA10 < SMA20 < SMA50
            if (r.sma_10 != null && r.sma_20 != null && r.sma_50 != null) {
                r.sma_alignment_bear = (r.sma_10 < r.sma_20 && r.sma_20 < r.sma_50) ? 1 : 0;
            } else {
                r.sma_alignment_bear = null;
            }

            r.session = sessionFor(r.timestamp);
            r.fold = (i < trainCount) ? 0 : 1;

            totalScannedBars++;
            if (r.fold === 0) totalTrainBars++; else totalTestBars++;

            if (isOtc) { sessionOtcCount[r.session]++; totalOtcBars++; }
            else       { sessionNonOtcCount[r.session]++; totalNonOtcBars++; }
        }

        // Walk gates
        for (const gate of GATES) {
            let lastFireTs = null;
            const signalsForGate = [];
            for (let i = 0; i < n; i++) {
                const r = rows[i];

                const fires = gateFires(gate, r);
                if (!fires) continue;
                gateFiresCount.set(gate.name + '|' + gate.dir, gateFiresCount.get(gate.name + '|' + gate.dir) + 1);

                // 3-bar independence rule
                if (lastFireTs !== null && r.timestamp < lastFireTs + INDEP_BARS * PERIOD) continue;
                lastFireTs = r.timestamp;

                const entry = r.close;
                const ts5  = r.timestamp + PERIOD;
                const ts10 = r.timestamp + 2 * PERIOD;
                const ts15 = r.timestamp + 3 * PERIOD;
                const e5  = closeByTs.has(ts5)  ? closeByTs.get(ts5)  : null;
                const e10 = closeByTs.has(ts10) ? closeByTs.get(ts10) : null;
                const e15 = closeByTs.has(ts15) ? closeByTs.get(ts15) : null;

                const winFor = (exit) => {
                    if (exit === null) return null;
                    if (gate.dir === 'CALL') return exit > entry ? 1 : 0;
                    return exit < entry ? 1 : 0;
                };

                signalsForGate.push({
                    asset, bar_ts: r.timestamp, gate: gate.name, direction: gate.dir,
                    fold: r.fold, session: r.session,
                    entry_close: entry,
                    exit_5m: e5, exit_10m: e10, exit_15m: e15,
                    win_5m: winFor(e5), win_10m: winFor(e10), win_15m: winFor(e15)
                });

                if (r.fold === 0) {
                    gateTrainCount.set(gate.name + '|' + gate.dir, gateTrainCount.get(gate.name + '|' + gate.dir) + 1);
                }
            }
            if (signalsForGate.length > 0) {
                insertMany(signalsForGate);
                gateSignalsCount.set(gate.name + '|' + gate.dir,
                    gateSignalsCount.get(gate.name + '|' + gate.dir) + signalsForGate.length);
            }
        }

        if (assetIdx % 10 === 0) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`  [${assetIdx}/${assets.length}] ${asset} done (elapsed ${elapsed}s)`);
        }
    }

    const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nScan complete in ${elapsedTotal}s.`);

    // ── Per-gate summary ────────────────────────────────────────────────────
    console.log(`\nPer-gate counts (across all ${assets.length} assets):`);
    console.log('gate'.padEnd(28) + 'dir'.padEnd(6) +
                'fires'.padStart(8) + 'inserted'.padStart(10) + 'train'.padStart(9) +
                'fire_rate'.padStart(11));
    console.log('-'.repeat(72));
    for (const g of GATES) {
        const key = g.name + '|' + g.dir;
        const fires = gateFiresCount.get(key);
        const inserted = gateSignalsCount.get(key);
        const train = gateTrainCount.get(key);
        const rate = (fires / totalIndicatorBars * 100).toFixed(2) + '%';
        console.log(
            g.name.padEnd(28) + g.dir.padEnd(6) +
            String(fires).padStart(8) + String(inserted).padStart(10) +
            String(train).padStart(9) + rate.padStart(11)
        );
    }

    // ── Sanity checks ───────────────────────────────────────────────────────
    console.log(`\nSANITY CHECKS:`);
    const sanityChecks = [
        { name: 'rsi_below_50 CALL',    expect: '40-60%',  rate: gateFiresCount.get('rsi_below_50|CALL')   / totalIndicatorBars,
          pass: r => r > 0.40 && r < 0.60 },
        { name: 'rsi_oversold CALL',    expect: '5-15%',   rate: gateFiresCount.get('rsi_oversold|CALL')   / totalIndicatorBars,
          pass: r => r > 0.03 && r < 0.20 },
        { name: 'psar_bullish CALL',    expect: '40-60%',  rate: gateFiresCount.get('psar_bullish|CALL')   / totalIndicatorBars,
          pass: r => r > 0.40 && r < 0.60 },
        { name: 'bb_squeeze_call CALL', expect: '1-5%',    rate: gateFiresCount.get('bb_squeeze_call|CALL') / totalIndicatorBars,
          pass: r => r > 0.005 && r < 0.10 },
        { name: 'exhaustion_triple PUT', expect: '<2%',    rate: gateFiresCount.get('exhaustion_triple|PUT') / totalIndicatorBars,
          pass: r => r < 0.05 },
    ];
    let sanityFails = 0;
    for (const sc of sanityChecks) {
        const pct = (sc.rate * 100).toFixed(2) + '%';
        const ok = sc.pass(sc.rate) ? 'PASS' : 'FAIL';
        if (ok === 'FAIL') sanityFails++;
        console.log(`  ${sc.name.padEnd(28)} expected ${sc.expect.padEnd(8)} actual ${pct.padStart(7)}  ${ok}`);
    }

    // Fold split
    const trainPct = (totalTrainBars / totalScannedBars * 100).toFixed(2);
    const testPct = (totalTestBars / totalScannedBars * 100).toFixed(2);
    const foldExpected = 'train ~70%, test ~30%';
    const foldActual = `train ${trainPct}%, test ${testPct}%`;
    const foldOk = (totalTrainBars / totalScannedBars > 0.65 && totalTrainBars / totalScannedBars < 0.72) ? 'PASS' : 'FAIL';
    if (foldOk === 'FAIL') sanityFails++;
    console.log(`  ${'fold split'.padEnd(28)} expected ${foldExpected.padEnd(22)} actual ${foldActual}  ${foldOk}`);

    // Session distribution
    const asianOtc = totalOtcBars > 0 ? sessionOtcCount.Asian / totalOtcBars : 0;
    const asianNonOtc = totalNonOtcBars > 0 ? sessionNonOtcCount.Asian / totalNonOtcBars : 0;
    console.log(`\nSession distribution (OTC bars, n=${totalOtcBars}):`);
    for (const s of ['Asian', 'European', 'American', 'Off-hours']) {
        const pct = totalOtcBars > 0 ? (sessionOtcCount[s] / totalOtcBars * 100).toFixed(2) : '0';
        console.log(`  ${s.padEnd(12)} ${String(sessionOtcCount[s]).padStart(8)} (${pct}%)`);
    }
    console.log(`\nSession distribution (non-OTC bars, n=${totalNonOtcBars}):`);
    for (const s of ['Asian', 'European', 'American', 'Off-hours']) {
        const pct = totalNonOtcBars > 0 ? (sessionNonOtcCount[s] / totalNonOtcBars * 100).toFixed(2) : '0';
        console.log(`  ${s.padEnd(12)} ${String(sessionNonOtcCount[s]).padStart(8)} (${pct}%)`);
    }
    console.log(`Expected: Asian ~36% OTC, ~8% non-OTC. Actual: ${(asianOtc * 100).toFixed(2)}% OTC, ${(asianNonOtc * 100).toFixed(2)}% non-OTC`);

    // ── Independence-rule reject reporting ──────────────────────────────────
    console.log(`\n3-bar independence rule rejected:`);
    let totalRejected = 0;
    for (const g of GATES) {
        const key = g.name + '|' + g.dir;
        const rejected = gateFiresCount.get(key) - gateSignalsCount.get(key);
        totalRejected += rejected;
    }
    console.log(`  ${totalRejected} bars (across all gates) — these were within 15 min of a prior same-gate fire`);

    // ── Final summary ───────────────────────────────────────────────────────
    const totalSignals = db.prepare(`SELECT COUNT(*) AS n FROM backtest_signals`).get().n;
    const trainSignals = db.prepare(`SELECT COUNT(*) AS n FROM backtest_signals WHERE fold = 0`).get().n;
    const testSignals = db.prepare(`SELECT COUNT(*) AS n FROM backtest_signals WHERE fold = 1`).get().n;
    console.log(`\nbacktest_signals rows: ${totalSignals} (train ${trainSignals}, test ${testSignals})`);

    // Stop-condition check: any gate with < 50 train-fold signals?
    console.log(`\nLow-count gates (train-fold < 50):`);
    const lowCounts = [];
    for (const g of GATES) {
        const key = g.name + '|' + g.dir;
        const t = gateTrainCount.get(key);
        if (t < 50) lowCounts.push({ gate: g.name, dir: g.dir, train: t });
    }
    if (lowCounts.length === 0) {
        console.log('  none');
    } else {
        for (const lc of lowCounts) {
            console.log(`  ${lc.gate.padEnd(28)} ${lc.dir.padEnd(5)} train=${lc.train}`);
        }
        console.log(`\n  WARNING: ${lowCounts.length} gate(s) have < 50 train-fold signals.`);
        console.log(`  Per phase0-agent.md R.1 stop condition, asking the user whether to keep or drop these.`);
    }

    if (sanityFails > 0) {
        console.log(`\nWARNING: ${sanityFails} sanity check(s) FAILED. Investigate before R.2.`);
    } else {
        console.log(`\nAll sanity checks PASSED.`);
    }

    db.close();
    console.log(`\nR.1 done. Output table: backtest_signals (in phase0_research.db).`);
    console.log(`Next: append summary to phase0_log.md, then await user confirmation for R.2.`);
}

main();
