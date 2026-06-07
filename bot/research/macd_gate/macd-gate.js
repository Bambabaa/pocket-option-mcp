'use strict';

/**
 * MACD DIVERGENCE & KINETIC DECAY GATE  (research/shadow)
 *
 * Ports the trained LogReg + GB_Stumps models from macd_gate_params.json.
 * Predicts the 3-bar reversal target from 6 MACD/ROC-derived features.
 *
 * ⚠ STATUS: RESEARCH_SHADOW. OOS AUC (purged CV) = 0.513 (LogReg) / 0.598 (GB),
 *   BELOW the 0.636 oscillator-stack ceiling. evaluateMacdGate() therefore
 *   returns approved=false unless { allowLive:true } is explicitly passed.
 *   Use for shadow logging / comparison only until validated on more data.
 *
 * Feature computation is STATEFUL per asset (EMA/ATR/rolling windows). Feed
 * closed bars in time order via update(); it maintains per-asset history.
 *
 * Exports: computeMacdFeatures, scoreLogReg, scoreGBStumps, evaluateMacdGate,
 *          resetState, getStats, PARAMS
 */

const fs = require('fs');
const path = require('path');

const PARAMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'macd_gate_params.json'), 'utf-8')
);

// ── per-asset rolling state ─────────────────────────────────────────────────
const _state = new Map();   // asset -> { closes:[], ema12, ema26, macdSignal, atr14, prevClose, histHist:[], roc3Hist:[] }
function _initAsset() {
  return { closes: [], highs: [], lows: [],
           ema12: null, ema26: null, macdSignal: null, atr14: null,
           prevClose: null, prevHist: null, prevHist3: [null, null, null],
           prevRoc3Abs: null, histWin: [], roc3Win: [] };
}
function resetState() { _state.clear(); }

const _ema = (prev, x, span) => prev == null ? x : prev + (2/(span+1))*(x - prev);
const _std = (arr) => {
  if (arr.length < 2) return null;
  const m = arr.reduce((a,b)=>a+b,0)/arr.length;
  return Math.sqrt(arr.reduce((a,b)=>a+(b-m)*(b-m),0)/(arr.length-1));
};
const _mean = (arr) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;

/**
 * Push a closed bar {asset, open, high, low, close}; returns the 6-feature
 * vector for THIS bar, or null if insufficient history (NaN-equivalent).
 */
function computeMacdFeatures(bar) {
  const a = bar.asset || '_';
  if (!_state.has(a)) _state.set(a, _initAsset());
  const s = _state.get(a);
  const c = bar.close, h = bar.high, l = bar.low;

  // EMAs / MACD
  s.ema12 = _ema(s.ema12, c, 12);
  s.ema26 = _ema(s.ema26, c, 26);
  const macd = s.ema12 - s.ema26;
  s.macdSignal = _ema(s.macdSignal, macd, 9);
  const hist = macd - s.macdSignal;

  // ATR14 (Wilder via ewm alpha=1/14)
  let tr;
  if (s.prevClose == null) tr = h - l;
  else tr = Math.max(h - l, Math.abs(h - s.prevClose), Math.abs(l - s.prevClose));
  s.atr14 = s.atr14 == null ? tr : s.atr14 + (1/14)*(tr - s.atr14);

  // ROC3
  s.closes.push(c);
  const c3 = s.closes.length > 3 ? s.closes[s.closes.length - 4] : null;
  const roc3 = c3 != null ? (c - c3)/c3*100 : null;

  // rolling-20 windows
  s.histWin.push(hist); if (s.histWin.length > 20) s.histWin.shift();
  if (roc3 != null) { s.roc3Win.push(roc3); if (s.roc3Win.length > 20) s.roc3Win.shift(); }

  // features
  const Delta_Hist = s.prevHist != null ? hist - s.prevHist : null;
  const hist3 = s.prevHist3[0];
  const Div_MACD = (c3 != null && hist3 != null) ? (c - c3) - (hist - hist3) : null;
  const histStd = s.histWin.length >= 20 ? _std(s.histWin) : null;
  const Prox_MACD = histStd ? hist / histStd : null;
  const roc3Abs = roc3 != null ? Math.abs(roc3) : null;
  const K_Decay = (roc3Abs != null && s.prevRoc3Abs != null) ? roc3Abs - s.prevRoc3Abs : null;
  const V_Exh = (c3 != null && s.atr14) ? (c - c3)/s.atr14 : null;
  const rMean = s.roc3Win.length >= 20 ? _mean(s.roc3Win) : null;
  const rStd  = s.roc3Win.length >= 20 ? _std(s.roc3Win) : null;
  const Z_ROC = (roc3 != null && rStd) ? (roc3 - rMean)/rStd : null;

  // advance state
  s.prevClose = c;
  s.prevHist3 = [s.prevHist3[1], s.prevHist3[2], hist];  // hist[t-3] tracking
  s.prevHist = hist;
  s.prevRoc3Abs = roc3Abs;

  if ([Delta_Hist, Div_MACD, Prox_MACD, K_Decay, V_Exh, Z_ROC].some(v => v == null || !isFinite(v)))
    return null;
  return { Delta_Hist, Div_MACD, Prox_MACD, K_Decay, V_Exh, Z_ROC };
}

function _scaled(features) {
  const { mean, scale } = PARAMS.scaler;
  return PARAMS.features.map((f, i) => (features[f] - mean[i]) / scale[i]);
}

function scoreLogReg(features) {
  const z = _scaled(features);
  const { coef, intercept } = PARAMS.logreg;
  let logit = intercept;
  for (let i = 0; i < coef.length; i++) logit += coef[i] * z[i];
  return 1 / (1 + Math.exp(-logit));
}

function scoreGBStumps(features) {
  const z = _scaled(features);
  const { init_raw, learning_rate, stumps } = PARAMS.gb_stumps;
  let s = 0;
  for (const st of stumps) s += z[st.feature] <= st.threshold ? st.left : st.right;
  const raw = init_raw + learning_rate * s;
  return 1 / (1 + Math.exp(-raw));
}

const _stats = { total: 0, logreg_approved: 0, gb_approved: 0 };

/**
 * Evaluate the gate for a closed bar. Returns null until enough history.
 * approved is FALSE unless opts.allowLive===true (RESEARCH_SHADOW guard).
 */
function evaluateMacdGate(bar, payout = 0.80, opts = {}) {
  const features = computeMacdFeatures(bar);
  if (!features) return null;
  _stats.total++;
  const gate = PARAMS.thresholds.gate;
  const live = opts.allowLive === true;

  const lrScore = scoreLogReg(features);
  const gbScore = scoreGBStumps(features);
  const lrPass = lrScore >= gate, gbPass = gbScore >= gate;
  if (lrPass) _stats.logreg_approved++;
  if (gbPass) _stats.gb_approved++;

  return {
    asset: bar.asset, features,
    logreg: { score: lrScore, approved: live && lrPass },
    gb:     { score: gbScore, approved: live && gbPass },
    status: PARAMS.status, oos_auc: PARAMS.oos_auc,
  };
}

function getStats() {
  return {
    total_evaluated: _stats.total,
    logreg_approved: _stats.logreg_approved,
    gb_approved: _stats.gb_approved,
    logreg_rate: _stats.total ? (_stats.logreg_approved/_stats.total*100).toFixed(2)+'%' : '0%',
    gb_rate: _stats.total ? (_stats.gb_approved/_stats.total*100).toFixed(2)+'%' : '0%',
  };
}

module.exports = {
  computeMacdFeatures, scoreLogReg, scoreGBStumps, evaluateMacdGate,
  resetState, getStats, PARAMS,
};
