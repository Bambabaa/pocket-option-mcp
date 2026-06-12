'use strict';
/**
 * test_parity.js — proves the native JS gate reproduces Python's p_decay to <1e-9.
 *
 * Reads parity_test_cases.json (feature_order + cases[{x, p_decay}]), reconstructs each
 * feature vector by name, runs evaluateOnset(), and compares js p_decay vs python p_decay.
 * Throws a hard error on any drift > 1e-9; otherwise prints a success line.
 */
const fs = require('fs');
const path = require('path');
const { evaluateOnset } = require('./test_gate.js');

const TOL = 1e-9;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity_test_cases.json'), 'utf8'));
const order = data.feature_order;
const n = data.cases.length;

let maxDrift = 0;
let fails = 0;

for (let i = 0; i < n; i++) {
  const cse = data.cases[i];
  const cf = {};
  for (let j = 0; j < order.length; j++) cf[order[j]] = cse.x[j];

  const res = evaluateOnset(cf);
  const drift = Math.abs(res.p_decay - cse.p_decay);
  if (drift > maxDrift) maxDrift = drift;
  if (drift > TOL) {
    fails++;
    console.error(`FAIL case ${i}: js=${res.p_decay} py=${cse.p_decay} drift=${drift.toExponential(3)}`);
  }
}

if (fails > 0) {
  throw new Error(`PARITY FAILED: ${fails}/${n} cases exceeded ${TOL} (max drift ${maxDrift.toExponential(3)})`);
}
console.log(`PARITY OK — ${n}/${n} cases within ${TOL} (max drift ${maxDrift.toExponential(3)})`);
