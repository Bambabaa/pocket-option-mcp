'use strict';

// ── Strategy Registry ─────────────────────────────────────────────────────────
//
// Canonical strategy list for the live bot.
// This file mirrors bot/verified_edges.md and uses Indicators-standard field names.
//
// Evaluated top-to-bottom — first strategy whose every gate returns true fires.
// Gate fn signature: (ind, feat, t) => boolean
//
// Feature engineering is self-contained below — no external feature imports.
//

// ── Math helpers ──────────────────────────────────────────────────────────────

function ring(arr, val, maxLen) {
    arr.push(val);
    if (arr.length > maxLen) arr.shift();
}

function updateEMA(prev, close, period) {
    if (prev == null) return close;
    const k = 2 / (period + 1);
    return close * k + prev * (1 - k);
}

function logRet(c1, c0) {
    if (c0 == null || c1 == null || c0 <= 0 || c1 <= 0) return null;
    return Math.log(c1 / c0);
}

function mean(arr) {
    if (!arr || !arr.length) return null;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr, mu) {
    if (!arr || arr.length < 2) return null;
    const m = (mu !== undefined) ? mu : mean(arr);
    if (m == null) return null;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// Least-squares slope of the last n values (Δvalue per bar)
function slope(arr, n) {
    const w = arr.slice(-n);
    const L = w.length;
    if (L < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < L; i++) {
        sx  += i;  sy  += w[i];
        sxy += i * w[i];  sx2 += i * i;
    }
    const denom = L * sx2 - sx * sx;
    if (Math.abs(denom) < 1e-15) return 0;
    return (L * sxy - sx * sy) / denom;
}

// ── Per-asset rolling state ───────────────────────────────────────────────────

function createAssetState() {
    return {
        diffs:         [],   // (close − ema20) per bar, max 50  → z_close_ema20
        bb_widths:     [],   // bb_width_bps per bar, max 50      → bb_w_z20/slope
        ranges:        [],   // (high − low) per bar, max 20      → range_expansion
        closes:        [],   // close prices, max 20              → ret_1 / ret_6
        highs:         [],   // prior bar highs, max 20           → persist_above_break
        ema20:         null, // running EMA(20) scalar
        persist_above: 0,    // bars in a row with close > prior_high_20
    };
}

// ── Feature builder ───────────────────────────────────────────────────────────
//
// Call once per closed bar, per asset. Mutates `state` in-place.
// Returns a `feat` object with every field referenced by the 9 verified edges.
//
// Indicator field names follow the Indicators-standard (indicators.js canon):
//   currentPrice / lastCandle[1/3/4], atr_14, bb_width_bps

function buildFeatures(ind, state) {
    const close = ind.close ?? ind.currentPrice;
    if (close == null) return null;

    const lc   = ind.lastCandle ?? null;
    const open  = ind.open  ?? (lc ? lc[1] : null) ?? close;
    const high  = ind.high  ?? (lc ? lc[3] : null) ?? close;
    const low   = ind.low   ?? (lc ? lc[4] : null) ?? close;
    const atr   = ind.atr_14       ?? null;
    const bb_w  = ind.bb_width_bps ?? null;

    const feat = {};

    // ── Candle anatomy (current bar — no ring needed) ─────────────────────────
    const body  = Math.abs(close - open);
    const range = high - low;

    feat.is_bear_bar = close < open;

    if (atr != null && atr > 0) {
        feat.body_atr        = body  / atr;
        feat.range_atr       = range / atr;
        feat.signed_body_atr = (close - open) / atr;
    } else {
        feat.body_atr = feat.range_atr = feat.signed_body_atr = null;
    }

    // ── EMA20 + z-score of (close − ema20) ────────────────────────────────────
    state.ema20    = updateEMA(state.ema20, close, 20);
    const diff     = close - state.ema20;

    if (state.diffs.length >= 20) {
        const mu    = mean(state.diffs);
        const sigma = std(state.diffs, mu);
        feat.z_close_ema20 = (sigma != null && sigma > 1e-10) ? (diff - mu) / sigma : 0;
    } else {
        feat.z_close_ema20 = null;
    }
    feat.dist_ema20_atr = (atr != null && atr > 0) ? diff / atr : null;
    ring(state.diffs, diff, 50);

    // ── BB width z-score + slope (computed BEFORE pushing current value) ───────
    if (bb_w != null && state.bb_widths.length >= 20) {
        const mu    = mean(state.bb_widths);
        const sigma = std(state.bb_widths, mu);
        feat.bb_w_z20    = (sigma != null && sigma > 1e-10) ? (bb_w - mu) / sigma : 0;
        feat.bb_w_slope5 = slope(state.bb_widths, 5);
    } else {
        feat.bb_w_z20 = feat.bb_w_slope5 = null;
    }
    if (bb_w != null) ring(state.bb_widths, bb_w, 50);

    // ── Range expansion vs prior 20-bar mean (BEFORE pushing current) ─────────
    if (state.ranges.length >= 20) {
        const mu = mean(state.ranges);
        feat.range_expansion = (mu != null && mu > 1e-12) ? range / mu : null;
    } else {
        feat.range_expansion = null;
    }
    ring(state.ranges, range, 20);

    // ── Log returns (BEFORE pushing current close) ────────────────────────────
    const prev = state.closes;
    feat.ret_1 = prev.length >= 1 ? logRet(close, prev[prev.length - 1]) : null;
    feat.ret_6 = prev.length >= 6 ? logRet(close, prev[prev.length - 6]) : null;
    ring(state.closes, close, 20);

    // ── Breakout persistence (BEFORE pushing current high) ────────────────────
    feat.persist_above_break = 0;
    feat.break_strength_up   = 0;
    if (state.highs.length >= 20) {
        const prior_high = Math.max(...state.highs);
        if (close > prior_high) {
            state.persist_above++;
        } else {
            state.persist_above = 0;
        }
        feat.persist_above_break = state.persist_above;
        feat.break_strength_up   = (close > prior_high && atr != null && atr > 0)
            ? (close - prior_high) / atr : 0;
    }
    ring(state.highs, high, 20);

    // ── Session tag (UTC windows) ─────────────────────────────────────────────
    const ts = (lc && lc[0] != null) ? lc[0] : ind.timestamp;
    if (ts != null) {
        const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
        const h = new Date(tsSec * 1000).getUTCHours();
        if      (h >= 22 || h < 7)  feat.session = 'Asian';
        else if (h < 13)             feat.session = 'European';
        else                         feat.session = 'American';
    } else {
        feat.session = null;
    }

    return feat;
}

const STRATEGIES = [

    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 1 — VERIFIED (live-size eligible)                                  ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝

    // T1 · T1_ZSCORE_EXTREME_LOW · CALL · 15m
    {
        name:      'T1_ZSCORE_EXTREME_LOW',
        tier:      1,
        direction: 'CALL',
        thresholds: {
            z_max: -3.0,
        },
        gates: [
            { label: 'z_extreme_low', fn: (ind, feat, t) => feat.z_close_ema20 != null && feat.z_close_ema20 <= t.z_max },
        ],
        reason: (ind, feat) =>
            `[T1-CALL] z_close_ema20=${feat.z_close_ema20?.toFixed(2)}σ` +
            ` dist_ema20_atr=${feat.dist_ema20_atr?.toFixed(2)} session=${feat.session}`,
    },

    // T1 · ML_EDGE_07 · CALL · 15m
    {
        name:      'ML_EDGE_07',
        tier:      1,
        direction: 'CALL',
        thresholds: {
            range_atr_gt:   0.0432135,
            body_atr_le:   -1.30231,
            atr_14_gt:      0.000126786,
            range_atr_gt_3: 2.79401,
        },
        gates: [
            { label: 'range_atr_gt',
              fn: (ind, feat, t) => feat.range_atr != null && feat.range_atr > t.range_atr_gt },
            { label: 'body_atr_le',
              fn: (ind, feat, t) => feat.signed_body_atr != null && feat.signed_body_atr <= t.body_atr_le },
            { label: 'atr_14_gt',
              fn: (ind, feat, t) => ind.atr_14 != null && ind.atr_14 > t.atr_14_gt },
            { label: 'range_atr_gt_3',
              fn: (ind, feat, t) => feat.range_atr != null && feat.range_atr > t.range_atr_gt_3 },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_07] range_atr=${feat.range_atr?.toFixed(2)}` +
            ` signed_body_atr=${feat.signed_body_atr?.toFixed(2)} atr_14=${ind.atr_14?.toFixed(6)}`,
    },

    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 2 — VERIFIED (standard sizing)                                     ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝

    // T2 · T2_FADE_FRESH_UP_BREAK · PUT · 15m
    {
        name:      'T2_FADE_FRESH_UP_BREAK',
        tier:      2,
        direction: 'PUT',
        thresholds: {
            persist_match: 1,
        },
        gates: [
            { label: 'fresh_up_break', fn: (ind, feat, t) => feat.persist_above_break === t.persist_match },
        ],
        reason: (ind, feat) =>
            `[T2-PUT] persist_above_break=${feat.persist_above_break}` +
            ` break_strength_up=${feat.break_strength_up?.toFixed(2)}`,
    },

    // T2 · T2_BB_PEAK_BEAR_BOUNCE · CALL · 15m
    {
        name:      'T2_BB_PEAK_BEAR_BOUNCE',
        tier:      2,
        direction: 'CALL',
        thresholds: {
            bb_w_z_min: 1.5,
            bb_w_slope_max: 0.0,
        },
        gates: [
            { label: 'bb_width_extended',     fn: (ind, feat, t) => feat.bb_w_z20 != null && feat.bb_w_z20 >= t.bb_w_z_min },
            { label: 'bb_width_rolling_over', fn: (ind, feat, t) => feat.bb_w_slope5 != null && feat.bb_w_slope5 < t.bb_w_slope_max },
            { label: 'bearish_candle',        fn: (ind, feat) => feat.is_bear_bar === true },
        ],
        reason: (ind, feat) =>
            `[T2-CALL] bb_w_z20=${feat.bb_w_z20?.toFixed(2)}` +
            ` bb_w_slope5=${feat.bb_w_slope5?.toFixed(3)} bearish_bar=true`,
    },

    // T2 · T2_RANGE_EXPAND_BEAR_BOUNCE · CALL · 15m
    {
        name:      'T2_RANGE_EXPAND_BEAR_BOUNCE',
        tier:      2,
        direction: 'CALL',
        thresholds: {
            range_exp_min: 2.0,
        },
        gates: [
            { label: 'large_bar',     fn: (ind, feat, t) => feat.range_expansion != null && feat.range_expansion >= t.range_exp_min },
            { label: 'bearish_close', fn: (ind, feat) => feat.is_bear_bar === true },
        ],
        reason: (ind, feat) =>
            `[T2-CALL] range_expansion=${feat.range_expansion?.toFixed(2)}x` +
            ` body_atr=${feat.body_atr?.toFixed(2)} bear=true`,
    },

    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 3 — VERIFIED (cautious sizing)                                     ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝

    // T3 · T3_ZSCORE_LOW_1_5SIG · CALL · 15m
    {
        name:      'T3_ZSCORE_LOW_1_5SIG',
        tier:      3,
        direction: 'CALL',
        thresholds: {
            z_max:   -1.5,
            z_floor: -2.0,
        },
        gates: [
            { label: 'z_low_mod',      fn: (ind, feat, t) => feat.z_close_ema20 != null && feat.z_close_ema20 <= t.z_max },
            { label: 'not_T2_already', fn: (ind, feat, t) => feat.z_close_ema20 > t.z_floor },
        ],
        reason: (ind, feat) =>
            `[T3-CALL] z_close_ema20=${feat.z_close_ema20?.toFixed(2)}σ`,
    },

    // T3 · ML_EDGE_01 · CALL · 15m
    {
        name:      'ML_EDGE_01',
        tier:      3,
        direction: 'CALL',
        thresholds: {
            macd_line_le:      -9.27073e-05,
            rsi_14_gt:          0.431004,
            macd_histogram_le: -0.00741764,
            rsi_14_le:         22.2888,
        },
        gates: [
            { label: 'macd_line_le',
              fn: (ind, feat, t) => ind.macd_macd != null && ind.macd_macd <= t.macd_line_le },
            { label: 'rsi_14_gt',
              fn: (ind, feat, t) => ind.rsi_14 != null && ind.rsi_14 > t.rsi_14_gt },
            { label: 'macd_histogram_le',
              fn: (ind, feat, t) => ind.macd_hist != null && ind.macd_hist <= t.macd_histogram_le },
            { label: 'rsi_14_le',
              fn: (ind, feat, t) => ind.rsi_14 != null && ind.rsi_14 <= t.rsi_14_le },
        ],
        reason: (ind) =>
            `[ML_EDGE_01] macd=${ind.macd_macd?.toFixed(5)} rsi=${ind.rsi_14?.toFixed(1)}`,
    },

    // T3 · ML_EDGE_02 · CALL · 15m
    {
        name:      'ML_EDGE_02',
        tier:      3,
        direction: 'CALL',
        thresholds: {
            ret_1_le:   -0.000263426,
            ret_1_le_1: -0.000858864,
            ret_6_gt:   -0.00149088,
        },
        gates: [
            { label: 'ret_1_le',   fn: (ind, feat, t) => feat.ret_1 != null && feat.ret_1 <= t.ret_1_le },
            { label: 'ret_1_le_1', fn: (ind, feat, t) => feat.ret_1 != null && feat.ret_1 <= t.ret_1_le_1 },
            { label: 'ret_6_gt',   fn: (ind, feat, t) => feat.ret_6 != null && feat.ret_6 >  t.ret_6_gt },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_02] ret_1=${feat.ret_1?.toFixed(5)} ret_6=${feat.ret_6?.toFixed(5)}`,
    },

    // T3 · STC_COMPRESSION_BREAKDOWN · PUT · 15m
    {
        name:      'T3_STC_COMPRESSION_BREAKDOWN',
        tier:      3,
        direction: 'PUT',
        thresholds: {
            stc_min:     75,
            atr_max_pct: 0.20,
        },
        gates: [
            { label: 'stc_high',     fn: (ind, feat, t) => ind.stc_value != null && ind.stc_value > t.stc_min },
            { label: 'psar_bearish', fn: (ind)        => ind.psar_bull === false || ind.psar_bull === 0 },
            { label: 'atr_low',      fn: (ind, feat, t) => ind.atr_pct != null && ind.atr_pct < t.atr_max_pct },
            { label: 'bb_inside_kc', fn: (ind)        => ind.bb_upper != null && ind.kc_upper != null && ind.bb_upper < ind.kc_upper },
        ],
        reason: (ind) =>
            `[T3-PUT] STC=${ind.stc_value?.toFixed(1)} PSAR_bear=true` +
            ` ATR_pct=${ind.atr_pct?.toFixed(3)} bb<kc=true`,
    },
];

const _stateByAsset = new Map();

function getState(asset) {
    if (!asset) return createAssetState();
    if (!_stateByAsset.has(asset)) _stateByAsset.set(asset, createAssetState());
    return _stateByAsset.get(asset);
}

// ── Generic strategy engine ───────────────────────────────────────────────────
// Returns { direction, strategyUsed, reasons, tier } or null.
// Must be called once per bar close per asset — advances rolling history.
function evaluate(ind) {
    if (!ind || ind.currentPrice == null) return null;

    const state = getState(ind.asset);
    const feat = buildFeatures(ind, state);
    if (!feat) return null;

    for (const strategy of STRATEGIES) {
        const { name, direction, thresholds: t, gates, reason, tier } = strategy;
        if (gates.every(({ fn }) => fn(ind, feat, t))) {
            return {
                direction,
                strategyUsed: name,
                tier,
                reasons: [reason(ind, feat)],
            };
        }
    }

    return null;
}

module.exports = { evaluate };
