'use strict';
/**
 * MACD GATE PARITY TEST
 *  [1] Score parity   — JS reproduces Python probas (1e-9)
 *  [2] Feature parity  — JS computeMacdFeatures reproduces Python features (1e-6)
 *  [3] Research-shadow guard + honest stats
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gate = require('./macd-gate.js');

const J = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf-8'));
let failures = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failures++; };

console.log('\n[1] Score parity (JS vs Python, 600 real fixtures)');
const fx = J('macd_gate_fixtures.json');
let maxLR = 0, maxGB = 0;
for (const row of fx) {
  maxLR = Math.max(maxLR, Math.abs(gate.scoreLogReg(row.features) - row.logreg));
  maxGB = Math.max(maxGB, Math.abs(gate.scoreGBStumps(row.features) - row.gb));
}
ok(maxLR < 1e-9, `LogReg  max|Δ| = ${maxLR.toExponential(2)}`);
ok(maxGB < 1e-9, `GB      max|Δ| = ${maxGB.toExponential(2)}`);

console.log('\n[2] Feature parity (JS recompute vs Python, EURUSD full series)');
const ff = J('macd_feature_fixtures.json');
gate.resetState();
const expByTs = new Map(ff.expected.map(e => [e.timestamp, e]));
const FEATS = gate.PARAMS.features;
let maxFeatErr = 0, checked = 0;
for (const bar of ff.bars) {
  const f = gate.computeMacdFeatures({ asset: ff.asset, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  const exp = expByTs.get(bar.timestamp);
  if (f && exp) { for (const k of FEATS) maxFeatErr = Math.max(maxFeatErr, Math.abs(f[k] - exp[k])); checked++; }
}
ok(maxFeatErr < 1e-6, `features  max|Δ| = ${maxFeatErr.toExponential(2)}  (${checked} bars checked)`);

console.log('\n[3] Research-shadow guard + approval stats');
gate.resetState();
let liveApprovals = 0, shadowPass = 0;
for (const bar of ff.bars) {
  const r = gate.evaluateMacdGate({ asset: ff.asset, ...bar }, 0.80);
  if (r) { if (r.logreg.approved || r.gb.approved) liveApprovals++;
           if (r.logreg.score >= gate.PARAMS.thresholds.gate) shadowPass++; }
}
ok(liveApprovals === 0, `live approvals with allowLive=false: ${liveApprovals} (must be 0)`);
console.log(`    LogReg scores ≥ gate (would-fire in shadow): ${shadowPass}`);
console.log(`    status=${gate.PARAMS.status}  OOS_AUC=${JSON.stringify(gate.PARAMS.oos_auc)}`);

console.log(`\n${failures === 0 ? '✓ ALL PARITY CHECKS PASSED' : '✗ ' + failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
