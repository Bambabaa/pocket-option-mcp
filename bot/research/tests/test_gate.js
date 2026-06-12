'use strict';
/**
 * test_gate.js — native Node implementation of the Two-Key static-decay-gate/v2.
 *
 * Exports evaluateOnset(currentFeatures): runs Key 1 (heuristic indicator-threshold
 * confluence, with side-normalized fold) then Key 2 (L2-logistic p_decay), both from
 * the frozen ml_gate_params.json. No Python at runtime.
 *
 * currentFeatures: a plain object keyed by engineered-feature name (the ml_model.features
 *   names). For side-normalized heuristic terms it also reads `side`
 *   ('bullish_exhaustion' | 'bearish_exhaustion'); absent → bullish frame (sign +1).
 *
 * Note: p_decay is computed unconditionally and returned in EVERY result (incl. the
 * Heuristic Trap) so it can be logged live and validated by the parity harness.
 */
const fs = require('fs');
const path = require('path');

const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ml_gate_params.json'), 'utf8'));

function sideSign(cf) {
  if (cf.side === 'bearish_exhaustion') return -1;
  if (typeof cf._side_sign === 'number') return cf._side_sign;
  return 1; // default bullish frame (parity cases carry no side; fold doesn't affect p_decay)
}

function passes(value, operator, threshold) {
  switch (operator) {
    case '>':  return value >  threshold;
    case '<':  return value <  threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    default:   throw new Error('unknown operator: ' + operator);
  }
}

// Key 2 — standardize each feature then logistic sigmoid. Undefined → contributes 0.
function pDecay(cf) {
  const m = PARAMS.ml_model;
  let score = m.bias;
  for (let i = 0; i < m.features.length; i++) {
    const raw = cf[m.features[i]];
    const z = (raw === undefined || raw === null)
      ? 0
      : (raw - m.scaler.means[i]) / m.scaler.scales[i];
    score += z * m.weights[i];
  }
  return 1 / (1 + Math.exp(-score));
}

function evaluateOnset(currentFeatures) {
  const sign = sideSign(currentFeatures);

  // ---- Key 1: heuristic confluence (side-normalized fold where flagged) ----
  let heuristicPass = true;
  for (const r of PARAMS.heuristic_rule) {
    let v = currentFeatures[r.feature];
    if (r.side_normalized) {
      const c = r.center || 0;
      v = c + sign * (v - c);
    }
    if (!passes(v, r.operator, r.threshold)) { heuristicPass = false; break; }
  }

  // ---- Key 2: ML gate (always computed) ----
  const p_decay = pDecay(currentFeatures);

  if (!heuristicPass) return { execute: false, p_decay, reason: 'Heuristic Trap' };
  if (p_decay >= PARAMS.oos_threshold) return { execute: true, p_decay, reason: 'Q1 Consensus' };
  return { execute: false, p_decay, reason: 'Model Abstention' };
}

module.exports = { evaluateOnset, pDecay, PARAMS };
