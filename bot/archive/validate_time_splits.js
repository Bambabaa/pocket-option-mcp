'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  bot/validate_time_splits.js
//
//  Re-runs the full strategy replay from validate_strategies.js and slices
//  every signal by:
//    1. Hour of day  (UTC — DB timestamps are UTC-5, offset corrected +5h)
//    2. Trading session  (ASIA / LONDON / OVERLAP / NY / OFF)
//    3. Day of week  (Mon-Fri)
//    4. Calendar week  (weekly P&L curve)
//
//  Only the 5 statistically strong strategies (p < 0.01) are reported in
//  detail; all 11 are included in the totals row.
//
//  Usage:
//    node bot/validate_time_splits.js [--strategy NAME] [--asset PAIR]
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const { createAssetState, buildFeatures } = require('./features.js');
const { ENTRY_STRATEGIES, routeEntry }    = require('./entry_strategies.js');

// ─── Constants ────────────────────────────────────────────────────────────────
const DB_PATH       = path.join(__dirname, '..', 'data', 'agent.db');
const TZ_OFFSET_S   = 5 * 3600;   // DB timestamps are UTC-5 → add 5h to get UTC
const COOLDOWN_BARS = 3;
const STRONG = new Set([
    'T1_ZSCORE_EXTREME_LOW',
    'T2_BB_PEAK_BEAR_BOUNCE',
    'T2_FADE_FRESH_UP_BREAK',
    'T2_RANGE_EXPAND_BEAR_BOUNCE',
    'T3_ZSCORE_LOW_1_5SIG',
]);

// Trading sessions in UTC hours [start, end)
const SESSIONS = [
    { name: 'ASIA',    start:  0, end:  7 },
    { name: 'LONDON',  start:  7, end: 12 },
    { name: 'OVERLAP', start: 12, end: 17 },   // London/NY overlap
    { name: 'NY',      start: 17, end: 22 },
    { name: 'OFF',     start: 22, end: 24 },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; }
const FILTER_ASSET    = arg('--asset');
const FILTER_STRATEGY = arg('--strategy');

// ─── DB ───────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });

const RAW_QUERY = `
    SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
           i.atr_14, i.bb_width_bps, i.rsi_14, i.stc_value,
           i.stc_prev AS prev_stc, i.macd_histogram,
           i.stoch_k, i.stoch_d, i.adx, i.plus_di, i.minus_di,
           i.cci_20, i.williams_r, i.psar_is_bullish
    FROM candles c
    JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
    ${FILTER_ASSET ? `WHERE c.asset = '${FILTER_ASSET}'` : ''}
    ORDER BY c.asset, c.timestamp ASC
`;

process.stdout.write('Loading data… ');
const rows = db.prepare(RAW_QUERY).all();
process.stdout.write(`${rows.length.toLocaleString()} bars\n`);

// Group by asset
const byAsset = {};
for (const row of rows) {
    (byAsset[row.asset] = byAsset[row.asset] || []).push(row);
}
const assets = Object.keys(byAsset).sort();

// ─── Accumulators ─────────────────────────────────────────────────────────────
// acc[strategy][dimension][bucket] = { n, wins }
function mkBucket() { return { n: 0, wins: 0 }; }

function acc() {
    return {
        hour:    {},   // 0-23 (UTC)
        session: {},   // ASIA / LONDON / OVERLAP / NY / OFF
        weekday: {},   // 0-6
        week:    {},   // ISO week string e.g. "2026-W21"
    };
}

const data = {};
for (const strat of ENTRY_STRATEGIES) data[strat.name] = acc();

function bump(dim, key, won) {
    if (!dim[key]) dim[key] = mkBucket();
    dim[key].n++;
    if (won) dim[key].wins++;
}

// ─── Replay ───────────────────────────────────────────────────────────────────
for (const asset of assets) {
    const bars  = byAsset[asset];
    const state = createAssetState();
    const cool  = {};
    for (const s of ENTRY_STRATEGIES) cool[s.name] = 0;

    for (let i = 0; i < bars.length; i++) {
        const bar  = bars[i];
        const feat = buildFeatures(bar, state);
        if (!feat) continue;

        for (const n in cool) if (cool[n] > 0) cool[n]--;

        const signal = routeEntry(bar, feat);
        if (!signal) continue;
        if (FILTER_STRATEGY && signal.edge_name !== FILTER_STRATEGY) continue;

        const sname = signal.edge_name;
        if (cool[sname] > 0) continue;
        cool[sname] = COOLDOWN_BARS;

        const exitBar = bars[i + 3];
        if (!exitBar) continue;

        const won = signal.action === 'CALL'
            ? exitBar.close > bar.close
            : exitBar.close < bar.close;

        // Time dimensions
        const utcTs  = bar.timestamp + TZ_OFFSET_S;
        const d      = new Date(utcTs * 1000);
        const hourH  = d.getUTCHours();
        const dayIdx = d.getUTCDay();               // 0=Sun
        const sess   = SESSIONS.find(s => hourH >= s.start && hourH < s.end)?.name ?? 'OFF';

        // ISO week key  e.g. "2026-W21"
        const jan4   = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
        const wNum   = Math.ceil(((d - jan4) / 86400000 + jan4.getUTCDay() + 1) / 7);
        const weekKey = `${d.getUTCFullYear()}-W${String(wNum).padStart(2, '0')}`;

        const sd = data[sname];
        bump(sd.hour,    hourH,   won);
        bump(sd.session, sess,    won);
        bump(sd.weekday, dayIdx,  won);
        bump(sd.week,    weekKey, won);
    }
}

db.close();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function wr(b) { return b.n ? (b.wins / b.n * 100).toFixed(1) : '-'; }
function pval(wins, n) {
    if (n < 5) return '-';
    const z  = (wins / n - 0.5) / Math.sqrt(0.25 / n);
    const p  = 0.3275911;
    const [a1, a2, a3, a4, a5] = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
    const t  = 1 / (1 + p * Math.abs(z) / Math.SQRT2);
    const pv = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z / 2);
    return Math.min(1, pv).toExponential(2);
}
function sig(wins, n) {
    if (n < 5) return '    ';
    const z = (wins / n - 0.5) / Math.sqrt(0.25 / n);
    if (z > 2.58) return ' ***';
    if (z > 1.96) return '  **';
    if (z > 1.64) return '   *';
    return '    ';
}

const SEP = '─'.repeat(72);

function printDimTable(stratName, dimLabel, dimData, keyLabels) {
    const keys = keyLabels ?? Object.keys(dimData).sort((a, b) => Number(a) - Number(b));
    if (keys.length === 0) return;
    console.log(`\n  [${dimLabel}]`);
    console.log('  ' + 'Bucket'.padEnd(14) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'p-value'.padStart(12) + '');
    console.log('  ' + SEP.slice(0, 42));
    for (const k of keys) {
        const b = dimData[k];
        if (!b || b.n === 0) continue;
        const label = (keyLabels ? k : String(k)).padEnd(14);
        console.log(
            '  ' + label +
            String(b.n).padStart(6) +
            String(wr(b)).padStart(8) +
            String(pval(b.wins, b.n)).padStart(12) +
            sig(b.wins, b.n)
        );
    }
}

// ─── Print ────────────────────────────────────────────────────────────────────
const STRONG_STRATS = ENTRY_STRATEGIES.filter(s => STRONG.has(s.name));
const OTHER_STRATS  = ENTRY_STRATEGIES.filter(s => !STRONG.has(s.name));

const titleFilter = FILTER_STRATEGY ? `  strategy=${FILTER_STRATEGY}` : '';
const assetFilter  = FILTER_ASSET   ? `  asset=${FILTER_ASSET}`       : '';

console.log('\n' + '═'.repeat(72));
console.log(`TIME & WEEK SPLIT REPORT — 15m horizon  (UTC timestamps, DB offset +5h)${titleFilter}${assetFilter}`);
console.log('═'.repeat(72));
console.log('Sessions (UTC):  ASIA 00-07  LONDON 07-12  OVERLAP 12-17  NY 17-22  OFF 22-24');
console.log('Significance:  *** p<0.01   ** p<0.05   * p<0.10');

// ── Strong strategies ─────────────────────────────────────────────────────────
for (const strat of (FILTER_STRATEGY ? ENTRY_STRATEGIES.filter(s => s.name === FILTER_STRATEGY) : STRONG_STRATS)) {
    const sd = data[strat.name];
    // total N for this strategy
    const totN    = Object.values(sd.session).reduce((s, b) => s + b.n,    0);
    const totWins = Object.values(sd.session).reduce((s, b) => s + b.wins, 0);
    if (totN === 0) continue;

    console.log('\n' + '═'.repeat(72));
    console.log(`${strat.name}  [${strat.direction}]  N=${totN}  WR=${(totWins/totN*100).toFixed(1)}%`);
    console.log('═'.repeat(72));

    // Hour of day (0-23 UTC, show as HH:00)
    const hourKeys = Array.from({ length: 24 }, (_, h) => h)
        .filter(h => sd.hour[h]?.n > 0)
        .map(h => ({ key: h, label: `${String(h).padStart(2, '0')}:00 UTC` }));
    if (hourKeys.length) {
        console.log('\n  [HOUR OF DAY — UTC]');
        console.log('  ' + 'Hour'.padEnd(14) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'p-value'.padStart(12) + '');
        console.log('  ' + SEP.slice(0, 42));
        for (const { key, label } of hourKeys) {
            const b = sd.hour[key];
            console.log(
                '  ' + label.padEnd(14) +
                String(b.n).padStart(6) +
                String(wr(b)).padStart(8) +
                String(pval(b.wins, b.n)).padStart(12) +
                sig(b.wins, b.n)
            );
        }
    }

    // Session
    printDimTable(strat.name, 'SESSION', sd.session,
        SESSIONS.map(s => s.name).filter(n => sd.session[n]?.n > 0));

    // Weekday (Mon-Fri)
    const wdKeys = [1, 2, 3, 4, 5].filter(d => sd.weekday[d]?.n > 0)
        .map(d => ({ key: d, label: DAYS[d] }));
    if (wdKeys.length) {
        console.log('\n  [DAY OF WEEK]');
        console.log('  ' + 'Day'.padEnd(14) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'p-value'.padStart(12) + '');
        console.log('  ' + SEP.slice(0, 42));
        for (const { key, label } of wdKeys) {
            const b = sd.weekday[key];
            console.log(
                '  ' + label.padEnd(14) +
                String(b.n).padStart(6) +
                String(wr(b)).padStart(8) +
                String(pval(b.wins, b.n)).padStart(12) +
                sig(b.wins, b.n)
            );
        }
    }

    // Weekly curve
    const weekKeys = Object.keys(sd.week).sort();
    if (weekKeys.length) {
        console.log('\n  [WEEKLY CURVE]');
        console.log('  ' + 'Week'.padEnd(14) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'Wins'.padStart(6) + 'Losses'.padStart(8));
        console.log('  ' + SEP.slice(0, 44));
        for (const wk of weekKeys) {
            const b = sd.week[wk];
            const losses = b.n - b.wins;
            const bar = '█'.repeat(Math.round(b.wins / b.n * 20)).padEnd(20, '░');
            console.log(
                '  ' + wk.padEnd(14) +
                String(b.n).padStart(6) +
                String(wr(b)).padStart(8) +
                String(b.wins).padStart(6) +
                String(losses).padStart(8) +
                '  ' + bar
            );
        }
    }
}

// ── Summary table: session WR for ALL strategies ──────────────────────────────
if (!FILTER_STRATEGY) {
    console.log('\n\n' + '═'.repeat(110));
    console.log('ALL-STRATEGY SESSION SUMMARY');
    console.log('═'.repeat(110));
    console.log(
        'Strategy'.padEnd(42) +
        'Dir'.padEnd(6) +
        'ASIA'.padStart(10) +
        'LONDON'.padStart(10) +
        'OVERLAP'.padStart(10) +
        'NY'.padStart(10) +
        'OFF'.padStart(10)
    );
    console.log('─'.repeat(100));
    for (const strat of ENTRY_STRATEGIES) {
        const sd = data[strat.name];
        const sessWR = (sname) => {
            const b = sd.session[sname];
            if (!b || b.n < 5) return '  -  ';
            return `${wr(b)}%${sig(b.wins, b.n).trim() ? sig(b.wins, b.n) : '  '}`;
        };
        const totN = Object.values(sd.session).reduce((s, b) => s + b.n, 0);
        if (totN === 0) continue;
        console.log(
            strat.name.padEnd(42) +
            strat.direction.padEnd(6) +
            sessWR('ASIA').padStart(10) +
            sessWR('LONDON').padStart(10) +
            sessWR('OVERLAP').padStart(10) +
            sessWR('NY').padStart(10) +
            sessWR('OFF').padStart(10)
        );
    }

    console.log('\n\n' + '═'.repeat(90));
    console.log('ALL-STRATEGY WEEKDAY SUMMARY');
    console.log('═'.repeat(90));
    console.log(
        'Strategy'.padEnd(42) +
        'Dir'.padEnd(6) +
        'Mon'.padStart(10) +
        'Tue'.padStart(10) +
        'Wed'.padStart(10) +
        'Thu'.padStart(10) +
        'Fri'.padStart(10)
    );
    console.log('─'.repeat(90));
    for (const strat of ENTRY_STRATEGIES) {
        const sd = data[strat.name];
        const dayWR = (d) => {
            const b = sd.weekday[d];
            if (!b || b.n < 5) return '  -  ';
            return `${wr(b)}%${sig(b.wins, b.n).trim() ? sig(b.wins, b.n) : '  '}`;
        };
        const totN = Object.values(sd.session).reduce((s, b) => s + b.n, 0);
        if (totN === 0) continue;
        console.log(
            strat.name.padEnd(42) +
            strat.direction.padEnd(6) +
            dayWR(1).padStart(10) +
            dayWR(2).padStart(10) +
            dayWR(3).padStart(10) +
            dayWR(4).padStart(10) +
            dayWR(5).padStart(10)
        );
    }
}
