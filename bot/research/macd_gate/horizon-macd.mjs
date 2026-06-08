'use strict';
/**
 * MACD GATE — HORIZON x DIRECTION SWEEP  (exploratory)
 * ---------------------------------------------------------------------------
 * For each MACD leg (LogReg, GB stumps), sweeps expiry horizons 5/10/15/20/30m
 * and reports realized WR for BOTH directions:
 *     FADE         = bet against the recent 3-bar move (the SOP decay direction)
 *     CONTINUATION = bet with it (the inversion)
 *
 * ⚠ READ THIS BEFORE TRUSTING ANY HIGH NUMBER:
 *   continuation_WR ≡ 1 − fade_WR on the same decided bars (a tautology, not an
 *   independent edge). The honest signal is the AUC, which is DIRECTION-INVARIANT.
 *   With AUC ≈ 0.50 (random) at every horizon, BOTH directions are noise — a high
 *   continuation WR is just "1 − a low fade WR" on small n. Per RESEARCH_PROCEDURE.md
 *   Step 6/8: the AUC is the truth, and "follow is never correct for a decay model."
 *
 * Trained 13 pairs only. allowLive=true used purely to read scores (no capital).
 * Run: node horizon-macd.mjs [db1 db2 ...]   (defaults to the 3 June snapshots)
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
const H = [1, 2, 3, 4, 6];                 // bars -> 5/10/15/20/30 min
const GATE = gate.PARAMS.thresholds.gate;  // 0.65
const PAYOUT = 0.85, BE = 1 / (1 + PAYOUT);// 54.05%

function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z*z/n;
  const c = (p + z*z/(2*n)) / d, h = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d;
  return [c - h, c + h];
}
function fastAuc(arr) {                     // direction-invariant
  const a = arr.filter(x => x.y === 0 || x.y === 1).sort((x, y) => x.s - y.s);
  if (!a.length) return null;
  let i = 0, rankSum = 0, nP = 0, nN = 0;
  while (i < a.length) {
    let j = i; while (j < a.length && a[j].s === a[i].s) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) { if (a[k].y === 1) { rankSum += avg; nP++; } else nN++; }
    i = j;
  }
  return (nP && nN) ? (rankSum - nP*(nP+1)/2) / (nP*nN) : null;
}

// ── replay: one record per scored bar, with per-horizon fade outcome + label ──
const recs = [];
for (const file of DBS) {
  const db = new Database(file, { readonly: true });
  const rows = db.prepare('SELECT timestamp,asset,open,high,low,close FROM candles ORDER BY asset ASC, timestamp ASC').all();
  db.close();
  const byA = new Map();
  for (const r of rows) { if (!byA.has(r.asset)) byA.set(r.asset, []); byA.get(r.asset).push(r); }
  const pos = new Map();
  for (const [a, arr] of byA) { arr.sort((x, y) => x.timestamp - y.timestamp); arr.forEach((r, p) => pos.set(a + '|' + r.timestamp, p)); }
  gate.resetState();
  for (const r of rows) {
    const res = gate.evaluateMacdGate({ asset: r.asset, open: r.open, high: r.high, low: r.low, close: r.close }, PAYOUT, { allowLive: true });
    if (!res) continue;
    const arr = byA.get(r.asset), p = pos.get(r.asset + '|' + r.timestamp);
    if (p < 3) continue;
    const recent = r.close - arr[p - 3].close;
    if (recent === 0) continue;
    const fadeDir = recent > 0 ? 'PUT' : 'CALL';
    const byH = {};
    for (const h of H) {
      if (p + h >= arr.length) { byH[h] = null; continue; }
      const fwd = arr[p + h].close - r.close, flat = fwd === 0, up = fwd > 0;
      byH[h] = { flat,
        fadeWin: flat ? null : ((fadeDir === 'CALL' && up) || (fadeDir === 'PUT' && !up)),
        label: flat ? null : (Math.sign(fwd) !== Math.sign(recent) ? 1 : 0) };
    }
    recs.push({ trained: TRAINED.has(r.asset), lr: res.logreg.score, gb: res.gb.score, byH });
  }
}
const T = recs.filter(r => r.trained);
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  MACD GATE — HORIZON x {FADE, CONTINUATION} SWEEP (exploratory)    ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log(`trained-pair scored bars: ${T.length}  | gate>=${GATE}  | BE WR=${(BE*100).toFixed(1)}%`);
console.log('NOTE: continuation_WR = 1 - fade_WR (tautology). AUC is direction-invariant = the truth.');

for (const [name, key] of [['MACD-LogReg', 'lr'], ['MACD-GB', 'gb']]) {
  console.log(`\n=== ${name} (gate>=${GATE}, trained pairs) ===`);
  console.log('  horizon |  n  | FADE WR  Wilson95   | CONT WR  Wilson95   |  AUC  | either clears BE?');
  for (const h of H) {
    const fired = T.filter(r => r[key] >= GATE && r.byH[h] && !r.byH[h].flat);
    const n = fired.length;
    const fw = fired.filter(r => r.byH[h].fadeWin).length;     // fade wins
    const cw = n - fw;                                          // continuation wins = the rest
    const [flo, fhi] = n ? wilson(fw, n) : [NaN, NaN];
    const [clo, chi] = n ? wilson(cw, n) : [NaN, NaN];
    // AUC over the FULL population at this horizon (not the gated subset) — the honest, n-robust discrimination
    const auc = fastAuc(T.filter(r => r.byH[h]).map(r => ({ s: r[key], y: r.byH[h].label })));
    const clears = n && (flo > BE || clo > BE) ? 'yes*' : 'no';
    if (!n) { console.log(`  ${String(h*5).padStart(3)}min  |  0  | (no fires)`); continue; }
    const f = `${(100*fw/n).toFixed(0)}% [${(flo*100).toFixed(0)},${(fhi*100).toFixed(0)}]`.padEnd(18);
    const c = `${(100*cw/n).toFixed(0)}% [${(clo*100).toFixed(0)},${(chi*100).toFixed(0)}]`.padEnd(18);
    console.log(`  ${String(h*5).padStart(3)}min  | ${String(n).padStart(3)} | ${f} | ${c} | ${auc==null?' -- ':auc.toFixed(3)} | ${clears}`);
  }
}
console.log('\n* "clears BE" ignores that AUC~0.50 makes it noise; a continuation Wilson-LB>BE on n~10–14');
console.log('  with AUC 0.50 is the SOP Step-6 small-n trap, NOT a deployable edge.');
