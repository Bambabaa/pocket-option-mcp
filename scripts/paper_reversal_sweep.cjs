// ML-filtered reversal sweep. Replaces raw RSI/Stoch/BB triple-confirm with
// Decision Tree leaves from docs/ML_REPORT.MD. Symmetric CALL/PUT per rule.
// Pulls indicators from the `indicators` table (stochastic_k_v2/d_v2 = 5,3,3).
// Usage: node scripts/paper_reversal_sweep.cjs [dbPath] [outCsv]
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outCsv = process.argv[3] || 'data/paper_reversal_ml.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 5];

// ── ML config (inline — mirrors docs/ML_REPORT.MD §5E) ───────────────────
const ML = {
  MA_TREND: 27.91,
  RSI_HIGH: 97.58,
  RSI_VERY_HIGH: 92.81,
  RSI_LOW: 2.42,         // mirror of RSI_HIGH
  RSI_VERY_LOW: 7.19,    // mirror of RSI_VERY_HIGH
  BB_WIDTH_NARROW: 68.48,
  BB_WIDTH_VERY_NARROW: 47.87,
  CLOSE_TO_UPPER: -3.29,
  CLOSE_TO_LOWER: -1.13,
  STOCH_K_LOW: 9.72,
  STOCH_K_HIGH: 90.28,
  // STC filters per docs/ML_REPORT_STC.MD §2
  STC_OVERSOLD: 25,   // DeepExtreme CALL only fires when schaff_value < 25
  STC_OVERBOUGHT: 75, // RsiVeryHighFlat PUT only fires when schaff_value > 75
};

// Feature engineering per ML_REPORT §5A (bps relative to BB middle).
function computeFeatures(r) {
  const close_to_lower = ((r.close - r.bb_lower) / r.bb_middle) * 10000;
  const close_to_upper = ((r.bb_upper - r.close) / r.bb_middle) * 10000;
  const bb_width_bps = ((r.bb_upper - r.bb_lower) / r.bb_middle) * 10000;
  const ma_trend_bps = (r.ma1 != null && r.ma3 != null && r.ma3)
    ? ((r.ma1 - r.ma3) / r.ma3) * 10000 : 0;
  return {
    rsi: r.rsi_5,
    k: r.stochastic_k_v2,
    d: r.stochastic_d_v2,
    stc: r.schaff_value,      // may be null during STC warmup
    close_to_lower, close_to_upper,
    bb_width_bps, ma_trend_bps,
  };
}

// Decision Tree leaves, symmetric. Each rule returns {dir, score} or null.
// PUT side = reflected thresholds (overbought mirrors oversold).
const RULES = [
  {
    key: 'DeepExtreme',   // Leaf 6 / mirror — strongest signal (85.3% WR reported)
    test: (f) => {
      // CALL branch: require STC oversold confirmation (STC_REPORT §7: 66.2% WR, +11.9pp edge)
      if (f.close_to_lower <= ML.CLOSE_TO_LOWER && f.k <= ML.STOCH_K_LOW) {
        if (f.stc == null || f.stc >= ML.STC_OVERSOLD) return null;
        return { dir: 'CALL', score: 0.85 };
      }
      // PUT branch: require STC neutral zone (STC_REPORT2 §4: 60% WR n=30)
      if (f.close_to_upper <= ML.CLOSE_TO_LOWER && f.k >= ML.STOCH_K_HIGH) {
        if (f.stc == null || f.stc < ML.STC_OVERSOLD || f.stc > ML.STC_OVERBOUGHT) return null;
        return { dir: 'PUT', score: 0.85 };
      }
      return null;
    },
  },
  {
    key: 'RsiExtremeNarrowBB',  // Leaf 33 / mirror — 82.6% WR reported
    test: (f) => {
      // PUT branch: require STC overbought (STC_REPORT2 §10 rank 5: 57.1% WR n=156)
      if (f.rsi > ML.RSI_HIGH && f.bb_width_bps <= ML.BB_WIDTH_VERY_NARROW && f.close_to_upper > ML.CLOSE_TO_UPPER) {
        if (f.stc == null || f.stc <= ML.STC_OVERBOUGHT) return null;
        return { dir: 'PUT', score: 0.83 };
      }
      // CALL branch: require STC neutral zone (STC_REPORT2 §10 rank 4: 58.0% WR n=69)
      if (f.rsi < ML.RSI_LOW && f.bb_width_bps <= ML.BB_WIDTH_VERY_NARROW && f.close_to_lower > ML.CLOSE_TO_UPPER) {
        if (f.stc == null || f.stc < ML.STC_OVERSOLD || f.stc > ML.STC_OVERBOUGHT) return null;
        return { dir: 'CALL', score: 0.83 };
      }
      return null;
    },
  },
  {
    key: 'RsiVeryHighFlat',     // Leaf 27 / mirror — 71.6% WR reported
    test: (f) => {
      // PUT branch: require STC overbought confirmation (STC_REPORT §6 rank 3: 64.1% WR, +9.8pp edge)
      if (f.ma_trend_bps <= ML.MA_TREND && f.rsi > ML.RSI_VERY_HIGH && f.close_to_upper > ML.CLOSE_TO_UPPER && f.bb_width_bps <= ML.BB_WIDTH_NARROW) {
        if (f.stc == null || f.stc <= ML.STC_OVERBOUGHT) return null;
        return { dir: 'PUT', score: 0.72 };
      }
      if (f.ma_trend_bps >= -ML.MA_TREND && f.rsi < ML.RSI_VERY_LOW && f.close_to_lower > ML.CLOSE_TO_UPPER && f.bb_width_bps <= ML.BB_WIDTH_NARROW)
        return { dir: 'CALL', score: 0.72 };
      return null;
    },
  },
];

// ── Load rows (indicators JOIN candles) ─────────────────────────────────
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

// trades[ruleKey][expiry] = [{outcome, pl, hour, dir, asset}, ...]
const trades = {};
for (const r of RULES) { trades[r.key] = {}; for (const e of EXPIRIES) trades[r.key][e] = []; }
trades['COMBINED'] = {};
for (const e of EXPIRIES) trades['COMBINED'][e] = [];

// CSV: one row per (candle × rule) that fired. Includes features + per-expiry outcome.
const csvHeader = [
  'timestamp_utc', 'asset', 'rule', 'direction', 'score',
  'open', 'high', 'low', 'close',
  'rsi_5', 'stoch_k_v2', 'stoch_d_v2',
  'bb_upper', 'bb_middle', 'bb_lower', 'bb_width_bps',
  'ma6', 'ma14', 'ma_trend_bps',
  'close_to_lower', 'close_to_upper',
  'schaff_value', 'stc_zone',
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
  let firedAny = null;

  for (const rule of RULES) {
    const hit = rule.test(f);
    if (!hit) continue;
    if (!firedAny) firedAny = hit;  // first-match for COMBINED

    const csvRow = [
      new Date(r.timestamp * 1000).toISOString(), r.asset, rule.key, hit.dir, hit.score,
      r.open, r.high, r.low, r.close,
      r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2,
      r.bb_upper, r.bb_middle, r.bb_lower, f.bb_width_bps,
      r.ma1, r.ma3, f.ma_trend_bps,
      f.close_to_lower, f.close_to_upper,
      r.schaff_value,
      r.schaff_value == null ? '' :
        (r.schaff_value < ML.STC_OVERSOLD ? 'oversold' :
         r.schaff_value > ML.STC_OVERBOUGHT ? 'overbought' : 'neutral'),
    ];

    for (const e of EXPIRIES) {
      const exit = closeByKey.get(r.asset + '|' + (r.timestamp + e * 60));
      if (exit == null) { csvRow.push('', '', ''); continue; }
      const win = hit.dir === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      trades[rule.key][e].push({ outcome: win ? 'WIN' : 'LOSS', pl, hour, dir: hit.dir, asset: r.asset });
      csvRow.push(exit, pl, win ? 1 : 0);
    }
    csvLines.push(csvRow.map(fmtCsv).join(','));
  }

  if (firedAny) {
    for (const e of EXPIRIES) {
      const exit = closeByKey.get(r.asset + '|' + (r.timestamp + e * 60));
      if (exit == null) continue;
      const win = firedAny.dir === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      trades['COMBINED'][e].push({ outcome: win ? 'WIN' : 'LOSS', pl, hour, dir: firedAny.dir, asset: r.asset });
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
console.log(`║  ML REVERSAL SWEEP  |  ${ver.padEnd(43)}║`);
console.log(`║  Rules: Decision Tree leaves (ML_REPORT §2)  |  payout=${PAYOUT}, amt=$${AMOUNT}   ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

const ALL_KEYS = [...RULES.map(r => r.key), 'COMBINED'];

console.log('── RULE × EXPIRY  (n / WR% / $P&L) ─────────────────────────────────');
const hdr = 'Rule'.padEnd(22) + EXPIRIES.map(e => (e + 'm').padStart(20)).join('');
console.log(hdr);
console.log('-'.repeat(hdr.length));
for (const key of ALL_KEYS) {
  let line = key.padEnd(22);
  for (const e of EXPIRIES) {
    const f = fmt(trades[key][e]);
    line += `n=${f.n} ${f.wr}% $${f.pl}`.padStart(20);
  }
  console.log(line);
}

console.log('\n── DIRECTIONAL BREAKDOWN (at best expiry per rule) ────────────────');
for (const key of ALL_KEYS) {
  let best = null;
  for (const e of EXPIRIES) {
    const f = fmt(trades[key][e]);
    if (f.n === 0) continue;
    if (!best || f.pl > best.pl) best = { e, f };
  }
  if (!best) { console.log(key.padEnd(22) + '  (no signals)'); continue; }
  const arr = trades[key][best.e];
  const c = fmt(arr.filter(x => x.dir === 'CALL'));
  const p = fmt(arr.filter(x => x.dir === 'PUT'));
  console.log(`${key.padEnd(22)} best=${best.e}m  CALL n=${c.n} ${c.wr}% $${c.pl}   PUT n=${p.n} ${p.wr}% $${p.pl}`);
}

console.log('\n── HOUR-OF-DAY (best P&L rule, best expiry) ────────────────────────');
let topKey = null, topE = null, topPl = -Infinity;
for (const key of ALL_KEYS) for (const e of EXPIRIES) {
  const f = fmt(trades[key][e]);
  if (f.pl > topPl) { topPl = f.pl; topKey = key; topE = e; }
}
if (topKey) {
  console.log(`Top: ${topKey} @ ${topE}m  (total $${topPl})`);
  const byHour = {};
  for (const t of trades[topKey][topE]) (byHour[t.hour] ??= []).push(t);
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  for (const h of hours) {
    const f = fmt(byHour[h]);
    console.log(`  UTC ${String(h).padStart(2)}:00   n=${String(f.n).padEnd(4)} WR=${f.wr}%   $${f.pl}`);
  }

  console.log('\n── TOP 10 ASSETS (best rule @ best expiry) ─────────────────────────');
  const byAsset = {};
  for (const t of trades[topKey][topE]) (byAsset[t.asset] ??= []).push(t);
  const ranked = Object.entries(byAsset).map(([a, arr]) => ({ a, ...fmt(arr) }))
    .filter(x => x.n >= 5)
    .sort((x, y) => y.pl - x.pl)
    .slice(0, 10);
  for (const x of ranked) {
    console.log(`  ${x.a.padEnd(18)} n=${String(x.n).padEnd(4)} WR=${x.wr}%   $${x.pl}`);
  }
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });
fs.writeFileSync(outCsv, csvLines.join('\n') + '\n');
console.log(`\nCSV: wrote ${csvLines.length - 1} rule-firings → ${outCsv}\n`);
