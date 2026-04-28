// edge_verify_db.cjs — ML edge verification against SQLite DB (mirrors paper_reversal_leaves.cjs)
// Usage:
//   Single DB:  node scripts/edge_verify_db.cjs [dbPath]
//   All DBs:    node scripts/edge_verify_db.cjs --all
//   Analysis:   node scripts/edge_verify_db.cjs --analyze [EdgeID] --feature [name] --bins [n]
//   Assets:     node scripts/edge_verify_db.cjs --analyze [EdgeID] --asset-breakdown
const Database = require('better-sqlite3');

const ALL_DBS = [
  'data/trading_data_v1.db',
  'data/trading_data_v2_13-15.db',
  'data/trading_data_V3_16.db',
  'data/trading_data_V3_17.db',
  'data/trading_data_V4_17.db',
  'data/trading_data-V4_18.db',
  'data/trading_data_V4_21.db',
  'data/trading_data.db',
];

const args = process.argv.slice(2);
const runAll = args.includes('--all');
const analyzeId = args.includes('--analyze') ? args[args.indexOf('--analyze') + 1] : null;
const featureName = args.includes('--feature') ? args[args.indexOf('--feature') + 1] : null;
// Support both --bins and --buckets
const binCountArg = args.includes('--bins') ? '--bins' : (args.includes('--buckets') ? '--buckets' : null);
const binCount = binCountArg ? parseInt(args[args.indexOf(binCountArg) + 1]) : 10;
const minN = args.includes('--min-n') ? parseInt(args[args.indexOf('--min-n') + 1]) : 0;
const assetBreakdown = args.includes('--asset-breakdown');

const dbPaths = runAll || analyzeId ? ALL_DBS : [args[0] || 'data/trading_data.db'];

const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRY = 2; // minutes

// ── Feature computation (identical to paper_reversal_leaves.cjs) ─────────────
function computeFeatures(r) {
  const bbRange = r.bb_upper - r.bb_lower;
  const bbPosition = bbRange > 0 ? (r.close - r.bb_lower) / bbRange : null;
  const closToLowerBps = r.bb_middle ? (r.close - r.bb_lower) / r.bb_middle * 10000 : null;
  const closeToUpperBps = r.bb_middle ? (r.bb_upper - r.close) / r.bb_middle * 10000 : null;
  const bbWidthBps = r.bb_middle ? (r.bb_upper - r.bb_lower) / r.bb_middle * 10000 : null;
  const stochKdDiff = (r.stochastic_k_v2 != null && r.stochastic_d_v2 != null)
    ? r.stochastic_k_v2 - r.stochastic_d_v2 : null;
  const stcStochDiff = (r.schaff_value != null && r.stochastic_k_v2 != null)
    ? r.schaff_value - r.stochastic_k_v2 : null;
  return {
    bbPosition, 
    closToLowerBps, 
    closeToUpperBps, 
    bbWidthBps,
    stochK: r.stochastic_k_v2,
    stochD: r.stochastic_d_v2,
    stochKdDiff, 
    stcStochDiff,
    schaffVal: r.schaff_value,
    rsi: r.rsi_5,
  };
}

// ── 7 ML edges (exact bot variable names, from ML_REPORT_EDGE.MD) ─────────────
const EDGES = [
  {
    id: 'E01', dir: 'PUT', wr_reported: 78.8, n_reported: 52,
    desc: 'K>D divergence + STC rolled over',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochD != null && f.stochD <= 60.3319 &&
      f.stochKdDiff != null && f.stochKdDiff > 27.1774 &&
      f.stcStochDiff != null && f.stcStochDiff <= -75.6442,
  },
  {
    id: 'E02', dir: 'PUT', wr_reported: 73.3, n_reported: 86,
    desc: 'Price pressing upper BB, high stochK (overbought squeeze)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK > 18.6691 &&
      f.bbPosition > 0.4270 &&
      f.closeToUpperBps != null && f.closeToUpperBps <= 4.0924 &&
      f.closToLowerBps != null && f.closToLowerBps > 0.9207,
  },
  {
    id: 'E03', dir: 'CALL', wr_reported: 71.7, n_reported: 53,
    desc: 'Deep oversold, wide upper room, low schaff',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK <= 18.6691 &&
      f.stcStochDiff != null && f.stcStochDiff <= 84.9062 &&
      f.closeToUpperBps != null && f.closeToUpperBps > 45.7296 &&
      f.closToLowerBps != null && f.closToLowerBps > -10.0033 &&
      f.schaffVal != null && f.schaffVal <= 9.3245,
  },
  {
    id: 'E04', dir: 'PUT', wr_reported: 69.8, n_reported: 63,
    desc: 'Extreme STC-Stoch divergence, low stochK',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK <= 18.6691 &&
      f.stcStochDiff != null && f.stcStochDiff > 84.9062 &&
      f.stochKdDiff != null && f.stochKdDiff > -22.0563,
  },
  {
    id: 'E05', dir: 'PUT', wr_reported: 68.2, n_reported: 66,
    desc: 'Narrow BB squeeze, price upper third, high stochD',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.schaffVal != null && f.schaffVal > 0.0194 &&
      f.bbPosition > 0.6483 &&
      f.stochD != null && f.stochD > 35.2926 &&
      f.bbWidthBps != null && f.bbWidthBps <= 12.2417,
  },
  {
    id: 'E06', dir: 'PUT', wr_reported: 67.3, n_reported: 55,
    desc: 'Mid-band, large lower gap, schaff active',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.schaffVal != null && f.schaffVal > 0.0194 &&
      f.bbPosition <= 0.6277 &&
      f.rsi != null && f.rsi <= 79.9055 &&
      f.closToLowerBps != null && f.closToLowerBps > 63.2778,
  },
  {
    id: 'E07', dir: 'PUT', wr_reported: 66.0, n_reported: 47,
    desc: 'E02 refined: 1.5-4.1 bps corridor below upper BB (B-only validated)',
    fn: (f) =>
      f.bbPosition != null && f.bbPosition > -0.1509 &&
      f.stochK != null && f.stochK > 18.6691 &&
      f.bbPosition > 0.4270 &&
      f.closeToUpperBps != null && f.closeToUpperBps <= 4.0924 &&
      f.closToLowerBps != null && f.closToLowerBps > 0.9207 &&
      f.closeToUpperBps > 1.4769,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function stat(arr) {
  const n = arr.length;
  const w = arr.filter(x => x.win).length;
  const pl = arr.reduce((s, x) => s + x.pl, 0);
  const wr = n ? (100 * w / n).toFixed(1) : '-';
  const bep = n === 0 ? ' ' : parseFloat(wr) >= 57 ? '✓' : parseFloat(wr) >= 52.1 ? '~' : '✗';
  return { n, w, wr, pl: pl.toFixed(0), bep };
}

const SQL = `
  SELECT i.asset, i.timestamp,
         c.open, c.close, c.high, c.low,
         i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
         i.bb_upper, i.bb_middle, i.bb_lower,
         i.ma1, i.ma3,
         i.schaff_value,
         strftime('%Y-%m-%d', datetime(i.timestamp, 'unixepoch')) as date,
         strftime('%H', datetime(i.timestamp, 'unixepoch')) as hour
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_5 IS NOT NULL AND i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper IS NOT NULL AND i.bb_middle IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`;

// ── Global accumulators (across all DBs) ──────────────────────────────────────
const globalTrades = {};
for (const e of EDGES) globalTrades[e.id] = [];

// ── Per-DB run ────────────────────────────────────────────────────────────────
for (const dbPath of dbPaths) {
  const dbFile = dbPath.split(/[\\/]/).pop();
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    if (!analyzeId) console.error(`⚠️ Could not open ${dbPath}: ${err.message}`);
    continue;
  }
  
  const rows = db.prepare(SQL).all();
  db.close();

  const closeByKey = new Map();
  for (const r of rows) closeByKey.set(r.asset + '|' + r.timestamp, r.close);

  for (const r of rows) {
    const f = computeFeatures(r);
    const exitClose = closeByKey.get(r.asset + '|' + (r.timestamp + EXPIRY * 60));
    if (exitClose == null) continue;

    for (const e of EDGES) {
      if (!e.fn(f)) continue;
      const win = e.dir === 'CALL' ? exitClose > r.close : exitClose < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      const rec = { 
        win, 
        pl, 
        date: r.date,
        hour: parseInt(r.hour), 
        asset: r.asset,
        features: f
      };
      globalTrades[e.id].push({ ...rec, db: dbFile });
    }
  }

  if (!analyzeId) {
    const dbTrades = {};
    for (const e of EDGES) {
        dbTrades[e.id] = globalTrades[e.id].filter(t => t.db === dbFile);
    }
    // ── Per-DB output ──────────────────────────────────────────────────────────
    console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  ML EDGE VERIFY  |  ${dbFile.padEnd(48)}║`);
    console.log(`╚══════════════════════════════════════════════════════════════════════╝`);
    console.log('  Live BEP ~57%. ✓=≥57% ~=52-57% ✗=<52%\n');
    console.log('  Edge   Dir   Reported    n       WR        P&L');
    console.log('  ' + '─'.repeat(55));
    for (const e of EDGES) {
        const s = stat(dbTrades[e.id]);
        console.log('  ' +
        e.id.padEnd(7) + e.dir.padEnd(6) +
        (e.wr_reported + '%').padEnd(12) +
        String(s.n).padEnd(8) + (s.wr + '%').padEnd(10) +
        '$' + s.pl + '  ' + s.bep);
    }
  }
}

if (analyzeId) {
    const edge = EDGES.find(e => e.id === analyzeId);
    const trades = globalTrades[analyzeId];
    console.log(`\n═══ ANALYSIS FOR ${analyzeId} (${edge.dir}) ═══`);
    console.log(`Total n: ${trades.length}, Overall WR: ${stat(trades).wr}%`);

    if (featureName && trades.length > 0) {
        // Map common aliases to internal feature names
        const featureMap = {
            'close_to_upper': 'closeToUpperBps',
            'stc_stoch_diff': 'stcStochDiff'
        };
        const internalName = featureMap[featureName] || featureName;

        console.log(`\nFeature Analysis: ${featureName} (bins: ${binCount})`);
        const values = trades.map(t => t.features[internalName]).filter(v => v != null);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min;
        const binSize = range / binCount;

        const bins = Array.from({ length: binCount }, (_, i) => ({
            min: min + i * binSize,
            max: min + (i + 1) * binSize,
            trades: []
        }));

        for (const t of trades) {
            const val = t.features[internalName];
            if (val == null) continue;
            const idx = Math.min(binCount - 1, Math.floor((val - min) / binSize));
            if (idx >= 0) bins[idx].trades.push(t);
        }

        console.log('  Range'.padEnd(20) + 'n'.padEnd(8) + 'WR'.padEnd(10) + 'P&L');
        console.log('  ' + '─'.repeat(45));
        for (const b of bins) {
            const s = stat(b.trades);
            const rangeStr = `${b.min.toFixed(2)} to ${b.max.toFixed(2)}`;
            console.log('  ' + rangeStr.padEnd(20) + String(s.n).padEnd(8) + (s.wr + '%').padEnd(10) + '$' + s.pl + ' ' + s.bep);
        }
    }

    if (assetBreakdown && trades.length > 0) {
        console.log(`\nAsset Breakdown (min-n: ${minN}):`);
        const byAsset = {};
        trades.forEach(t => { (byAsset[t.asset] = byAsset[t.asset] || []).push(t); });
        const results = Object.entries(byAsset)
            .filter(([, arr]) => arr.length >= minN)
            .map(([a, arr]) => ({ a, ...stat(arr) }))
            .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));

        console.log('  Asset'.padEnd(20) + 'n'.padEnd(8) + 'WR'.padEnd(10) + 'P&L');
        console.log('  ' + '─'.repeat(45));
        for (const r of results) {
            console.log('  ' + r.a.padEnd(20) + String(r.n).padEnd(8) + (r.wr + '%').padEnd(10) + '$' + r.pl + ' ' + r.bep);
        }
    }
    process.exit(0);
}

// ── Aggregate: all DBs combined ───────────────────────────────────────────────
console.log('\n' + '═'.repeat(72));
console.log('  AGGREGATE — ALL DBs COMBINED');
console.log('═'.repeat(72));
console.log('\n  Edge   Dir   Reported    n       WR        P&L');
console.log('  ' + '─'.repeat(55));
for (const e of EDGES) {
  const s = stat(globalTrades[e.id]);
  console.log('  ' +
    e.id.padEnd(7) + e.dir.padEnd(6) +
    (e.wr_reported + '%').padEnd(12) +
    String(s.n).padEnd(8) + (s.wr + '%').padEnd(10) +
    '$' + s.pl + '  ' + s.bep);
}

// ── Per-edge detail ───────────────────────────────────────────────────────────
console.log('\n── EDGE DETAIL: Date / Hour / Asset breakdown ───────────────────────');
for (const e of EDGES) {
  const all = globalTrades[e.id];
  const s = stat(all);
  console.log('\n  ' + e.id + ' ' + e.dir + ' — ' + e.desc);
  console.log('  Combined: n=' + s.n + ' WR=' + s.wr + '% P&L=$' + s.pl + ' ' + s.bep);
  if (s.n === 0) continue;

  // Per DB breakdown
  const dbs = [...new Set(all.map(x => x.db))].sort();
  const dbLine = dbs.map(db => {
    const arr = all.filter(x => x.db === db);
    const st = stat(arr);
    return db.replace('trading_data', '').replace('.db', '') + ':' + st.wr + '%(n=' + st.n + ')' + st.bep;
  }).join('  ');
  console.log('  DBs: ' + dbLine);

  // Date breakdown (top 7 by date DESC)
  const byDate = {};
  all.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
  const topDates = Object.keys(byDate).sort((a,b) => b.localeCompare(a))
    .slice(0, 7)
    .map(d => {
      const st = stat(byDate[d]);
      return d + ':' + st.wr + '%(n=' + st.n + ')' + st.bep;
    }).join('  ');
  console.log('  Dates: ' + topDates);

  // Hour breakdown (min 2 signals)
  const byHour = {};
  all.forEach(r => { (byHour[r.hour] = byHour[r.hour] || []).push(r); });
  const hourStr = Object.keys(byHour).map(Number).sort((a, b) => a - b)
    .filter(h => byHour[h].length >= 2)
    .map(h => {
      const st = stat(byHour[h]);
      return 'UTC' + h + ':' + st.wr + '%(n=' + st.n + ')';
    }).join('  ');
  console.log('  Hours: ' + (hourStr || 'insufficient data per hour'));

  // Top assets (min 3)
  const byAsset = {};
  all.forEach(r => { (byAsset[r.asset] = byAsset[r.asset] || []).push(r); });
  const topAssets = Object.entries(byAsset)
    .filter(([, arr]) => arr.length >= 3)
    .map(([a, arr]) => ({ a, ...stat(arr) }))
    .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr))
    .slice(0, 5)
    .map(r => r.a + ' ' + r.wr + '%(n=' + r.n + ')');
  console.log('  Top assets: ' + (topAssets.join('  ') || 'none with n≥3'));
}

// ── Summary verdict ───────────────────────────────────────────────────────────
console.log('\n── SUMMARY: DEPLOY / MARGINAL / REJECT ──────────────────────────────────');
for (const e of EDGES) {
  const s = stat(globalTrades[e.id]);
  if (s.n === 0) {
    console.log('  ' + e.id + ' ' + e.dir + ': NO SIGNALS — conditions never met in any DB');
    continue;
  }
  const verdict = parseFloat(s.wr) >= 57 ? 'DEPLOY' : parseFloat(s.wr) >= 52.1 ? 'MARGINAL' : 'REJECT';
  const note = e.id === 'E07' ? ' (B-only validated — treat as provisional)' : '';
  console.log('  ' + e.id + ' ' + e.dir + ': n=' + s.n + ' WR=' + s.wr + '% P&L=$' + s.pl + ' → ' + verdict + note);
}
console.log('');
