'use strict';

// ── Strategy Registry ─────────────────────────────────────────────────────────
//
// To tune a threshold  → edit one number in a strategy's `thresholds` block
// To add/remove a gate → add/remove one entry from a strategy's `gates` array
// To add a feature     → add one entry to FEATURES (rolling history handled there)
// To add a strategy    → add one object to STRATEGIES; first match per bar wins
//
// evaluate(ind) is the generic engine — never needs to change.
// ─────────────────────────────────────────────────────────────────────────────


// ── Feature engineering ───────────────────────────────────────────────────────
// Each fn(ind, hist) mutates hist (rolling window), returns derived value.
// hist is a plain object initialised per-asset with empty arrays.

const FEATURES = {
    bb_expanding: (ind, hist) => {
        if (ind.bb_width_bps != null) {
            hist.bbWidth.push(ind.bb_width_bps);
            if (hist.bbWidth.length > 3) hist.bbWidth.shift();
        }
        const w = hist.bbWidth;
        return w.length >= 2 && w[w.length - 1] > w[w.length - 2];
    },

    ma_gap_trend: (ind, hist) => {
        const gap = (ind.sma_10 != null && ind.sma_20 != null)
            ? ind.sma_10 - ind.sma_20 : null;
        if (gap != null) {
            hist.maGap.push(gap);
            if (hist.maGap.length > 3) hist.maGap.shift();
        }
        const w = hist.maGap;
        if (w.length < 2) return 'flat';
        const diff = w[w.length - 1] - w[w.length - 2];
        return Math.abs(diff) < 1e-8 ? 'flat' : diff > 0 ? 'widening' : 'narrowing';
    },
};


// ── Strategy definitions ──────────────────────────────────────────────────────
// Evaluated top-to-bottom — first strategy whose every gate returns true fires.
//
// Gate fn signature: (ind, feat, t) => boolean
//   ind  — raw indicator object
//   feat — computed FEATURES values for this bar
//   t    — this strategy's thresholds object

const STRATEGIES = [

    // ── CALL/PUT: ────────────────────────────────────────────────
    // {
    //     name:      '',
    //     direction: '',
    //     thresholds: {
    //         
    //     },
    //     gates: [
    //         ],
    //     reason: (ind, f) =>    
    // },

    // ── PUT/CALL: ─────────────────────────────────────────────
    // {
    //     name:      '',
    //     direction: '',
    //     thresholds: {
    //     },
    //     gates: [
    //     ],
    //     reason: (ind, f) =>
    // },

    // ── PUT: STC Compression Breakdown (ML edge) ──────────────────────────────
    {
        name:      'STC_COMPRESSION_PUT',
        direction: 'PUT',
        thresholds: {
            stc_min:     75,    // STC must be elevated (not at ceiling, but high)
            atr_max_pct: 0.20,  // ATR < 0.20% of price = volatility compression
        },
        gates: [
            { label: 'stc_high',     fn: (ind, f, t) => ind.stc_value  >  t.stc_min },
            { label: 'psar_bearish', fn: (ind)        => ind.psar_bull === false || ind.psar_bull === 0 },
            { label: 'atr_low',      fn: (ind, f, t) => ind.atr_pct   <  t.atr_max_pct },
            { label: 'bb_inside_kc', fn: (ind)        => ind.bb_upper != null && ind.kc_upper != null && ind.bb_upper < ind.kc_upper },
        ],
        reason: (ind) =>
            `stc=${ind.stc_value?.toFixed(1)} psar_bull=${ind.psar_bull}` +
            ` atr_pct=${ind.atr_pct?.toFixed(4)}` +
            ` bb_upper=${ind.bb_upper?.toFixed(5)} kc_upper=${ind.kc_upper?.toFixed(5)}`,
    },

];


// ── Per-asset rolling history ─────────────────────────────────────────────────
const _history = {};

function _getHistory(asset) {
    if (!_history[asset]) _history[asset] = { bbWidth: [], maGap: [] };
    return _history[asset];
}


// ── Generic strategy engine ───────────────────────────────────────────────────
// Returns { direction, strategyUsed, reasons } or null.
// Must be called once per bar close per asset — advances rolling history.

function evaluate(ind) {
    if (!ind || ind.stc_value == null || ind.stc_delta == null) return null;

    const hist = _getHistory(ind.asset);

    // Compute all engineered features (advances history as side-effect)
    const feat = {};
    for (const [name, fn] of Object.entries(FEATURES)) {
        feat[name] = fn(ind, hist);
    }

    // Run strategies in order — first full pass fires
    for (const strategy of STRATEGIES) {
        const { name, direction, thresholds: t, gates, reason } = strategy;
        if (gates.every(({ fn }) => fn(ind, feat, t))) {
            return {
                direction,
                strategyUsed: name,
                reasons: [reason(ind, feat)],
            };
        }
    }

    return null;
}

module.exports = { evaluate };

