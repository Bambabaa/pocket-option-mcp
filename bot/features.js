'use strict';

// ─── Math helpers ──────────────────────────────────────────────────────────────

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

// Population std; accepts optional pre-computed mean to avoid double pass
function std(arr, mu) {
    if (!arr || arr.length < 2) return null;
    const m = (mu !== undefined) ? mu : mean(arr);
    if (m == null) return null;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// Least-squares slope of the last n values; units: Δvalue per bar
function slope(arr, n) {
    const w = arr.slice(-n);
    const L = w.length;
    if (L < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < L; i++) {
        sx  += i;
        sy  += w[i];
        sxy += i * w[i];
        sx2 += i * i;
    }
    const denom = L * sx2 - sx * sx;
    if (Math.abs(denom) < 1e-15) return 0;
    return (L * sxy - sx * sy) / denom;
}

// ─── Per-asset rolling state ───────────────────────────────────────────────────

function createAssetState() {
    return {
        diffs:         [],   // (close − ema20) per bar, max 50
        bb_widths:     [],   // bb_width_bps per bar, max 50
        atrs:          [],   // atr_14 per bar, max 50
        highs:         [],   // prior bar highs, max 20  ← pushed AFTER sweep/persist
        lows:          [],   // prior bar lows,  max 20
        ranges:        [],   // (high − low) per bar, max 20
        lwicks:        [],   // lower wick sizes, max 20
        uwicks:        [],   // upper wick sizes, max 20
        bodies:        [],   // |close − open| per bar, max 20
        closes:        [],   // close prices, max 20 — used for directional_efficiency
        ema20:         null, // running EMA(20) scalar
        persist_above: 0,    // bars in a row with close > prior_high_20
        persist_below: 0,    // bars in a row with close < prior_low_20
        prev_bar:      null, // { open, close, high, low, atr_14 } — 1-bar lag for OB
        regime_prev:   null, // regime label of the previous bar
        regime_age:    0,    // bars since regime last changed
    };
}

// ─── Feature builder ──────────────────────────────────────────────────────────
//
// Call once per closed 5m bar, per asset.  Mutates `state` in-place.
// Returns a `feat` object containing every field referenced in entry_strategies.js.
//
// ind fields consumed:
//   open, close (or currentPrice), high, low
//   atr_14, bb_width_bps
//   timestamp (optional Unix seconds — used for session tag only)

function buildFeatures(ind, state) {
    const close = ind.close ?? ind.currentPrice;
    if (close == null) return null;

    const lc = ind.lastCandle ?? null;
    const open = ind.open ?? (lc ? lc[1] : null) ?? close;
    const high = ind.high ?? (lc ? lc[3] : null) ?? close;
    const low  = ind.low  ?? (lc ? lc[4] : null) ?? close;
    const atr  = ind.atr_14        ?? null;
    const bb_w = ind.bb_width_bps  ?? null;

    const feat = {};

    // ── Candle structure (current bar — no ring needed) ───────────────────────
    const body  = Math.abs(close - open);
    const lwick = Math.min(open, close) - low;
    const uwick = high - Math.max(open, close);
    const range = high - low;

    feat.is_bull_bar = close > open;
    feat.is_bear_bar = close < open;

    // Pass-through indicator scalars used by regime classifier and strategies
    feat.adx      = ind.adx_14      ?? ind.adx      ?? null;
    feat.plus_di  = ind.adx_plus_di ?? ind.plus_di  ?? null;
    feat.minus_di = ind.adx_minus_di ?? ind.minus_di ?? null;

    if (atr != null && atr > 0) {
        feat.body_atr  = body  / atr;
        feat.uwick_atr = uwick / atr;
        feat.lwick_atr = lwick / atr;
        feat.range_atr = range / atr;
        feat.signed_body_atr = (close - open) / atr;
    } else {
        feat.body_atr = feat.uwick_atr = feat.lwick_atr = feat.range_atr = feat.signed_body_atr = null;
    }

    // ── EMA20 + z-score of (close − ema20) ────────────────────────────────────
    // Update EMA first, compute diff, then z vs the ring of PRIOR diffs.
    // This measures "how extreme is today's deviation relative to recent history".
    state.ema20    = updateEMA(state.ema20, close, 20);
    const diff     = close - state.ema20;

    if (state.diffs.length >= 20) {
        const mu    = mean(state.diffs);
        const sigma = std(state.diffs, mu);
        feat.z_close_ema20 = (sigma != null && sigma > 1e-10)
            ? (diff - mu) / sigma
            : 0;
    } else {
        feat.z_close_ema20 = null;
    }
    feat.dist_ema20_atr = (atr != null && atr > 0) ? diff / atr : null;
    ring(state.diffs, diff, 50);

    // ── BB width z-score + slope (BEFORE pushing current value) ──────────────
    if (bb_w != null && state.bb_widths.length >= 20) {
        const mu    = mean(state.bb_widths);
        const sigma = std(state.bb_widths, mu);
        feat.bb_w_z20    = (sigma != null && sigma > 1e-10) ? (bb_w - mu) / sigma : 0;
        feat.bb_w_slope5 = slope(state.bb_widths, 5);
    } else {
        feat.bb_w_z20 = feat.bb_w_slope5 = null;
    }
    if (bb_w != null) ring(state.bb_widths, bb_w, 50);

    // ── ATR z-score + slope (BEFORE pushing current value) ───────────────────
    if (atr != null && state.atrs.length >= 20) {
        const mu    = mean(state.atrs);
        const sigma = std(state.atrs, mu);
        feat.atr_z20    = (sigma != null && sigma > 1e-10) ? (atr - mu) / sigma : 0;
        feat.atr_slope5 = slope(state.atrs, 5);
    } else {
        feat.atr_z20 = feat.atr_slope5 = null;
    }
    if (atr != null) ring(state.atrs, atr, 50);

    // ── Range expansion vs prior 20-bar mean (BEFORE pushing current) ─────────
    if (state.ranges.length >= 20) {
        const mu = mean(state.ranges);
        feat.range_expansion = (mu != null && mu > 1e-12) ? range / mu : null;
    } else {
        feat.range_expansion = null;
    }
    ring(state.ranges, range, 20);

    // ── Exhaustion dynamics — 5-bar mean vs 20-bar mean (BEFORE pushing) ─────
    if (state.lwicks.length >= 20) {
        const m20 = mean(state.lwicks);
        const m5  = mean(state.lwicks.slice(-5));
        feat.lwick_growth_rate = (m20 != null && m20 > 1e-12) ? m5 / m20 : null;
    } else {
        feat.lwick_growth_rate = null;
    }
    ring(state.lwicks, lwick, 20);

    if (state.uwicks.length >= 20) {
        const m20 = mean(state.uwicks);
        const m5  = mean(state.uwicks.slice(-5));
        feat.uwick_growth_rate = (m20 != null && m20 > 1e-12) ? m5 / m20 : null;
    } else {
        feat.uwick_growth_rate = null;
    }
    ring(state.uwicks, uwick, 20);

    if (state.bodies.length >= 20) {
        const m20 = mean(state.bodies);
        const m5  = mean(state.bodies.slice(-5));
        feat.body_decay_rate = (m20 != null && m20 > 1e-12) ? m5 / m20 : null;
    } else {
        feat.body_decay_rate = null;
    }
    ring(state.bodies, body, 20);

    // ── Log returns (BEFORE pushing current close) ────────────────────────────
    const prev = state.closes;
    feat.ret_1 = prev.length >= 1 ? logRet(close, prev[prev.length - 1]) : null;
    feat.ret_6 = prev.length >= 6 ? logRet(close, prev[prev.length - 6]) : null;

    // ── Directional efficiency (BEFORE pushing current close) ─────────────────
    // DE = net displacement / total path over last 10 closes.
    // Measures how "efficiently" price is moving — high = trending, low = choppy.
    if (state.closes.length >= 10) {
        const w   = state.closes.slice(-10);
        const net = Math.abs(close - w[0]);
        let path  = Math.abs(w[1] - w[0]);
        for (let i = 2; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
        path += Math.abs(close - w[w.length - 1]);
        feat.de = path > 1e-12 ? net / path : 0;
    } else {
        feat.de = null;
    }
    ring(state.closes, close, 20);

    // ── SMC sweep + breakout persistence (BEFORE pushing current high/low) ────
    feat.sweep_high          = false;
    feat.sweep_low           = false;
    feat.sweep_dist_up_atr   = 0;
    feat.sweep_dist_down_atr = 0;
    feat.persist_above_break = 0;
    feat.persist_below_break = 0;
    feat.break_strength_up   = 0;
    feat.break_strength_down = 0;

    if (state.highs.length >= 20) {
        const prior_high = Math.max(...state.highs);

        if (high > prior_high && close < prior_high) {
            feat.sweep_high        = true;
            feat.sweep_dist_up_atr = (atr != null && atr > 0) ? (high - prior_high) / atr : 0;
        }
        if (close > prior_high) {
            state.persist_above++;
        } else {
            state.persist_above = 0;
        }
        feat.persist_above_break = state.persist_above;
        feat.break_strength_up   = (close > prior_high && atr != null && atr > 0)
            ? (close - prior_high) / atr : 0;
    }

    if (state.lows.length >= 20) {
        const prior_low = Math.min(...state.lows);

        if (low < prior_low && close > prior_low) {
            feat.sweep_low           = true;
            feat.sweep_dist_down_atr = (atr != null && atr > 0) ? (prior_low - low) / atr : 0;
        }
        if (close < prior_low) {
            state.persist_below++;
        } else {
            state.persist_below = 0;
        }
        feat.persist_below_break = state.persist_below;
        feat.break_strength_down = (close < prior_low && atr != null && atr > 0)
            ? (prior_low - close) / atr : 0;
    }

    ring(state.highs, high, 20);
    ring(state.lows,  low,  20);

    // ── OB detection (1-bar lag) ──────────────────────────────────────────────
    // bull_ob: previous bar was bearish AND current bar moved up ≥ 1.2 ATR from prev close
    // bear_ob: previous bar was bullish AND current bar moved down ≥ 1.2 ATR from prev close
    feat.bull_ob = false;
    feat.bear_ob = false;
    if (state.prev_bar != null) {
        const prev    = state.prev_bar;
        const prevAtr = prev.atr_14 ?? atr;
        if (prevAtr != null && prevAtr > 0) {
            if (prev.close < prev.open && (close - prev.close) >= 1.2 * prevAtr) feat.bull_ob = true;
            if (prev.close > prev.open && (prev.close - close) >= 1.2 * prevAtr) feat.bear_ob = true;
        }
    }

    // ── Regime classifier — 8-rule cascade matching Python research ──────────────
    // Rules evaluated in priority order; first match wins.
    // Requires: bb_w_z20, atr_z20, bb_w_slope5, atr_slope5, feat.adx, feat.de
    feat.regime_prev = state.regime_prev;
    feat.regime_age  = state.regime_age;

    let regime = 'RANGING'; // default catch-all (matches Python's most common bucket ~56%)

    if (feat.bb_w_z20 != null && feat.atr_z20 != null) {
        const adxVal = feat.adx;
        const deVal  = feat.de;

        if (feat.bb_w_z20 < -1.5 && feat.atr_z20 < -1.5) {
            // Both volatility measures deeply suppressed — market is dormant
            regime = 'DEAD_MARKET';
        } else if (feat.bb_w_slope5 != null && feat.bb_w_z20 > 1.0 && feat.atr_slope5 != null && feat.atr_slope5 > 0) {
            // BB expanding AND ATR rising — volatility releasing from compression
            regime = 'VOL_EXPANSION';
        } else if (feat.atr_z20 > 0.5 && feat.atr_slope5 != null && feat.atr_slope5 < 0) {
            // ATR elevated but declining — volatility pulse dying out
            regime = 'EXHAUSTION';
        } else if (feat.bb_w_z20 < -0.5 && adxVal != null && adxVal < 20) {
            // Tight bands + weak trend = classic compression
            regime = 'COMPRESSION';
        } else if (adxVal != null && deVal != null && adxVal >= 28 && deVal >= 0.55 && state.regime_age >= 6) {
            // Strong, mature trend — high ADX, highly efficient directional movement
            regime = 'STRONG_TREND';
        } else if (adxVal != null && deVal != null && adxVal >= 22 && deVal >= 0.40) {
            // Moderate trend — directional but not yet dominant
            regime = 'TRENDING';
        }
        // RANGING is the default — no positive condition needed
    }
    feat.regime = regime;

    // ── Session tag — UTC windows matching the research session definitions ──────
    // Asian:    22:00–06:59 UTC (spans midnight — Tokyo/Sydney)
    // European: 07:00–12:59 UTC (London open)
    // American: 13:00–21:59 UTC (NY open through close)
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

    // ── Advance state for next bar ────────────────────────────────────────────
    state.regime_prev  = regime;
    state.regime_age   = (regime === state.regime_prev) ? state.regime_age + 1 : 1;
    state.prev_bar     = { open, close, high, low, atr_14: atr };

    return feat;
}

module.exports = { createAssetState, buildFeatures };
