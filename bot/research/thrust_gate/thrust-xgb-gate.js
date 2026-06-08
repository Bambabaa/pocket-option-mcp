'use strict';
/**
 * Thrust XGBoost Continuation Gate — JS port (RESEARCH_SHADOW).
 *
 * Reproduces the exported XGBoost ensemble (thrust_xgb_params.json) bit-for-bit
 * (float32 precision). Walks the real dumped trees: at each node go LEFT if
 * x[feature] < threshold, else RIGHT (missing -> node.d). proba = sigmoid(base + Σ leaves).
 *
 * ⚠ This model is a confirmed single-regime overfit (June 65% / May 45%). Export/parity
 *   demo only — NOT wired for live. There is no allowLive path.
 *
 * Features (contemporaneous, causal):
 *   Thrust_dir = |plus_di - minus_di| * williams_r
 *   F_macro    = (close - keltner_middle) / atr_14
 * Squeeze_Release (1-bar state) gates WHICH bars are scored, not the score itself.
 */
const fs = require('fs');
const path = require('path');

const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'thrust_xgb_params.json'), 'utf-8'));

// XGBoost evaluates splits in float32. Math.fround replicates that exactly; comparing in
// float64 flips branches at boundaries and breaks parity.
function walkTree(node, x) {
  while (node.leaf === undefined) {
    const v = x[node.f];
    node = (v == null || Number.isNaN(v))
      ? (node.d === 'l' ? node.l : node.r)
      : (Math.fround(v) < Math.fround(node.t) ? node.l : node.r);
  }
  return node.leaf;
}

// score from a feature object {Thrust_dir, F_macro} -> P(continuation)
function scoreXGB(feat) {
  const x = PARAMS.features.map((name) => feat[name]);
  let raw = PARAMS.base;
  for (const t of PARAMS.trees) raw += walkTree(t, x);
  return 1 / (1 + Math.exp(-raw));
}

// contemporaneous feature computation from a closed bar + previous bar (for squeeze state)
function computeThrustFeatures(bar, prevBar) {
  const bbW = bar.bb_upper - bar.bb_lower;
  const kcW = bar.kc_upper - bar.kc_lower;
  const squeezeOn = bbW < kcW;
  const prevSqueezeOn = prevBar ? (prevBar.bb_upper - prevBar.bb_lower) < (prevBar.kc_upper - prevBar.kc_lower) : false;
  return {
    Thrust_dir: Math.abs(bar.plus_di - bar.minus_di) * bar.williams_r,
    F_macro: (bar.close - bar.kc_middle) / bar.atr_14,
    squeeze_release: prevSqueezeOn && !squeezeOn,
  };
}

module.exports = { scoreXGB, walkTree, computeThrustFeatures, PARAMS };
