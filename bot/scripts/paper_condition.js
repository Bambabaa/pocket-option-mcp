// condition.txt Implementation - Binary Gates (NO confidence scoring)
// Pure reversal strategy with hard requirements only
// Usage: node scripts/paper_condition_txt.cjs [dbPath] [outCsv]

const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outPath = process.argv[3] || 'data/paper_condition_txt.csv';
const db = new Database(dbPath, { readonly: true });
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 4, 5]; // minutes

// ─── THRESHOLDS FROM CONDITION.TXT ───────────────────────────────────────────
const CALL_STC_MAX = 25;          // Adjusted based on chart visual lines (25/75)
const CALL_RSI_MIN_5 = 35;        // RSI must have hit ≤35 in last 5 bars
const CALL_STOCH_OVERSOLD = 35;

const PUT_STC_MIN = 75;           // Adjusted based on chart visual lines (25/75)
const PUT_RSI_MAX_5 = 65;         // RSI must have hit ≥65 in last 5 bars
const PUT_STOCH_OVERBOUGHT = 65;

const BB_WIDTH_MIN = 10;          // Bollinger band width minimum

// ─── FETCH ALL DATA ───────────────────────────────────────────────────────────
const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.rsi_14, i.stoch_k, i.stoch_d,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.sma_10, i.sma_50,
    i.stc_value
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.rsi_14 IS NOT NULL
    AND i.stoch_k IS NOT NULL
    AND i.bb_upper IS NOT NULL
    AND i.stc_value IS NOT NULL
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

// ─── FEATURE ENGINEERING ──────────────────────────────────────────────────────

function computeFeatures(assetRows, idx) {
  if (idx < 10) return null; // Need 10 bars history

  const curr = assetRows[idx];
  const prev = assetRows[idx - 1];
  const history = assetRows.slice(Math.max(0, idx - 10), idx);

  // Basic indicators
  const stc = curr.stc_value;
  const stcPrev = prev.stc_value;
  const rsi = curr.rsi_14;
  const k = curr.stoch_k;
  const d = curr.stoch_d;
  const kPrev = prev.stoch_k;
  const dPrev = prev.stoch_d;

  if (!stc || !stcPrev || !rsi || !k || !d) return null;

  // BB calculations
  const bbWidthBps = curr.bb_middle ?
    (curr.bb_upper - curr.bb_lower) / curr.bb_middle * 10000 : null;

  if (!bbWidthBps || bbWidthBps < BB_WIDTH_MIN) return null;

  // STC lookback features
  const stcMin8 = Math.min(...history.slice(-8).map(h => h.stc_value).filter(v => v != null));
  const stcMax8 = Math.max(...history.slice(-8).map(h => h.stc_value).filter(v => v != null));

  // RSI lookback features (critical for condition.txt)
  const rsiVals5 = history.slice(-5).map(h => h.rsi_14).filter(v => v != null);
  const rsiMin5 = rsiVals5.length > 0 ? Math.min(...rsiVals5) : null;
  const rsiMax5 = rsiVals5.length > 0 ? Math.max(...rsiVals5) : null;

  // Stoch crossover detection (within last 3 candles)
  let bullCross = false;
  let bearCross = false;
  for (let offset = 0; offset < 3; offset++) {
    const cIdx = idx - offset;
    const pIdx = cIdx - 1;
    const kC = assetRows[cIdx].stoch_k;
    const dC = assetRows[cIdx].stoch_d;
    const kP = assetRows[pIdx].stoch_k;
    const dP = assetRows[pIdx].stoch_d;
    if (kC != null && dC != null && kP != null && dP != null) {
      if (kP <= dP && kC > dC) bullCross = true;
      if (kP >= dP && kC < dC) bearCross = true;
    }
  }

  return {
    // Core indicators
    stc, stcPrev, rsi, k, d, kPrev, dPrev,

    // BB features
    bbWidthBps,
    bbUpper: curr.bb_upper,
    bbLower: curr.bb_lower,
    bbMiddle: curr.bb_middle,

    // STC features
    stcMin8, stcMax8,
    stcTurningUp: stc > stcPrev,
    stcTurningDown: stc < stcPrev,

    // RSI features
    rsiMin5, rsiMax5,

    // Stoch features
    bullCross, bearCross,

    // Raw values for output
    close: curr.close,
    open: curr.open,
    high: curr.high,
    low: curr.low,
    ma10: curr.sma_10,
    ma50: curr.sma_50,
  };
}

// ─── CALL REVERSAL STRATEGY (HARD GATES ONLY) ────────────────────────────────

function checkCallReversal(f) {
  // Gate 1a: PREVIOUS STC was ≤ 25
  if (f.stcPrev > CALL_STC_MAX) return null;

  // Gate 1b: Current STC hooked up, but hasn't crossed 75
  if (f.stc >= PUT_STC_MIN) return null;

  // Gate 2: STC turned up (hook)
  if (!f.stcTurningUp) return null;

  // Gate 3: Price must have pierced the lower Bollinger Band
  if (f.low > f.bbLower) return null;

  // Gate 4: RSI was ≤ 35 in last 5 bars (critical retracement check)
  if (f.rsiMin5 === null || f.rsiMin5 > CALL_RSI_MIN_5) return null;

  // Gate 5: Stoch bull cross (K crossed above D)
  if (!f.bullCross) return null;

  // All gates passed
  return { direction: 'CALL' };
}

// ─── PUT REVERSAL STRATEGY (HARD GATES ONLY) ─────────────────────────────────

function checkPutReversal(f) {
  // Gate 1a: PREVIOUS STC was ≥ 75
  if (f.stcPrev < PUT_STC_MIN) return null;

  // Gate 1b: Current STC hooked down, but hasn't crossed 25
  if (f.stc <= CALL_STC_MAX) return null;

  // Gate 2: STC turned down (hook)
  if (!f.stcTurningDown) return null;

  // Gate 3: Price must have pierced the upper Bollinger Band
  if (f.high < f.bbUpper) return null;

  // Gate 4: RSI was ≥ 65 in last 5 bars (critical extension check)
  if (f.rsiMax5 === null || f.rsiMax5 < PUT_RSI_MAX_5) return null;

  // Gate 5: Stoch bear cross (K crossed below D)
  if (!f.bearCross) return null;

  // All gates passed
  return { direction: 'PUT' };
}

// ─── PROCESS SIGNALS ──────────────────────────────────────────────────────────

const header = [
  'timestamp_utc', 'asset',
  'open', 'high', 'low', 'close',
  'rsi_14', 'rsi_min_5', 'rsi_max_5',
  'stoch_k', 'stoch_d', 'bull_cross', 'bear_cross',
  'stc', 'stc_prev', 'stc_min_8', 'stc_max_8',
  'bb_width_bps', 'bb_upper', 'bb_middle', 'bb_lower',
  'sma_10', 'sma_50',
  'signal', 'direction',
];
for (const e of EXPIRIES) header.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);

const lines = [header.join(',')];
let sigCount = 0;

const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
  return String(v);
};

// Process each asset
for (const [asset, assetRows] of Object.entries(byAsset)) {
  for (let idx = 10; idx < assetRows.length; idx++) {
    const r = assetRows[idx];
    const features = computeFeatures(assetRows, idx);
    if (!features) continue;

    // Try CALL reversal
    let signal = checkCallReversal(features);

    // Try PUT reversal if CALL didn't fire
    if (!signal) {
      signal = checkPutReversal(features);
    }

    if (!signal) continue;

    sigCount++;

    const row = [
      new Date(r.timestamp * 1000).toISOString(),
      r.asset,
      r.open, r.high, r.low, r.close,
      features.rsi, features.rsiMin5, features.rsiMax5,
      features.k, features.d, features.bullCross, features.bearCross,
      features.stc, features.stcPrev, features.stcMin8, features.stcMax8,
      features.bbWidthBps, features.bbUpper, features.bbMiddle, features.bbLower,
      features.ma10, features.ma50,
      'CONDITION_TXT',
      signal.direction,
    ];

    // Calculate exits
    for (const e of EXPIRIES) {
      const exitTs = r.timestamp + e * 60;
      const exit = closeByKey.get(r.asset + '|' + exitTs);
      if (exit == null) { row.push('', '', ''); continue; }
      const win = signal.direction === 'CALL' ? exit > r.close : exit < r.close;
      const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
      row.push(exit, pl, win ? 1 : 0);
    }

    lines.push(row.map(fmt).join(','));
  }
}

// Write output
fs.writeFileSync(outPath, lines.join('\n') + '\n');

console.log(`\n=== CONDITION.TXT STRATEGY (BINARY GATES) ===`);
console.log(`Wrote ${lines.length - 1} signal rows -> ${outPath}`);
console.log(`DB rows scanned: ${rows.length}`);
console.log(`Signals fired: ${sigCount}`);
console.log(`\nHard gates enforced:`);
console.log(`  CALL: Prev STC≤25 + STC turning up (current <75) + Pierced BB Lower + RSI min 5 bars ≤35 + Stoch bull cross (last 3 bars)`);
console.log(`  PUT:  Prev STC≥75 + STC turning down (current >25) + Pierced BB Upper + RSI max 5 bars ≥65 + Stoch bear cross (last 3 bars)`);
console.log(`  BB width ≥ 10 bps (all signals)`);
console.log(`\nNext: Analyze ${outPath} for 2m performance validation\n`);
