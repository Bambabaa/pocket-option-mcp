/**
 * BB %B Position Analysis — multi-DB
 *
 * %B = (close - bb_lower) / (bb_upper - bb_lower)
 *   CALL: low %B = price near lower band  (good reversal zone)
 *   PUT:  high %B = price near upper band (good reversal zone)
 *
 * Goal: find the least conservative %B threshold that still correlates with wins.
 * Reports WR by %B bucket at 120s for CALL and PUT, across all historical DBs.
 */

import sqlite3pkg from 'sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, '../../data');

const DATASETS = [
    { path: `${DATA}/trading_data_v1.db`,        label: 'v1'        },
    { path: `${DATA}/trading_data_v2_13-15.db`,  label: 'v2_13-15'  },
    { path: `${DATA}/trading_data_V3_17.db`,     label: 'V3_17'     },
    { path: `${DATA}/trading_data-V4_18.db`,     label: 'V4_18'     },
    { path: `${DATA}/trading_data-V5_25.db`,     label: 'V5_25'     },
    { path: `${DATA}/trading_data.db`,           label: 'live'      },
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
function normalCDF(z){const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;const sign=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);return 0.5*(1+sign*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));}
function logFact(n){let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s;}
function logBinom(n,k){return logFact(n)-logFact(k)-logFact(n-k);}
function binomP(wins,n,p0=0.5){if(n===0||wins/n<=p0)return 1;if(n>120)return Math.max(0,1-normalCDF((wins/n-p0)/Math.sqrt(p0*(1-p0)/n)));let pv=0;const lp=Math.log(p0),lq=Math.log(1-p0);for(let k=wins;k<=n;k++)pv+=Math.exp(logBinom(n,k)+k*lp+(n-k)*lq);return Math.min(1,pv);}
function wilsonCI(wins,n){if(n===0)return 'N/A';const z=1.96,p=wins/n,z2=z*z,c=(p+z2/(2*n))/(1+z2/n);const m=(z/(1+z2/n))*Math.sqrt(p*(1-p)/n+z2/(4*n*n));return `[${(Math.max(0,c-m)*100).toFixed(0)}%,${(Math.min(1,c+m)*100).toFixed(0)}%]`;}
function sigMark(p){if(p<0.01)return '***';if(p<0.05)return '** ';if(p<0.10)return '*  ';return '   ';}

// ── Context ────────────────────────────────────────────────────────────────────
function computeCtx(candles, t) {
    const bar0 = candles[t];
    const barPrev = t >= 3 ? candles[t - 3] : null;
    let ma_gap_trend = 'unknown';
    if (bar0.ma1 != null && bar0.ma3 != null && barPrev?.ma1 != null && barPrev?.ma3 != null) {
        const gapNow  = bar0.ma1 - bar0.ma3;
        const gapPrev = barPrev.ma1 - barPrev.ma3;
        const deltaBps = ((gapNow - gapPrev) / bar0.ma3) * 10000;
        if      (Math.abs(deltaBps) < 1) ma_gap_trend = 'flat';
        else if (deltaBps > 0)           ma_gap_trend = 'widening_up';
        else                             ma_gap_trend = 'widening_down';
        if (Math.abs(gapPrev) - Math.abs(gapNow) > bar0.ma3 * 0.0001) ma_gap_trend = 'narrowing';
    }
    let bb_expanding = null;
    const barBbPrev = t >= 5 ? candles[t - 5] : null;
    if (bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null &&
        barBbPrev?.bb_upper != null && barBbPrev?.bb_lower != null && barBbPrev?.bb_middle != null) {
        const wNow  = (bar0.bb_upper  - bar0.bb_lower)  / bar0.bb_middle;
        const wPrev = (barBbPrev.bb_upper - barBbPrev.bb_lower) / barBbPrev.bb_middle;
        bb_expanding = wNow > wPrev;
    }
    return { ma_gap_trend, bb_expanding };
}

// ── Gates ──────────────────────────────────────────────────────────────────────
function getBbBps(bar) {
    if (bar.bb_upper == null || bar.bb_lower == null || bar.bb_middle == null) return null;
    return ((bar.bb_upper - bar.bb_lower) / bar.bb_middle) * 10000;
}
function getBbPct(bar) {
    if (bar.bb_upper == null || bar.bb_lower == null || bar.close == null) return null;
    const range = bar.bb_upper - bar.bb_lower;
    if (range <= 0) return null;
    return (bar.close - bar.bb_lower) / range;
}
function gatesCall(barM1, bar0, ctx) {
    const bps = getBbBps(bar0);
    return bar0.schaff_value <= 25 && bar0.schaff_value > barM1.schaff_value &&
        bar0.rsi_5 != null && bar0.rsi_5 < 30 &&
        bar0.stochastic_k_v2 != null && bar0.stochastic_d_v2 != null &&
        bar0.stochastic_k_v2 > bar0.stochastic_d_v2 && bar0.stochastic_k_v2 < 50 &&
        bps != null && bps >= 10 && ctx.bb_expanding !== false && ctx.ma_gap_trend !== 'narrowing';
}
function gatesPut(barM1, bar0, ctx) {
    const bps = getBbBps(bar0);
    return bar0.schaff_value >= 90 && bar0.schaff_value < barM1.schaff_value &&
        bar0.rsi_5 != null && bar0.rsi_5 > 70 &&
        bar0.stochastic_k_v2 != null && bar0.stochastic_d_v2 != null &&
        bar0.stochastic_k_v2 < bar0.stochastic_d_v2 && bar0.stochastic_k_v2 > 50 &&
        bps != null && bps >= 10 && ctx.ma_gap_trend !== 'narrowing';
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
    if (exit == null && fbClose != null && fbTs != null && fbTs <= signalTs + secs + 30) exit = fbClose;
    if (exit == null) return null;
    return dir === 'CALL' ? exit > entry : exit < entry;
}

// ── Per-DB replay ──────────────────────────────────────────────────────────────
async function replayDb(dbPath) {
    let db;
    try { db = await openDb(dbPath); } catch { return []; }

    const rows = await dbAll(db, `
        SELECT c.asset, c.timestamp, c.close,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma3, i.bb_upper, i.bb_middle, i.bb_lower, i.schaff_value
        FROM candles c
        LEFT JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
        ORDER BY c.asset, c.timestamp
    `);
    const priceRows = await dbAll(db, `SELECT asset, timestamp, price FROM prices ORDER BY asset, timestamp`);
    await closeDb(db);

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

            const ctx  = computeCtx(candles, t);
            const tick120 = findExpiry(priceList, bar0.timestamp, 120);
            const bar2    = candles[t + 2];
            const bbPct   = getBbPct(bar0);

            for (const [dir, pass] of [['CALL', gatesCall(barM1, bar0, ctx)], ['PUT', gatesPut(barM1, bar0, ctx)]]) {
                if (!pass) continue;
                const win120 = resolveExit(dir, bar0.close, tick120, bar2?.close, bar2?.timestamp, bar0.timestamp, 120);
                if (win120 == null) continue; // skip unvalidated
                signals.push({ direction: dir, result: win120 ? 'WIN' : 'LOSS', bbPct });
            }
        }
    }
    return signals;
}

// ── Collect all signals ────────────────────────────────────────────────────────
const allSignals = [];
for (const ds of DATASETS) {
    const sigs = await replayDb(ds.path);
    allSignals.push(...sigs);
}

const calls = allSignals.filter(s => s.direction === 'CALL');
const puts  = allSignals.filter(s => s.direction === 'PUT');
console.log(`\nTotal validated signals: ${allSignals.length}  (CALL ${calls.length} / PUT ${puts.length})\n`);

// ── Report helper ──────────────────────────────────────────────────────────────
function row(label, sigs) {
    const n = sigs.length;
    if (n === 0) return `  ${label.padEnd(24)} n=  0  —`;
    const w = sigs.filter(s => s.result === 'WIN').length;
    const wr = (w/n*100).toFixed(1);
    const p  = binomP(w, n);
    const pl = w * AMOUNT * PAYOUT - (n - w) * AMOUNT;
    return `  ${label.padEnd(24)} n=${String(n).padStart(3)}  wr=${(wr+'%').padEnd(7)}  pl=${('$'+Math.round(pl)).padStart(8)}  ci=${wilsonCI(w,n).padEnd(14)}  p=${p.toFixed(4)}  ${sigMark(p)}`;
}

// ── %B distribution ────────────────────────────────────────────────────────────
console.log('=== BB %B DISTRIBUTION AT SIGNAL TIME ===');
for (const [dir, sigs] of [['CALL', calls], ['PUT', puts]]) {
    const vals = sigs.filter(s => s.bbPct != null).map(s => s.bbPct).sort((a, b) => a - b);
    if (!vals.length) { console.log(`\n${dir}: no data`); continue; }
    const pct = p => vals[Math.min(vals.length-1, Math.floor(p/100*(vals.length-1)))];
    console.log(`\n  ${dir} (n=${vals.length})  p0=${pct(0).toFixed(3)}  p10=${pct(10).toFixed(3)}  p25=${pct(25).toFixed(3)}  p50=${pct(50).toFixed(3)}  p75=${pct(75).toFixed(3)}  p90=${pct(90).toFixed(3)}  p100=${pct(100).toFixed(3)}`);
}

// ── CALL buckets ───────────────────────────────────────────────────────────────
console.log('\n\n=== CALL — WR by BB %B bucket (120s) ===');
console.log('  lower %B = price closer to lower band\n');
for (const [label, f] of [
    ['%B < 0.10',       s => s.bbPct < 0.10],
    ['%B < 0.20',       s => s.bbPct < 0.20],
    ['%B < 0.30',       s => s.bbPct < 0.30],
    ['%B < 0.40',       s => s.bbPct < 0.40],
    ['%B < 0.50',       s => s.bbPct < 0.50],
    ['%B >= 0.50',      s => s.bbPct >= 0.50],
    ['ALL',             () => true],
]) console.log(row(label, calls.filter(f)));

// ── PUT buckets ────────────────────────────────────────────────────────────────
console.log('\n\n=== PUT — WR by BB %B bucket (120s) ===');
console.log('  higher %B = price closer to upper band\n');
for (const [label, f] of [
    ['%B > 0.90',       s => s.bbPct > 0.90],
    ['%B > 0.80',       s => s.bbPct > 0.80],
    ['%B > 0.70',       s => s.bbPct > 0.70],
    ['%B > 0.60',       s => s.bbPct > 0.60],
    ['%B > 0.50',       s => s.bbPct > 0.50],
    ['%B <= 0.50',      s => s.bbPct <= 0.50],
    ['ALL',             () => true],
]) console.log(row(label, puts.filter(f)));

// ── Mean %B: wins vs losses ────────────────────────────────────────────────────
console.log('\n\n=== MEAN BB %B: WINS vs LOSSES (120s) ===');
for (const [dir, sigs] of [['CALL', calls], ['PUT', puts]]) {
    const w = sigs.filter(s => s.result === 'WIN'  && s.bbPct != null);
    const l = sigs.filter(s => s.result === 'LOSS' && s.bbPct != null);
    const mean = arr => arr.length ? (arr.reduce((a, s) => a + s.bbPct, 0) / arr.length).toFixed(3) : 'N/A';
    console.log(`  ${dir}  WIN mean %B=${mean(w)} (n=${w.length})   LOSS mean %B=${mean(l)} (n=${l.length})`);
}

// ── Threshold sweep: least conservative that improves WR ─────────────────────
console.log('\n\n=== THRESHOLD SWEEP: BASELINE vs +%B GATE (120s) ===\n');
for (const [dir, sigs, thresholds] of [
    ['CALL', calls, [0.50, 0.45, 0.40, 0.35, 0.30, 0.25, 0.20]],
    ['PUT',  puts,  [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]],
]) {
    console.log(`  ${dir}:`);
    console.log(row('Baseline', sigs));
    for (const t of thresholds) {
        const label = dir === 'CALL' ? `+%B < ${t.toFixed(2)}` : `+%B > ${t.toFixed(2)}`;
        const filtered = dir === 'CALL' ? sigs.filter(s => s.bbPct < t) : sigs.filter(s => s.bbPct > t);
        console.log(row(label, filtered));
    }
    console.log();
}
