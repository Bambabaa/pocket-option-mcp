'use strict';
/**
 * THRUST XGBOOST GATE — PARITY TEST (SOP Step 10)
 *   Score parity: JS scoreXGB reproduces Python predict_proba over real fixtures.
 *   XGBoost uses float32 internally, so the bar is 1e-5 (not 1e-9 like the linear gate).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const gate = require('./thrust-xgb-gate.js');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'thrust_xgb_fixtures.json'), 'utf-8'));
let maxErr = 0;
for (const row of fx) maxErr = Math.max(maxErr, Math.abs(gate.scoreXGB(row.features) - row.proba));

const TOL = 1e-5;
const pass = maxErr < TOL;
console.log(`\n[XGB parity] ${fx.length} fixtures, ${gate.PARAMS.n_trees} trees`);
console.log(`  ${pass ? '✓' : '✗'} JS vs Python  max|Δproba| = ${maxErr.toExponential(2)}  (tol ${TOL})`);
console.log(`  status=${gate.PARAMS.status}  (research/parity demo — not live)`);
console.log(pass ? '\n✓ PARITY PASSED' : '\n✗ PARITY FAILED');
process.exit(pass ? 0 : 1);
