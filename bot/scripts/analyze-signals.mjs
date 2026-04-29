/**
 * analyze-signals.mjs
 *
 * Deep analysis of replay_signals.csv across 4 dimensions:
 *   1. Feature bucket scan  — WR per indicator range
 *   2. Asset quality filter — identify structural losers to block
 *   3. Direction × date     — CALL vs PUT consistency over time
 *   4. Combination slices   — intersection of top features
 *
 * Usage: node bot/scripts/analyze-signals.mjs [csv_path]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] || resolve(__dirname, '../../data/replay_signals.csv');

// ── Parse CSV ──────────────────────────────────────────────────────────────────
const raw = readFileSync(csvPath, 'utf8').trim().split('\n');
const headers = raw[0].split(',').map(h => h.trim());
const sigs = raw.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
        const v = vals[i]?.trim();
        obj[h] = (v === '' || v === undefined) ? null
               : (v === 'WIN' || v === 'LOSS' || isNaN(Number(v))) ? v
               : Number(v);
    });
    return obj;
});

const AMOUNT = 500, PAYOUT = 0.92;

// ── Stat helpers ───────────────────────────────────────────────────────────────
function normalCDF(z) {
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911;
    const sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + p * x);
    return 0.5 * (1 + sign * (1 - ((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0]) * t * Math.exp(-x * x)));
}
function logFact(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
function logBinom(n, k) { return logFact(n) - logFact(k) - logFact(n - k); }
function binomP(wins, n, p0 = 0.5) {
    if (n === 0 || wins / n <= p0) return 1;
    if (n > 120) return Math.max(0, 1 - normalCDF((wins / n - p0) / Math.sqrt(p0 * (1 - p0) / n)));
    let pv = 0;
    const lp = Math.log(p0), lq = Math.log(1 - p0);
    for (let k = wins; k <= n; k++) pv += Math.exp(logBinom(n, k) + k * lp + (n - k) * lq);
    return Math.min(1, pv);
}
function wilsonCI(wins, n) {
    if (n === 0) return 'N/A';
    const z = 1.96, p = wins / n, z2 = z * z;
    const c = (p + z2 / (2 * n)) / (1 + z2 / n);
    const m = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return `[${(Math.max(0, c - m) * 100).toFixed(0)}%,${(Math.min(1, c + m) * 100).toFixed(0)}%]`;
}
function sigMark(p) {
    if (p >= 1) return '   ';
    if (p < 0.01) return '***';
    if (p < 0.05) return '** ';
    if (p < 0.10) return '*  ';
    return '   ';
}
function agg(subset) {
    const valid = subset.filter(s => s.r120 != null);
    const wins  = valid.filter(s => s.r120 === 'WIN').length;
    const n = valid.length;
    if (n === 0) return null;
    const pl = Math.round(valid.reduce((a, s) => a + (s.pl120 || 0), 0));
    const p  = binomP(wins, n);
    return { n, wins, wr: (wins / n * 100).toFixed(1), pl, p: p.toFixed(4), ci: wilsonCI(wins, n), sig: sigMark(p) };
}

// ── Print helpers ──────────────────────────────────────────────────────────────
const SEP  = '═'.repeat(110);
const DIV  = '─'.repeat(108);
const W    = (s, w) => String(s ?? '').padEnd(w);
const WR   = (s, w) => String(s ?? '').padStart(w);

function printHeader(title) {
    console.log(`\n${SEP}`);
    console.log(`  ${title}`);
    console.log(SEP);
}

function printBucketTable(rows, labelCol = 'range', labelWidth = 22) {
    const hdr = `  ${W(labelCol.toUpperCase(), labelWidth)}  ${WR('n', 4)}  ${WR('WR%', 6)}  ${WR('P/L', 8)}  ${'p-val'.padEnd(7)}  ${'CI 95%'.padEnd(14)}  sig`;
    console.log(hdr);
    console.log('  ' + DIV.slice(0, hdr.length - 2));
    for (const r of rows) {
        if (!r.stats) { console.log(`  ${W(r.label, labelWidth)}  ${'—'.padStart(4)}`); continue; }
        const s = r.stats;
        console.log(
            `  ${W(r.label, labelWidth)}  ${WR(s.n, 4)}  ${WR(s.wr + '%', 6)}  ` +
            `${WR('$' + s.pl, 8)}  ${s.p.padEnd(7)}  ${s.ci.padEnd(14)}  ${s.sig}`
        );
    }
}

// ── Bucket factory ─────────────────────────────────────────────────────────────
function bucketBy(subset, field, bins) {
    return bins.map(b => {
        const filtered = subset.filter(s => {
            const v = s[field];
            if (v === null) return false;
            if (b.min !== undefined && b.max !== undefined) return v >= b.min && v < b.max;
            if (b.min !== undefined) return v >= b.min;
            if (b.max !== undefined) return v < b.max;
            return false;
        });
        return { label: b.label, stats: agg(filtered) };
    }).filter(r => r.stats);
}

const calls = sigs.filter(s => s.dir === 'CALL');
const puts  = sigs.filter(s => s.dir === 'PUT');

// ══════════════════════════════════════════════════════════════════════════════
// PART 1 — FEATURE BUCKET SCAN
// ══════════════════════════════════════════════════════════════════════════════
printHeader('PART 1 — FEATURE BUCKET SCAN  (120s expiry)');

// ── 1a. STC prev depth ────────────────────────────────────────────────────────
console.log('\n  [1a] STC PREV DEPTH — how deep was STC before it hooked?');
console.log('       CALL (stc_prev ≤ 25, lower = deeper oversold)');
printBucketTable(bucketBy(calls, 'stc_prev', [
    { label: '0 – 5  (deepest)', min: 0,  max: 5  },
    { label: '5 – 10',           min: 5,  max: 10 },
    { label: '10 – 15',          min: 10, max: 15 },
    { label: '15 – 20',          min: 15, max: 20 },
    { label: '20 – 25',          min: 20, max: 25 },
]));
console.log('       PUT (stc_prev ≥ 75, higher = deeper overbought)');
printBucketTable(bucketBy(puts, 'stc_prev', [
    { label: '75 – 80',          min: 75, max: 80  },
    { label: '80 – 85',          min: 80, max: 85  },
    { label: '85 – 90',          min: 85, max: 90  },
    { label: '90 – 95',          min: 90, max: 95  },
    { label: '95 – 100 (deepest)', min: 95, max: 101 },
]));

// ── 1b. STC hook value (current bar) ──────────────────────────────────────────
console.log('\n  [1b] STC HOOK VALUE — where is STC at signal bar?');
console.log('       CALL (low STC = early hook near the floor)');
printBucketTable(bucketBy(calls, 'stc', [
    { label: '0 – 10  (early)',  min: 0,  max: 10 },
    { label: '10 – 20',         min: 10, max: 20 },
    { label: '20 – 35',         min: 20, max: 35 },
    { label: '35 – 50',         min: 35, max: 50 },
    { label: '50 – 75',         min: 50, max: 75 },
]));
console.log('       PUT (high STC = early hook near the ceiling)');
printBucketTable(bucketBy(puts, 'stc', [
    { label: '25 – 50',          min: 25, max: 50  },
    { label: '50 – 65',          min: 50, max: 65  },
    { label: '65 – 80',          min: 65, max: 80  },
    { label: '80 – 90  (early)', min: 80, max: 90  },
    { label: '90 – 100',         min: 90, max: 101 },
]));

// ── 1c. RSI lookback depth ────────────────────────────────────────────────────
console.log('\n  [1c] RSI LOOKBACK DEPTH — how oversold/overbought did RSI get?');
console.log('       CALL: rsi_min_5');
printBucketTable(bucketBy(calls, 'rsi_min_5', [
    { label: '< 15  (extreme)',  min: 0,  max: 15 },
    { label: '15 – 20',         min: 15, max: 20 },
    { label: '20 – 25',         min: 20, max: 25 },
    { label: '25 – 30',         min: 25, max: 30 },
    { label: '30 – 35',         min: 30, max: 35 },
]));
console.log('       PUT: rsi_max_5');
printBucketTable(bucketBy(puts, 'rsi_max_5', [
    { label: '65 – 70',          min: 65, max: 70  },
    { label: '70 – 75',          min: 70, max: 75  },
    { label: '75 – 80',          min: 75, max: 80  },
    { label: '80 – 90',          min: 80, max: 90  },
    { label: '90 – 100 (extreme)', min: 90, max: 101 },
]));

// ── 1d. BB width (volatility) ─────────────────────────────────────────────────
console.log('\n  [1d] BB WIDTH (bps) — volatility at signal time  (all signals)');
printBucketTable(bucketBy(sigs, 'bb_bps', [
    { label: '10 – 15',   min: 10,  max: 15  },
    { label: '15 – 25',   min: 15,  max: 25  },
    { label: '25 – 40',   min: 25,  max: 40  },
    { label: '40 – 60',   min: 40,  max: 60  },
    { label: '60 – 100',  min: 60,  max: 100 },
    { label: '100+',      min: 100             },
]));

// ── 1e. BB %B — price position in band ───────────────────────────────────────
console.log('\n  [1e] BB %B — price position in band at signal');
console.log('       CALL (expect bb_pct ≤ 0 = price below lower band)');
printBucketTable(bucketBy(calls, 'bb_pct', [
    { label: '< -0.05 (deep pierce)',  min: -Infinity, max: -0.05 },
    { label: '-0.05 – 0.00 (pierce)',  min: -0.05,     max: 0.00  },
    { label: '0.00 – 0.05 (just at)',  min: 0.00,      max: 0.05  },
    { label: '0.05 – 0.15',            min: 0.05,      max: 0.15  },
]));
console.log('       PUT (expect bb_pct ≥ 1 = price above upper band)');
printBucketTable(bucketBy(puts, 'bb_pct', [
    { label: '0.85 – 1.00 (just at)',  min: 0.85, max: 1.00     },
    { label: '1.00 – 1.05 (pierce)',   min: 1.00, max: 1.05     },
    { label: '1.05+ (deep pierce)',    min: 1.05                 },
]));

// ── 1f. K–D spread magnitude ─────────────────────────────────────────────────
console.log('\n  [1f] K–D SPREAD — momentum of stoch cross (|K - D|)');
const withSpread = sigs.map(s => ({ ...s, kd_spread: s.k != null && s.d != null ? Math.abs(s.k - s.d) : null }));
printBucketTable(bucketBy(withSpread, 'kd_spread', [
    { label: '0 – 3   (weak)',    min: 0,  max: 3  },
    { label: '3 – 7',             min: 3,  max: 7  },
    { label: '7 – 15',            min: 7,  max: 15 },
    { label: '15 – 25',           min: 15, max: 25 },
    { label: '25+  (strong)',      min: 25          },
]));

// ── 1g. STC hook speed (delta) ───────────────────────────────────────────────
console.log('\n  [1g] STC HOOK SPEED — how fast STC moved on signal bar (|stc - stc_prev|)');
const withDelta = sigs.map(s => ({ ...s, stc_delta: s.stc != null && s.stc_prev != null ? Math.abs(s.stc - s.stc_prev) : null }));
printBucketTable(bucketBy(withDelta, 'stc_delta', [
    { label: '0 – 1   (slow)',    min: 0, max: 1  },
    { label: '1 – 3',             min: 1, max: 3  },
    { label: '3 – 6',             min: 3, max: 6  },
    { label: '6 – 10',            min: 6, max: 10 },
    { label: '10+  (fast)',        min: 10         },
]));

// ══════════════════════════════════════════════════════════════════════════════
// PART 2 — ASSET QUALITY FILTER
// ══════════════════════════════════════════════════════════════════════════════
printHeader('PART 2 — ASSET QUALITY FILTER  (≥2 signals, sorted by WR)');

const assetDirMap = {};
for (const s of sigs) {
    const key = `${s.asset}|${s.dir}`;
    if (!assetDirMap[key]) assetDirMap[key] = { asset: s.asset, dir: s.dir, sigs: [] };
    assetDirMap[key].sigs.push(s);
}
const assetRows = Object.values(assetDirMap)
    .map(({ asset, dir, sigs: ss }) => ({ asset, dir, stats: agg(ss) }))
    .filter(r => r.stats && r.stats.n >= 2)
    .sort((a, b) => parseFloat(a.stats.wr) - parseFloat(b.stats.wr));

console.log(`\n  ${'ASSET'.padEnd(18)} ${'DIR'.padEnd(5)}  ${WR('n', 4)}  ${WR('WR%', 6)}  ${WR('P/L', 8)}  ${'p-val'.padEnd(7)}  ${'CI 95%'.padEnd(14)}  ${'flag'}`);
console.log('  ' + DIV.slice(0, 80));
for (const { asset, dir, stats: s } of assetRows) {
    const flag = parseFloat(s.wr) < 45 ? '⚠ BLOCK' : parseFloat(s.wr) > 70 ? '★ KEEP' : '';
    console.log(
        `  ${W(asset, 18)} ${W(dir, 5)}  ${WR(s.n, 4)}  ${WR(s.wr + '%', 6)}  ` +
        `${WR('$' + s.pl, 8)}  ${s.p.padEnd(7)}  ${s.ci.padEnd(14)}  ${flag}`
    );
}

// Summary: what if we exclude block candidates?
const blockCandidates = assetRows.filter(r => parseFloat(r.stats.wr) < 45 && r.stats.n >= 2).map(r => r.asset + '|' + r.dir);
const filteredSigs = sigs.filter(s => !blockCandidates.includes(s.asset + '|' + s.dir));
const filteredStats = agg(filteredSigs);
const allStats = agg(sigs);
console.log(`\n  All signals:           n=${allStats.n}  WR=${allStats.wr}%  P/L=$${allStats.pl}  p=${allStats.p}`);
if (filteredStats) {
    console.log(`  After blocking ⚠ assets: n=${filteredStats.n}  WR=${filteredStats.wr}%  P/L=$${filteredStats.pl}  p=${filteredStats.p}  ${filteredStats.sig}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 3 — DIRECTION × DATE CONSISTENCY
// ══════════════════════════════════════════════════════════════════════════════
printHeader('PART 3 — DIRECTION × DATE CONSISTENCY');

// Per direction overall
console.log('\n  OVERALL BY DIRECTION:');
for (const dir of ['CALL', 'PUT']) {
    const s = agg(sigs.filter(x => x.dir === dir));
    if (s) console.log(`  ${W(dir, 5)}  n=${WR(s.n, 3)}  WR=${WR(s.wr + '%', 6)}  P/L=$${WR(s.pl, 7)}  p=${s.p}  ${s.sig}`);
}

// Per date × direction
console.log(`\n  BY DATE:`);
console.log(`  ${'DATE'.padEnd(12)} ${'DIR'.padEnd(5)}  ${WR('n', 4)}  ${WR('WR%', 6)}  ${WR('P/L', 8)}  ${'p-val'.padEnd(7)}  ${'CI 95%'}`);
console.log('  ' + DIV.slice(0, 72));
const dates = [...new Set(sigs.map(s => s.date))].sort();
for (const date of dates) {
    for (const dir of ['CALL', 'PUT', 'ALL']) {
        const subset = sigs.filter(s => s.date === date && (dir === 'ALL' || s.dir === dir));
        const s = agg(subset);
        if (!s || s.n === 0) continue;
        const label = dir === 'CALL' ? date : '';
        console.log(`  ${W(label, 12)} ${W(dir, 5)}  ${WR(s.n, 4)}  ${WR(s.wr + '%', 6)}  ${WR('$' + s.pl, 8)}  ${s.p.padEnd(7)}  ${s.ci}`);
    }
    console.log('  ' + '·'.repeat(68));
}

// Hour of day
const hourMap = {};
for (const s of sigs) {
    if (s.r120 == null || s.timestamp == null) continue;
    const h = Math.floor((s.timestamp % 86400) / 3600);
    if (!hourMap[h]) hourMap[h] = { wins: 0, n: 0, pl: 0 };
    hourMap[h].n++;
    hourMap[h].pl += s.pl120 || 0;
    if (s.r120 === 'WIN') hourMap[h].wins++;
}
const hourRows = Object.entries(hourMap)
    .map(([h, d]) => ({ hour: parseInt(h), stats: { n: d.n, wins: d.wins, wr: (d.wins/d.n*100).toFixed(1), pl: Math.round(d.pl) } }))
    .filter(r => r.stats.n >= 2)
    .sort((a, b) => parseFloat(b.stats.wr) - parseFloat(a.stats.wr));
console.log(`\n  BY HOUR OF DAY (UTC, ≥2 signals, sorted by WR):`);
console.log(`  ${'HOUR'.padEnd(8)}  ${WR('n', 4)}  ${WR('WR%', 6)}  ${WR('P/L', 8)}`);
console.log('  ' + '─'.repeat(35));
for (const { hour, stats: s } of hourRows) {
    const bar = '█'.repeat(Math.round(parseFloat(s.wr) / 10));
    console.log(`  ${W('UTC ' + String(hour).padStart(2, '0') + 'h', 8)}  ${WR(s.n, 4)}  ${WR(s.wr + '%', 6)}  ${WR('$' + s.pl, 8)}  ${bar}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 4 — COMBINATION SLICES
// ══════════════════════════════════════════════════════════════════════════════
printHeader('PART 4 — COMBINATION SLICES  (finding the highest-conviction subset)');

function comboSlice(label, filter) {
    const s = agg(sigs.filter(filter));
    if (!s || s.n < 2) return;
    console.log(`  ${W(label, 55)}  n=${WR(s.n, 3)}  WR=${WR(s.wr + '%', 6)}  P/L=$${WR(s.pl, 7)}  p=${s.p}  ${s.sig}`);
}

console.log('\n  [4a] STC DEPTH × RSI DEPTH  (most likely discriminators)');
console.log('  ' + '─'.repeat(100));
// CALL combos
comboSlice('CALL  stc_prev≤10  +  rsi_min_5≤25',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.rsi_min_5<=25);
comboSlice('CALL  stc_prev≤10  +  rsi_min_5≤30',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.rsi_min_5<=30);
comboSlice('CALL  stc_prev≤10  +  rsi_min_5≤35',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.rsi_min_5<=35);
comboSlice('CALL  stc_prev≤15  +  rsi_min_5≤25',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.rsi_min_5<=25);
comboSlice('CALL  stc_prev≤15  +  rsi_min_5≤30',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.rsi_min_5<=30);
comboSlice('CALL  stc_prev≤15  +  rsi_min_5≤35',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.rsi_min_5<=35);
comboSlice('CALL  stc_prev≤25  +  rsi_min_5≤25',
    s => s.dir==='CALL' && s.stc_prev<=25 && s.rsi_min_5<=25);
comboSlice('CALL  stc_prev≤25  +  rsi_min_5≤30',
    s => s.dir==='CALL' && s.stc_prev<=25 && s.rsi_min_5<=30);
// PUT combos
comboSlice('PUT   stc_prev≥90  +  rsi_max_5≥75',
    s => s.dir==='PUT' && s.stc_prev>=90 && s.rsi_max_5>=75);
comboSlice('PUT   stc_prev≥85  +  rsi_max_5≥75',
    s => s.dir==='PUT' && s.stc_prev>=85 && s.rsi_max_5>=75);
comboSlice('PUT   stc_prev≥80  +  rsi_max_5≥75',
    s => s.dir==='PUT' && s.stc_prev>=80 && s.rsi_max_5>=75);
comboSlice('PUT   stc_prev≥80  +  rsi_max_5≥70',
    s => s.dir==='PUT' && s.stc_prev>=80 && s.rsi_max_5>=70);
comboSlice('PUT   stc_prev≥75  +  rsi_max_5≥75',
    s => s.dir==='PUT' && s.stc_prev>=75 && s.rsi_max_5>=75);
comboSlice('PUT   stc_prev≥75  +  rsi_max_5≥70',
    s => s.dir==='PUT' && s.stc_prev>=75 && s.rsi_max_5>=70);

console.log('\n  [4b] STC DEPTH × BB WIDTH');
console.log('  ' + '─'.repeat(100));
comboSlice('CALL  stc_prev≤10  +  bb_bps≥20',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.bb_bps>=20);
comboSlice('CALL  stc_prev≤15  +  bb_bps≥20',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.bb_bps>=20);
comboSlice('CALL  stc_prev≤25  +  bb_bps≥25',
    s => s.dir==='CALL' && s.stc_prev<=25 && s.bb_bps>=25);
comboSlice('PUT   stc_prev≥90  +  bb_bps≥20',
    s => s.dir==='PUT' && s.stc_prev>=90 && s.bb_bps>=20);
comboSlice('PUT   stc_prev≥85  +  bb_bps≥20',
    s => s.dir==='PUT' && s.stc_prev>=85 && s.bb_bps>=20);
comboSlice('PUT   stc_prev≥75  +  bb_bps≥25',
    s => s.dir==='PUT' && s.stc_prev>=75 && s.bb_bps>=25);

console.log('\n  [4c] RSI DEPTH × BB WIDTH');
console.log('  ' + '─'.repeat(100));
comboSlice('CALL  rsi_min_5≤25  +  bb_bps≥20',
    s => s.dir==='CALL' && s.rsi_min_5<=25 && s.bb_bps>=20);
comboSlice('CALL  rsi_min_5≤30  +  bb_bps≥20',
    s => s.dir==='CALL' && s.rsi_min_5<=30 && s.bb_bps>=20);
comboSlice('CALL  rsi_min_5≤30  +  bb_bps≥15',
    s => s.dir==='CALL' && s.rsi_min_5<=30 && s.bb_bps>=15);
comboSlice('PUT   rsi_max_5≥75  +  bb_bps≥20',
    s => s.dir==='PUT' && s.rsi_max_5>=75 && s.bb_bps>=20);
comboSlice('PUT   rsi_max_5≥70  +  bb_bps≥20',
    s => s.dir==='PUT' && s.rsi_max_5>=70 && s.bb_bps>=20);
comboSlice('PUT   rsi_max_5≥70  +  bb_bps≥15',
    s => s.dir==='PUT' && s.rsi_max_5>=70 && s.bb_bps>=15);

console.log('\n  [4d] THREE-WAY: STC DEPTH × RSI DEPTH × BB WIDTH');
console.log('  ' + '─'.repeat(100));
comboSlice('CALL  stc_prev≤10  +  rsi_min_5≤30  +  bb_bps≥15',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.rsi_min_5<=30 && s.bb_bps>=15);
comboSlice('CALL  stc_prev≤15  +  rsi_min_5≤30  +  bb_bps≥15',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.rsi_min_5<=30 && s.bb_bps>=15);
comboSlice('CALL  stc_prev≤15  +  rsi_min_5≤30  +  bb_bps≥20',
    s => s.dir==='CALL' && s.stc_prev<=15 && s.rsi_min_5<=30 && s.bb_bps>=20);
comboSlice('CALL  stc_prev≤10  +  rsi_min_5≤25  +  bb_bps≥15',
    s => s.dir==='CALL' && s.stc_prev<=10 && s.rsi_min_5<=25 && s.bb_bps>=15);
comboSlice('PUT   stc_prev≥90  +  rsi_max_5≥75  +  bb_bps≥15',
    s => s.dir==='PUT' && s.stc_prev>=90 && s.rsi_max_5>=75 && s.bb_bps>=15);
comboSlice('PUT   stc_prev≥85  +  rsi_max_5≥70  +  bb_bps≥15',
    s => s.dir==='PUT' && s.stc_prev>=85 && s.rsi_max_5>=70 && s.bb_bps>=15);
comboSlice('PUT   stc_prev≥80  +  rsi_max_5≥70  +  bb_bps≥15',
    s => s.dir==='PUT' && s.stc_prev>=80 && s.rsi_max_5>=70 && s.bb_bps>=15);
comboSlice('PUT   stc_prev≥80  +  rsi_max_5≥70  +  bb_bps≥20',
    s => s.dir==='PUT' && s.stc_prev>=80 && s.rsi_max_5>=70 && s.bb_bps>=20);

console.log('\n  [4e] KD SPREAD × STC DEPTH');
console.log('  ' + '─'.repeat(100));
const withSpr = sigs.map(s => ({ ...s, kd_spread: s.k != null && s.d != null ? Math.abs(s.k - s.d) : null }));
comboSlice('CALL  stc_prev≤15  +  kd_spread≥5',
    s => { const ws = withSpr.find(w => w.timestamp===s.timestamp && w.asset===s.asset && w.dir===s.dir); return s.dir==='CALL' && s.stc_prev<=15 && ws?.kd_spread>=5; });
comboSlice('CALL  stc_prev≤15  +  kd_spread≥10',
    s => { const ws = withSpr.find(w => w.timestamp===s.timestamp && w.asset===s.asset && w.dir===s.dir); return s.dir==='CALL' && s.stc_prev<=15 && ws?.kd_spread>=10; });
comboSlice('PUT   stc_prev≥85  +  kd_spread≥5',
    s => { const ws = withSpr.find(w => w.timestamp===s.timestamp && w.asset===s.asset && w.dir===s.dir); return s.dir==='PUT' && s.stc_prev>=85 && ws?.kd_spread>=5; });
comboSlice('PUT   stc_prev≥85  +  kd_spread≥10',
    s => { const ws = withSpr.find(w => w.timestamp===s.timestamp && w.asset===s.asset && w.dir===s.dir); return s.dir==='PUT' && s.stc_prev>=85 && ws?.kd_spread>=10; });

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${SEP}`);
console.log('  SUMMARY');
console.log(SEP);
console.log(`  Total signals analyzed : ${sigs.length}`);
console.log(`  Overall WR (120s)      : ${allStats.wr}%  (p=${allStats.p}  ${allStats.sig})`);
console.log(`  Overall P/L (120s)     : $${allStats.pl}`);
console.log(`\n  Key questions answered by each part:`);
console.log(`   Part 1 → Which indicator ranges should become tighter gate thresholds?`);
console.log(`   Part 2 → Which asset+direction combos are structural losers to block?`);
console.log(`   Part 3 → Is the edge consistent across days and hours?`);
console.log(`   Part 4 → What is the highest-conviction slice to validate first?`);
console.log(SEP + '\n');
