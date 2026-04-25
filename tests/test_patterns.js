const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_PATH = path.join(DATA_DIR, 'pattern_test_results.csv');
const REPORT_PATH = path.join(DATA_DIR, 'pattern_test_report.txt');

// All databases to aggregate across
const DB_NAMES = ['ap5', 'ap5v1', 'ap7', 'ap7v1', 'ap9'];
const DB_PATHS = DB_NAMES.map(n => path.join(DATA_DIR, `trading_data-${n}.db`));

function queryDb(dbPath, text, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
      if (err) return reject(err);
    });
    db.all(text, params, (err, rows) => {
      db.close();
      if (err) reject(err); else resolve(rows);
    });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const sep = (n = 90) => '='.repeat(n);
const sepThin = (n = 90) => '-'.repeat(n);
const pad = (s, len) => String(s) + ' '.repeat(Math.max(0, len - String(s).length));
const pct = (w, l) => { const t = w + l; return t === 0 ? 'n/a' : ((w / t) * 100).toFixed(1) + '%'; };
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
};

// ════════════════════════════════════════════════════════════════════════════
// PATTERN DEFINITIONS — Deterministic 6-gate logic
// ════════════════════════════════════════════════════════════════════════════

/**
 * CALL — K Flash Crash Bounce
 * Pattern: 5,3,3 stoch K drops 25+ pts from above 50 to below 25 in ONE bar.
 * The fast stochastic overshoots on a sharp move — next bar snaps back.
 *
 * Gate logic (all must pass):
 *   Gate 1: Bearish MA stack (ma6 < ma14 < ma50) — counter-trend context
 *   Gate 2: K₋₁ - K₀ > 25 (K crashed 25+ pts in one bar)
 *   Gate 3: K₀ < 25 (K is now in oversold territory)
 *   Gate 4: K₋₁ >= 50 (K was from mid/high territory before crash — not already oversold)
 *   Gate 5: RSI₀ < 40 (RSI also confirmed pullback)
 *   Gate 6: MA14-MA50 bps > -20 (not deeply bearish: counter-trend bounce works here)
 *
 * Validated WR: 70.0% (14W/6L) on 20 signals (v2 stoch, 5 DBs)
 * Note: crash>30 + k_m1>50 + rsi<45 = 72.2% WR (n=18); d_0<20 = 90.9% (n=11)
 */
function checkCallOversoldBounce(_barM2, barM1, bar0) {
  const i1 = barM1; const i0 = bar0;

  if (i1.stochastic_k == null || i0.stochastic_k == null) return { pass: false, gates: {} };

  // Gate 1: Bearish MA stack
  const g1_maStack = i0.ma1 != null && i0.ma3 != null && i0.ma2 != null &&
    i0.ma1 < i0.ma3 && i0.ma3 < i0.ma2;

  // Gate 2: K crashed 25+ pts in one bar
  const kCrash = i1.stochastic_k - i0.stochastic_k;
  const g2_kCrash = kCrash > 25;

  // Gate 3: K now < 25 (oversold)
  const g3_kOversold = i0.stochastic_k < 25;

  // Gate 4: K₋₁ >= 50 (crashed from meaningful territory, not already oversold)
  const g4_kWasMid = i1.stochastic_k >= 50;

  // Gate 5: RSI₀ < 40 (RSI confirms pullback)
  const g5_rsiDown = i0.rsi_5 != null && i0.rsi_5 < 40;

  // Gate 6: MA14-MA50 gap > -20 bps (not deeply bearish)
  const maTrendBps = i0.ma3 != null && i0.ma2 != null
    ? ((i0.ma3 - i0.ma2) / i0.ma2) * 10000 : null;
  const g6_maNotDeep = maTrendBps != null && maTrendBps > -20;

  const pass = g1_maStack && g2_kCrash && g3_kOversold && g4_kWasMid && g5_rsiDown && g6_maNotDeep;

  return {
    pass,
    direction: 'CALL',
    patternName: 'OVERSOLD',
    gates: {
      g1_maStack, g2_kCrash, g3_kOversold, g4_kWasMid, g5_rsiDown, g6_maNotDeep,
    },
    values: {
      rsi_0: i0.rsi_5, rsi_m1: i1.rsi_5,
      k_m1: i1.stochastic_k, k_0: i0.stochastic_k,
      kCrash, d_0: i0.stochastic_d,
      ma6_0: i0.ma1, ma14_0: i0.ma3, ma50_0: i0.ma2,
      maTrendBps,
    }
  };
}

/**
 * PUT — Late Overbought Reversal
 * All 6 gates must pass simultaneously at the signal candle.
 */
function checkPutLateOverbought(barM2, barM1, bar0) {
  const i2 = barM2; const i1 = barM1; const i0 = bar0;

  // Gate 1: RSI > 70 at BOTH -2 and -1 bars, EXCLUDE RSI₋₁ [75,80) — fast-drop zone 0% WR
  if (i2.rsi_5 == null || i1.rsi_5 == null) return { pass: false, gates: {} };
  const g1_rsiBaseline = i2.rsi_5 > 70 && i1.rsi_5 > 70 &&
    !(i1.rsi_5 >= 75 && i1.rsi_5 < 80);

  // Gate 2: RSI falling, in [38,70), EXCLUDE [55,65) death zone, velocity > -12, close >= BB mid
  const rsiFalling = i0.rsi_5 != null && i0.rsi_5 < i1.rsi_5;
  const rsiVelocity = i0.rsi_5 != null && i1.rsi_5 != null ? i0.rsi_5 - i1.rsi_5 : null;
  const closeAboveMid = i0.close != null && i0.bb_middle != null && i0.close >= i0.bb_middle;
  const g2_rsiRecovery = rsiFalling && i0.rsi_5 >= 38 && i0.rsi_5 < 70 &&
    !(i0.rsi_5 >= 55 && i0.rsi_5 < 65) &&
    rsiVelocity != null && rsiVelocity > -12 &&
    closeAboveMid;

  // Gate 3: K was > 65 at -1 bar, now falling into [55,80) at signal
  const kFalling = i0.stochastic_k != null && i1.stochastic_k != null && i0.stochastic_k < i1.stochastic_k;
  const g3_kTurn = i1.stochastic_k != null && i1.stochastic_k > 65 &&
    kFalling && i0.stochastic_k >= 55 && i0.stochastic_k < 80;

  // Gate 4: D still >= 80
  const g4_dPosition = i0.stochastic_d != null && i0.stochastic_d >= 80;

  // Gate 5: Bullish MA stack
  const g5_maStack = i0.ma1 != null && i0.ma3 != null && i0.ma2 != null &&
    i0.ma1 > i0.ma3 && i0.ma3 > i0.ma2;

  // Gate 6: K < D AND spread < -3 (confirmed cross, not whipsaw)
  const kdSpread = i0.stochastic_k != null && i0.stochastic_d != null
    ? i0.stochastic_k - i0.stochastic_d : null;
  const g6_kdCross = kdSpread != null && kdSpread < -3;

  // Gate 7: MA14-MA50 gap < 20 bps (not a strong uptrend)
  const maTrendBps = i0.ma3 != null && i0.ma2 != null
    ? ((i0.ma3 - i0.ma2) / i0.ma2) * 10000 : null;
  const g7_maTrendWeak = maTrendBps != null && maTrendBps < 20;

  const pass = g1_rsiBaseline && g2_rsiRecovery && g3_kTurn && g4_dPosition && g5_maStack && g6_kdCross && g7_maTrendWeak;

  return {
    pass,
    direction: 'PUT',
    patternName: 'OVERBOUGHT',
    gates: {
      g1_rsiBaseline, g2_rsiRecovery, g3_kTurn, g4_dPosition, g5_maStack, g6_kdCross, g7_maTrendWeak,
    },
    values: {
      rsi_m2: i2.rsi_5, rsi_m1: i1.rsi_5, rsi_0: i0.rsi_5,
      rsiVelocity, closeAboveMid,
      k_m1: i1.stochastic_k, k_0: i0.stochastic_k,
      d_0: i0.stochastic_d, kdSpread,
      ma6_0: i0.ma1, ma14_0: i0.ma3, ma50_0: i0.ma2,
      maTrendBps,
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN — Candle-by-candle replay engine
// ════════════════════════════════════════════════════════════════════════════

async function replayDb(dbPath) {
  // Load candles + indicators from one DB and return signals + stats
  const rows = await queryDb(dbPath, `
    SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
           i.rsi_5,
           i.stochastic_k_v2 AS stochastic_k,
           i.stochastic_d_v2 AS stochastic_d,
           i.ma1, i.ma2, i.ma3,
           i.bb_middle, i.bb_upper, i.bb_lower
    FROM candles c
    LEFT JOIN indicators i
      ON c.asset = i.asset AND c.timestamp = i.timestamp
    ORDER BY c.asset, c.timestamp
  `);

  const byAsset = {};
  for (const r of rows) {
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
  }
  for (const asset of Object.keys(byAsset)) {
    byAsset[asset].sort((a, b) => a.timestamp - b.timestamp);
  }

  const signals = [];
  let totalCandles = 0, candlesWithIndicators = 0, candlesWithHistory = 0;
  const callRejections = { g1_maStack: 0, g2_kCrash: 0, g3_kOversold: 0, g4_kWasMid: 0, g5_rsiDown: 0, g6_maNotDeep: 0 };
  const putRejections = { g1_rsiBaseline: 0, g2_rsiRecovery: 0, g3_kTurn: 0, g4_dPosition: 0, g5_maStack: 0, g6_kdCross: 0, g7_maTrendWeak: 0 };
  const callGateNames = ['g1_maStack', 'g2_kCrash', 'g3_kOversold', 'g4_kWasMid', 'g5_rsiDown', 'g6_maNotDeep'];
  const putGateNames = ['g1_rsiBaseline', 'g2_rsiRecovery', 'g3_kTurn', 'g4_dPosition', 'g5_maStack', 'g6_kdCross', 'g7_maTrendWeak'];

  for (const [asset, candles] of Object.entries(byAsset)) {
    for (let t = 2; t < candles.length; t++) {
      totalCandles++;
      const barM2 = candles[t - 2];
      const barM1 = candles[t - 1];
      const bar0 = candles[t];

      if (bar0.rsi_5 == null) continue;  // need indicators at signal bar
      candlesWithIndicators++;

      if (barM1.rsi_5 == null || barM2.rsi_5 == null) continue;  // need 2 bars of history
      candlesWithHistory++;

      // Check CALL pattern
      const callResult = checkCallOversoldBounce(barM2, barM1, bar0);
      if (callResult.pass) {
        const nextBar = candles[t + 1];
        const isGap = !nextBar || (nextBar.timestamp - bar0.timestamp > 120);
        let result = null, exitPrice = null, gapFlag = isGap;
        const amount = 500;  // standard trade size

        if (!isGap) {
          exitPrice = nextBar.close;
          result = nextBar.close > bar0.close ? 'WIN' : 'LOSS';
        }

        signals.push({
          asset, signalTs: bar0.timestamp, pattern: callResult.patternName,
          direction: 'CALL', entryPrice: bar0.close, exitPrice,
          result, profitLoss: result === 'WIN' ? amount * 0.92 : -amount,
          gapFlag, candleDelta: nextBar ? nextBar.timestamp - bar0.timestamp : null,
          ...callResult.values, stackType: 'BEAR',
          ...callResult.gates,
        });
      } else {
        // Track which gates rejected this candle
        for (const gn of callGateNames) {
          if (callResult.gates && callResult.gates[gn] === false) {
            callRejections[gn]++;
          }
        }
      }

      // Check PUT pattern
      const putResult = checkPutLateOverbought(barM2, barM1, bar0);
      if (putResult.pass) {
        const nextBar = candles[t + 1];
        const isGap = !nextBar || (nextBar.timestamp - bar0.timestamp > 120);
        let result = null, exitPrice = null, gapFlag = isGap;
        const amount = 500;  // standard trade size

        if (!isGap) {
          exitPrice = nextBar.close;
          result = nextBar.close < bar0.close ? 'WIN' : 'LOSS';
        }

        signals.push({
          asset, signalTs: bar0.timestamp, pattern: putResult.patternName,
          direction: 'PUT', entryPrice: bar0.close, exitPrice,
          result, profitLoss: result === 'WIN' ? amount * 0.92 : -amount,
          gapFlag, candleDelta: nextBar ? nextBar.timestamp - bar0.timestamp : null,
          ...putResult.values, stackType: 'BULL',
          ...putResult.gates,
        });
      } else {
        // Track which gates rejected this candle
        for (const gn of putGateNames) {
          if (putResult.gates && putResult.gates[gn] === false) {
            putRejections[gn]++;
          }
        }
      }
    }
  }

  // ─── Return everything for aggregation ───────────────────────────────
  return {
    signals, totalCandles, candlesWithIndicators, candlesWithHistory,
    callRejections, putRejections, callGateNames, putGateNames,
    assetCount: Object.keys(byAsset).length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN — Run all DBs and produce combined report
// ════════════════════════════════════════════════════════════════════════════

async function runTest() {
  try {
    // ─── Step 1: Replay all databases ────────────────────────────────────
    const allSignals = [];
    let totalCandles = 0, candlesWithIndicators = 0, candlesWithHistory = 0;
    let totalAssets = 0;
    const callRejections = { g1_maStack: 0, g2_kCrash: 0, g3_kOversold: 0, g4_kWasMid: 0, g5_rsiDown: 0, g6_maNotDeep: 0 };
    const putRejections = { g1_rsiBaseline: 0, g2_rsiRecovery: 0, g3_kTurn: 0, g4_dPosition: 0, g5_maStack: 0, g6_kdCross: 0, g7_maTrendWeak: 0 };
    const callGateNames = ['g1_maStack', 'g2_kCrash', 'g3_kOversold', 'g4_kWasMid', 'g5_rsiDown', 'g6_maNotDeep'];
    const putGateNames = ['g1_rsiBaseline', 'g2_rsiRecovery', 'g3_kTurn', 'g4_dPosition', 'g5_maStack', 'g6_kdCross', 'g7_maTrendWeak'];
    const dbResults = [];

    for (let i = 0; i < DB_NAMES.length; i++) {
      const name = DB_NAMES[i];
      const dbPath = DB_PATHS[i];
      console.log(`Loading ${name}...`);
      const res = await replayDb(dbPath);
      dbResults.push({ name, ...res });
      // Tag each signal with source db
      res.signals.forEach(s => { s.db = name; allSignals.push(s); });
      totalCandles += res.totalCandles;
      candlesWithIndicators += res.candlesWithIndicators;
      candlesWithHistory += res.candlesWithHistory;
      totalAssets += res.assetCount;
      for (const gn of callGateNames) callRejections[gn] += res.callRejections[gn] || 0;
      for (const gn of putGateNames) putRejections[gn] += res.putRejections[gn] || 0;
      console.log(`  ${name}: ${res.signals.length} signals (${res.totalCandles} candles)`);
    }

    const signals = allSignals;

    // ─── Step 2: Build report ─────────────────────────────────────────────
    const lines = [];
    const out = (...args) => lines.push(args.join(''));

    out(sep());
    out('  DETERMINISTIC PATTERN RECOGNITION — COMBINED TEST REPORT');
    out(`  Databases: ${DB_NAMES.join(', ')}`);
    out(sep());
    out('');
    out('  Combined data summary:');
    out(`    Databases:            ${DB_NAMES.length}`);
    out(`    Total candles:        ${totalCandles}`);
    out(`    Candles w/indicators: ${candlesWithIndicators}`);
    out(`    Candles w/history:    ${candlesWithHistory}`);
    out(`    Total signals:        ${signals.length}`);
    const validated = signals.filter(s => s.result != null);
    const gapped = signals.filter(s => s.gapFlag);
    out(`    Validated signals:    ${validated.length}`);
    out(`    Gapped signals:       ${gapped.length}`);
    out('');

    // Per-DB breakdown summary
    out(sep());
    out('  PER-DATABASE BREAKDOWN');
    out(sep());
    out('');
    out(pad('DB', 10) + pad('Candles', 10) + pad('CALL', 8) + pad('CALL WR', 10) + pad('PUT', 8) + pad('PUT WR', 10) + pad('Total P/L', 12));
    out(sepThin(72));
    for (const r of dbResults) {
      const cs = r.signals.filter(s => s.pattern === 'K_FLASH_CRASH' && s.result != null);
      const cw = cs.filter(s => s.result === 'WIN').length;
      const ps = r.signals.filter(s => s.pattern === 'LATE_OVERBOUGHT' && s.result != null);
      const pw = ps.filter(s => s.result === 'WIN').length;
      const pl = r.signals.reduce((a, s) => a + (s.profitLoss || 0), 0);
      out(pad(r.name, 10) + pad(r.totalCandles, 10) + pad(cs.length, 8) + pad(pct(cw, cs.length - cw), 10) +
        pad(ps.length, 8) + pad(pct(pw, ps.length - pw), 10) + pad(pl.toFixed(0), 12));
    }
    out('');

    // Per-pattern breakdown (combined)
    for (const [pname, pdir] of [['K_FLASH_CRASH', 'CALL'], ['LATE_OVERBOUGHT', 'PUT']]) {
      const pSignals = signals.filter(s => s.pattern === pname);
      const pValid = pSignals.filter(s => s.result != null);
      const pWins = pValid.filter(s => s.result === 'WIN');
      const pLosses = pValid.filter(s => s.result === 'LOSS');
      const pGapped = pSignals.filter(s => s.gapFlag);
      const totalPL = pValid.reduce((sum, s) => sum + (s.profitLoss || 0), 0);

      out(sep());
      out(`  ${pname} (${pdir}) — COMBINED`);
      out(sep());
      out(`    Total fired:     ${pSignals.length}`);
      out(`    Wins:            ${pWins.length}`);
      out(`    Losses:          ${pLosses.length}`);
      out(`    Win Rate:        ${pct(pWins.length, pLosses.length)}`);
      out(`    Net P/L:         ${totalPL.toFixed(2)}`);
      if (pWins.length + pLosses.length > 0) {
        out(`    Avg Win:         ${(pWins.reduce((s, r) => s + (r.profitLoss || 0), 0) / pWins.length).toFixed(2)}`);
        out(`    Avg Loss:        ${(pLosses.reduce((s, r) => s + (r.profitLoss || 0), 0) / pLosses.length).toFixed(2)}`);
      }
      out(`    Gapped (skipped):${pGapped.length}`);
      out('');

      // Per-asset breakdown
      if (pValid.length > 0) {
        out(`    By asset (top 20):`);
        const byAssetP = {};
        for (const s of pValid) {
          if (!byAssetP[s.asset]) byAssetP[s.asset] = { w: 0, l: 0, pl: 0 };
          if (s.result === 'WIN') byAssetP[s.asset].w++; else byAssetP[s.asset].l++;
          byAssetP[s.asset].pl += (s.profitLoss || 0);
        }
        const topAssets = Object.entries(byAssetP).sort((a, b) => b[1].pl - a[1].pl).slice(0, 20);
        out(pad('Asset', 22) + pad('W', 5) + pad('L', 5) + pad('WR%', 8) + pad('Net P/L', 10));
        out(sepThin(60));
        for (const [asset, st] of topAssets) {
          out(pad(asset, 22) + pad(st.w, 5) + pad(st.l, 5) + pad(pct(st.w, st.l), 8) + pad(st.pl.toFixed(2), 10));
        }
        out('');
      }

      // All signals (chronological)
      if (pValid.length > 0) {
        out(`    All signals (chronological):`);
        out(pad('#', 4) + pad('DB', 8) + pad('Asset', 18) + pad('Signal Time', 22) +
          pad('RSI₀', 7) + pad('K₋₁', 7) + pad('K₀', 7) + pad('D₀', 7) + pad('Result', 8) + pad('P/L', 10));
        out(sepThin(120));
        const sorted = [...pValid].sort((a, b) => a.signalTs - b.signalTs);
        sorted.forEach((s, idx) => {
          out(pad(idx + 1, 4) + pad(s.db || '?', 8) + pad(s.asset, 18) + pad(fmtTime(s.signalTs), 22) +
            pad(s.rsi_0?.toFixed(1) || '—', 7) + pad(s.k_m1?.toFixed(1) || '—', 7) +
            pad(s.k_0?.toFixed(1) || '—', 7) + pad(s.d_0?.toFixed(1) || '—', 7) +
            pad(s.result || '—', 8) + pad((s.profitLoss || 0).toFixed(2), 10));
        });
        out('');
      }
    }

    // Gate effectiveness (combined)
    out(sep());
    out('  GATE EFFECTIVENESS — Combined across all databases');
    out(sep());
    out('');
    for (const [pname, pdir, rejections, gnames] of [
      ['OVERSOLD', 'CALL', callRejections, callGateNames],
      ['OVERBOUGHT', 'PUT', putRejections, putGateNames]
    ]) {
      const pSignals = signals.filter(s => s.pattern === pname);
      if (pSignals.length === 0) continue;
      out(`  ${pname} (${pdir}) — ${candlesWithHistory} candles tested, ${pSignals.length} fired:`);
      out(pad('Gate', 20) + pad('Rejected', 12) + pad('Reject%', 12) + pad('Signals if removed', 22));
      out(sepThin(70));
      for (const gn of gnames) {
        const rejected = rejections[gn];
        const rejectPct = ((rejected / candlesWithHistory) * 100).toFixed(1);
        out(pad(gn, 20) + pad(String(rejected), 12) + pad(rejectPct + '%', 12) + pad(`→ ${pSignals.length + rejected} signals`, 22));
      }
      out('');
    }

    // Hourly WR (combined)
    out(sep());
    out('  SIGNAL DISTRIBUTION BY HOUR (UTC) — Combined');
    out(sep());
    out('');
    const byHour = {};
    for (const s of signals) {
      const h = new Date(s.signalTs * 1000).getUTCHours();
      if (!byHour[h]) byHour[h] = { w: 0, l: 0, total: 0 };
      byHour[h].total++;
      if (s.result === 'WIN') byHour[h].w++;
      else if (s.result === 'LOSS') byHour[h].l++;
    }
    out(pad('Hour (UTC)', 14) + pad('Signals', 10) + pad('Validated', 12) + pad('WR%', 10));
    out(sepThin(50));
    for (let h = 0; h < 24; h++) {
      if (!byHour[h]) continue;
      out(pad(`${h.toString().padStart(2, '0')}:00`, 14) + pad(byHour[h].total, 10) +
        pad(byHour[h].w + byHour[h].l, 12) + pad(pct(byHour[h].w, byHour[h].l), 10));
    }
    out('');

    out(sep());
    out('  END OF REPORT');
    out(`  Generated: ${new Date().toISOString()}`);
    out(sep());

    // Write report
    const report = lines.join('\n');
    fs.writeFileSync(REPORT_PATH, report);
    console.log(report);

    // Write CSV
    const csvColumns = [
      'db', 'asset', 'signalTs', 'pattern', 'direction', 'entryPrice', 'exitPrice',
      'result', 'profitLoss', 'gapFlag', 'candleDelta',
      'rsi_m2', 'rsi_m1', 'rsi_0', 'k_m1', 'k_0', 'd_0',
      'ma6_0', 'ma14_0', 'ma50_0', 'maTrendBps', 'stackType',
      'g1_rsiBaseline', 'g2_rsiRecovery', 'g3_kTurn',
      'g4_dPosition', 'g5_maStack', 'g6_kdCross', 'g7_maTrendWeak'
    ];
    const esc = v => v == null ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    const csvLines = [csvColumns.join(',')];
    for (const s of signals) csvLines.push(csvColumns.map(c => esc(s[c])).join(','));
    fs.writeFileSync(CSV_PATH, csvLines.join('\n'));
    console.log(`\nCSV written: ${CSV_PATH} (${signals.length} rows)`);
    console.log(`Report written: ${REPORT_PATH}`);

  } catch (err) {
    console.error('ERROR:', err);
  }
}

runTest();
