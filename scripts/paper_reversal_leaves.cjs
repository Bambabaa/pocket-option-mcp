// Decision-tree leaf sweep. Replays the 10 directionally-unambiguous leaves
// from docs/ML_REPORT_LEAF_PATTERN.MD (all WR ≥ 60%). Measures claim-vs-actual
// to expose overfitting. Does NOT modify paper_reversal_sweep.cjs.
// Usage: node scripts/paper_reversal_leaves.cjs [dbPath] [outCsv]
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outCsv = process.argv[3] || 'data/paper_reversal_leaves.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 5];

// Feature engineering. Adds bb_position and stc_stoch_diff used by leaves.
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

// Required-field guard per leaf. Returns false if any needed feature is null.
const has = (v) => v != null;

// 10 leaves with WR ≥ 60% from LEAF_PATTERN report §4.
// Thresholds copied verbatim. Direction inferred from oversold/overbought semantics.
const LEAVES = [
  { id: 2, dir: 'CALL', wr_reported: 1.00, n_reported: 24, test: (f) =>
      has(f.rsi) && has(f.k) && has(f.d) && has(f.bb_position) &&
      f.rsi <= 1.8098 && f.k <= 9.6 && f.d > 5.7217 && f.d <= 15.3208 &&
      f.close_to_lower <= -2.111 && f.bb_position <= 0.1198 },

  { id: 6, dir: 'CALL', wr_reported: 0.92, n_reported: 25, test: (f) =>
      has(f.k) && has(f.stoch_kd_diff) && has(f.bb_position) &&
      f.k <= 9.6 && f.close_to_lower > -2.111 && f.bb_width_bps <= 12.8662 &&
      f.stoch_kd_diff > -2.8832 && f.stoch_kd_diff <= -0.8091 && f.bb_position <= 0.1198 },

  { id: 31, dir: 'PUT', wr_reported: 0.8824, n_reported: 17, test: (f) =>
      has(f.stc) && has(f.stc_stoch_diff) && has(f.stoch_kd_diff) && has(f.bb_position) &&
      f.stc > 88.8626 && f.stc <= 98.6049 && f.bb_width_bps > 0.5241 &&
      f.stc_stoch_diff > 64.7924 && f.stoch_kd_diff > -8.7362 && f.bb_position > 0.1198 },

  { id: 21, dir: 'PUT', wr_reported: 0.8786, n_reported: 140, test: (f) =>
      has(f.k) && has(f.stc_stoch_diff) && has(f.bb_position) &&
      f.k <= 90.466 && f.close_to_lower <= 29.4479 && f.close_to_upper <= 6.7463 &&
      f.bb_width_bps > 0.5241 && f.stc_stoch_diff <= 64.7924 && f.bb_position > 0.1198 },

  { id: 27, dir: 'PUT', wr_reported: 0.8116, n_reported: 69, test: (f) =>
      has(f.k) && has(f.stc) && has(f.stc_stoch_diff) && has(f.bb_position) &&
      f.k > 90.466 && f.stc > 99.7811 && f.bb_width_bps > 0.5241 &&
      f.stc_stoch_diff <= 64.7924 && f.bb_position > 0.1198 && f.bb_position <= 1.0691 },

  { id: 3, dir: 'CALL', wr_reported: 0.80, n_reported: 15, test: (f) =>
      has(f.rsi) && has(f.k) && has(f.d) && has(f.bb_position) &&
      f.rsi > 1.8098 && f.k <= 9.6 && f.d > 5.7217 && f.d <= 15.3208 &&
      f.close_to_lower <= -2.111 && f.bb_position <= 0.1198 },

  { id: 24, dir: 'PUT', wr_reported: 0.7447, n_reported: 47, test: (f) =>
      has(f.k) && has(f.stc_stoch_diff) && has(f.bb_position) &&
      f.k <= 90.466 && f.close_to_upper > 21.9194 && f.bb_width_bps > 0.5241 &&
      f.stc_stoch_diff <= 64.7924 && f.bb_position > 0.1198 },

  { id: 25, dir: 'PUT', wr_reported: 0.6422, n_reported: 109, test: (f) =>
      has(f.k) && has(f.stc) && has(f.stc_stoch_diff) && has(f.bb_position) &&
      f.k > 90.466 && f.stc <= 96.513 && f.bb_width_bps > 0.5241 &&
      f.stc_stoch_diff <= 64.7924 && f.bb_position > 0.1198 },

  { id: 1, dir: 'CALL', wr_reported: 0.619, n_reported: 21, test: (f) =>
      has(f.k) && has(f.d) && has(f.bb_position) &&
      f.k <= 9.6 && f.d <= 5.7217 && f.close_to_lower <= -2.111 && f.bb_position <= 0.1198 },

  { id: 5, dir: 'CALL', wr_reported: 0.6154, n_reported: 52, test: (f) =>
      has(f.k) && has(f.stoch_kd_diff) && has(f.bb_position) &&
      f.k <= 9.6 && f.close_to_lower > -2.111 && f.bb_width_bps <= 12.8662 &&
      f.stoch_kd_diff <= -2.8832 && f.bb_position <= 0.1198 },
];

// ── Load rows ───────────────────────────────────────────────────────────
const rows = db.prepare(`
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
`).all();

const closeByKey = new Map();
for (const r of rows) closeByKey.set(r.asset + '|' + r.timestamp, r.close);

// trades[leafKey][expiry] = [{outcome, pl, hour, dir, asset}, ...]
const trades = {};
for (const L of LEAVES) { trades['L' + L.id] = {}; for (const e of EXPIRIES) trades['L' + L.id][e] = []; }
trades['COMBINED'] = {};
for (const e of EXPIRIES) trades['COMBINED'][e] = [];

const csvHeader = [
  'timestamp_utc', 'asset', 'leaf_id', 'direction', 'wr_reported', 'n_reported',
  'open', 'high', 'low', 'close',
  'rsi_5', 'stoch_k_v2', 'stoch_d_v2',
  'bb_upper', 'bb_middle', 'bb_lower', 'bb_width_bps',
  'ma6', 'ma14', 'ma_trend_bps',
  'close_to_lower', 'close_to_upper',
  'schaff_value', 'stc_zone',
  'bb_position', 'stc_stoch_diff', 'stoch_kd_diff',
];
for (const e of EXPIRIES) csvHeader.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);
const csvLines = [csvHeader.join(',')];
const fmtCsv = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
  return String(v);
};

for (const r of rows) {
  const f = computeFeatures(r);
  const hour = new Date(r.timestamp * 1000).getUTCHours();
  let firstFired = null;

  for (const L of LEAVES) {
    if (!L.test(f)) continue;
    if (!firstFired) firstFired = L;

    const stcZone = f.stc == null ? '' :
      (f.stc < 25 ? 'oversold' : f.stc > 75 ? 'overbought' : 'neutral');

    const csvRow = [
      new Date(r.timestamp * 1000).toISOString(), r.asset, L.id, L.dir, L.wr_reported, L.n_reported,
      r.open, r.high, r.low, r.close,
      r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2,
      r.bb_upper, r.bb_middle, r.bb_lower, f.bb_width_bps,
      r.ma1, r.ma3, f.ma_trend_bps,
      f.close_to_lower, f.close_to_upper,
      r.schaff_value, stcZone,
      f.bb_position, f.stc_stoch_diff, f.stoch_kd_diff,
    ];

    for (const e of EXPIRIES) {
      const exit = closeByKey.get(r.asset + '|' + (r.timestamp + e * 60));
      if (exit == null) { csvRow.push('', '', ''); continue; }
      const win = L.dir === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      trades['L' + L.id][e].push({ outcome: win ? 'WIN' : 'LOSS', pl, hour, dir: L.dir, asset: r.asset });
      csvRow.push(exit, pl, win ? 1 : 0);
    }
    csvLines.push(csvRow.map(fmtCsv).join(','));
  }

  if (firstFired) {
    for (const e of EXPIRIES) {
      const exit = closeByKey.get(r.asset + '|' + (r.timestamp + e * 60));
      if (exit == null) continue;
      const win = firstFired.dir === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      trades['COMBINED'][e].push({ outcome: win ? 'WIN' : 'LOSS', pl, hour, dir: firstFired.dir, asset: r.asset });
    }
  }
}

function fmt(arr) {
  const n = arr.length;
  const w = arr.filter(x => x.outcome === 'WIN').length;
  const pl = arr.reduce((s, x) => s + x.pl, 0);
  const wr = n ? (100 * w / n).toFixed(1) : '-';
  return { n, wr, pl };
}

const ver = dbPath.split(/[\\/]/).pop();
console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  LEAF SWEEP  |  ${ver.padEnd(50)}║`);
console.log(`║  10 leaves (WR≥60%) from ML_REPORT_LEAF_PATTERN  |  payout=${PAYOUT}        ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

const ALL_KEYS = [...LEAVES.map(L => 'L' + L.id), 'COMBINED'];

console.log('── LEAF × EXPIRY  (n / WR% / $P&L) ─────────────────────────────────');
const hdr = 'Leaf'.padEnd(10) + EXPIRIES.map(e => (e + 'm').padStart(20)).join('');
console.log(hdr);
console.log('-'.repeat(hdr.length));
for (const key of ALL_KEYS) {
  let line = key.padEnd(10);
  for (const e of EXPIRIES) {
    const f = fmt(trades[key][e]);
    line += `n=${f.n} ${f.wr}% $${f.pl}`.padStart(20);
  }
  console.log(line);
}

// Claim vs Actual — the whole point of this script
console.log('\n── CLAIM vs ACTUAL (at 2m expiry) ──────────────────────────────────');
console.log('Leaf   Dir    claimed_WR  actual_WR   n     Δ(pp)');
console.log('-'.repeat(56));
for (const L of LEAVES) {
  const f = fmt(trades['L' + L.id][2]);
  const claimed = (L.wr_reported * 100).toFixed(1);
  const delta = f.n > 0 ? (parseFloat(f.wr) - L.wr_reported * 100).toFixed(1) : '-';
  console.log(`L${String(L.id).padEnd(4)} ${L.dir.padEnd(6)} ${claimed.padStart(7)}%    ${String(f.wr).padStart(5)}%   ${String(f.n).padEnd(5)} ${String(delta).padStart(6)}`);
}

console.log('\n── DIRECTIONAL BREAKDOWN (at best expiry per leaf) ─────────────────');
for (const key of ALL_KEYS) {
  let best = null;
  for (const e of EXPIRIES) {
    const f = fmt(trades[key][e]);
    if (f.n === 0) continue;
    if (!best || f.pl > best.pl) best = { e, f };
  }
  if (!best) { console.log(key.padEnd(10) + '  (no signals)'); continue; }
  const arr = trades[key][best.e];
  const c = fmt(arr.filter(x => x.dir === 'CALL'));
  const p = fmt(arr.filter(x => x.dir === 'PUT'));
  console.log(`${key.padEnd(10)} best=${best.e}m  CALL n=${c.n} ${c.wr}% $${c.pl}   PUT n=${p.n} ${p.wr}% $${p.pl}`);
}

// Hour-of-day for COMBINED @ 2m
console.log('\n── HOUR-OF-DAY (COMBINED @ 2m) ─────────────────────────────────────');
{
  const byHour = {};
  for (const t of trades['COMBINED'][2]) (byHour[t.hour] ??= []).push(t);
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  for (const h of hours) {
    const f = fmt(byHour[h]);
    console.log(`  UTC ${String(h).padStart(2)}:00   n=${String(f.n).padEnd(4)} WR=${f.wr}%   $${f.pl}`);
  }
}

// Top assets COMBINED @ 2m (n>=5)
console.log('\n── TOP 10 ASSETS (COMBINED @ 2m, n≥5) ──────────────────────────────');
{
  const byAsset = {};
  for (const t of trades['COMBINED'][2]) (byAsset[t.asset] ??= []).push(t);
  const ranked = Object.entries(byAsset).map(([a, arr]) => ({ a, ...fmt(arr) }))
    .filter(x => x.n >= 5).sort((x, y) => y.pl - x.pl).slice(0, 10);
  for (const x of ranked) {
    console.log(`  ${x.a.padEnd(18)} n=${String(x.n).padEnd(4)} WR=${x.wr}%   $${x.pl}`);
  }
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });
fs.writeFileSync(outCsv, csvLines.join('\n') + '\n');
console.log(`\nCSV: wrote ${csvLines.length - 1} leaf-firings → ${outCsv}\n`);
