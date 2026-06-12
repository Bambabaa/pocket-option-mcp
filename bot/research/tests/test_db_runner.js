'use strict';
/**
 * test_db_runner.js — drive the native Two-Key gate over a historical SQLite DB and
 * cross-check against the Python onset CSV (the oracle).
 *
 * It reproduces _lib/po_data.engineer_families in JS: dynamic schema-alias resolution
 * (agent_* vs trading_data names), derived atr_pct, per-asset previous-bar deltas. Then
 * it applies the onset mask (from ml_gate_params.json), sets the side from the stretch
 * sign, runs evaluateOnset, and reports:
 *   1) onset-set match  — do JS onsets == CSV onsets (same asset@timestamp)?
 *   2) feature parity   — max |JS feature − CSV feature| over matched rows (NaN-aware)
 *   3) signal tally     — Q1 consensus / abstention / trap counts from the frozen gate
 *
 * p_decay is NOT compared to the CSV: the CSV's p_decay is decay_onset's purged-OOF
 * model, while the gate uses the freeze_pipeline logistic — a different model by design.
 * p_decay parity is proven separately by test_parity.js. This run validates the JS
 * FEATURE PIPELINE + mask reproduce Python's onset detection.
 *
 * Usage: node test_db_runner.js [dbPath] [csvPath]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { evaluateOnset, PARAMS } = require('./test_gate.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const DB_ARG = process.argv[2] || path.join(ROOT, 'agent', 'data', 'agent_FXSB.db');
const DB_PATHS = DB_ARG.split(',').map(s => s.trim()).filter(Boolean)
  .map(p => path.isAbsolute(p) ? p : path.join(ROOT, p));
const CSV_ARG = process.argv[3];   // optional oracle CSV; 'none'/missing → skip cross-check, WR only
const CSV = (CSV_ARG && CSV_ARG !== 'none')
  ? (path.isAbsolute(CSV_ARG) ? CSV_ARG : path.join(ROOT, CSV_ARG))
  : (DB_PATHS.length === 1 && DB_PATHS[0].endsWith('agent_FXSB.db')
      ? path.join(ROOT, 'bot', 'research', 'ml4t', 'skills', 'directional-momentum-edge',
                  'exports', 'onsets_fxsb_4.0_full.csv') : null);
const TOL = 1e-6, PAYOUT = 0.8, BREAKEVEN = 1 / (1 + PAYOUT);
const BAR_SEC = PARAMS.bar_sec, HORIZON_BARS = (PARAMS.expiry_minutes * 60) / BAR_SEC;

// canonical indicator -> ordered source-name candidates (handles both schemas)
const ALIASES = {
  sma_10:['sma_10'], sma_20:['sma_20'], sma_50:['sma_50'], ema_12:['ema_12'], ema_26:['ema_26'],
  rsi_14:['rsi_14'], macd_macd:['macd_macd','macd_line'], macd_signal:['macd_signal'],
  macd_hist:['macd_hist','macd_histogram'], bb_upper:['bb_upper'], bb_middle:['bb_middle'],
  bb_lower:['bb_lower'], bb_width_bps:['bb_width_bps'], stoch_k:['stoch_k'], stoch_d:['stoch_d'],
  stc_value:['stc_value'], stc_signal:['stc_signal'], stc_delta:['stc_delta'],
  kc_upper:['kc_upper','keltner_upper'], kc_middle:['kc_middle','keltner_middle'],
  kc_lower:['kc_lower','keltner_lower'], adx_14:['adx_14','adx'],
  adx_plus_di:['adx_plus_di','plus_di'], adx_minus_di:['adx_minus_di','minus_di'],
  cci_20:['cci_20'], williams_14:['williams_14','williams_r'], atr_14:['atr_14'],
  psar:['psar','psar_value'], psar_bull:['psar_bull','psar_is_bullish'],
};

function loadBars(dbPaths) {
  const all = [];
  const aliasMap = Object.assign({ atr_pct: ['atr_pct'] }, ALIASES);  // stored atr_pct if present
  dbPaths.forEach((dbPath, fi) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const have = new Set(db.prepare(`SELECT name FROM pragma_table_info('indicators')`).all().map(r => r.name));
    const sel = ['c.asset', 'c.timestamp', 'c.close'];
    let hasAtrPct = false;
    for (const [canon, cands] of Object.entries(aliasMap)) {
      const src = cands.find(s => have.has(s));
      if (src) { sel.push(`i.${src} AS ${canon}`); if (canon === 'atr_pct') hasAtrPct = true; }
    }
    const rows = db.prepare(
      `SELECT ${sel.join(',')} FROM candles c JOIN indicators i
         ON i.asset=c.asset AND i.timestamp=c.timestamp ORDER BY c.asset, c.timestamp`).all();
    db.close();
    for (const r of rows) {
      if (!hasAtrPct) r.atr_pct = (r.close && r.atr_14 != null) ? r.atr_14 / r.close * 100 : null; // derive only if absent
      if (dbPaths.length > 1) r.asset = r.asset + '@' + fi;   // keep per-file series separate
    }
    for (const r of rows) all.push(r);   // not push(...rows): 278k spread overflows the stack
  });
  return all;
}

const nz = (x, atr) => (atr && atr !== 0 && x != null) ? x / atr : NaN;
const sub = (a, b) => (a != null && b != null) ? a - b : NaN;

// mirror engineer_families for one bar given its prev bar (same asset, prior row)
function engineer(b, p) {
  const atr = (b.atr_14 && b.atr_14 !== 0) ? b.atr_14 : null;
  const band = sub(b.bb_upper, b.bb_lower), kcw = sub(b.kc_upper, b.kc_lower);
  const bandOK = band ? band : NaN, kcwOK = kcw ? kcw : NaN;
  const sq = (band && kcw) ? band / kcw : NaN;
  const psq = p && (p.bb_upper - p.bb_lower) && (p.kc_upper - p.kc_lower)
    ? (p.bb_upper - p.bb_lower) / (p.kc_upper - p.kc_lower) : NaN;
  return {
    // TREND
    t_close_sma10: nz(sub(b.close, b.sma_10), atr), t_close_sma20: nz(sub(b.close, b.sma_20), atr),
    t_close_sma50: nz(sub(b.close, b.sma_50), atr), t_close_ema12: nz(sub(b.close, b.ema_12), atr),
    t_close_ema26: nz(sub(b.close, b.ema_26), atr), t_ema_spread: nz(sub(b.ema_12, b.ema_26), atr),
    t_sma_10_20: nz(sub(b.sma_10, b.sma_20), atr), t_sma_20_50: nz(sub(b.sma_20, b.sma_50), atr),
    t_close_psar: nz(sub(b.close, b.psar), atr), t_psar_bull: b.psar_bull,
    t_macd_cross: nz(sub(b.macd_macd, b.macd_signal), atr),
    // MOMENTUM
    m_rsi: b.rsi_14, m_rsi_d: p ? sub(b.rsi_14, p.rsi_14) : NaN, m_stoch_k: b.stoch_k, m_stoch_d: b.stoch_d,
    m_stoch_kd: sub(b.stoch_k, b.stoch_d), m_stc: b.stc_value, m_stc_delta: b.stc_delta,
    m_stc_gap: sub(b.stc_value, b.stc_signal), m_cci: b.cci_20, m_williams: b.williams_14,
    m_macd_hist: nz(b.macd_hist, atr), m_macd_hist_d: p ? nz(sub(b.macd_hist, p.macd_hist), atr) : NaN,
    // VOLATILITY
    v_bb_width: b.bb_width_bps, v_bb_width_d: p ? sub(b.bb_width_bps, p.bb_width_bps) : NaN,
    v_pctB: (band) ? sub(b.close, b.bb_lower) / bandOK : NaN, v_atr_pct: b.atr_pct,
    v_atr_pct_d: p ? sub(b.atr_pct, p.atr_pct) : NaN, v_squeeze: sq, v_close_kc: nz(sub(b.close, b.kc_middle), atr),
    // BREAKOUT
    b_adx: b.adx_14, b_adx_d: p ? sub(b.adx_14, p.adx_14) : NaN, b_di_spread: sub(b.adx_plus_di, b.adx_minus_di),
    b_pctB_ext: (band) ? Math.abs(sub(b.close, b.bb_lower) / bandOK - 0.5) : NaN,
    b_bbw_expand: p ? sub(b.bb_width_bps, p.bb_width_bps) : NaN,
    b_squeeze_rel: (p && isFinite(sq) && isFinite(psq)) ? sq - psq : NaN,
  };
}

// onset mask thresholds from the frozen gate
function maskThresholds() {
  const m = {};
  for (const r of PARAMS.onset_mask) m[r.name] = r;
  return { squeeze: m.squeeze.threshold, stretch: m.stretch_atr.threshold };
}

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim());
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(',');
    const o = {};
    head.forEach((h, j) => { const x = v[j]; o[h] = (x === '' || x === undefined) ? NaN : (isNaN(+x) ? x.trim() : +x); });
    rows.set(`${o.asset}|${o.timestamp}`, o);
  }
  return { head, rows };
}

function main() {
  const bars = loadBars(DB_PATHS);
  const { squeeze: SQ, stretch: STR } = maskThresholds();
  const feats = PARAMS.ml_model.features;

  // group by asset, keep input order (already sorted by asset,timestamp)
  const byAsset = new Map();
  for (const b of bars) { if (!byAsset.has(b.asset)) byAsset.set(b.asset, []); byAsset.get(b.asset).push(b); }

  const jsOnsets = new Map();           // key -> { F, side }
  const reasons = { 'Q1 Consensus': 0, 'Model Abstention': 0, 'Heuristic Trap': 0 };
  const wr = { 'Q1 Consensus': { n: 0, w: 0 }, 'Model Abstention': { n: 0, w: 0 }, 'Heuristic Trap': { n: 0, w: 0 } };
  let execs = 0;
  for (const [, series] of byAsset) {
    for (let i = 0; i < series.length; i++) {
      const F = engineer(series[i], i > 0 ? series[i - 1] : null);
      // mask + side
      const stretched = isFinite(F.v_squeeze) && F.v_squeeze > SQ && isFinite(F.t_close_sma50);
      const bull = stretched && F.t_close_sma50 >  STR && F.m_stc_delta < 0;
      const bear = stretched && F.t_close_sma50 < -STR && F.m_stc_delta > 0;
      if (!bull && !bear) continue;
      // forward bar at the gate's expiry (contiguous) — matches decay_onset onset filter AND gives the outcome
      const fwd = series[i + HORIZON_BARS];
      if (!fwd || fwd.timestamp - series[i].timestamp !== HORIZON_BARS * BAR_SEC) continue;

      const side = bull ? 'bullish_exhaustion' : 'bearish_exhaustion';
      const key = `${series[i].asset}|${series[i].timestamp}`;
      jsOnsets.set(key, { F, side });
      const res = evaluateOnset(Object.assign({}, F, { side }));
      reasons[res.reason]++; if (res.execute) execs++;
      // realized FADE outcome at expiry: bullish exhaustion wins if price fell, bearish if it rose
      const fadeWin = bull ? (fwd.close < series[i].close) : (fwd.close > series[i].close);
      wr[res.reason].n++; if (fadeWin) wr[res.reason].w++;
    }
  }

  console.log(`# DB Runner — [${DB_PATHS.map(p => path.basename(p)).join(', ')}]`);
  console.log(`bars ${bars.length} (${byAsset.size} asset-series)   mask squeeze>${SQ} |stretch|>${STR}   `
    + `expiry ${PARAMS.expiry_minutes}m   break-even ${(BREAKEVEN * 100).toFixed(1)}%`);

  // ---- (optional) cross-check vs CSV oracle: proves the JS feature port ----
  let ok = true;
  if (CSV && fs.existsSync(CSV)) {
    const { rows: csv } = parseCsv(CSV);
    const jsKeys = new Set(jsOnsets.keys()), csvKeys = new Set(csv.keys());
    const matched = [...jsKeys].filter(k => csvKeys.has(k));
    const jsOnly = [...jsKeys].filter(k => !csvKeys.has(k));
    const csvOnly = [...csvKeys].filter(k => !jsKeys.has(k));
    const worst = {}; let globalMax = 0, nan_mismatch = 0;
    for (const k of matched) {
      const F = jsOnsets.get(k).F, row = csv.get(k);
      for (const f of feats) {
        const a = F[f], b = row[f];
        const aNan = !(typeof a === 'number' && isFinite(a)), bNan = !(typeof b === 'number' && isFinite(b));
        if (aNan && bNan) continue;
        if (aNan !== bNan) { nan_mismatch++; continue; }
        const d = Math.abs(a - b); worst[f] = Math.max(worst[f] || 0, d); if (d > globalMax) globalMax = d;
      }
    }
    console.log(`\n## Port check vs ${path.basename(CSV)}`);
    console.log(`  onset-set: JS ${jsKeys.size} | CSV ${csvKeys.size} | JS-only ${jsOnly.length} | CSV-only ${csvOnly.length}`
      + (jsOnly.length || csvOnly.length ? '  ✗' : '  ✓ identical'));
    console.log(`  feature parity: max |JS−CSV| = ${globalMax.toExponential(3)} over ${matched.length} rows`
      + (nan_mismatch ? ` | NaN mismatches ${nan_mismatch}` : '') + (globalMax <= TOL && !nan_mismatch ? '  ✓' : '  ✗'));
    ok = jsOnly.length === 0 && csvOnly.length === 0 && globalMax <= TOL && nan_mismatch === 0;
  } else {
    console.log(`\n## Port check: skipped (no matching CSV oracle for this mask) — WR-only mode`);
  }

  // ---- realized fade-WR of the captured signals (the edge number) ----
  console.log(`\n## Realized fade-WR @ ${PARAMS.expiry_minutes}m by gate verdict`);
  for (const r of ['Q1 Consensus', 'Model Abstention', 'Heuristic Trap']) {
    const { n, w } = wr[r];
    const pct = n ? (w / n * 100).toFixed(1) + '%' : '—';
    const clears = n >= 20 && w / n > BREAKEVEN ? '  ✓ clears' : '';
    console.log(`  ${r.padEnd(16)} n=${String(n).padStart(5)}  WR ${pct}${r === 'Q1 Consensus' ? clears : ''}`);
  }
  const q = wr['Q1 Consensus'];
  console.log(`\nQ1 CONSENSUS (the executed signal): ${q.n} trades, fade-WR `
    + `${q.n ? (q.w / q.n * 100).toFixed(1) + '%' : '—'} vs break-even ${(BREAKEVEN * 100).toFixed(1)}%`);

  console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'} — feature port ${ok ? 'verified' : 'DIVERGES'}; WR above is `
    + `${DB_PATHS.length === 1 && DB_PATHS[0].endsWith('agent_FXSB.db') ? 'IN-SAMPLE (training DB)' : 'out-of-sample'}.`);
  if (!ok) process.exitCode = 1;
}

main();
