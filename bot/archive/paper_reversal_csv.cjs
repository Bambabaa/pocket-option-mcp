// Paper-trading reversal CSV: STC-based 7-gate reversal strategy
// Matches upgraded gates from src/core/analysis.js (tightened + retracement + trend filters)
// For each signal, walks forward 1/2/3/5/10 minutes and records exit+PnL.
// Usage: node scripts/paper_reversal_csv.cjs [dbPath] [outCsv]
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outPath = process.argv[3] || 'data/paper_reversal_today.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 4, 5]; // minutes = bars (1-min candles)

// ─── STC Reversal Gate Thresholds ────────────────────────────────────────────
const CALL_STC_FLOOR = 20;        // STC ≤ 20 (deeply oversold, tightened from 25)
const CALL_RSI_MAX = 20;          // RSI < 20 (deeply oversold, tightened from 30)
const CALL_K_MAX = 35;            // Stoch K < 35 (oversold zone, tightened from 50)
const CALL_RETRACEMENT_MIN = 15;  // Prior RSI trough < 15 (deep retracement validation)
const CALL_TREND_MIN = -20;       // MA6-MA14 gap > -20 bps (not strong downtrend)

const PUT_STC_CEILING = 75;       // STC ≥ 75 (deeply overbought)
const PUT_RSI_MIN = 70;           // RSI > 70 (overbought, tightened from 60)
const PUT_K_MIN = 65;             // Stoch K > 65 (overbought zone, tightened from 50)
const PUT_EXTENSION_MIN = 80;     // Prior RSI peak > 80 (deep extension validation)
const PUT_TREND_MAX = 20;         // MA6-MA14 gap < 20 bps (not strong uptrend)

const BB_WIDTH_MIN = 10;          // BB width ≥ 10 bps (volatility gate, validated)

const CALL_CCI_FLOOR = -100;      // CCI must cross back above -100 (G8)
const PUT_CCI_CEILING = 100;      // CCI must cross back below +100 (G8)

// ─── Signal Definitions (8-gate STC reversals with CCI crossover) ─────────────
const SIG_DEFS = [
  {
    key: 'STC_CALL_8G',
    call: (c, hist) => {
      if (c.stc == null || c.stcPrev == null) return false;
      if (c.cci == null || c.cciPrev == null) return false;
      const g1 = c.stc <= CALL_STC_FLOOR;
      const g2 = c.stc > c.stcPrev;
      // const g3 = c.rsi != null && c.rsi < CALL_RSI_MAX;
      const g4 = c.k != null && c.d != null && c.k > c.d && c.k < CALL_K_MAX;
      const g5 = c.bbWidthBps != null && c.bbWidthBps >= BB_WIDTH_MIN;
      const g6 = hist.rsiTrough10 != null && hist.rsiTrough10 < CALL_RETRACEMENT_MIN;
      // const g7 = c.maTrendBps != null && c.maTrendBps > CALL_TREND_MIN;
      const g8 = c.cciPrev <= CALL_CCI_FLOOR && c.cci > CALL_CCI_FLOOR;
      return g1 && g2 && g4 && g5 && g6 && g8;
    },
    put: () => false,
  },
  {
    key: 'STC_PUT_8G',
    call: () => false,
    put: (c, hist) => {
      if (c.stc == null || c.stcPrev == null) return false;
      if (c.cci == null || c.cciPrev == null) return false;
      const g1 = c.stc >= PUT_STC_CEILING;
      const g2 = c.stc < c.stcPrev;
      // const g3 = c.rsi != null && c.rsi > PUT_RSI_MIN;
      const g4 = c.k != null && c.d != null && c.k < c.d && c.k > PUT_K_MIN;
      const g5 = c.bbWidthBps != null && c.bbWidthBps >= BB_WIDTH_MIN;
      const g6 = hist.rsiPeak10 != null && hist.rsiPeak10 > PUT_EXTENSION_MIN;
      // const g7 = c.maTrendBps != null && c.maTrendBps < PUT_TREND_MAX;
      const g8 = c.cciPrev >= PUT_CCI_CEILING && c.cci < PUT_CCI_CEILING;
      return g1 && g2 && g4 && g5 && g6 && g8;
    },
  },
];

// Join indicators + candles by (asset, timestamp). Pull everything needed for 8-gate logic.
const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.ma1, i.ma3,
    i.schaff_value,
    i.cci_8
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_5 IS NOT NULL
    AND i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper IS NOT NULL
    AND i.schaff_value IS NOT NULL
    AND i.cci_8 IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`).all();

// Index close prices + STC + CCI by (asset, timestamp) for lookups.
const closeByKey = new Map();
const stcByKey = new Map();
const cciByKey = new Map();
for (const r of rows) {
  const key = r.asset + '|' + r.timestamp;
  closeByKey.set(key, r.close);
  stcByKey.set(key, r.schaff_value);
  cciByKey.set(key, r.cci_8);
}

// Build per-asset history for lookback context (retracement depth)
const byAsset = {};
for (const r of rows) {
  if (!byAsset[r.asset]) byAsset[r.asset] = [];
  byAsset[r.asset].push(r);
}

// Compute lookback context for each bar
function computeLookback(assetRows, idx) {
  const LOOKBACK = 4
  const history = [];
  for (let i = Math.max(0, idx - LOOKBACK); i < idx; i++) {
    history.push(assetRows[i]);
  }
  // Include current bar in lookback (10 historical + 1 current = 11 total)
  const rsiVals = [
    ...history.map(r => r.rsi_5),
    assetRows[idx].rsi_5
  ].filter(v => v != null);
  const rsiPeak10 = rsiVals.length > 0 ? Math.max(...rsiVals) : null;
  const rsiTrough10 = rsiVals.length > 0 ? Math.min(...rsiVals) : null;
  return { rsiPeak10, rsiTrough10 };
}

const header = [
  'timestamp_utc', 'asset',
  'open', 'high', 'low', 'close',
  'rsi_5', 'stoch_k_v2', 'stoch_d_v2',
  'bb_upper', 'bb_middle', 'bb_lower', 'bb_width_bps',
  'ma6', 'ma14', 'ma_trend_bps',
  'stc', 'stc_prev',
  'cci_8', 'cci_prev',
  'rsi_peak_10', 'rsi_trough_10',
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

// Process each asset separately to compute lookback context
for (const [asset, assetRows] of Object.entries(byAsset)) {
  for (let idx = 1; idx < assetRows.length; idx++) {
    const r = assetRows[idx];
    const rPrev = assetRows[idx - 1];

    const bbWidthBps = r.bb_middle ? (r.bb_upper - r.bb_lower) / r.bb_middle * 10000 : null;
    const maTrendBps = (r.ma1 != null && r.ma3 != null && r.ma3) ? (r.ma1 - r.ma3) / r.ma3 * 10000 : null;
    const stcPrev = rPrev.schaff_value;
    const cciPrev = rPrev.cci_8;
    const lookback = computeLookback(assetRows, idx);

    const ctx = {
      rsi: r.rsi_5,
      k: r.stochastic_k_v2,
      d: r.stochastic_d_v2,
      stc: r.schaff_value,
      stcPrev: stcPrev,
      cci: r.cci_8,
      cciPrev: cciPrev,
      bbWidthBps: bbWidthBps,
      maTrendBps: maTrendBps,
      close: r.close,
    };

    for (const s of SIG_DEFS) {
      let dir = null;
      if (s.call(ctx, lookback)) dir = 'CALL';
      else if (s.put(ctx, lookback)) dir = 'PUT';
      if (!dir) continue;
      sigCount++;

      const row = [
        new Date(r.timestamp * 1000).toISOString(),
        r.asset,
        r.open, r.high, r.low, r.close,
        r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2,
        r.bb_upper, r.bb_middle, r.bb_lower, bbWidthBps,
        r.ma1, r.ma3, maTrendBps,
        r.schaff_value, stcPrev,
        r.cci_8, cciPrev,
        lookback.rsiPeak10, lookback.rsiTrough10,
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
}

fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} signal rows -> ${outPath}`);
console.log(`DB rows scanned: ${rows.length}, signals fired: ${sigCount}`);
