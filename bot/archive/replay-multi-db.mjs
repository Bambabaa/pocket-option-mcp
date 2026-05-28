/**
 * replay-multi-db.mjs
 *
 * Runs full 7-gate STC reversal logic across ALL historical datasets.
 * Gates mirror analysis.js exactly:
 *   CALL: prevSTC≤25, STC<75, STC rising, rsi_min_5≤35, bullCross3, BB≥10bps, low≤bb_lower
 *   PUT:  prevSTC≥75, STC>25, STC falling, rsi_max_5≥65, bearCross3, BB≥10bps, high≥bb_upper
 *   Expiry: 120s primary (60s shown for reference)
 *
 * Outputs: console report + data/replay_signals.csv for deep analysis
 */

import sqlite3pkg from 'sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, '../../data');

const DATASETS = [
    { path: `${DATA}/trading_data_v1.db`, label: 'v1        ' },
    { path: `${DATA}/trading_data_v2_13-15.db`, label: 'v2_13-15  ' },
    { path: `${DATA}/trading_data_V3_17.db`, label: 'V3_17     ' },
    { path: `${DATA}/trading_data-V4_18.db`, label: 'V4_18     ' },
    { path: `${DATA}/trading_data-V5_25.db`, label: 'V5_25     ' },
    { path: `${DATA}/trading_data.db`, label: 'live      ' },
];

const AMOUNT = 500;
const PAYOUT = 0.92;

// ── SQLite helpers ─────────────────────────────────────────────────────────────
function openDb(path) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, err => err ? rej(err) : res(db));
    });
}
function dbAll(db, sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows || [])));
}
function closeDb(db) {
    return new Promise((res, rej) => db.close(err => err ? rej(err) : res()));
}

// ── Stat helpers ───────────────────────────────────────────────────────────────
function normalCDF(z) {
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911;
    const sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + p * x);
    return 0.5 * (1 + sign * (1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-x * x)));
}
function logFact(n) { let s = 0; for (let i = 2; i <= n; i++)s += Math.log(i); return s; }
function logBinom(n, k) { return logFact(n) - logFact(k) - logFact(n - k); }
function binomP(wins, n, p0 = 0.5) {
    if (n === 0 || wins / n <= p0) return 1;
    if (n > 120) return Math.max(0, 1 - normalCDF((wins / n - p0) / Math.sqrt(p0 * (1 - p0) / n)));
    let pv = 0; const lp = Math.log(p0), lq = Math.log(1 - p0);
    for (let k = wins; k <= n; k++)pv += Math.exp(logBinom(n, k) + k * lp + (n - k) * lq);
    return Math.min(1, pv);
}
function wilsonCI(wins, n) {
    if (n === 0) return '      N/A     ';
    const z = 1.96, p = wins / n, z2 = z * z, c = (p + z2 / (2 * n)) / (1 + z2 / n);
    const m = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return `[${(Math.max(0, c - m) * 100).toFixed(0)}%,${(Math.min(1, c + m) * 100).toFixed(0)}%]`;
}
function kelly(wins, n) {
    if (n === 0) return 'N/A';
    const p = wins / n; return ((p - (1 - p) / PAYOUT) * 100).toFixed(1) + '%';
}
function sigMark(p) {
    if (p === 'N/A') return '   ';
    const v = +p;
    if (v < 0.01) return '***';
    if (v < 0.05) return '** ';
    if (v < 0.10) return '*  ';
    return '   ';
}

// ── Lookback context ───────────────────────────────────────────────────────────
function computeCtx(candles, t) {
    const LOOKBACK = 10;
    const history = [];
    for (let i = Math.max(0, t - LOOKBACK); i < t; i++) history.push(candles[i]);

    // RSI 5-bar min/max from prior 5 bars
    const rsiVals5 = history.slice(-5).map(c => c.rsi_5).filter(v => v != null);
    const rsi_min_5 = rsiVals5.length > 0 ? Math.min(...rsiVals5) : null;
    const rsi_max_5 = rsiVals5.length > 0 ? Math.max(...rsiVals5) : null;

    // Stoch crossover within last 3 candles
    let bullCross3 = false, bearCross3 = false;
    for (let offset = 0; offset < 3; offset++) {
        const cIdx = t - offset, pIdx = cIdx - 1;
        if (cIdx >= 0 && pIdx >= 0 && cIdx < candles.length) {
            const kC = candles[cIdx].stochastic_k_v2, dC = candles[cIdx].stochastic_d_v2;
            const kP = candles[pIdx].stochastic_k_v2, dP = candles[pIdx].stochastic_d_v2;
            if (kC != null && dC != null && kP != null && dP != null) {
                if (kP <= dP && kC > dC) bullCross3 = true;
                if (kP >= dP && kC < dC) bearCross3 = true;
            }
        }
    }

    return { rsi_min_5, rsi_max_5, bullCross3, bearCross3 };
}

// ── Gate checks ────────────────────────────────────────────────────────────────
function bbBps(bar) {
    if (bar.bb_upper == null || bar.bb_lower == null || bar.bb_middle == null) return null;
    return ((bar.bb_upper - bar.bb_lower) / bar.bb_middle) * 10000;
}

function gatesCall(barM1, bar0, ctx) {
    const bps = bbBps(bar0);
    const stcDelta = bar0.schaff_value - barM1.schaff_value;
    return (
        barM1.schaff_value <= 25 &&                          // g1: prev bar at floor
        bar0.schaff_value < 75 &&                           // g2: range guard
        stcDelta > 0 &&                                     // g3: STC hooking up
        ctx.rsi_min_5 != null && ctx.rsi_min_5 <= 35 &&    // g4: RSI min in last 5 bars ≤35
        ctx.bullCross3 === true &&                          // g5: K crossed above D within 3 bars
        bps != null && bps >= 10 &&                         // g6: BB wide enough
        bar0.low != null && bar0.bb_lower != null && bar0.low <= bar0.bb_lower && // g7: BB pierce
        stcDelta >= 2 &&                                    // g8: STC momentum ≥2 (near-zero = weak)
        bar0.rsi_5 != null && bar0.rsi_5 > 40              // g9: RSI not deep-oversold at signal time
    );
}

function gatesPut(barM1, bar0, ctx) {
    const bps = bbBps(bar0);
    const stcDelta = bar0.schaff_value - barM1.schaff_value;
    return (
        barM1.schaff_value >= 75 &&                          // g1: prev bar at ceiling
        bar0.schaff_value > 25 &&                           // g2: range guard
        stcDelta < 0 &&                                     // g3: STC hooking down
        ctx.rsi_max_5 != null && ctx.rsi_max_5 >= 65 &&    // g4: RSI max in last 5 bars ≥65
        ctx.bearCross3 === true &&                          // g5: K crossed below D within 3 bars
        bps != null && bps >= 10 &&                         // g6: BB wide enough
        bar0.high != null && bar0.bb_upper != null && bar0.high >= bar0.bb_upper && // g7: BB pierce
        (stcDelta <= -2)                                    // g8: STC drop ≥2 (near-zero = weak)
    );
}

// ── Expiry resolution ──────────────────────────────────────────────────────────
function findExpiry(priceList, signalTs, secs) {
    if (!priceList?.length) return null;
    const target = signalTs + secs;
    let closest = null, minDiff = Infinity;
    for (const p of priceList) {
        if (p.timestamp < target - 30) continue;
        if (p.timestamp > target + 30) break;
        const d = Math.abs(p.timestamp - target);
        if (d < minDiff) { minDiff = d; closest = p.price; }
    }
    return closest;
}

function resolveExit(dir, entry, tick, fbClose, fbTs, signalTs, secs) {
    let exit = tick;
    if (exit == null && fbClose != null && fbTs != null && fbTs <= signalTs + secs + 30)
        exit = fbClose;
    if (exit == null) return { result: null, pl: 0 };
    const win = dir === 'CALL' ? exit > entry : exit < entry;
    return { result: win ? 'WIN' : 'LOSS', pl: win ? AMOUNT * PAYOUT : -AMOUNT };
}

// ── Per-DB replay ──────────────────────────────────────────────────────────────
async function replayDb(dbPath, label) {
    const db = await openDb(dbPath);

    const rows = await dbAll(db, `
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma3, i.bb_upper, i.bb_middle, i.bb_lower, i.schaff_value
        FROM candles c
        LEFT JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
        ORDER BY c.asset, c.timestamp
    `);

    const priceRows = await dbAll(db, `SELECT asset, timestamp, price FROM prices ORDER BY asset, timestamp`);
    const pricesByAsset = {};
    for (const p of priceRows) {
        if (!pricesByAsset[p.asset]) pricesByAsset[p.asset] = [];
        pricesByAsset[p.asset].push(p);
    }

    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    const signals = [];
    for (const [asset, candles] of Object.entries(byAsset)) {
        const priceList = pricesByAsset[asset] || null;

        for (let t = 1; t < candles.length; t++) {
            const barM1 = candles[t - 1], bar0 = candles[t];
            if (bar0.schaff_value == null || barM1.schaff_value == null) continue;

            const ctx = computeCtx(candles, t);
            const date = new Date(bar0.timestamp * 1000).toISOString().slice(0, 10);
            const tick60 = findExpiry(priceList, bar0.timestamp, 60);
            const tick120 = findExpiry(priceList, bar0.timestamp, 120);
            const bar1 = candles[t + 1], bar2 = candles[t + 2];

            const bps = bbBps(bar0);
            const bbPct = (bps != null && bar0.bb_lower != null && bar0.bb_upper != null && bar0.bb_upper !== bar0.bb_lower)
                ? (bar0.close - bar0.bb_lower) / (bar0.bb_upper - bar0.bb_lower) : null;

            function buildRow(dir, e60, e120) {
                return {
                    db: label.trim(), date, asset,
                    timestamp: bar0.timestamp,
                    dir,
                    // Entry OHLC
                    open: bar0.open, high: bar0.high, low: bar0.low, close: bar0.close,
                    // STC
                    stc: bar0.schaff_value, stc_prev: barM1.schaff_value,
                    // RSI
                    rsi: bar0.rsi_5, rsi_min_5: ctx.rsi_min_5, rsi_max_5: ctx.rsi_max_5,
                    // Stoch
                    k: bar0.stochastic_k_v2, d: bar0.stochastic_d_v2,
                    bull_cross3: ctx.bullCross3 ? 1 : 0,
                    bear_cross3: ctx.bearCross3 ? 1 : 0,
                    // BB
                    bb_upper: bar0.bb_upper, bb_middle: bar0.bb_middle, bb_lower: bar0.bb_lower,
                    bb_bps: bps != null ? +bps.toFixed(2) : null,
                    bb_pct: bbPct != null ? +bbPct.toFixed(4) : null,
                    // MA
                    ma6: bar0.ma1, ma14: bar0.ma3,
                    // Results
                    r60: e60.result, pl60: e60.pl,
                    r120: e120.result, pl120: e120.pl,
                };
            }

            if (gatesCall(barM1, bar0, ctx)) {
                const e60 = resolveExit('CALL', bar0.close, tick60, bar1?.close, bar1?.timestamp, bar0.timestamp, 60);
                const e120 = resolveExit('CALL', bar0.close, tick120, bar2?.close, bar2?.timestamp, bar0.timestamp, 120);
                signals.push(buildRow('CALL', e60, e120));
            }
            if (gatesPut(barM1, bar0, ctx)) {
                const e60 = resolveExit('PUT', bar0.close, tick60, bar1?.close, bar1?.timestamp, bar0.timestamp, 60);
                const e120 = resolveExit('PUT', bar0.close, tick120, bar2?.close, bar2?.timestamp, bar0.timestamp, 120);
                signals.push(buildRow('PUT', e60, e120));
            }
        }
    }

    await closeDb(db);
    return signals;
}

// ── Aggregation helpers ────────────────────────────────────────────────────────
function agg(sigs, rKey, plKey) {
    const valid = sigs.filter(s => s[rKey] != null);
    const wins = valid.filter(s => s[rKey] === 'WIN').length;
    const n = valid.length;
    const pl = Math.round(valid.reduce((a, s) => a + s[plKey], 0));
    if (n === 0) return { n: 0, wins: 0, wr: 'N/A', pl: 0, p: 'N/A', ci: '      N/A     ', k: 'N/A' };
    const p = binomP(wins, n).toFixed(4);
    return { n, wins, wr: (wins / n * 100).toFixed(1) + '%', pl, p, ci: wilsonCI(wins, n), k: kelly(wins, n) };
}

function printRow(date, db, dir, s) {
    const sig = sigMark(s.p);
    console.log(
        `  ${date.padEnd(12)} ${db.padEnd(10)} ${dir.padEnd(5)}` +
        `  n=${String(s.n).padStart(3)}` +
        `  wr=${s.wr.padEnd(7)}` +
        `  pl=$${String(s.pl).padStart(7)}` +
        `  p=${s.p.padEnd(6)}` +
        `  ci=${s.ci.padEnd(16)}` +
        `  k=${s.k.padEnd(7)}` +
        `  ${sig}`
    );
}

// ── Main ───────────────────────────────────────────────────────────────────────
const allSigs = [];
console.log('\nLoading datasets...');
for (const ds of DATASETS) {
    process.stdout.write(`  ${ds.label.trim().padEnd(12)}... `);
    try {
        const sigs = await replayDb(ds.path, ds.label);
        allSigs.push(...sigs);
        console.log(`${sigs.length} signals (${sigs.filter(s => s.dir === 'CALL').length} CALL / ${sigs.filter(s => s.dir === 'PUT').length} PUT)`);
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }
}
console.log(`  Total: ${allSigs.length} signals across ${DATASETS.length} datasets\n`);

// ── Date × DB report (120s) ────────────────────────────────────────────────────
const SEP = '═'.repeat(105);
const DIV = '  ' + '─'.repeat(101);

console.log(SEP);
console.log('  MULTI-DB STC REVERSAL — BY DATE — 120s EXPIRY');
console.log(SEP);
console.log(`  ${'DATE'.padEnd(12)} ${'DB'.padEnd(10)} ${'DIR'.padEnd(5)}  ${'n'.padStart(3)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'p-val'.padEnd(6)}  ${'CI 95%'.padEnd(16)}  ${'Kelly'.padEnd(7)}  sig`);
console.log(DIV);

// Group by date+db
const byDateDb = {};
for (const s of allSigs) {
    const key = `${s.date}|${s.db}`;
    if (!byDateDb[key]) byDateDb[key] = { date: s.date, db: s.db, sigs: [] };
    byDateDb[key].sigs.push(s);
}

const sorted = Object.values(byDateDb).sort((a, b) => {
    const dk = a.date.localeCompare(b.date);
    return dk !== 0 ? dk : a.db.localeCompare(b.db);
});

for (const { date, db, sigs } of sorted) {
    const calls = sigs.filter(s => s.dir === 'CALL');
    const puts = sigs.filter(s => s.dir === 'PUT');
    if (calls.length) printRow(date, db, 'CALL', agg(calls, 'r120', 'pl120'));
    if (puts.length) printRow('', '', 'PUT', agg(puts, 'r120', 'pl120'));
    if (calls.length && puts.length) {
        const all = agg(sigs, 'r120', 'pl120');
        printRow('', '', 'ALL', all);
    }
    console.log(DIV);
}

// ── Grand totals ────────────────────────────────────────────────────────────────
console.log('\n  GRAND TOTAL — all datasets combined (120s)');
console.log(DIV);
const gtCall = agg(allSigs.filter(s => s.dir === 'CALL'), 'r120', 'pl120');
const gtPut = agg(allSigs.filter(s => s.dir === 'PUT'), 'r120', 'pl120');
const gtAll = agg(allSigs, 'r120', 'pl120');
printRow('', '', 'CALL', gtCall);
printRow('', '', 'PUT', gtPut);
printRow('', '', 'ALL', gtAll);

// ── Per-asset breakdown ────────────────────────────────────────────────────────
console.log(`\n\n${SEP}`);
console.log('  PER-ASSET BREAKDOWN — all datasets, 120s');
console.log(SEP);
console.log(`  ${'ASSET'.padEnd(16)} ${'DIR'.padEnd(5)}  ${'n'.padStart(3)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'p-val'.padEnd(6)}  ${'CI 95%'.padEnd(16)}  ${'Kelly'.padEnd(7)}  sig`);
console.log(DIV);

const byAssetDir = {};
for (const s of allSigs) {
    const key = `${s.asset}|${s.dir}`;
    if (!byAssetDir[key]) byAssetDir[key] = { asset: s.asset, dir: s.dir, sigs: [] };
    byAssetDir[key].sigs.push(s);
}
const assetRows = Object.values(byAssetDir).sort((a, b) => a.asset.localeCompare(b.asset) || a.dir.localeCompare(b.dir));
for (const { asset, dir, sigs } of assetRows) {
    const s = agg(sigs, 'r120', 'pl120');
    if (s.n > 0) {
        const sig = sigMark(s.p);
        console.log(
            `  ${asset.padEnd(16)} ${dir.padEnd(5)}  n=${String(s.n).padStart(3)}  wr=${s.wr.padEnd(7)}  pl=$${String(s.pl).padStart(7)}  p=${s.p.padEnd(6)}  ci=${s.ci.padEnd(16)}  k=${s.k.padEnd(7)}  ${sig}`
        );
    }
}

// ── 60s comparison ─────────────────────────────────────────────────────────────
console.log(`\n\n${SEP}`);
console.log('  60s EXPIRY — confirming not viable');
console.log(SEP);
console.log(`  ${''.padEnd(12)} ${''.padEnd(10)} ${'DIR'.padEnd(5)}  ${'n'.padStart(3)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'p-val'.padEnd(6)}  ${'CI 95%'.padEnd(16)}  sig`);
console.log(DIV);
printRow('ALL DATASETS', '', 'CALL', agg(allSigs.filter(s => s.dir === 'CALL'), 'r60', 'pl60'));
printRow('', '', 'PUT', agg(allSigs.filter(s => s.dir === 'PUT'), 'r60', 'pl60'));
printRow('', '', 'ALL', agg(allSigs, 'r60', 'pl60'));

// ── Daily P&L curve ────────────────────────────────────────────────────────────
console.log(`\n\n=== DAILY P&L CURVE (120s, all DBs) ===`);
const byDate = {};
for (const s of allSigs) {
    if (!byDate[s.date]) byDate[s.date] = { n: 0, wins: 0, pl: 0 };
    if (s.r120 != null) {
        byDate[s.date].n++;
        if (s.r120 === 'WIN') byDate[s.date].wins++;
        byDate[s.date].pl += s.pl120;
    }
}
let cumPl = 0;
console.log(`  ${'DATE'.padEnd(12)}  ${'n'.padStart(3)}  ${'WR'.padEnd(7)}  ${'Daily P/L'.padEnd(11)}  Cumulative P/L`);
console.log('  ' + '─'.repeat(60));
for (const date of Object.keys(byDate).sort()) {
    const d = byDate[date];
    const wr = d.n > 0 ? (d.wins / d.n * 100).toFixed(1) + '%' : 'N/A';
    cumPl += Math.round(d.pl);
    console.log(`  ${date.padEnd(12)}  ${String(d.n).padStart(3)}  ${wr.padEnd(7)}  $${String(Math.round(d.pl)).padStart(9)}  $${cumPl}`);
}
console.log(`  ${'─'.repeat(60)}`);
console.log(`  ${'TOTAL'.padEnd(12)}  ${String(gtAll.n).padStart(3)}  ${gtAll.wr.padEnd(7)}  ${''.padEnd(11)}  $${cumPl}`);

// ── CSV export ─────────────────────────────────────────────────────────────────
const CSV_PATH = resolve(__dirname, '../../data/replay_signals.csv');
const CSV_COLS = [
    'db', 'date', 'asset', 'timestamp', 'dir',
    'open', 'high', 'low', 'close',
    'stc', 'stc_prev',
    'rsi', 'rsi_min_5', 'rsi_max_5',
    'k', 'd', 'bull_cross3', 'bear_cross3',
    'bb_upper', 'bb_middle', 'bb_lower', 'bb_bps', 'bb_pct',
    'ma6', 'ma14',
    'r60', 'pl60', 'r120', 'pl120',
];
const fmt = v => (v === null || v === undefined) ? '' : String(v);
const csvLines = [
    CSV_COLS.join(','),
    ...allSigs.map(s => CSV_COLS.map(c => fmt(s[c])).join(',')),
];
writeFileSync(CSV_PATH, csvLines.join('\n') + '\n');
console.log(`\nCSV saved → ${CSV_PATH}  (${allSigs.length} rows, ${CSV_COLS.length} columns)`);
