'use strict';

/**
 * ML REVERSAL GATE — real trained models (Decision Tree + L2 Logistic Regression)
 *
 * Predicts reversal probability from 4 kinetic features, then applies a
 * probability gate (0.85) AND a payout-aware kill-switch.
 *
 * IMPORTANT — this file embeds the ACTUAL trained models exported from sklearn
 * (ml_gate_params.json), not a hand-transcribed approximation. The tree is the
 * full 22-leaf structure (leaf P(reversal) up to 0.970); the logistic model is
 * the fitted coefficients + StandardScaler parameters. Both reproduce the
 * Python predictions to < 1e-9 (see test-ml-gate.js parity suite).
 *
 * Features:
 *   BB_Deviation     = (close - bb_lower) / (bb_upper - bb_lower)
 *   CCI_Velocity     = (cci[t] - cci[t-2]) / 2
 *   Stoch_Divergence = |stoch_k - stoch_d|
 *   STC_Momentum     = stc[t] - stc[t-1]
 *
 * Tree feature importance (trained): Stoch_Divergence 0.988 (dominant),
 *   STC_Momentum 0.006, BB_Deviation 0.005, CCI_Velocity 0.001
 *
 * Payout-aware gating (break-even payout per model, from EV analysis):
 *   Tree   @0.85 → fire only when live payout >= 0.70  (break-even ~47%, robust)
 *   LogReg @0.85 → fire only when live payout >= 0.78  (pessimistic CI floor)
 */

// ── Embedded trained model parameters (exported from sklearn) ───────────────────
const PARAMS = {"features":["BB_Deviation","CCI_Velocity","Stoch_Divergence","STC_Momentum"],"tree":{"leaf":false,"feature":2,"feature_name":"Stoch_Divergence","threshold":8.291357104184272e-05,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-8.08472941571381e-05,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-0.00031169370049610734,"left":{"leaf":false,"feature":1,"feature_name":"CCI_Velocity","threshold":-5.038522958755493,"left":{"leaf":true,"proba":0.07554516245555994,"n":39},"right":{"leaf":true,"proba":0.0,"n":413}},"right":{"leaf":true,"proba":0.4964633524686564,"n":38}},"right":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":4.276415165804792e-05,"left":{"leaf":false,"feature":1,"feature_name":"CCI_Velocity","threshold":1.031991720199585,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":5.859012617293047e-07,"left":{"leaf":true,"proba":0.008823094469014369,"n":11275},"right":{"leaf":true,"proba":0.0,"n":89}},"right":{"leaf":true,"proba":0.04954786451397304,"n":30}},"right":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":0.00030508059717249125,"left":{"leaf":true,"proba":0.3016473088893948,"n":54},"right":{"leaf":false,"feature":1,"feature_name":"CCI_Velocity","threshold":-8.874473571777344,"left":{"leaf":true,"proba":0.08633005996350043,"n":34},"right":{"leaf":true,"proba":0.006046891715654911,"n":499}}}}},"right":{"leaf":false,"feature":0,"feature_name":"BB_Deviation","threshold":-0.24976781010627747,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-1.7275676727294922,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-5.286126613616943,"left":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-12.822106838226318,"left":{"leaf":true,"proba":0.6635155503803825,"n":53},"right":{"leaf":true,"proba":0.8447797720003589,"n":46}},"right":{"leaf":true,"proba":0.6018782187215994,"n":30}},"right":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":-0.004142840509302914,"left":{"leaf":true,"proba":0.9701524401322722,"n":45},"right":{"leaf":false,"feature":3,"feature_name":"STC_Momentum","threshold":0.0018502046004869044,"left":{"leaf":true,"proba":0.70862613771976,"n":60},"right":{"leaf":true,"proba":0.9199336171581612,"n":43}}}},"right":{"leaf":false,"feature":0,"feature_name":"BB_Deviation","threshold":0.10223327204585075,"left":{"leaf":false,"feature":1,"feature_name":"CCI_Velocity","threshold":149.00348663330078,"left":{"leaf":false,"feature":0,"feature_name":"BB_Deviation","threshold":0.10136408731341362,"left":{"leaf":true,"proba":0.6506164596569832,"n":4285},"right":{"leaf":true,"proba":0.8943592909484352,"n":33}},"right":{"leaf":true,"proba":0.8896600748921116,"n":38}},"right":{"leaf":false,"feature":2,"feature_name":"Stoch_Divergence","threshold":20.43914794921875,"left":{"leaf":false,"feature":2,"feature_name":"Stoch_Divergence","threshold":20.257585525512695,"left":{"leaf":true,"proba":0.6232516580265917,"n":30195},"right":{"leaf":true,"proba":0.38895659281229067,"n":81}},"right":{"leaf":false,"feature":1,"feature_name":"CCI_Velocity","threshold":102.12317657470703,"left":{"leaf":true,"proba":0.6603512464482695,"n":2046},"right":{"leaf":true,"proba":0.5182347550229119,"n":89}}}}}},"logreg":{"coef":[-0.0236338162805624,-0.015641326881888303,0.5929172997525298,0.010139202934211776],"intercept":-0.02016788423033882,"scaler_mean":[0.5080840748821602,0.031534569989103645,6.602434489293413,-0.002437409635799347],"scaler_scale":[0.31294123964738,37.33871023750869,6.8432647788377725,7.126178257894905],"feature_order":["BB_Deviation","CCI_Velocity","Stoch_Divergence","STC_Momentum"]},"thresholds":{"gate":0.85},"payout_floor":{"tree":0.7,"logreg":0.78},"meta":{"trained_rows":49515,"reversal_base_rate":0.3981217812784005,"tree_n_leaves":22}};

const FEATURE_ORDER = PARAMS.features;        // ['BB_Deviation','CCI_Velocity','Stoch_Divergence','STC_Momentum']
const GATE = PARAMS.thresholds.gate;          // 0.85
const PAYOUT_FLOOR = PARAMS.payout_floor;     // { tree: 0.70, logreg: 0.78 }

// ── Per-asset rolling state for feature computation ─────────────────────────────
const stateByAsset = new Map();

function createAssetState() {
  return {
    cci_history: [],   // last 3 CCI values for velocity
    stc_history: [],   // last 2 STC values for momentum
  };
}

function getState(asset) {
  if (!asset) return createAssetState();
  if (!stateByAsset.has(asset)) stateByAsset.set(asset, createAssetState());
  return stateByAsset.get(asset);
}

function resetState() { stateByAsset.clear(); }

// ── Feature Engineering ─────────────────────────────────────────────────────────
//
// Mirrors the Python pipeline exactly:
//   - diff-based features read the rolling ring BEFORE pushing the current value
//   - CCI_Velocity needs 3 CCI samples (t, t-1, t-2); STC_Momentum needs 2

function computeKineticFeatures(ind, state) {
  if (!ind || ind.close == null) return null;

  const close    = ind.close;
  const bb_upper = ind.bb_upper;
  const bb_lower = ind.bb_lower;
  const cci      = ind.cci_20;
  const stc      = ind.stc_value;
  const stoch_k  = ind.stoch_k;
  const stoch_d  = ind.stoch_d;

  const feat = {};

  // 1. BB_Deviation (Percent B) — contemporaneous, no history
  if (bb_upper != null && bb_lower != null) {
    const band = bb_upper - bb_lower;
    feat.BB_Deviation = Math.abs(band) > 1e-10 ? (close - bb_lower) / band : 0;
  } else {
    feat.BB_Deviation = null;
  }

  // 2. CCI_Velocity = (cci[t] - cci[t-2]) / 2  — needs 3 samples
  if (cci != null) {
    const h = state.cci_history;
    feat.CCI_Velocity = h.length >= 2 ? (cci - h[h.length - 2]) / 2 : null;
    h.push(cci);
    if (h.length > 3) h.shift();
  } else {
    feat.CCI_Velocity = null;
  }

  // 3. Stoch_Divergence = |K - D| — contemporaneous
  feat.Stoch_Divergence =
    (stoch_k != null && stoch_d != null) ? Math.abs(stoch_k - stoch_d) : null;

  // 4. STC_Momentum = stc[t] - stc[t-1]  — needs 2 samples
  if (stc != null) {
    const h = state.stc_history;
    feat.STC_Momentum = h.length >= 1 ? stc - h[h.length - 1] : null;
    h.push(stc);
    if (h.length > 2) h.shift();
  } else {
    feat.STC_Momentum = null;
  }

  return feat;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────
function featuresComplete(feat) {
  return feat &&
    feat.BB_Deviation     != null &&
    feat.CCI_Velocity     != null &&
    feat.Stoch_Divergence != null &&
    feat.STC_Momentum     != null;
}

function featureVector(feat) {
  return FEATURE_ORDER.map((name) => feat[name]);
}

// ── Decision Tree inference — walks the REAL exported tree ──────────────────────
function scoreDecisionTree(feat) {
  if (!featuresComplete(feat)) return null;
  const x = featureVector(feat);
  let node = PARAMS.tree;
  while (!node.leaf) {
    node = (x[node.feature] <= node.threshold) ? node.left : node.right;
  }
  return node.proba;
}

// ── Logistic Regression inference — standardize then sigmoid ────────────────────
function scoreLogReg(feat) {
  if (!featuresComplete(feat)) return null;
  const x = featureVector(feat);
  const { coef, intercept, scaler_mean, scaler_scale } = PARAMS.logreg;
  let logit = intercept;
  for (let i = 0; i < x.length; i++) {
    const z = (x[i] - scaler_mean[i]) / scaler_scale[i];
    logit += z * coef[i];
  }
  return 1 / (1 + Math.exp(-logit));
}

// ── Gate Evaluation ─────────────────────────────────────────────────────────────
//
// Main entry point. Called once per closed bar per asset.
// `payout` is the broker\'s current win payout fraction (e.g. 0.80 = 80%).
// Returns the decision for BOTH models, each with its own payout kill-switch.

function evaluateGate(ind, payout = null) {
  if (!ind || !ind.asset) return null;

  const state = getState(ind.asset);
  const feat = computeKineticFeatures(ind, state);
  if (!featuresComplete(feat)) return null;

  const treeScore = scoreDecisionTree(feat);
  const lrScore   = scoreLogReg(feat);

  function decide(score, model) {
    const clearsProb   = score >= GATE;
    const floor        = PAYOUT_FLOOR[model];
    const clearsPayout = payout == null ? true : payout >= floor;
    return {
      model,
      score: parseFloat(score.toFixed(6)),
      clears_probability: clearsProb,
      payout_floor: floor,
      clears_payout: clearsPayout,
      approved: clearsProb && clearsPayout,
    };
  }

  return {
    asset: ind.asset,
    threshold: GATE,
    payout,
    tree:   decide(treeScore, "tree"),
    logreg: decide(lrScore,   "logreg"),
    // combined: both models agree AND both payout floors clear
    consensus_approved:
      treeScore >= GATE && lrScore >= GATE &&
      (payout == null || (payout >= PAYOUT_FLOOR.tree && payout >= PAYOUT_FLOOR.logreg)),
    features: {
      Stoch_Divergence: parseFloat(feat.Stoch_Divergence.toFixed(4)),
      BB_Deviation:     parseFloat(feat.BB_Deviation.toFixed(4)),
      STC_Momentum:     parseFloat(feat.STC_Momentum.toFixed(4)),
      CCI_Velocity:     parseFloat(feat.CCI_Velocity.toFixed(4)),
    },
  };
}

// ── Stats & Monitoring ────────────────────────────────────────────────────────
const stats = {
  total_evaluated: 0,
  tree_approved: 0,
  logreg_approved: 0,
  consensus_approved: 0,
  score_distribution: { tree: {}, logreg: {} },
};

function recordEvaluation(result) {
  if (!result) return;
  stats.total_evaluated++;
  if (result.tree.approved)   stats.tree_approved++;
  if (result.logreg.approved) stats.logreg_approved++;
  if (result.consensus_approved) stats.consensus_approved++;
  for (const m of ["tree", "logreg"]) {
    const b = Math.round(result[m].score * 10) / 10;
    stats.score_distribution[m][b] = (stats.score_distribution[m][b] || 0) + 1;
  }
}

function getStats() {
  const rate = (n) => stats.total_evaluated > 0
    ? (n / stats.total_evaluated * 100).toFixed(2) + "%" : "N/A";
  return {
    ...stats,
    tree_approval_rate:      rate(stats.tree_approved),
    logreg_approval_rate:    rate(stats.logreg_approved),
    consensus_approval_rate: rate(stats.consensus_approved),
  };
}

module.exports = {
  evaluateGate,
  computeKineticFeatures,
  scoreDecisionTree,
  scoreLogReg,
  getState,
  createAssetState,
  resetState,
  getStats,
  recordEvaluation,
  PARAMS,
};
