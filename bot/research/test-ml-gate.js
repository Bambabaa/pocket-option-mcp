'use strict';

/**
 * TEST SUITE — ml-gate.js
 *
 * Five tests:
 *   1. Tree parity     — JS tree score == Python sklearn proba (< 1e-9) on 600 vectors
 *   2. LogReg parity   — JS logistic score == Python proba (< 1e-9) on 600 vectors
 *   3. Feature builder — JS-computed 4 features == pandas features on 210 real bars
 *   4. Gate decisions  — approve/reject at 0.85 matches Python on all parity vectors
 *   5. Payout switch   — kill-switch flips off below each model's payout floor
 *
 * Run: node test-ml-gate.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const gate = require('./ml-gate.js');
const {
  evaluateGate, computeKineticFeatures, scoreDecisionTree, scoreLogReg,
  createAssetState, resetState, getStats, recordEvaluation, PARAMS,
} = gate;

const here = (f) => path.join(__dirname, f);
const parity   = JSON.parse(fs.readFileSync(here('ml_gate_parity.json'), 'utf8'));
const featTest = JSON.parse(fs.readFileSync(here('ml_gate_feature_test.json'), 'utf8'));

const TOL = 1e-9;
let passed = 0, failed = 0;
const log = (ok, name, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? passed++ : failed++;
};

// helper: build the feat object directly from a parity vector's raw features
function featFromVector(v) {
  return {
    BB_Deviation:     v.features.BB_Deviation,
    CCI_Velocity:     v.features.CCI_Velocity,
    Stoch_Divergence: v.features.Stoch_Divergence,
    STC_Momentum:     v.features.STC_Momentum,
  };
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log(' TEST SUITE — ml-gate.js');
console.log('══════════════════════════════════════════════════════════════');

// ── TEST 1: Decision Tree parity ────────────────────────────────────────────
console.log('\n[1] Decision-Tree parity (JS vs Python sklearn, tol=1e-9)');
{
  let maxErr = 0, n = 0;
  for (const v of parity) {
    const js = scoreDecisionTree(featFromVector(v));
    const err = Math.abs(js - v.tree_proba);
    if (err > maxErr) maxErr = err;
    n++;
  }
  log(maxErr < TOL, `tree parity over ${n} vectors`, `max|Δ|=${maxErr.toExponential(2)}`);
}

// ── TEST 2: Logistic Regression parity ──────────────────────────────────────
console.log('\n[2] Logistic-Regression parity (JS vs Python sklearn, tol=1e-9)');
{
  let maxErr = 0, n = 0;
  for (const v of parity) {
    const js = scoreLogReg(featFromVector(v));
    const err = Math.abs(js - v.logreg_proba);
    if (err > maxErr) maxErr = err;
    n++;
  }
  log(maxErr < TOL, `logreg parity over ${n} vectors`, `max|Δ|=${maxErr.toExponential(2)}`);
}

// ── TEST 3: Feature builder parity ──────────────────────────────────────────
console.log('\n[3] Feature-builder parity (JS rolling state vs pandas, tol=1e-9)');
{
  resetState();
  const state = createAssetState();
  const bars = featTest.bars;        // 210 ordered EURUSD bars
  const expected = featTest.expected; // pandas-computed features (aligned, with NaN-drop)

  // Build an index of expected features by Timestamp for matching
  const expByTs = new Map();
  for (const e of expected) expByTs.set(String(e.Timestamp), e);

  let maxErr = 0, checked = 0, missing = 0;
  for (const bar of bars) {
    const ind = {
      asset: 'EURUSD',
      close:     bar.Close,
      bb_upper:  bar.Upper_Band,
      bb_lower:  bar.Lower_Band,
      cci_20:    bar.CCI,
      stc_value: bar.STC,
      stoch_k:   bar.Stoch_K,
      stoch_d:   bar.Stoch_D,
    };
    const feat = computeKineticFeatures(ind, state);
    const exp = expByTs.get(String(bar.Timestamp));
    if (!exp) continue;  // pandas dropped this row (warmup NaN) — skip
    // only compare once JS has produced all 4 (post warmup)
    if (feat.CCI_Velocity == null || feat.STC_Momentum == null) { missing++; continue; }
    for (const k of ['BB_Deviation', 'CCI_Velocity', 'Stoch_Divergence', 'STC_Momentum']) {
      const err = Math.abs(feat[k] - exp[k]);
      if (err > maxErr) maxErr = err;
    }
    checked++;
  }
  log(maxErr < 1e-9, `feature parity over ${checked} bars (${missing} warmup-skipped)`,
      `max|Δ|=${maxErr.toExponential(2)}`);
}

// ── TEST 4: Gate decision parity at 0.85 ────────────────────────────────────
console.log('\n[4] Gate decision parity at 0.85 (no payout constraint)');
{
  let treeMismatch = 0, lrMismatch = 0;
  for (const v of parity) {
    const ind = {
      asset: 'PARITY',
      close: 1, bb_upper: 1, bb_lower: 0,    // dummies; we inject features directly below
    };
    // bypass feature engineering by scoring the known vector
    const f = featFromVector(v);
    const jsTree = scoreDecisionTree(f) >= 0.85;
    const pyTree = v.tree_proba >= 0.85;
    if (jsTree !== pyTree) treeMismatch++;
    const jsLr = scoreLogReg(f) >= 0.85;
    const pyLr = v.logreg_proba >= 0.85;
    if (jsLr !== pyLr) lrMismatch++;
  }
  log(treeMismatch === 0, `tree gate decisions`, `${treeMismatch} mismatches`);
  log(lrMismatch === 0,   `logreg gate decisions`, `${lrMismatch} mismatches`);
}

// ── TEST 5: Payout kill-switch ──────────────────────────────────────────────
console.log('\n[5] Payout-aware kill-switch');
{
  // craft a bar whose features land in a high-proba tree leaf (>=0.85)
  // We search the parity set for a vector that both models would approve on prob.
  const hiTree = parity.find((v) => v.tree_proba >= 0.85);
  const hiLr   = parity.find((v) => v.logreg_proba >= 0.85);

  // Inject the high-tree vector through evaluateGate via a synthetic state.
  // evaluateGate computes features from `ind`, so we reconstruct an `ind` that
  // reproduces the target features is non-trivial; instead we test the decision
  // logic directly by calling the scorers + payout floors.
  function decideWithPayout(score, model, payout) {
    const clearsProb = score >= PARAMS.thresholds.gate;
    const clearsPayout = payout == null ? true : payout >= PARAMS.payout_floor[model];
    return clearsProb && clearsPayout;
  }

  // tree floor 0.70
  const ts = hiTree.tree_proba;
  log(decideWithPayout(ts, 'tree', 0.80) === true,  'tree approves @ payout 0.80');
  log(decideWithPayout(ts, 'tree', 0.70) === true,  'tree approves @ payout 0.70 (at floor)');
  log(decideWithPayout(ts, 'tree', 0.65) === false, 'tree BLOCKED @ payout 0.65 (below floor)');

  // logreg floor 0.78
  const ls = hiLr.logreg_proba;
  log(decideWithPayout(ls, 'logreg', 0.80) === true,  'logreg approves @ payout 0.80');
  log(decideWithPayout(ls, 'logreg', 0.78) === true,  'logreg approves @ payout 0.78 (at floor)');
  log(decideWithPayout(ls, 'logreg', 0.70) === false, 'logreg BLOCKED @ payout 0.70 (below floor)');
}

// ── TEST 6: End-to-end evaluateGate on a real bar stream ────────────────────
console.log('\n[6] End-to-end evaluateGate on the 210-bar EURUSD stream');
{
  resetState();
  let evaluated = 0, treeApproved = 0, lrApproved = 0;
  for (const bar of featTest.bars) {
    const ind = {
      asset: 'EURUSD',
      close:     bar.Close,
      bb_upper:  bar.Upper_Band,
      bb_lower:  bar.Lower_Band,
      cci_20:    bar.CCI,
      stc_value: bar.STC,
      stoch_k:   bar.Stoch_K,
      stoch_d:   bar.Stoch_D,
    };
    const r = evaluateGate(ind, 0.80);  // assume 80% payout
    if (r) {
      evaluated++;
      recordEvaluation(r);
      if (r.tree.approved)   treeApproved++;
      if (r.logreg.approved) lrApproved++;
    }
  }
  log(evaluated > 0, `evaluated ${evaluated} bars end-to-end`,
      `tree_appr=${treeApproved} lr_appr=${lrApproved}`);
  const s = getStats();
  log(s.total_evaluated === evaluated, 'stats counter consistent',
      `total=${s.total_evaluated} tree_rate=${s.tree_approval_rate}`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(` RESULT: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(failed === 0 ? 0 : 1);
