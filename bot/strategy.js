'use strict';

// ── Strategy: STC Mode D ──────────────────────────────────────────────────────
// Owns its own rolling buffers for gate prep (bb_expanding, ma_gap_trend).
// Call evaluate(ind) on every bar close — it advances history and returns a
// signal object or null.  No imports of indicators or config needed.
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
    stc_floor:      25,    // STC at floor zone (CALL)
    stc_ceiling:    90,    // STC at ceiling zone (PUT)
    rsi_oversold:   30,    // RSI deeply oversold (CALL)
    rsi_overbought: 70,    // RSI deeply overbought (PUT)
    bb_min_bps:     10,    // Minimum BB width — flat-market filter
    stoch_mid:      50,    // Stochastic midline
};

// ── Per-asset rolling buffers ─────────────────────────────────────────────────
const _bbWidthHistory = {};  // last 3 bb_width_bps values per asset
const _maGapHistory   = {};  // last 3 SMA10−SMA20 gap values per asset

function _push(store, asset, value, maxLen = 3) {
    if (!store[asset]) store[asset] = [];
    store[asset].push(value);
    if (store[asset].length > maxLen) store[asset].shift();
}

// Returns { direction, strategyUsed, reasons } or null if no gates fire.
// Advances rolling history on every call — call once per bar close per asset.
function evaluate(ind) {
    if (!ind) return null;
    if (ind.stc_value == null || ind.stc_delta == null) return null;

    const asset = ind.asset;

    // ── Advance rolling buffers ───────────────────────────────────────────────
    if (ind.bb_width_bps != null) _push(_bbWidthHistory, asset, ind.bb_width_bps);

    const _maGapVal = (ind.sma_10 != null && ind.sma_20 != null)
        ? ind.sma_10 - ind.sma_20 : null;
    if (_maGapVal != null) _push(_maGapHistory, asset, _maGapVal);

    // ── Derived gate fields ───────────────────────────────────────────────────
    const _bbWH = _bbWidthHistory[asset] || [];
    const bb_expanding = _bbWH.length >= 2 && _bbWH[_bbWH.length - 1] > _bbWH[_bbWH.length - 2];

    const _maGH = _maGapHistory[asset] || [];
    let ma_gap_trend = 'flat';
    if (_maGH.length >= 2) {
        const _diff = _maGH[_maGH.length - 1] - _maGH[_maGH.length - 2];
        ma_gap_trend = Math.abs(_diff) < 1e-8 ? 'flat' : _diff > 0 ? 'widening' : 'narrowing';
    }

    // ── CALL: STC Floor Bounce (7 gates) ──────────────────────────────────────
    if (
        ind.stc_value    <=  THRESHOLDS.stc_floor      &&  // g1: STC at floor
        ind.stc_delta    >   0                          &&  // g2: STC curling up
        ind.rsi_14       <   THRESHOLDS.rsi_oversold    &&  // g3: RSI oversold
        ind.stoch_k      !=  null                       &&
        ind.stoch_d      !=  null                       &&
        ind.stoch_k      >   ind.stoch_d                &&  // g4a: bullish K>D
        ind.stoch_k      <   THRESHOLDS.stoch_mid       &&  // g4b: K not overbought
        ind.bb_width_bps >=  THRESHOLDS.bb_min_bps      &&  // g5: market not flat
        bb_expanding     === true                        &&  // g6: volatility releasing
        ma_gap_trend     !== 'narrowing'                     // g7: trend momentum intact
    ) {
        return {
            direction:    'CALL',
            strategyUsed: 'STC_CALL_MODE_D',
            reasons: [
                `stc=${ind.stc_value.toFixed(1)} delta=${ind.stc_delta.toFixed(3)}` +
                ` rsi=${ind.rsi_14?.toFixed(1)} k=${ind.stoch_k.toFixed(1)} d=${ind.stoch_d.toFixed(1)}` +
                ` bbW=${ind.bb_width_bps.toFixed(1)}bps bb_exp=true ma_gap=${ma_gap_trend}`
            ]
        };
    }

    // ── PUT: STC Ceiling Rollover (6 gates) ───────────────────────────────────
    if (
        ind.stc_value    >=  THRESHOLDS.stc_ceiling     &&  // g1: STC at ceiling
        ind.stc_delta    <   0                           &&  // g2: STC rolling down
        ind.rsi_14       >   THRESHOLDS.rsi_overbought   &&  // g3: RSI overbought
        ind.stoch_k      !=  null                        &&
        ind.stoch_d      !=  null                        &&
        ind.stoch_k      <   ind.stoch_d                 &&  // g4a: bearish K<D
        ind.stoch_k      >   THRESHOLDS.stoch_mid        &&  // g4b: K not oversold
        ind.bb_width_bps >=  THRESHOLDS.bb_min_bps       &&  // g5: market not flat
        ma_gap_trend     !== 'narrowing'                      // g6: trend momentum intact
    ) {
        return {
            direction:    'PUT',
            strategyUsed: 'STC_PUT_MODE_D',
            reasons: [
                `stc=${ind.stc_value.toFixed(1)} delta=${ind.stc_delta.toFixed(3)}` +
                ` rsi=${ind.rsi_14?.toFixed(1)} k=${ind.stoch_k.toFixed(1)} d=${ind.stoch_d.toFixed(1)}` +
                ` bbW=${ind.bb_width_bps.toFixed(1)}bps ma_gap=${ma_gap_trend}`
            ]
        };
    }

    return null;
}

module.exports = { evaluate };
