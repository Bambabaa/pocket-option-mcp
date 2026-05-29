'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../../data/trading_data.db'), { readonly: true });

function pct(n, total) { return total ? (100 * n / total).toFixed(1) + '%' : 'N/A'; }

function winRate(rows) {
    const wins   = rows.filter(r => r.outcome === 'WIN').reduce((s, r) => s + r.n, 0);
    const losses = rows.filter(r => r.outcome === 'LOSS').reduce((s, r) => s + r.n, 0);
    const total  = wins + losses;
    return { wins, losses, total, wr: pct(wins, total) };
}

// ── 1. Overall ────────────────────────────────────────────────────────────────
const overall = db.prepare('SELECT result as outcome, COUNT(*) as n FROM signal_outcomes GROUP BY result').all();
const ov = winRate(overall);
console.log('\n═══════════════════════════════════════');
console.log('  OVERALL RESULTS');
console.log('═══════════════════════════════════════');
console.log(`  Wins   : ${ov.wins}`);
console.log(`  Losses : ${ov.losses}`);
console.log(`  Total  : ${ov.total}`);
console.log(`  Win Rate: ${ov.wr}`);

// ── 2. By strategy ───────────────────────────────────────────────────────────
const byStrat = db.prepare(`
    SELECT s.strategy_used, so.result as outcome, COUNT(*) as n
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    GROUP BY s.strategy_used, so.result
    ORDER BY s.strategy_used, so.result
`).all();

const stratMap = {};
for (const row of byStrat) {
    if (!stratMap[row.strategy_used]) stratMap[row.strategy_used] = [];
    stratMap[row.strategy_used].push(row);
}
console.log('\n═══════════════════════════════════════');
console.log('  BY STRATEGY');
console.log('═══════════════════════════════════════');
for (const [strat, rows] of Object.entries(stratMap)) {
    const { wins, losses, total, wr } = winRate(rows);
    console.log(`  ${strat.padEnd(36)} W:${wins}  L:${losses}  n:${total}  WR:${wr}`);
}

// ── 3. By direction ──────────────────────────────────────────────────────────
const byDir = db.prepare(`
    SELECT s.direction, so.result as outcome, COUNT(*) as n
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    GROUP BY s.direction, so.result
`).all();

const dirMap = {};
for (const row of byDir) {
    if (!dirMap[row.direction]) dirMap[row.direction] = [];
    dirMap[row.direction].push(row);
}
console.log('\n═══════════════════════════════════════');
console.log('  BY DIRECTION');
console.log('═══════════════════════════════════════');
for (const [dir, rows] of Object.entries(dirMap)) {
    const { wins, losses, total, wr } = winRate(rows);
    console.log(`  ${dir.padEnd(8)} W:${wins}  L:${losses}  n:${total}  WR:${wr}`);
}

// ── 4. By asset ──────────────────────────────────────────────────────────────
const byAsset = db.prepare(`
    SELECT s.asset, so.result as outcome, COUNT(*) as n
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    GROUP BY s.asset, so.result
    ORDER BY s.asset, so.result
`).all();

const assetMap = {};
for (const row of byAsset) {
    if (!assetMap[row.asset]) assetMap[row.asset] = [];
    assetMap[row.asset].push(row);
}
console.log('\n═══════════════════════════════════════');
console.log('  BY ASSET');
console.log('═══════════════════════════════════════');
for (const [asset, rows] of Object.entries(assetMap)) {
    const { wins, losses, total, wr } = winRate(rows);
    console.log(`  ${asset.padEnd(20)} W:${wins}  L:${losses}  n:${total}  WR:${wr}`);
}

// ── 5. Sample outcomes with entry/exit prices ─────────────────────────────────
const samples = db.prepare(`
    SELECT so.signal_id, s.asset, s.direction, s.strategy_used,
           datetime(so.signal_timestamp, 'unixepoch') as fired_at,
           so.entry_price, so.exit_price, so.result as outcome, so.updated_at as validated_at
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    ORDER BY so.signal_timestamp
    LIMIT 20
`).all();
console.log('\n═══════════════════════════════════════');
console.log('  SAMPLE ROWS (first 20)');
console.log('═══════════════════════════════════════');
for (const r of samples) {
    const move = r.entry_price && r.exit_price
        ? ((r.exit_price - r.entry_price) * (r.direction === 'CALL' ? 1 : -1)).toFixed(5)
        : 'N/A';
    console.log(`  ${r.fired_at}  ${r.direction.padEnd(5)} ${r.strategy_used.padEnd(36)} ${r.outcome.padEnd(4)}  Δ${move}`);
}

db.close();
