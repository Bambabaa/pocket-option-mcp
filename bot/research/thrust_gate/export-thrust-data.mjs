'use strict';
/**
 * THRUST GATE — DATA EXPORT for further analysis.
 *
 * Dumps every bar (trained pairs, both regimes) with the thrust features, the XGBoost score,
 * the squeeze flags, the continuation direction, and the 15-min outcome -> CSV.
 * Filter on squeeze_release==1 for the gate's actual domain; the rest is there for context
 * (score distribution on/off squeeze, calibration, per-asset/per-regime breakdowns, etc.).
 *
 * Read-only. Output: thrust_signals.csv  (override path: node export-thrust-data.mjs out.csv)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gate = require('./thrust-xgb-gate.js');

const REPO = path.resolve(__dirname, '../../..');
const DATA = path.join(REPO, 'data');
const OUT = path.isAbsolute(process.argv[2] || '') ? process.argv[2] : path.join(__dirname, process.argv[2] || 'thrust_signals.csv');
const TRAINED = new Set(['AUDCAD','AUDCHF','AUDJPY','CADCHF','CADJPY','CHFJPY',
  'EURAUD','EURCHF','EURJPY','EURUSD','USDCAD','USDCHF','USDJPY']);

const SQL_AGENT = `SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.keltner_upper AS kc_upper, i.keltner_lower AS kc_lower, i.keltner_middle AS kc_middle,
  i.plus_di, i.minus_di, i.williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp ORDER BY c.asset,c.timestamp`;
const SQL_SNAP = `SELECT c.timestamp,c.asset,c.close, i.bb_upper,i.bb_lower,
  i.kc_upper,i.kc_lower,i.kc_middle, i.adx_plus_di AS plus_di, i.adx_minus_di AS minus_di,
  i.williams_14 AS williams_r, i.atr_14
  FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp ORDER BY c.asset,c.timestamp`;

const SOURCES = [
  ['MAY', 'agent.db', SQL_AGENT, 1],                     // in_sample = 1 (model fit here)
  ['JUN', 'trading_data_5-02.db', SQL_SNAP, 0],
  ['JUN', 'trading_data_5-03.db', SQL_SNAP, 0],
  ['JUN', 'trading_data_5-04_6.db', SQL_SNAP, 0],
];

const HEADERS = ['regime','source','in_sample','asset','timestamp','datetime','prev_close','close','close_p3',
  'bb_width','kc_width','squeeze_on','squeeze_release','Thrust_dir','F_macro','xgb_score',
  'thrust_move','direction','forward3','target_continuation'];

const rows = [HEADERS.join(',')];
let total = 0, sqr = 0;
for (const [regime, fname, sql, inSample] of SOURCES) {
  const fp = path.join(DATA, fname);
  if (!fs.existsSync(fp)) continue;
  const db = new Database(fp, { readonly: true });
  const data = db.prepare(sql).all(); db.close();
  const byAsset = new Map();
  for (const r of data) { if (!TRAINED.has(r.asset)) continue; if (!byAsset.has(r.asset)) byAsset.set(r.asset, []); byAsset.get(r.asset).push(r); }
  for (const arr of byAsset.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < arr.length; i++) {
      const b = arr[i], p = arr[i - 1];
      const bbW = b.bb_upper - b.bb_lower, kcW = b.kc_upper - b.kc_lower;
      const sqOn = bbW < kcW, prevSqOn = (p.bb_upper - p.bb_lower) < (p.kc_upper - p.kc_lower);
      const sqRel = prevSqOn && !sqOn;
      const f = gate.computeThrustFeatures(b, p);
      if (!Number.isFinite(f.Thrust_dir) || !Number.isFinite(f.F_macro)) continue;
      const score = gate.scoreXGB(f);
      const move = b.close - p.close;
      const dir = move > 0 ? 'CALL' : move < 0 ? 'PUT' : '';
      const c3 = i + 3 < arr.length ? arr[i + 3].close : null;
      const fwd = c3 != null ? c3 - b.close : null;
      let tgt = '';
      if (fwd != null && fwd !== 0 && move !== 0) tgt = (Math.sign(fwd) === Math.sign(move)) ? 1 : 0;
      rows.push([
        regime, fname, inSample, b.asset, b.timestamp, new Date(b.timestamp * 1000).toISOString(),
        p.close, b.close, c3 ?? '', bbW.toFixed(6), kcW.toFixed(6), sqOn ? 1 : 0, sqRel ? 1 : 0,
        f.Thrust_dir.toFixed(6), f.F_macro.toFixed(6), score.toFixed(6),
        move.toFixed(6), dir, fwd != null ? fwd.toFixed(6) : '', tgt,
      ].join(','));
      total++; if (sqRel) sqr++;
    }
  }
}
fs.writeFileSync(OUT, rows.join('\n') + '\n', 'utf-8');
console.log(`✓ wrote ${total.toLocaleString()} bars (${sqr.toLocaleString()} squeeze-release) -> ${OUT}`);
console.log(`  columns: ${HEADERS.length} | filter squeeze_release=1 for the gate domain | in_sample=1 is MAY (overfit)`);
