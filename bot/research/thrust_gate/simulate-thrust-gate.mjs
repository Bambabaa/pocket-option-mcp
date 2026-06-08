'use strict';
/**
 * THRUST GATE — VALIDATION SIMULATOR (mirrors bot/tests/signal-simulator.js)
 *
 * Runs the EXPORTED JS gate (thrust-xgb-gate.js) over historical data exactly as the bot
 * would, then validates each signal at the 15-min horizon (3 candle bars ahead, candle close).
 *
 * Gate logic: on a Squeeze_Release bar, score via XGBoost; if score >= threshold, take the
 * CONTINUATION direction (CALL if close[t]>close[t-1], else PUT). Win if price continues at +3 bars.
 *
 * The model was fit on agent.db (May). So:  agent = IN-SAMPLE,  snapshots = OUT-OF-SAMPLE (honest).
 * Read-only. Run: node simulate-thrust-gate.mjs
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gate = require('./thrust-xgb-gate.js');

const REPO = path.resolve(__dirname, '../../..');
const DATA = path.join(REPO, 'data');
const TRAINED = new Set(['AUDCAD','AUDCHF','AUDJPY','CADCHF','CADJPY','CHFJPY',
  'EURAUD','EURCHF','EURJPY','EURUSD','USDCAD','USDCHF','USDJPY']);
const THRESHOLDS = [0.55, 0.60, 0.65, 0.70];
const BE = 1 / 1.85;

// canonical column SQL per source
const SQL_AGENT = `SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.keltner_upper AS kc_upper, i.keltner_lower AS kc_lower, i.keltner_middle AS kc_middle,
  i.plus_di, i.minus_di, i.williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp ORDER BY c.asset,c.timestamp`;
const SQL_SNAP = `SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.kc_upper,i.kc_lower,i.kc_middle, i.adx_plus_di AS plus_di, i.adx_minus_di AS minus_di,
  i.williams_14 AS williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp ORDER BY c.asset,c.timestamp`;

function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k/n, d = 1 + z*z/n, c = (p + z*z/(2*n))/d, h = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d;
  return [c-h, c+h];
}

function loadByAsset(files) {
  const byAsset = new Map();
  for (const [fname, sql] of files) {
    const db = new Database(path.join(DATA, fname), { readonly: true });
    const rows = db.prepare(sql).all(); db.close();
    for (const r of rows) {
      if (!TRAINED.has(r.asset)) continue;
      const key = r.asset + '|' + fname;          // keep each day/source's series separate
      if (!byAsset.has(key)) byAsset.set(key, []);
      byAsset.get(key).push(r);
    }
  }
  for (const arr of byAsset.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return byAsset;
}

function simulate(files, label) {
  const byAsset = loadByAsset(files);
  // collect signals: {score, dir, win} at +3 bars
  const sigs = [];
  for (const arr of byAsset.values()) {
    for (let i = 1; i + 3 < arr.length; i++) {
      const f = gate.computeThrustFeatures(arr[i], arr[i - 1]);
      if (!f.squeeze_release) continue;
      if (!Number.isFinite(f.Thrust_dir) || !Number.isFinite(f.F_macro)) continue;
      const score = gate.scoreXGB(f);
      const move = arr[i].close - arr[i - 1].close;     // thrust direction
      if (move === 0) continue;
      const dir = move > 0 ? 'CALL' : 'PUT';            // CONTINUATION = follow the thrust
      const fwd = arr[i + 3].close - arr[i].close;
      if (fwd === 0) continue;                          // flat -> refund, drop
      const win = (dir === 'CALL' && fwd > 0) || (dir === 'PUT' && fwd < 0);
      sigs.push({ score, win });
    }
  }
  console.log(`\n===== ${label}  (squeeze-release signals scored: ${sigs.length}) =====`);
  console.log('| Threshold | Approved (n) | Gated Win Rate | Wilson95 | BE Payout Req |');
  console.log('|---|---|---|---|---|');
  for (const thr of THRESHOLDS) {
    const ap = sigs.filter(s => s.score >= thr);
    const n = ap.length, w = ap.filter(s => s.win).length;
    if (!n) { console.log(`| ${thr.toFixed(2)} | 0 | — | — | — |`); continue; }
    const wr = w/n, [lo, hi] = wilson(w, n), be = (1-wr)/wr;
    console.log(`| ${thr.toFixed(2)} | ${n} | ${(wr*100).toFixed(1)}% | [${(lo*100).toFixed(0)},${(hi*100).toFixed(0)}] | ${(be*100).toFixed(0)}% |`);
  }
}

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  THRUST XGBOOST GATE — VALIDATION SIMULATOR (15m horizon)      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`model status: ${gate.PARAMS.status}  | break-even WR = ${(BE*100).toFixed(1)}%`);
simulate([['agent.db', SQL_AGENT]], 'agent.db (MAY — IN-SAMPLE, model was fit here)');
simulate([['trading_data_5-02.db', SQL_SNAP], ['trading_data_5-03.db', SQL_SNAP], ['trading_data_5-04_6.db', SQL_SNAP]],
         'June snapshots (OUT-OF-SAMPLE — the honest validation)');
