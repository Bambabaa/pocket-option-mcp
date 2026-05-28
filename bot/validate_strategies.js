'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  bot/validate_strategies.js
//
//  Backtest every strategy in entry_strategies.js against data/agent.db.
//
//  Logic:
//    - 5m bars (candles + indicators tables) are the data source, read-only.
//    - features.js runs on each 5m bar close, per asset.
//    - routeEntry() is called on each bar's (ind, feat) pair.
//    - When a signal fires, the entry price = close of the signal bar.
//    - The expiry horizon is 15m = 3 bars later.
//    - Outcome: CALL wins if close[+3] > entry, PUT wins if close[+3] < entry.
//    - A trade is excluded if the exit bar does not exist (near end of data).
//    - Cooldown: per-asset per-strategy, 3-bar cooldown after a signal fires.
//
//  Output:
//    - Per-strategy summary (N, WR, avg_payout_atr, p-value)
//    - Per-asset breakdown for strategies with N >= 10
//    - Overall equity stats
//
//  Usage:
//    node bot/validate_strategies.js [--asset EURUSD] [--strategy T1_ZSCORE_EXTREME_LOW]
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
const Database = require('better-sqlite3');

const { createAssetState, buildFeatures } = require('./features.js');
const { ENTRY_STRATEGIES, routeEntry }    = require('./entry_strategies.js');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(flag) {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
}
const FILTER_ASSET    = arg('--asset');
const FILTER_STRATEGY = arg('--strategy');
const VERBOSE         = args.includes('--verbose');
const COOLDOWN_BARS   = 3;

// ─── DB ───────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'data', 'agent.db');
const db = new Database(DB_PATH, { readonly: true });

// ─── Load all bars per asset ──────────────────────────────────────────────────
// JOIN candles + indicators on (asset, timestamp).  Sort ascending.
const RAW_QUERY = `
    SELECT
        c.asset,
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        i.atr_14,
        i.bb_width_bps,
        i.rsi_14,
        i.stc_value,
        i.stc_prev       AS prev_stc,
        i.macd_histogram,
        i.stoch_k,
        i.stoch_d,
        i.adx,
        i.plus_di,
        i.minus_di,
        i.cci_20,
        i.williams_r,
        i.psar_is_bullish
    FROM candles c
    JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
    ${FILTER_ASSET ? "WHERE c.asset = '" + FILTER_ASSET + "'" : ''}
    ORDER BY c.asset, c.timestamp ASC
`;

process.stdout.write('Loading data… ');
const rows = db.prepare(RAW_QUERY).all();
process.stdout.write(`${rows.length.toLocaleString()} bars loaded\n`);

// Group by asset
const byAsset = {};
for (const row of rows) {
    if (!byAsset[row.asset]) byAsset[row.asset] = [];
    byAsset[row.asset].push(row);
}
const assets = Object.keys(byAsset).sort();
console.log(`Assets: ${assets.join(', ')}\n`);

// ─── Result accumulators ──────────────────────────────────────────────────────
// stratStats[name] = { n, wins, pnl_atr[], n_excluded }
const stratStats = {};
// assetStratStats[asset][name] = { n, wins }
const assetStratStats = {};

for (const strat of ENTRY_STRATEGIES) {
    stratStats[strat.name] = { n: 0, wins: 0, pnl_atr: [], n_excluded: 0 };
}

// ─── Replay per asset ─────────────────────────────────────────────────────────
for (const asset of assets) {
    const bars = byAsset[asset];
    const state = createAssetState();
    assetStratStats[asset] = {};
    for (const strat of ENTRY_STRATEGIES) {
        assetStratStats[asset][strat.name] = { n: 0, wins: 0 };
    }

    // Per-asset, per-strategy cooldown counter
    const cooldown = {};
    for (const strat of ENTRY_STRATEGIES) cooldown[strat.name] = 0;

    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const feat = buildFeatures(bar, state);
        if (!feat) continue;

        // Decrement cooldowns
        for (const name in cooldown) {
            if (cooldown[name] > 0) cooldown[name]--;
        }

        // Only run the strategy filter if requested
        const signal = routeEntry(bar, feat);
        if (!signal) continue;
        if (FILTER_STRATEGY && signal.edge_name !== FILTER_STRATEGY) continue;

        const sname = signal.edge_name;

        // Cooldown check
        if (cooldown[sname] > 0) continue;
        cooldown[sname] = COOLDOWN_BARS;

        // Exit bar: 3 bars forward (15m)
        const exitBar = bars[i + 3];
        if (!exitBar) {
            stratStats[sname].n_excluded++;
            continue;
        }

        const entry = bar.close;
        const exit  = exitBar.close;
        const atr   = bar.atr_14 ?? 0.001;

        const won = signal.action === 'CALL'
            ? exit > entry
            : exit < entry;

        const pnl_atr = signal.action === 'CALL'
            ? (exit - entry) / atr
            : (entry - exit) / atr;

        stratStats[sname].n++;
        if (won) stratStats[sname].wins++;
        stratStats[sname].pnl_atr.push(pnl_atr);

        assetStratStats[asset][sname].n++;
        if (won) assetStratStats[asset][sname].wins++;

        if (VERBOSE) {
            const dt = new Date(bar.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
            console.log(
                `  ${asset}  ${dt}  ${sname.padEnd(38)}  ` +
                `${signal.action}  entry=${entry.toFixed(5)}  exit=${exit.toFixed(5)}  ` +
                `${won ? 'WIN ' : 'LOSS'}  pnl=${pnl_atr.toFixed(3)}atr`
            );
        }
    }
}

// ─── Binomial p-value (normal approximation) ──────────────────────────────────
function zScore(wins, n) {
    if (n < 5) return null;
    const p = wins / n;
    const se = Math.sqrt(0.5 * 0.5 / n);
    return (p - 0.5) / se;
}

function pValue(z) {
    if (z == null) return null;
    // Two-tailed; approximation via complementary error function
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * Math.abs(z) / Math.SQRT2);
    const erfc = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z / 2);
    return Math.min(1, erfc);
}

function wilsonLow(wins, n, z95 = 1.645) {
    if (n === 0) return 0;
    const p = wins / n;
    const d = 1 + z95 * z95 / n;
    return (p + z95 * z95 / (2 * n) - z95 * Math.sqrt(p * (1 - p) / n + z95 * z95 / (4 * n * n))) / d;
}

function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr, mu) {
    if (arr.length < 2) return 0;
    const m = mu ?? mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ─── Print summary ────────────────────────────────────────────────────────────
console.log('═'.repeat(110));
console.log('STRATEGY VALIDATION REPORT — 15m horizon  (entry=close[0], exit=close[+3])');
console.log('═'.repeat(110));
console.log(
    'Strategy'.padEnd(40) +
    'Dir'.padEnd(6) +
    'Tier'.padEnd(6) +
    'N'.padStart(6) +
    'WR%'.padStart(8) +
    'WR_lo95%'.padStart(10) +
    'Exp_atr'.padStart(10) +
    'Std_atr'.padStart(10) +
    'z'.padStart(7) +
    'p'.padStart(9) +
    'Excl'.padStart(7)
);
console.log('─'.repeat(110));

// Sort by tier then N descending
const sortedStrats = ENTRY_STRATEGIES.slice().sort((a, b) => {
    const ta = a.name.startsWith('T1') ? 0 : a.name.startsWith('T2') ? 1 : 2;
    const tb = b.name.startsWith('T1') ? 0 : b.name.startsWith('T2') ? 1 : 2;
    if (ta !== tb) return ta - tb;
    return stratStats[b.name].n - stratStats[a.name].n;
});

for (const strat of sortedStrats) {
    const s   = stratStats[strat.name];
    const wr  = s.n > 0 ? (s.wins / s.n * 100).toFixed(1) : '-';
    const exp = s.pnl_atr.length > 0 ? mean(s.pnl_atr).toFixed(3) : '-';
    const sd  = s.pnl_atr.length > 0 ? std(s.pnl_atr).toFixed(3)  : '-';
    const z   = zScore(s.wins, s.n);
    const p   = pValue(z);
    const wlo = s.n > 0 ? (wilsonLow(s.wins, s.n) * 100).toFixed(1) : '-';
    const tier = strat.name.startsWith('T1') ? 'T1' : strat.name.startsWith('T2') ? 'T2' : 'T3';
    const dir  = strat.direction;

    console.log(
        strat.name.padEnd(40) +
        dir.padEnd(6) +
        tier.padEnd(6) +
        String(s.n).padStart(6) +
        String(wr).padStart(8) +
        String(wlo).padStart(10) +
        String(exp).padStart(10) +
        String(sd).padStart(10) +
        (z != null ? z.toFixed(2) : '-').padStart(7) +
        (p != null ? p.toExponential(2) : '-').padStart(9) +
        String(s.n_excluded).padStart(7)
    );
}

// ─── Per-asset breakdown for any strategy with N >= 10 total ─────────────────
const sigStrats = sortedStrats.filter(s => stratStats[s.name].n >= 10);
if (sigStrats.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('PER-ASSET BREAKDOWN  (strategies with N ≥ 10)');
    console.log('═'.repeat(80));

    for (const strat of sigStrats) {
        console.log(`\n  ${strat.name}  [${strat.direction}]`);
        console.log('  ' + 'Asset'.padEnd(12) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'WR_lo95%'.padStart(10));
        console.log('  ' + '─'.repeat(36));
        const rows = assets
            .map(a => ({ asset: a, ...assetStratStats[a][strat.name] }))
            .filter(r => r.n > 0)
            .sort((a, b) => b.n - a.n);
        for (const r of rows) {
            const wr  = (r.wins / r.n * 100).toFixed(1);
            const wlo = (wilsonLow(r.wins, r.n) * 100).toFixed(1);
            console.log(`  ${r.asset.padEnd(12)}${String(r.n).padStart(6)}${String(wr).padStart(8)}${String(wlo).padStart(10)}`);
        }
    }
}

// ─── Aggregate totals ─────────────────────────────────────────────────────────
const totalN    = Object.values(stratStats).reduce((s, v) => s + v.n,    0);
const totalWins = Object.values(stratStats).reduce((s, v) => s + v.wins, 0);
const allPnl    = Object.values(stratStats).flatMap(v => v.pnl_atr);

console.log('\n' + '═'.repeat(110));
console.log(`TOTALS   signals=${totalN}  wins=${totalWins}  WR=${totalN > 0 ? (totalWins/totalN*100).toFixed(1) : '-'}%  avg_pnl=${allPnl.length ? mean(allPnl).toFixed(3) : '-'} ATR`);
console.log('═'.repeat(110));

db.close();
