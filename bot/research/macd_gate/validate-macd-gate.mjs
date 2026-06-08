'use strict';
/**
 * MACD GATE — OUT-OF-SAMPLE HOLDOUT VALIDATION  (RESEARCH_PROCEDURE.md Step 9)
 * ---------------------------------------------------------------------------
 * Companion to test-macd-gate.mjs (Step 10 parity). This one measures whether
 * the gate actually PREDICTS: scores the deployed model on later, non-overlapping
 * June sessions and reports realized 15m fade WR + AUC against the 0.636 ceiling.
 *
 * SOP rules enforced here:
 *   - Per-asset, leak-safe positional lookback (Step 1/3).
 *   - 3-class labelling: flats (forward==0) excluded from WR denominator (Step 2).
 *   - Direction = FADE, always (Step 8).
 *   - Threshold sweep [0.60..0.85] with Wilson-95 CI + break-even payout (Step 6).
 *   - 13 trained pairs only; novel assets reported separately (Step 1 #2).
 *   - Economic bar: payout 0.85 -> break-even WR 54.05% (Step 0).
 *
 * Data is read from <repo>/data — resolved relative to this file so the test runs
 * from any cwd. Override with: node validate-macd-gate.mjs <db1> <db2> ...
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gate = require('./macd-gate.js');

const REPO = path.resolve(__dirname, '../../..');
const DATA = path.join(REPO, 'data');
const DEFAULT_DBS = ['trading_data_5-02.db', 'trading_data_5-03.db', 'trading_data_5-04_6.db'];
const DBS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DBS)
  .map(f => (path.isAbsolute(f) ? f : path.join(DATA, f)));

const TRAINED = new Set(['AUDCAD','AUDCHF','AUDJPY','CADCHF','CADJPY','CHFJPY',
  'EURAUD','EURCHF','EURJPY','EURUSD','USDCAD','USDCHF','USDJPY']);
const THRESHOLDS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85];
const PAYOUT = 0.85, BE_WR = 1 / (1 + PAYOUT);          // 54.05%
const CEILING = 0.636;

// ── stats helpers ───────────────────────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z*z/n;
  const c = (p + z*z/(2*n)) / d;
  const h = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d;
  return [c - h, c + h];
}
const bePayout = (wr) => (wr > 0 ? (1 - wr) / wr : Infinity);
function auc(scored) {                                    // [{s, y}], y in {0,1}
  const pos = scored.filter(x => x.y === 1), neg = scored.filter(x => x.y === 0);
  if (!pos.length || !neg.length) return null;
  let c = 0;
  for (const p of pos) for (const n of neg) c += p.s > n.s ? 1 : p.s === n.s ? 0.5 : 0;
  return c / (pos.length * neg.length);
}

// ── load + replay one DB into scored records ────────────────────────────────
function collect(file) {
  const db = new Database(file, { readonly: true });
  const rows = db.prepare(
    'SELECT timestamp, asset, open, high, low, close FROM candles ORDER BY asset ASC, timestamp ASC'
  ).all();
  db.close();
  const byAsset = new Map();
  for (const r of rows) { if (!byAsset.has(r.asset)) byAsset.set(r.asset, []); byAsset.get(r.asset).push(r); }
  const pos = new Map();
  for (const [a, arr] of byAsset) { arr.sort((x, y) => x.timestamp - y.timestamp); arr.forEach((r, p) => pos.set(a + '|' + r.timestamp, p)); }

  gate.resetState();
  const recs = [];
  for (const r of rows) {
    const res = gate.evaluateMacdGate({ asset: r.asset, open: r.open, high: r.high, low: r.low, close: r.close }, PAYOUT, { allowLive: true });
    if (!res) continue;
    const arr = byAsset.get(r.asset), p = pos.get(r.asset + '|' + r.timestamp);
    if (p < 3 || p + 3 >= arr.length) continue;
    const recent = r.close - arr[p - 3].close;
    const forward = arr[p + 3].close - r.close;
    if (recent === 0) continue;                            // flat entry move -> ambiguous direction
    const flat = forward === 0;                            // 3-class: refund, excluded from WR
    const label = flat ? null : (Math.sign(forward) !== Math.sign(recent) ? 1 : 0);
    const fadeDir = recent > 0 ? 'PUT' : 'CALL';           // SOP Step 8: fade always
    const up = forward > 0;
    const fadeWin = flat ? null : ((fadeDir === 'CALL' && up) || (fadeDir === 'PUT' && !up));
    recs.push({ asset: r.asset, trained: TRAINED.has(r.asset),
      lr: res.logreg.score, gb: res.gb.score, label, flat, fadeWin });
  }
  return recs;
}

// ── threshold sweep for one model on a record subset ────────────────────────
function sweep(recs, scoreKey) {
  const out = [];
  for (const thr of THRESHOLDS) {
    const fired = recs.filter(r => r[scoreKey] >= thr);
    const decided = fired.filter(r => !r.flat);            // exclude flats from WR
    const wins = decided.filter(r => r.fadeWin).length;
    const n = decided.length;
    const wr = n ? wins / n : null;
    const [lo, hi] = n ? wilson(wins, n) : [NaN, NaN];
    out.push({ thr, fired: fired.length, flats: fired.length - decided.length, n, wr, lo, hi,
      cap: recs.length ? fired.length / recs.length : 0, be: wr != null ? bePayout(wr) : null });
  }
  return out;
}
function printSweep(rows, label) {
  console.log(`\n  ${label}`);
  console.log('  thr  | fired(flats) | capture | gated WR (n) | Wilson95         | BE payout | deploy?');
  for (const r of rows) {
    if (r.n === 0) { console.log(`  ${r.thr.toFixed(2)} | ${String(r.fired).padStart(5)}(${r.flats}) |  ${(r.cap*100).toFixed(1)}% | —            | —                | —        | no(0 fires)`); continue; }
    const pass = r.lo > BE_WR ? 'YES' : 'no';
    console.log(`  ${r.thr.toFixed(2)} | ${String(r.fired).padStart(5)}(${r.flats}) |  ${(r.cap*100).toFixed(1)}% | ${(r.wr*100).toFixed(1)}% (n=${r.n}) | [${(r.lo*100).toFixed(1)},${(r.hi*100).toFixed(1)}] | ${(r.be*100).toFixed(0)}% | ${pass}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  MACD GATE — OOS HOLDOUT VALIDATION (SOP Step 9)                   ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log(`payout=${PAYOUT}  break-even WR=${(BE_WR*100).toFixed(2)}%  AUC ceiling=${CEILING}  status=${gate.PARAMS.status}`);

let all = [];
for (const db of DBS) {
  const recs = collect(db);
  all = all.concat(recs);
  console.log(`  loaded ${path.basename(db)}: ${recs.length} scored bars`);
}
const trained = all.filter(r => r.trained);
const novel = all.filter(r => !r.trained);
console.log(`\nTotal scored: ${all.length}  | trained-pair: ${trained.length}  | novel: ${novel.length}`);

// AUC (trained pairs, the deployable universe) — vs ceiling
const labelled = trained.filter(r => r.label !== null);
const lrAuc = auc(labelled.map(r => ({ s: r.lr, y: r.label })));
const gbAuc = auc(labelled.map(r => ({ s: r.gb, y: r.label })));
console.log('\n── AUC vs actual 3-bar reversal (trained pairs, holdout) ──');
const verdict = (a) => a == null ? 'n/a' : a >= CEILING + 0.005 ? 'BREAKS ceiling' : Math.abs(a - CEILING) <= 0.005 ? 'matches' : 'below';
console.log(`  LogReg AUC = ${lrAuc?.toFixed(4)}  (param OOS ${gate.PARAMS.oos_auc.logreg})  -> ${verdict(lrAuc)}`);
console.log(`  GB     AUC = ${gbAuc?.toFixed(4)}  (param OOS ${gate.PARAMS.oos_auc.gb_stumps})  -> ${verdict(gbAuc)}   [0.5=random]`);

// threshold sweeps (trained pairs)
console.log('\n── Threshold sweep — TRAINED pairs, FADE direction, flats excluded ──');
printSweep(sweep(trained, 'lr'), 'LogReg');
printSweep(sweep(trained, 'gb'), 'GB stumps');

// Go/No-Go summary
const gateThr = gate.PARAMS.thresholds.gate;
const lrAtGate = sweep(trained, 'lr').find(r => Math.abs(r.thr - gateThr) < 1e-9);
console.log('\n── GO / NO-GO (SOP Step 12) ──');
const aucOK = (lrAuc != null && lrAuc >= CEILING) || (gbAuc != null && gbAuc >= CEILING);
const wrOK = lrAtGate && lrAtGate.n > 0 && lrAtGate.lo > BE_WR;
console.log(`  [${aucOK ? 'x' : ' '}] OOS AUC at/above ceiling (${CEILING})`);
console.log(`  [${wrOK ? 'x' : ' '}] Gated WR Wilson lower bound > ${(BE_WR*100).toFixed(2)}% at gate ${gateThr}`);
console.log(`\n  VERDICT: ${aucOK && wrOK ? '✓ candidate for live (recheck full Step 12 checklist)' : '✗ SHADOW ONLY — does not clear the bar'}`);
console.log(`  (status guard in macd-gate.js keeps approved=false without allowLive — correct)\n`);
