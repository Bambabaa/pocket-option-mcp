// Gate Comparison: Bot's current gates vs Paper's retracement gates
// Tests both strategies side-by-side to find correlations before applying to live bot
// Usage: node scripts/gate_comparison.cjs [dbPath] [outCsv]

const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outPath = process.argv[3] || 'data/gate_comparison.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 5, 10];

// ─── Strategy A: BOT CURRENT (bb_expanding + ma_gap_trend) ───────────────────
const BOT_CALL_STC_FLOOR = 25;
const BOT_CALL_RSI_MAX = 30;
const BOT_CALL_K_MAX = 50;
const BOT_PUT_STC_CEILING = 90;
const BOT_PUT_RSI_MIN = 70;
const BOT_PUT_K_MIN = 50;
const BB_WIDTH_MIN = 10;

// ─── Strategy B: PAPER (retracement + tighter zones) ─────────────────────────
const PAPER_CALL_STC_FLOOR = 20;
const PAPER_CALL_RSI_MAX = 20;
const PAPER_CALL_K_MAX = 35;
const PAPER_CALL_RETRACEMENT_MIN = 15;
const PAPER_CALL_TREND_MIN = -20;

const PAPER_PUT_STC_CEILING = 75;
const PAPER_PUT_RSI_MIN = 70;
const PAPER_PUT_K_MIN = 65;
const PAPER_PUT_EXTENSION_MIN = 80;
const PAPER_PUT_TREND_MAX = 20;

// ─── Signal Definitions ───────────────────────────────────────────────────────
const strategies = [
  {
    key: 'BOT_CALL',
    call: (c, hist, ctx) => {
      if (c.stc == null || c.stcPrev == null) return false;
      return (
        c.stc <= BOT_CALL_STC_FLOOR &&
        c.stc > c.stcPrev &&
        c.rsi < BOT_CALL_RSI_MAX &&
        c.k > c.d && c.k < BOT_CALL_K_MAX &&
        c.bbWidthBps >= BB_WIDTH_MIN &&
        ctx.bbExpanding !== false &&
        ctx.maGapTrend !== 'narrowing'
      );
    },
    put: () => false,
  },
  {
    key: 'BOT_PUT',
    call: () => false,
    put: (c, hist, ctx) => {
      if (c.stc == null || c.stcPrev == null) return false;
      return (
        c.stc >= BOT_PUT_STC_CEILING &&
        c.stc < c.stcPrev &&
        c.rsi > BOT_PUT_RSI_MIN &&
        c.k < c.d && c.k > BOT_PUT_K_MIN &&
        c.bbWidthBps >= BB_WIDTH_MIN &&
        ctx.maGapTrend !== 'narrowing'
      );
    },
  },
  {
    key: 'PAPER_CALL',
    call: (c, hist) => {
      if (c.stc == null || c.stcPrev == null) return false;
      return (
        c.stc <= PAPER_CALL_STC_FLOOR &&
        c.stc > c.stcPrev &&
        c.rsi < PAPER_CALL_RSI_MAX &&
        c.k > c.d && c.k < PAPER_CALL_K_MAX &&
        c.bbWidthBps >= BB_WIDTH_MIN &&
        hist.rsiTrough10 != null && hist.rsiTrough10 < PAPER_CALL_RETRACEMENT_MIN &&
        c.maTrendBps > PAPER_CALL_TREND_MIN
      );
    },
    put: () => false,
  },
  {
    key: 'PAPER_PUT',
    call: () => false,
    put: (c, hist) => {
      if (c.stc == null || c.stcPrev == null) return false;
      return (
        c.stc >= PAPER_PUT_STC_CEILING &&
        c.stc < c.stcPrev &&
        c.rsi > PAPER_PUT_RSI_MIN &&
        c.k < c.d && c.k > PAPER_PUT_K_MIN &&
        c.bbWidthBps >= BB_WIDTH_MIN &&
        hist.rsiPeak10 != null && hist.rsiPeak10 > PAPER_PUT_EXTENSION_MIN &&
        c.maTrendBps < PAPER_PUT_TREND_MAX
      );
    },
  },
];

// Fetch all data
const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.ma1, i.ma3,
    i.schaff_value
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_5 IS NOT NULL
    AND i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper IS NOT NULL
    AND i.schaff_value IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`).all();

// Index prices
const closeByKey = new Map();
for (const r of rows) {
  closeByKey.set(r.asset + '|' + r.timestamp, r.close);
}

// Build per-asset history
const byAsset = {};
for (const r of rows) {
  if (!byAsset[r.asset]) byAsset[r.asset] = [];
  byAsset[r.asset].push(r);
}

// Lookback context
function computeLookback(assetRows, idx) {
  const LOOKBACK = 10;
  const history = assetRows.slice(Math.max(0, idx - LOOKBACK), idx);
  // Include current bar in lookback
  const rsiVals = [
    ...history.map(r => r.rsi_5),
    assetRows[idx].rsi_5
  ].filter(v => v != null);
  const bbVals = history.map(r => {
    const mid = r.bb_middle;
    return mid ? (r.bb_upper - r.bb_lower) / mid * 10000 : null;
  }).filter(v => v != null);
  
  return {
    rsiPeak10: rsiVals.length > 0 ? Math.max(...rsiVals) : null,
    rsiTrough10: rsiVals.length > 0 ? Math.min(...rsiVals) : null,
    bbAvg10: bbVals.length > 0 ? bbVals.reduce((a,b)=>a+b)/bbVals.length : null,
  };
}

// Compute bb_expanding and ma_gap_trend
function computeContext(assetRows, idx) {
  if (idx < 3) return { bbExpanding: null, maGapTrend: null };
  
  const curr = assetRows[idx];
  const prev = assetRows[idx - 1];
  const m3 = assetRows[idx - 3];
  
  const bbNow = curr.bb_middle ? (curr.bb_upper - curr.bb_lower) / curr.bb_middle * 10000 : null;
  const bbPrev = prev.bb_middle ? (prev.bb_upper - prev.bb_lower) / prev.bb_middle * 10000 : null;
  const bbExpanding = (bbNow != null && bbPrev != null) ? bbNow > bbPrev : null;
  
  const gapNow = (curr.ma1 != null && curr.ma3 != null) ? Math.abs(curr.ma1 - curr.ma3) : null;
  const gapOld = (m3.ma1 != null && m3.ma3 != null) ? Math.abs(m3.ma1 - m3.ma3) : null;
  
  let maGapTrend = null;
  if (gapNow != null && gapOld != null) {
    if (gapNow < gapOld * 0.95) maGapTrend = 'narrowing';
    else if (gapNow > gapOld * 1.05) maGapTrend = 'widening';
    else maGapTrend = 'flat';
  }
  
  return { bbExpanding, maGapTrend };
}

const header = [
  'timestamp_utc', 'asset',
  'rsi_5', 'stoch_k', 'stoch_d', 'bb_width_bps', 'stc', 'stc_prev',
  'rsi_peak_10', 'rsi_trough_10', 'bb_expanding', 'ma_gap_trend',
  'signal', 'direction',
];
for (const e of EXPIRIES) header.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);

const lines = [header.join(',')];
const sigCounts = {};

const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
  return String(v);
};

// Process signals
for (const [asset, assetRows] of Object.entries(byAsset)) {
  for (let idx = 3; idx < assetRows.length; idx++) {
    const r = assetRows[idx];
    const rPrev = assetRows[idx - 1];
    
    const bbWidthBps = r.bb_middle ? (r.bb_upper - r.bb_lower) / r.bb_middle * 10000 : null;
    const maTrendBps = (r.ma1 != null && r.ma3 != null && r.ma3) ? (r.ma1 - r.ma3) / r.ma3 * 10000 : null;
    const lookback = computeLookback(assetRows, idx);
    const ctx = computeContext(assetRows, idx);
    
    const c = {
      rsi: r.rsi_5,
      k: r.stochastic_k_v2,
      d: r.stochastic_d_v2,
      stc: r.schaff_value,
      stcPrev: rPrev.schaff_value,
      bbWidthBps,
      maTrendBps,
      close: r.close,
    };
    
    for (const strat of strategies) {
      let dir = null;
      if (strat.call(c, lookback, ctx)) dir = 'CALL';
      else if (strat.put(c, lookback, ctx)) dir = 'PUT';
      if (!dir) continue;
      
      sigCounts[strat.key] = (sigCounts[strat.key] || 0) + 1;
      
      const row = [
        new Date(r.timestamp * 1000).toISOString(),
        r.asset,
        r.rsi_5, r.stochastic_k_v2, r.stochastic_d_v2, bbWidthBps,
        r.schaff_value, rPrev.schaff_value,
        lookback.rsiPeak10, lookback.rsiTrough10,
        ctx.bbExpanding, ctx.maGapTrend,
        strat.key, dir,
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
console.log(`\n=== Gate Comparison Results ===`);
console.log(`Wrote ${lines.length - 1} signal rows -> ${outPath}`);
console.log(`\nSignal counts by strategy:`);
for (const [key, count] of Object.entries(sigCounts)) {
  console.log(`  ${key}: ${count} signals`);
}
console.log(`\nDB rows scanned: ${rows.length}`);
console.log(`\nNext: Analyze ${outPath} to compare win rates & correlations`);
