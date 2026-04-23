// Paper-trading reversal CSV: one row per signal-firing candle, pulled from
// the pre-computed `indicators` table (stochastic_k_v2/d_v2 = 5,3,3).
// For each signal, walks forward 1/2/3/5/10 minutes and records exit+PnL.
// Usage: node scripts/paper_reversal_csv.cjs [dbPath] [outCsv]
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outPath = process.argv[3] || 'data/paper_reversal_today.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 5, 10]; // minutes = bars (1-min candles)

const RSI_OS = 30, RSI_OB = 70;
const K_OS = 20, K_OB = 80;

const SIG_DEFS = [
  { key: 'RSI', call: (c) => c.rsi < RSI_OS, put: (c) => c.rsi > RSI_OB },
  { key: 'Stoch', call: (c) => c.k < K_OS, put: (c) => c.k > K_OB },
  { key: 'BB', call: (c) => c.close <= c.bbL, put: (c) => c.close >= c.bbU },
  { key: 'RSI+Stoch', call: (c) => c.rsi < RSI_OS && c.k < K_OS, put: (c) => c.rsi > RSI_OB && c.k > K_OB },
  { key: 'RSI+BB', call: (c) => c.rsi < RSI_OS && c.close <= c.bbL, put: (c) => c.rsi > RSI_OB && c.close >= c.bbU },
  { key: 'Stoch+BB', call: (c) => c.k < K_OS && c.close <= c.bbL, put: (c) => c.k > K_OB && c.close >= c.bbU },
  { key: 'RSI+Stoch+BB', call: (c) => c.rsi < RSI_OS && c.k < K_OS && c.close <= c.bbL, put: (c) => c.rsi > RSI_OB && c.k > K_OB && c.close >= c.bbU },
];

// Join indicators + candles by (asset, timestamp). Pull everything in one query.
const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.ma1, i.ma3
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_5 IS NOT NULL
    AND i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`).all();

// Index close prices by (asset, timestamp) so we can look up expiry exits.
const closeByKey = new Map();
for (const r of rows) closeByKey.set(r.asset + '|' + r.timestamp, r.close);

const header = [
  'timestamp_utc', 'asset',
  'open', 'high', 'low', 'close',
  'rsi_5', 'stoch_k_v2', 'stoch_d_v2',
  'bb_upper', 'bb_middle', 'bb_lower', 'bb_width_bps',
  'ma6', 'ma14', 'ma_trend_bps',
  'signal', 'direction',
];
for (const e of EXPIRIES) header.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);

const lines = [header.join(',')];
let sigCount = 0;

const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
  return String(v);
};

for (const r of rows) {
  const ctx = {
    rsi: r.rsi_5,
    k: r.stochastic_k_v2,
    bbL: r.bb_lower,
    bbU: r.bb_upper,
    close: r.close,
  };

  for (const s of SIG_DEFS) {
    let dir = null;
    if (s.call(ctx)) dir = 'CALL';
    else if (s.put(ctx)) dir = 'PUT';
    if (!dir) continue;
    sigCount++;

    const bbWidthBps = r.bb_middle ? (r.bb_upper - r.bb_lower) / r.bb_middle * 10000 : '';
    const maTrendBps = (r.ma1 != null && r.ma3 != null && r.ma3) ? (r.ma1 - r.ma3) / r.ma3 * 10000 : '';

    const row = [
      new Date(r.timestamp * 1000).toISOString(),
      r.asset,
      r.open, r.high, r.low, r.close,
      r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2,
      r.bb_upper, r.bb_middle, r.bb_lower, bbWidthBps,
      r.ma1, r.ma3, maTrendBps,
      s.key, dir,
    ];
    for (const e of EXPIRIES) {
      const exitTs = r.timestamp + e * 60;
      const exit = closeByKey.get(r.asset + '|' + exitTs);
      if (exit == null) { row.push('', '', ''); continue; }
      const win = dir === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      row.push(exit, pl, win ? 1 : 0);
    }
    lines.push(row.map(fmt).join(','));
  }
}

fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} signal rows -> ${outPath}`);
console.log(`DB rows scanned: ${rows.length}, signals fired: ${sigCount}`);
