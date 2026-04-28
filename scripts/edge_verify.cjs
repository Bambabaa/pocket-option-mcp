// edge_verify.cjs — Standalone ML edge verification against paper CSV datasets
// Usage: node scripts/edge_verify.cjs
// Reads Dataset A (paper_reversal_leaves_all_V1.csv) and Dataset B (paper_reversal_leaves_live_v2.csv)
// Evaluates all 7 ML edges, reports n/WR/P&L per edge per dataset + combined

const fs = require('fs');

function loadCsv(path) {
  const lines = fs.readFileSync(path, 'utf8').replace(/\r/g, '').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i]);
    return obj;
  });
}

const A = loadCsv('data/paper_reversal_leaves_all_V1.csv');
const B = loadCsv('data/paper_reversal_leaves_live_v2.csv');
const ALL = [...A.map(r => ({ ...r, _ds: 'A' })), ...B.map(r => ({ ...r, _ds: 'B' }))];

console.log('Dataset A:', A.length, 'rows');
console.log('Dataset B:', B.length, 'rows');
console.log('Combined: ', ALL.length, 'rows');

// ── Feature extraction ────────────────────────────────────────────────────────
// All features already computed in CSV — we re-engineer them here for verification
// and to catch any definition mismatches vs what indicators.js would compute

function features(r) {
  const close      = parseFloat(r.close);
  const bbUpper    = parseFloat(r.bb_upper);
  const bbLower    = parseFloat(r.bb_lower);
  const bbMiddle   = parseFloat(r.bb_middle);
  const bbRange    = bbUpper - bbLower;

  // bb_position = (close - bb_lower) / (bb_upper - bb_lower)
  const bbPosition = bbRange > 0 ? (close - bbLower) / bbRange : null;

  // close_to_lower = (close - bb_lower) / bb_middle * 10000  [bps]
  const closToLowerBps = bbMiddle ? (close - bbLower) / bbMiddle * 10000 : null;

  // close_to_upper = (bb_upper - close) / bb_middle * 10000  [bps]
  const closeToUpperBps = bbMiddle ? (bbUpper - close) / bbMiddle * 10000 : null;

  const stochK     = r.stoch_k_v2 !== '' ? parseFloat(r.stoch_k_v2) : null;
  const stochD     = r.stoch_d_v2 !== '' ? parseFloat(r.stoch_d_v2) : null;

  // stoch_kd_diff = stochK - stochD
  const stochKdDiff = stochK != null && stochD != null ? stochK - stochD : null;

  const schaffVal  = r.schaff_value !== '' ? parseFloat(r.schaff_value) : null;

  // stc_stoch_diff = schaff_value - stochK
  const stcStochDiff = schaffVal != null && stochK != null ? schaffVal - stochK : null;

  const rsi        = r.rsi_5 !== '' ? parseFloat(r.rsi_5) : null;
  const bbWidthBps = r.bb_width_bps !== '' ? parseFloat(r.bb_width_bps) : null;
  const maTrendBps = r.ma_trend_bps !== '' ? parseFloat(r.ma_trend_bps) : null;

  // CSV also has pre-computed versions — compare for sanity
  const csv_bbPos       = r.bb_position !== '' ? parseFloat(r.bb_position) : null;
  const csv_closToLower = r.close_to_lower !== '' ? parseFloat(r.close_to_lower) : null;
  const csv_closToUpper = r.close_to_upper !== '' ? parseFloat(r.close_to_upper) : null;
  const csv_stcStochDiff= r.stc_stoch_diff !== '' ? parseFloat(r.stc_stoch_diff) : null;
  const csv_stochKdDiff = r.stoch_kd_diff !== '' ? parseFloat(r.stoch_kd_diff) : null;

  return {
    bbPosition, closToLowerBps, closeToUpperBps,
    stochK, stochD, stochKdDiff,
    schaffVal, stcStochDiff,
    rsi, bbWidthBps, maTrendBps,
    // CSV pre-computed (for cross-check)
    csv_bbPos, csv_closToLower, csv_closToUpper, csv_stcStochDiff, csv_stochKdDiff,
  };
}

// ── Sanity check: recomputed vs CSV pre-computed ─────────────────────────────
console.log('\n── FEATURE RECOMPUTATION SANITY CHECK (first 500 rows) ─────────────────');
let bbPosDiff = 0, closLowerDiff = 0, closUpperDiff = 0, stcDiff = 0, kdDiff = 0, checked = 0;
ALL.slice(0, 500).forEach(r => {
  const f = features(r);
  const tol = 0.001;
  if (f.bbPosition != null && f.csv_bbPos != null && Math.abs(f.bbPosition - f.csv_bbPos) > tol) bbPosDiff++;
  if (f.closToLowerBps != null && f.csv_closToLower != null && Math.abs(f.closToLowerBps - f.csv_closToLower) > tol) closLowerDiff++;
  if (f.closeToUpperBps != null && f.csv_closToUpper != null && Math.abs(f.closeToUpperBps - f.csv_closToUpper) > tol) closUpperDiff++;
  if (f.stcStochDiff != null && f.csv_stcStochDiff != null && Math.abs(f.stcStochDiff - f.csv_stcStochDiff) > tol) stcDiff++;
  if (f.stochKdDiff != null && f.csv_stochKdDiff != null && Math.abs(f.stochKdDiff - f.csv_stochKdDiff) > tol) kdDiff++;
  checked++;
});
console.log('  Rows checked:', checked);
console.log('  bb_position mismatches:    ', bbPosDiff);
console.log('  close_to_lower mismatches: ', closLowerDiff);
console.log('  close_to_upper mismatches: ', closUpperDiff);
console.log('  stc_stoch_diff mismatches: ', stcDiff);
console.log('  stoch_kd_diff mismatches:  ', kdDiff);
console.log('  (tolerance = 0.001 — small diffs expected from float precision)');

// ── Edge definitions ──────────────────────────────────────────────────────────
// Using RECOMPUTED features, not CSV pre-computed, to match what indicators.js will use

const EDGES = [
  {
    id: 'E01', dir: 'PUT', wr_reported: 78.8,
    desc: 'K>D divergence + STC rolled over (exhaustion reversal)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochD != null && f.stochD <= 60.3319 &&
      f.stochKdDiff != null && f.stochKdDiff > 27.1774 &&
      f.stcStochDiff != null && f.stcStochDiff <= -75.6442,
  },
  {
    id: 'E02', dir: 'PUT', wr_reported: 73.3,
    desc: 'Price pressing upper BB, high stochK (overbought squeeze)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK > 18.6691 &&
      f.bbPosition > 0.4270 &&
      f.closeToUpperBps != null && f.closeToUpperBps <= 4.0924 &&
      f.closToLowerBps != null && f.closToLowerBps > 0.9207,
  },
  {
    id: 'E03', dir: 'CALL', wr_reported: 71.7,
    desc: 'Deep oversold, wide upper room, low schaff (high-prob bounce)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK <= 18.6691 &&
      f.stcStochDiff != null && f.stcStochDiff <= 84.9062 &&
      f.closeToUpperBps != null && f.closeToUpperBps > 45.7296 &&
      f.closToLowerBps != null && f.closToLowerBps > -10.0033 &&
      f.schaffVal != null && f.schaffVal <= 9.3245,
  },
  {
    id: 'E04', dir: 'PUT', wr_reported: 69.8,
    desc: 'Extreme STC-Stoch divergence, low stochK (exhaustion top)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK <= 18.6691 &&
      f.stcStochDiff != null && f.stcStochDiff > 84.9062 &&
      f.stochKdDiff != null && f.stochKdDiff > -22.0563,
  },
  {
    id: 'E05', dir: 'PUT', wr_reported: 68.2,
    desc: 'Narrow BB squeeze, price upper third, high stochD (mean reversion)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.schaffVal != null && f.schaffVal > 0.0194 &&
      f.bbPosition > 0.6483 &&
      f.stochD != null && f.stochD > 35.2926 &&
      f.bbWidthBps != null && f.bbWidthBps <= 12.2417,
  },
  {
    id: 'E06', dir: 'PUT', wr_reported: 67.3,
    desc: 'Mid-band, large lower gap, schaff active (early exhaustion)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.schaffVal != null && f.schaffVal > 0.0194 &&
      f.bbPosition <= 0.6277 &&
      f.rsi != null && f.rsi <= 79.9055 &&
      f.closToLowerBps != null && f.closToLowerBps > 63.2778,
  },
  {
    id: 'E07', dir: 'PUT', wr_reported: 66.0,
    desc: 'E02 refined: price in 1.5–4.1 bps corridor below upper BB (B-only)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK > 18.6691 &&
      f.bbPosition > 0.4270 &&
      f.closeToUpperBps != null && f.closeToUpperBps <= 4.0924 &&
      f.closToLowerBps != null && f.closToLowerBps > 0.9207 &&
      f.closeToUpperBps > 1.4769,
  },
];

// ── Evaluation ────────────────────────────────────────────────────────────────
function evalEdge(rows, edgeFn) {
  const matched = rows.filter(r => {
    const f = features(r);
    return edgeFn(f);
  });
  const wins = matched.filter(r => r.win_2m === '1').length;
  const pl = matched.reduce((s, r) => s + parseFloat(r.pnl_2m || 0), 0);
  const n = matched.length;
  const wr = n ? (wins / n * 100).toFixed(1) : '-';
  return { n, wins, wr, pl: pl.toFixed(0) };
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n');
console.log('╔══════════════════════════════════════════════════════════════════════════════════════╗');
console.log('║  ML EDGE VERIFICATION — Dataset A vs B vs Combined                                  ║');
console.log('╚══════════════════════════════════════════════════════════════════════════════════════╝');
console.log('  Paper payout 92% ($460 win / -$500 loss). Break-even WR = 52.1%');
console.log('  Live BEP ~57% at avg payout 75%.');
console.log('');
console.log('  Edge  Dir   Reported    ── Dataset A ──────────────  ── Dataset B ──────────────  ── Combined ───────────────');
console.log('              WR          n      WR       P&L           n      WR       P&L           n      WR       P&L      ');
console.log('  ' + '─'.repeat(115));

EDGES.forEach(e => {
  const ra = evalEdge(A, e.fn);
  const rb = evalEdge(B, e.fn);
  const rc = evalEdge(ALL, e.fn);

  const fmt = (r) => String(r.n).padEnd(7) + (r.wr + '%').padEnd(9) + ('$' + r.pl).padEnd(14);
  const flag = (r) => parseFloat(r.wr) >= 57 ? '✓' : parseFloat(r.wr) >= 52.1 ? '~' : r.n === 0 ? ' ' : '✗';

  console.log('  ' +
    e.id.padEnd(6) +
    e.dir.padEnd(6) +
    (e.wr_reported + '%').padEnd(12) +
    fmt(ra) + flag(ra) + '   ' +
    fmt(rb) + flag(rb) + '   ' +
    fmt(rc) + flag(rc));
});

// ── Per-edge detail ───────────────────────────────────────────────────────────
console.log('\n\n── EDGE DETAIL: Hour / BB width / Asset breakdown ────────────────────────────────');

EDGES.forEach(e => {
  const matched = ALL.filter(r => e.fn(features(r)));
  if (matched.length === 0) {
    console.log('\n  ' + e.id + ': NO SIGNALS');
    return;
  }

  const stat = arr => {
    if (!arr.length) return 'n=0';
    const w = arr.filter(r => r.win_2m === '1').length;
    const pl = arr.reduce((s, r) => s + parseFloat(r.pnl_2m || 0), 0);
    return 'n=' + arr.length + ' WR=' + (w/arr.length*100).toFixed(0) + '% $' + pl.toFixed(0);
  };

  console.log('\n  ' + e.id + ' ' + e.dir + ' — ' + e.desc);

  // By dataset
  const mA = matched.filter(r => r._ds === 'A');
  const mB = matched.filter(r => r._ds === 'B');
  console.log('    Dataset A: ' + stat(mA) + '   Dataset B: ' + stat(mB));

  // By hour
  const byHour = {};
  matched.forEach(r => {
    const h = new Date(r.timestamp_utc).getUTCHours();
    if (!byHour[h]) byHour[h] = [];
    byHour[h].push(r);
  });
  const hourStr = Object.keys(byHour).map(Number).sort((a,b)=>a-b)
    .filter(h => byHour[h].length >= 2)
    .map(h => {
      const arr = byHour[h];
      const w = arr.filter(r => r.win_2m === '1').length;
      return 'UTC' + h + ':' + (w/arr.length*100).toFixed(0) + '%(n=' + arr.length + ')';
    }).join('  ');
  console.log('    Hours: ' + (hourStr || 'insufficient data'));

  // By BB width band
  const bands = [[0,20],[20,40],[40,60],[60,100],[100,999]];
  const bbStr = bands.map(([lo,hi]) => {
    const arr = matched.filter(r => {
      const bw = parseFloat(r.bb_width_bps);
      return bw >= lo && bw < hi;
    });
    if (!arr.length) return null;
    const w = arr.filter(r => r.win_2m === '1').length;
    return 'bbW[' + lo + ',' + hi + '):' + (w/arr.length*100).toFixed(0) + '%(n=' + arr.length + ')';
  }).filter(Boolean).join('  ');
  console.log('    BB width: ' + bbStr);

  // Top assets (min 3)
  const byAsset = {};
  matched.forEach(r => { if (!byAsset[r.asset]) byAsset[r.asset] = []; byAsset[r.asset].push(r); });
  const topAssets = Object.entries(byAsset)
    .filter(([,arr]) => arr.length >= 3)
    .map(([a, arr]) => {
      const w = arr.filter(r => r.win_2m === '1').length;
      return { a, wr: w/arr.length, n: arr.length };
    })
    .sort((a,b) => b.wr - a.wr)
    .slice(0, 5)
    .map(r => r.a + ' ' + (r.wr*100).toFixed(0) + '%(n=' + r.n + ')');
  console.log('    Top assets: ' + (topAssets.join('  ') || 'none with n>=3'));

  // Schaff zone breakdown for edges that use schaff
  if ([E01, E02, E03, E04, E05, E06, E07].indexOf(e) === -1) return;
  const zones = { null_empty:[], peg0:[], valid:[], peg100:[] };
  matched.forEach(r => {
    const sv = r.schaff_value;
    if (!sv || sv === '') zones.null_empty.push(r);
    else if (parseFloat(sv) <= 1) zones.peg0.push(r);
    else if (parseFloat(sv) >= 99) zones.peg100.push(r);
    else zones.valid.push(r);
  });
  const schaffStr = Object.entries(zones).filter(([,arr]) => arr.length > 0).map(([z,arr]) => {
    const w = arr.filter(r => r.win_2m === '1').length;
    return z + ':' + (w/arr.length*100).toFixed(0) + '%(n=' + arr.length + ')';
  }).join('  ');
  console.log('    Schaff zones: ' + schaffStr);
});

// ── Overlap analysis ──────────────────────────────────────────────────────────
console.log('\n\n── EDGE OVERLAP ANALYSIS ─────────────────────────────────────────────────────────');
console.log('  How many signals fire on multiple edges simultaneously?');
const overlapCounts = {};
ALL.forEach(r => {
  const fired = EDGES.filter(e => e.fn(features(r))).map(e => e.id);
  if (fired.length > 1) {
    const key = fired.join('+');
    overlapCounts[key] = (overlapCounts[key] || 0) + 1;
  }
});
if (Object.keys(overlapCounts).length === 0) {
  console.log('  No overlaps found.');
} else {
  Object.entries(overlapCounts).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log('  ' + k + ': ' + v + ' signals');
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n\n── SUMMARY: EDGES ABOVE LIVE BEP (57%) ON COMBINED ──────────────────────────────');
EDGES.forEach(e => {
  const rc = evalEdge(ALL, e.fn);
  if (rc.n === 0) {
    console.log('  ' + e.id + ': NO SIGNALS — conditions never met in combined dataset');
    return;
  }
  const verdict = parseFloat(rc.wr) >= 57 ? '✓ DEPLOY' : parseFloat(rc.wr) >= 52.1 ? '~ MARGINAL' : '✗ REJECT';
  console.log('  ' + e.id + ' ' + e.dir + ': n=' + rc.n + ' WR=' + rc.wr + '% P&L=$' + rc.pl + ' — ' + verdict);
});
console.log('');
