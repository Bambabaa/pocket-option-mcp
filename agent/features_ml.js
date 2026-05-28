'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  ML FEATURE BUILDER — companion to ml_only_router.js
//  Produces every column the ML edges reference (53 non-SMC features).
//
//  Design notes
//   • Per-asset rolling state, mutated in place by buildMLFeatures().
//   • Ring buffers are read BEFORE the current bar is pushed → no look-ahead.
//   • Raw indicators (RSI, MACD, ADX, ATR, STC, BB, Stoch, CCI, etc.) are
//     assumed to be computed upstream and passed in via the `ind` object.
//     This module only computes the DERIVED features the ML edges depend on:
//       candle anatomy, SMA/EMA distances, log returns, range position,
//       vol-regime one-hot, time cyclicals, session tag.
//   • All numeric outputs are null-safe — missing inputs propagate as null,
//     null-aware gates in the router short-circuit safely.
//
//  Required `ind` fields per bar:
//     open, close, high, low
//     atr_14
//     rsi_14, macd_line, macd_signal, macd_histogram
//     adx, plus_di, minus_di
//     bb_width_bps, stoch_k, stoch_d, williams_r, cci_20, stc_value
//     psar_is_bullish      (optional)
//     timestamp            (Unix seconds; used for time-cyclical + session)
//     asset                (string; used to look up vol-regime terciles)
// ════════════════════════════════════════════════════════════════════════════

// ─── Math helpers ──────────────────────────────────────────────────────────

function ring(arr, val, maxLen) {
    arr.push(val);
    if (arr.length > maxLen) arr.shift();
}

function updateEMA(prev, x, period) {
    if (prev == null) return x;
    const k = 2 / (period + 1);
    return x * k + prev * (1 - k);
}

// Log return: ln(c1 / c0). Returns null on degenerate inputs.
function logRet(c1, c0) {
    if (c0 == null || c1 == null || c0 <= 0 || c1 <= 0) return null;
    return Math.log(c1 / c0);
}

// ─── Per-asset state ──────────────────────────────────────────────────────

function createAssetState() {
    return {
        // Close-price ring for returns. Need lookbacks up to 12 → keep 13.
        closes: [],

        // Highs/lows for 50-bar range position.
        highs50: [],
        lows50:  [],

        // SMA running sums — incremental O(1) update.
        sma10_sum: 0, sma10_arr: [],
        sma20_sum: 0, sma20_arr: [],
        sma50_sum: 0, sma50_arr: [],

        // EMA scalars.
        ema12: null,
        ema26: null,

        // ATR history for vol-regime tagging when terciles are not provided.
        atrs: [],
    };
}

// ─── SMA helper (incremental) ─────────────────────────────────────────────
//
// Keeps a running sum + a ring buffer of the last N values. Returns the new
// mean AFTER incorporating `val`. Side-effects state.{sumKey, arrKey}.

function smaPush(state, sumKey, arrKey, val, n) {
    const arr = state[arrKey];
    arr.push(val);
    state[sumKey] += val;
    if (arr.length > n) {
        state[sumKey] -= arr.shift();
    }
    return arr.length === n ? state[sumKey] / n : null;
}

// ─── Session tag (UTC-5 / Chicago time) ───────────────────────────────────
//
// Matches the research definitions exactly:
//   Asian:    17:00 – 02:00 UTC-5  → UTC 22:00 – 07:00
//   European: 02:00 – 08:00 UTC-5  → UTC 07:00 – 13:00
//   American: 08:00 – 17:00 UTC-5  → UTC 13:00 – 22:00

function sessionFromTimestamp(tsSec) {
    if (tsSec == null) return null;
    const h = new Date(tsSec * 1000).getUTCHours();
    if (h >= 22 || h < 7)  return 'Asian';
    if (h >= 7  && h < 13) return 'European';
    return 'American';   // 13–21
}

// ─── Vol-regime tag ───────────────────────────────────────────────────────
//
// Two modes:
//   (a) If `assetTerciles` is supplied (recommended), use the precomputed
//       per-asset ATR p33 / p67 thresholds from the training set.
//   (b) Otherwise, fall back to a rolling self-comparison against the
//       last 200 ATRs in state.atrs. Less stable; only use as a bootstrap
//       until you have proper persisted terciles.

function regimeFromATR(atr, asset, opts, state) {
    if (atr == null) return null;
    if (opts && opts.assetTerciles && opts.assetTerciles[asset]) {
        const { p33, p67 } = opts.assetTerciles[asset];
        if (atr <= p33) return 'LOW';
        if (atr >= p67) return 'HIGH';
        return 'MED';
    }
    // fallback: in-state self-comparison (warmup until atrs >= 100)
    if (state.atrs.length < 100) return null;
    const sorted = [...state.atrs].sort((a, b) => a - b);
    const p33 = sorted[Math.floor(0.33 * sorted.length)];
    const p67 = sorted[Math.floor(0.67 * sorted.length)];
    if (atr <= p33) return 'LOW';
    if (atr >= p67) return 'HIGH';
    return 'MED';
}

// ─── Main builder ─────────────────────────────────────────────────────────

function buildMLFeatures(ind, state, opts = {}) {
    const close = ind.close ?? ind.currentPrice;
    if (close == null) return null;

    const open = ind.open ?? close;
    const high = ind.high ?? close;
    const low  = ind.low  ?? close;
    const atr  = ind.atr_14 ?? null;

    const feat = {};

    // ─── Raw indicators — pass through unchanged ──────────────────────────
    // (The router's gates reference these as ind.X but a few are also exposed
    //  on the feat object for downstream consumers that want a single dict.)
    feat.open  = open;
    feat.high  = high;
    feat.low   = low;
    feat.close = close;

    feat.atr_14         = atr;
    feat.rsi_14         = ind.rsi_14         ?? null;
    feat.macd_line      = ind.macd_line      ?? null;
    feat.macd_signal    = ind.macd_signal    ?? null;
    feat.macd_histogram = ind.macd_histogram ?? null;
    feat.adx            = ind.adx            ?? null;
    feat.plus_di        = ind.plus_di        ?? null;
    feat.minus_di       = ind.minus_di       ?? null;
    feat.bb_width_bps   = ind.bb_width_bps   ?? null;
    feat.stoch_k        = ind.stoch_k        ?? null;
    feat.stoch_d        = ind.stoch_d        ?? null;
    feat.williams_r     = ind.williams_r     ?? null;
    feat.cci_20         = ind.cci_20         ?? null;
    feat.stc_value      = ind.stc_value      ?? null;
    feat.psar_is_bullish = ind.psar_is_bullish ?? null;

    // ─── Candle anatomy (ATR-normalised) ──────────────────────────────────
    const body   = Math.abs(close - open);
    const range  = high - low;
    const upwick = high - Math.max(open, close);
    const dnwick = Math.min(open, close) - low;

    feat.is_bull = close > open ? 1 : 0;

    if (atr != null && atr > 0) {
        feat.body_atr   = body   / atr;
        feat.range_atr  = range  / atr;
        feat.upwick_atr = upwick / atr;
        feat.dnwick_atr = dnwick / atr;
    } else {
        feat.body_atr = feat.range_atr = feat.upwick_atr = feat.dnwick_atr = null;
    }

    // ─── Returns: log(close[t] / close[t-h]) for h ∈ {1, 3, 6, 12} ────────
    //
    // Read state.closes BEFORE pushing the current close to avoid using the
    // current bar as its own lag-0 reference.
    const cs = state.closes;
    feat.ret_1  = cs.length >=  1 ? logRet(close, cs[cs.length -  1]) : null;
    feat.ret_3  = cs.length >=  3 ? logRet(close, cs[cs.length -  3]) : null;
    feat.ret_6  = cs.length >=  6 ? logRet(close, cs[cs.length -  6]) : null;
    feat.ret_12 = cs.length >= 12 ? logRet(close, cs[cs.length - 12]) : null;

    // ─── SMA distances ────────────────────────────────────────────────────
    //
    // smaPush returns the *new* SMA AFTER incorporating close. The distance
    // is therefore measured against the SMA that INCLUDES the current bar,
    // matching the X_static.pkl construction in the research pipeline.
    const sma10 = smaPush(state, 'sma10_sum', 'sma10_arr', close, 10);
    const sma20 = smaPush(state, 'sma20_sum', 'sma20_arr', close, 20);
    const sma50 = smaPush(state, 'sma50_sum', 'sma50_arr', close, 50);
    feat.dist_sma_10 = sma10 != null ? close - sma10 : null;
    feat.dist_sma_20 = sma20 != null ? close - sma20 : null;
    feat.dist_sma_50 = sma50 != null ? close - sma50 : null;

    // ─── EMA distances ────────────────────────────────────────────────────
    state.ema12 = updateEMA(state.ema12, close, 12);
    state.ema26 = updateEMA(state.ema26, close, 26);
    feat.dist_ema_12 = state.ema12 != null ? close - state.ema12 : null;
    feat.dist_ema_26 = state.ema26 != null ? close - state.ema26 : null;

    // ─── 50-bar range position (read BEFORE push) ────────────────────────
    //
    // range_pos_50 = (close − rolling_min_low_50) / (rolling_max_high_50 − rolling_min_low_50)
    // Includes the current bar's high/low in the window (matching the research).
    state.highs50.push(high); if (state.highs50.length > 50) state.highs50.shift();
    state.lows50 .push(low);  if (state.lows50 .length > 50) state.lows50 .shift();
    if (state.highs50.length >= 50) {
        const rh = Math.max(...state.highs50);
        const rl = Math.min(...state.lows50);
        const denom = rh - rl;
        feat.range_pos_50 = denom > 1e-12 ? (close - rl) / denom : 0.5;
    } else {
        feat.range_pos_50 = null;
    }

    // ─── Vol-regime one-hot ───────────────────────────────────────────────
    if (atr != null) {
        ring(state.atrs, atr, 200);
    }
    const regime = regimeFromATR(atr, ind.asset, opts, state);
    feat.regime  = regime;
    feat.reg_LOW  = regime === 'LOW'  ? 1 : 0;
    feat.reg_MED  = regime === 'MED'  ? 1 : 0;
    feat.reg_HIGH = regime === 'HIGH' ? 1 : 0;

    // ─── Time cyclicals (UTC reference; identical to research pipeline) ───
    if (ind.timestamp != null) {
        const d = new Date(ind.timestamp * 1000);
        const hr  = d.getUTCHours();
        const dow = d.getUTCDay();   // 0 = Sunday
        feat.hr_sin  = Math.sin(2 * Math.PI * hr  / 24);
        feat.hr_cos  = Math.cos(2 * Math.PI * hr  / 24);
        feat.dow_sin = Math.sin(2 * Math.PI * dow /  7);
        feat.dow_cos = Math.cos(2 * Math.PI * dow /  7);
    } else {
        feat.hr_sin = feat.hr_cos = feat.dow_sin = feat.dow_cos = null;
    }

    // ─── Session one-hot (UTC-5 window) ───────────────────────────────────
    const sess = sessionFromTimestamp(ind.timestamp);
    feat.session         = sess;
    feat.sess_Asian      = sess === 'Asian'    ? 1 : 0;
    feat.sess_European   = sess === 'European' ? 1 : 0;
    feat.sess_American   = sess === 'American' ? 1 : 0;

    // ─── Push current close to the returns ring AFTER all reads ──────────
    ring(state.closes, close, 13);

    return feat;
}

// ─── Optional convenience: produce just the 16 fields the ML router needs ─

const ML_ROUTER_KEYS = [
    'adx', 'atr_14', 'body_atr', 'dist_ema_26', 'dist_sma_20',
    'hr_sin', 'macd_histogram', 'macd_line', 'minus_di',
    'range_atr', 'ret_1', 'ret_3', 'ret_6', 'ret_12',
    'rsi_14', 'stc_value',
];

function projectMLRouterInputs(feat) {
    if (feat == null) return null;
    const out = {};
    for (const k of ML_ROUTER_KEYS) out[k] = feat[k];
    return out;
}

// ─── Warmup check ─────────────────────────────────────────────────────────
//
// The ML router will only see complete inputs once the deepest lookback has
// filled. Use this to decide when to start trading on a fresh state.

const WARMUP_BARS = 50;   // dist_sma_50 / range_pos_50 require 50 closed bars

function isWarm(state) {
    // The closes ring is capped at 13 (just enough for ret_12). Use the
    // 50-length rings, which are the deepest lookbacks in the feature set.
    return state.sma50_arr.length >= 50
        && state.highs50.length   >= 50
        && state.ema26 != null;
}

// ════════════════════════════════════════════════════════════════════════════
//  Asset-tercile loader (recommended in production)
// ════════════════════════════════════════════════════════════════════════════
//
// In the Python research pipeline the vol-regime label uses per-asset ATR
// terciles computed from the training window. Persist those thresholds as JSON
// and load them here. Example shape:
//
//   {
//     "EURUSD": { "p33": 0.0000412, "p67": 0.0000951 },
//     "USDJPY": { "p33": 0.0089,    "p67": 0.0186    },
//     ...
//   }
//
// Pass the loaded object via opts.assetTerciles on every buildMLFeatures call:
//
//   const terciles = require('./atr_terciles.json');
//   const feat = buildMLFeatures(ind, state, { assetTerciles: terciles });

// ─── Worked usage ─────────────────────────────────────────────────────────
//
//   const { createAssetState, buildMLFeatures, isWarm } = require('./features_ml');
//   const { mlRouter } = require('./ml_only_router');
//
//   const states = new Map();
//
//   function onBar(ind) {                  // ind.asset, ind.timestamp, OHLCV + indicators
//     if (!states.has(ind.asset)) states.set(ind.asset, createAssetState());
//     const state = states.get(ind.asset);
//     const feat  = buildMLFeatures(ind, state, { assetTerciles: TERCILES });
//
//     if (!isWarm(state)) return;          // skip until lookbacks satisfied
//     const decision = mlRouter(ind, feat);
//     if (decision) placeOrder(decision);
//   }
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
    createAssetState,
    buildMLFeatures,
    projectMLRouterInputs,
    isWarm,
    sessionFromTimestamp,
    regimeFromATR,
    ML_ROUTER_KEYS,
    WARMUP_BARS,
};
