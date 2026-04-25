// Decision-tree leaf sweep — CORR report revision.
// Implements only the 3 leaves with adequate sample size (n≥50) from
// docs/ML_REPORT_LEAF_PATTERN-CORR.MD. Expiry fixed at 2m (model was 2m).
//
// Single DB:  node scripts/paper_reversal_leaves.cjs [dbPath] [outCsv]
// All DBs:    node scripts/paper_reversal_leaves.cjs --all [outCsv]
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const ALL_DBS = [
  'data/trading_data_v1.db',
  'data/trading_data_v2_13-15.db',
  'data/trading_data_V3_16.db',
  'data/trading_data_V3_17.db',
  'data/trading_data_V4_17.db',
  'data/trading_data-V4_18.db',
  'data/trading_data.db',
];

const runAll = process.argv[2] === '--all';
const dbPaths = runAll ? ALL_DBS : [process.argv[2] || 'data/trading_data.db'];
const outCsv = (runAll ? process.argv[3] : process.argv[3]) || 'data/paper_reversal_leaves.csv';

const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRY = 2; // minutes — model was trained on 2m expiry only

function computeFeatures(r) {
  const close_to_lower = ((r.close - r.bb_lower) / r.bb_middle) * 10000;
  const close_to_upper = ((r.bb_upper - r.close) / r.bb_middle) * 10000;
  const bb_width_bps = ((r.bb_upper - r.bb_lower) / r.bb_middle) * 10000;
  const bbRange = r.bb_upper - r.bb_lower;
  const bb_position = bbRange > 0 ? (r.close - r.bb_lower) / bbRange : null;
  const stoch_kd_diff = (r.stochastic_k_v2 != null && r.stochastic_d_v2 != null)
    ? r.stochastic_k_v2 - r.stochastic_d_v2 : null;
  const stc_stoch_diff = (r.schaff_value != null && r.stochastic_k_v2 != null)
    ? r.schaff_value - r.stochastic_k_v2 : null;
  const ma_trend_bps = (r.ma1 != null && r.ma3 != null && r.ma3)
    ? ((r.ma1 - r.ma3) / r.ma3) * 10000 : 0;
  return {
    rsi: r.rsi_5,
    k: r.stochastic_k_v2,
    d: r.stochastic_d_v2,
    stc: r.schaff_value,
    close_to_lower, close_to_upper,
    bb_width_bps, ma_trend_bps,
    bb_position, stoch_kd_diff, stc_stoch_diff,
  };
}

const has = (v) => v != null;

// ── Leaves from ML_REPORT_LEAF_PATTERN-CORR.MD (2-minute model, 26,377 rows)
// Only leaves with n≥50. Razor-band leaves (n<20 or band<1 unit) excluded.
//
// L16 CALL (n=86, WR=68.6%)
//   IF bb_position <= 0.021859
//   AND stoch_kd_diff > -1.668935
//   AND close_to_lower <= -1.013379
//   AND rsi_5 <= 5.787841
//   AND rsi_5 <= 2.679860          ← tighter of the two RSI splits
//   AND stoch_d_v2 > 4.079007
//
// L41 PUT (n=50, WR=76.0%)
//   IF bb_position > 0.021859
//   AND stoch_kd_diff <= 22.493945
//   AND stc_stoch_diff > -58.236702
//   AND rsi_5 <= 17.150460
//   AND stoch_kd_diff <= -16.898592
//   AND bb_position > 0.352286
//
// L65 PUT (n=323, WR=63.8%)
//   IF bb_position > 0.021859
//   AND stoch_kd_diff > 22.493945
//   AND stoch_kd_diff > 22.671788  ← the razor split that produces L55/L56 is *before* this
//   AND bb_position <= 0.721175
//   AND schaff_value > 0.000060
//   AND stoch_kd_diff > 24.659285  ← final gate: K running well ahead of D

const LEAVES = [
  {
    id: 'L16', dir: 'CALL', wr_reported: 0.6860, n_reported: 86,
    test: (f) =>
      has(f.bb_position) && has(f.rsi) && has(f.d) && has(f.stoch_kd_diff) &&
      f.bb_position <= 0.021859 &&
      f.stoch_kd_diff > -1.668935 &&
      f.close_to_lower <= -1.013379 &&
      f.rsi <= 2.679860 &&  // combines both RSI splits (≤5.788 AND ≤2.680)
      f.d > 4.079007,
  },
  {
    id: 'L41', dir: 'PUT', wr_reported: 0.7600, n_reported: 50,
    test: (f) =>
      has(f.bb_position) && has(f.rsi) && has(f.stoch_kd_diff) && has(f.stc_stoch_diff) &&
      f.bb_position > 0.021859 &&
      f.stc_stoch_diff > -58.236702 &&
      f.rsi <= 17.150460 &&
      f.stoch_kd_diff <= -16.898592 &&  // also satisfies ≤22.493945
      f.bb_position > 0.352286,
  },
  {
    id: 'L65', dir: 'PUT', wr_reported: 0.6378, n_reported: 323,
    test: (f) =>
      has(f.bb_position) && has(f.stoch_kd_diff) && has(f.stc) &&
      f.bb_position > 0.021859 &&
      f.bb_position <= 0.721175 &&
      f.stoch_kd_diff > 24.659285 &&  // supersedes the two earlier ≥22.49/22.67 splits
      f.stc > 0.000060,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(arr) {
  const n = arr.length;
  const w = arr.filter(x => x.outcome === 'WIN').length;
  const pl = arr.reduce((s, x) => s + x.pl, 0);
  const wr = n ? (100 * w / n).toFixed(1) : '-';
  return { n, wr: String(wr), pl };
}

const fmtCsv = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
  return String(v);
};

const SQL = `
  SELECT i.asset, i.timestamp,
         c.open, c.close, c.high, c.low,
         i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
         i.bb_upper, i.bb_middle, i.bb_lower,
         i.ma1, i.ma3,
         i.schaff_value
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_5 IS NOT NULL AND i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper IS NOT NULL AND i.bb_middle IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`;

// ── Accumulate across all DBs ─────────────────────────────────────────────────
const csvHeader = [
  'db_source',
  'timestamp_utc', 'asset', 'leaf_id', 'direction', 'wr_reported', 'n_reported',
  'open', 'high', 'low', 'close',
  'rsi_5', 'stoch_k_v2', 'stoch_d_v2',
  'bb_upper', 'bb_middle', 'bb_lower', 'bb_width_bps',
  'ma6', 'ma14', 'ma_trend_bps',
  'close_to_lower', 'close_to_upper',
  'schaff_value', 'stc_zone',
  'bb_position', 'stc_stoch_diff', 'stoch_kd_diff',
  'exit_2m', 'pnl_2m', 'win_2m',
];
const csvLines = [csvHeader.join(',')];

// global trade accumulators (across all DBs)
const allTrades = {};
for (const L of LEAVES) allTrades[L.id] = [];
allTrades['COMBINED'] = [];

for (const dbPath of dbPaths) {
  const dbFile = dbPath.split(/[\\/]/).pop();
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(SQL).all();
  db.close();

  const closeByKey = new Map();
  for (const r of rows) closeByKey.set(r.asset + '|' + r.timestamp, r.close);

  // per-DB trade accumulators for console output
  const dbTrades = {};
  for (const L of LEAVES) dbTrades[L.id] = [];
  dbTrades['COMBINED'] = [];

  for (const r of rows) {
    const f = computeFeatures(r);
    const hour = new Date(r.timestamp * 1000).getUTCHours();
    const exit = closeByKey.get(r.asset + '|' + (r.timestamp + EXPIRY * 60));
    let firstFired = null;

    for (const L of LEAVES) {
      if (!L.test(f)) continue;
      if (!firstFired) firstFired = L;

      const stcZone = f.stc == null ? '' :
        (f.stc < 25 ? 'oversold' : f.stc > 75 ? 'overbought' : 'neutral');

      const csvRow = [
        dbFile,
        new Date(r.timestamp * 1000).toISOString(), r.asset, L.id, L.dir, L.wr_reported, L.n_reported,
        r.open, r.high, r.low, r.close,
        r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2,
        r.bb_upper, r.bb_middle, r.bb_lower, f.bb_width_bps,
        r.ma1, r.ma3, f.ma_trend_bps,
        f.close_to_lower, f.close_to_upper,
        r.schaff_value, stcZone,
        f.bb_position, f.stc_stoch_diff, f.stoch_kd_diff,
      ];

      if (exit == null) {
        csvRow.push('', '', '');
      } else {
        const win = L.dir === 'CALL' ? exit > r.close : exit < r.close;
        const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
        const rec = { outcome: win ? 'WIN' : 'LOSS', pl, hour, dir: L.dir, asset: r.asset };
        dbTrades[L.id].push(rec);
        allTrades[L.id].push(rec);
        csvRow.push(exit, pl, win ? 1 : 0);
      }
      csvLines.push(csvRow.map(fmtCsv).join(','));
    }

    if (firstFired && exit != null) {
      const win = firstFired.dir === 'CALL' ? exit > r.close : exit < r.close;
      const rec = { outcome: win ? 'WIN' : 'LOSS', pl: win ? AMOUNT * PAYOUT : -AMOUNT, hour, dir: firstFired.dir, asset: r.asset };
      dbTrades['COMBINED'].push(rec);
      allTrades['COMBINED'].push(rec);
    }
  }

  // ── Per-DB console output ───────────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  LEAF SWEEP (CORR)  |  ${dbFile.padEnd(44)}║`);
  console.log(`║  3 leaves (n≥50) from ML_REPORT_LEAF_PATTERN-CORR  |  expiry=2m    ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

  console.log('── LEAF RESULTS @ 2m ───────────────────────────────────────────────────');
  console.log('Leaf    Dir   n       WR%     $P&L');
  console.log('-'.repeat(50));
  for (const L of LEAVES) {
    const f = fmt(dbTrades[L.id]);
    console.log(`${L.id.padEnd(7)} ${L.dir.padEnd(5)} ${String(f.n).padEnd(7)} ${f.wr.padStart(5)}%   $${f.pl}`);
  }
  {
    const f = fmt(dbTrades['COMBINED']);
    console.log(`${'COMBINED'.padEnd(7)} ${''.padEnd(5)} ${String(f.n).padEnd(7)} ${f.wr.padStart(5)}%   $${f.pl}`);
  }

  console.log('\n── CLAIM vs ACTUAL (2m) ────────────────────────────────────────────────');
  console.log('Leaf    Dir   claimed_WR  actual_WR   n      Δ(pp)');
  console.log('-'.repeat(58));
  for (const L of LEAVES) {
    const f = fmt(dbTrades[L.id]);
    const claimed = (L.wr_reported * 100).toFixed(1);
    const delta = f.n > 0 ? (parseFloat(f.wr) - L.wr_reported * 100).toFixed(1) : '-';
    console.log(`${L.id.padEnd(7)} ${L.dir.padEnd(5)} ${claimed.padStart(7)}%    ${f.wr.padStart(5)}%   ${String(f.n).padEnd(6)} ${String(delta).padStart(6)}`);
  }
}

// ── AGGREGATE summary (all DBs combined) ─────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log('  AGGREGATE — ALL DBs COMBINED');
console.log('═'.repeat(72));

console.log('\n── LEAF RESULTS @ 2m (ALL DBs) ─────────────────────────────────────────');
console.log('Leaf    Dir   n       WR%     $P&L');
console.log('-'.repeat(50));
for (const L of LEAVES) {
  const f = fmt(allTrades[L.id]);
  console.log(`${L.id.padEnd(7)} ${L.dir.padEnd(5)} ${String(f.n).padEnd(7)} ${f.wr.padStart(5)}%   $${f.pl}`);
}
{
  const f = fmt(allTrades['COMBINED']);
  console.log(`${'COMBINED'.padEnd(7)} ${''.padEnd(5)} ${String(f.n).padEnd(7)} ${f.wr.padStart(5)}%   $${f.pl}`);
}

// ── Hour of day ───────────────────────────────────────────────────────────────
console.log('\n── HOUR-OF-DAY (COMBINED @ 2m, ALL DBs) ────────────────────────────────');
{
  const byHour = {};
  for (const t of allTrades['COMBINED']) (byHour[t.hour] ??= []).push(t);
  for (const h of Object.keys(byHour).map(Number).sort((a, b) => a - b)) {
    const f = fmt(byHour[h]);
    console.log(`  UTC ${String(h).padStart(2)}:00   n=${String(f.n).padEnd(4)} WR=${f.wr}%   $${f.pl}`);
  }
}

// ── Top assets ────────────────────────────────────────────────────────────────
console.log('\n── TOP 10 ASSETS (COMBINED @ 2m, ALL DBs, n≥5) ─────────────────────────');
{
  const byAsset = {};
  for (const t of allTrades['COMBINED']) (byAsset[t.asset] ??= []).push(t);
  const ranked = Object.entries(byAsset)
    .map(([a, arr]) => ({ a, ...fmt(arr) }))
    .filter(x => x.n >= 5)
    .sort((x, y) => y.pl - x.pl)
    .slice(0, 10);
  for (const x of ranked)
    console.log(`  ${x.a.padEnd(18)} n=${String(x.n).padEnd(4)} WR=${x.wr}%   $${x.pl}`);
}

// ── Per-leaf asset breakdown ──────────────────────────────────────────────────
console.log('\n── PER-LEAF ASSET BREAKDOWN (ALL DBs, n≥5, top 5 by P&L) ──────────────');
for (const L of LEAVES) {
  const byAsset = {};
  for (const t of allTrades[L.id]) (byAsset[t.asset] ??= []).push(t);
  const ranked = Object.entries(byAsset)
    .map(([a, arr]) => ({ a, ...fmt(arr) }))
    .filter(x => x.n >= 5)
    .sort((x, y) => y.pl - x.pl)
    .slice(0, 5);
  console.log(`  ${L.id} (${L.dir}):`);
  if (ranked.length === 0) { console.log('    (no assets with n≥5)'); continue; }
  for (const x of ranked)
    console.log(`    ${x.a.padEnd(18)} n=${String(x.n).padEnd(4)} WR=${x.wr}%   $${x.pl}`);
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });
fs.writeFileSync(outCsv, csvLines.join('\n') + '\n');
console.log(`\nCSV: wrote ${csvLines.length - 1} leaf-firings → ${outCsv}\n`);
