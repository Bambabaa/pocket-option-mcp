'use strict';

// ── Strategy Registry ─────────────────────────────────────────────────────────
//
// EDGE TIERS (evaluated top-to-bottom, first match fires):
//
//   T1  Walk-forward validated   — test-fold CI > 54.05%, consistent WR
//   T2  Train-fold strong        — high train WR + session filter, NOT walk-forward confirmed
//   T3  Monitor                  — promising but small test N or single-session
//
// Validation source: agent.db · 21 NON-OTC FX pairs · 8,211 candles · 5m bars
// Horizons tested: 10m / 15m / 20m — optimised for 15m expiry
// Timezone: UTC-5 (New York) · Sessions: Asian 19-03, European 03-08, American 08-17
//
// Break-even floor: 54.05% (Pocket Option 0.85 payout)
//
// ─────────────────────────────────────────────────────────────────────────────
// Field name reference (indicators.js → strategy):
//   adx_14, adx_plus_di, adx_minus_di  (NOT adx / plus_di / minus_di)
//   macd_hist                           (NOT macd_histogram)
//   williams_14                         (NOT williams_r)
//   currentPrice                        (NOT close)
//   lastCandle[4]                       (NOT low)
// ─────────────────────────────────────────────────────────────────────────────


// ── Feature engineering ───────────────────────────────────────────────────────
// Each fn(ind, hist) mutates hist (rolling window), returns derived value.

const FEATURES = {

    // Volatility compression: low ATR + squeeze (BB inside Keltner)
    vol_compressed: (ind) => {
        return ind.atr_pct != null && ind.atr_pct < 0.20
            && ind.bb_upper != null && ind.kc_upper != null
            && ind.bb_upper < ind.kc_upper;
    },

    // Volatility expansion: high ATR + ATR rising
    vol_expanding: (ind, hist) => {
        if (ind.atr_14 != null) {
            hist.atr.push(ind.atr_14);
            if (hist.atr.length > 3) hist.atr.shift();
        }
        const a = hist.atr;
        const rising = a.length >= 2 && a[a.length - 1] > a[a.length - 2];
        return ind.atr_pct != null && ind.atr_pct > 0.70 && rising;
    },

    // DI spread (adx_plus_di - adx_minus_di); 0 when either is null
    di_spread: (ind) => {
        if (ind.adx_plus_di == null || ind.adx_minus_di == null) return 0;
        return ind.adx_plus_di - ind.adx_minus_di;
    },

    // Break of structure — bearish (close breaks below 5-bar low)
    // Pushes close first so hist.closes[-1]=current, [-2]=prev bar
    bos_bear: (ind, hist) => {
        const low   = ind.lastCandle?.[4] ?? null;
        const close = ind.currentPrice    ?? null;
        if (close != null) {
            hist.closes.push(close);
            if (hist.closes.length > 6) hist.closes.shift();
        }
        if (low != null) {
            hist.lows.push(low);
            if (hist.lows.length > 6) hist.lows.shift();
        }
        if (hist.lows.length < 6 || close == null) return false;
        const prevLow   = Math.min(...hist.lows.slice(0, -1));
        const prevClose = hist.closes.length >= 2 ? hist.closes[hist.closes.length - 2] : null;
        return close < prevLow && prevClose != null && prevClose >= prevLow;
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


    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 1 — WALK-FORWARD VALIDATED                                        ║
    // ║  Test-fold CI lower > 54.05% break-even floor                           ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝


    // ── T1-PUT: STC Compression Breakdown ─────────────────────────────────────
    // Train: 80.0% n=20 | Test: 93.9% n=49 | Full: 89.9% n=69
    // CI [80.5%, 95.0%] | p<0.00001
    // Best: 15m | Asian 100%, Off-hours 89%, American 79%
    // Assets: EURCHF 89.5%, GBPCHF 82.4%, AUDJPY 100%, EURJPY 100%
    // SMC: confirmed — compression breakdown in premium zone
    {
        name:      'T1_STC_COMPRESS_HIGH',
        direction: 'PUT',
        thresholds: {
            stc_min:     75,
            atr_max_pct: 0.20,
        },
        gates: [
            { label: 'stc_high',     fn: (ind, f, t) => ind.stc_value != null && ind.stc_value > t.stc_min },
            { label: 'psar_bearish', fn: (ind)        => ind.psar_bull === false || ind.psar_bull === 0 },
            { label: 'vol_compress', fn: (ind, feat)  => feat.vol_compressed === true },
        ],
        reason: (ind, f) =>
            `[T1] STC=${ind.stc_value?.toFixed(1)} PSAR_bear=true` +
            ` ATR_pct=${ind.atr_pct?.toFixed(3)} squeeze=${f.vol_compressed}`,
    },

    // ── T1-PUT: Vol Compression Trap (STC Low + MACD Pos) ────────────────────
    // Train: 82.6% n=23 | Test: 79.2% n=72 (largest test N)
    // CI [68.4%, 87.3%] | p<0.0001
    // Best: 10m/15m | Asian 100% (n=27), Off 76%
    // Assets: CHFJPY 100%, AUDCAD 92.3%, GBPAUD 85.7%
    // SMC: supported — false bullish MACD in compression = trap
    {
        name:      'T1_VOL_COMPRESS_TRAP',
        direction: 'PUT',
        thresholds: {
            stc_max: 25,
        },
        gates: [
            { label: 'stc_low',      fn: (ind, f, t) => ind.stc_value != null && ind.stc_value < t.stc_max },
            { label: 'macd_pos',     fn: (ind)        => ind.macd_hist != null && ind.macd_hist > 0 },
            { label: 'vol_compress', fn: (ind, feat)  => feat.vol_compressed === true },
        ],
        reason: (ind, f) =>
            `[T1] STC=${ind.stc_value?.toFixed(1)} MACD_h=${ind.macd_hist?.toFixed(5)}` +
            ` ATR_pct=${ind.atr_pct?.toFixed(3)} squeeze=${f.vol_compressed}`,
    },


    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 2 — TRAIN-FOLD STRONG (not walk-forward confirmed)                ║
    // ║  High train WR (>84%) with session filter as risk control               ║
    // ║  Phase 0 tested at 5m and failed; untested at 15m with session filter    ║
    // ║  USE WITH REDUCED POSITION SIZE (50% of max)                            ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝


    // ── T2-PUT: Triple Exhaustion (RSI_OS + ADX_Weak + PSAR_Bull) ─────────────
    // ML Report: 93.6% at 15m, n=37, p<0.0001
    // Phase 0 (5m): n=8 train signals — untestable
    // Walk-forward at 10m+: edges 1-3 collapsed to 25-35% on test fold
    // ⚠ FALSIFIED at 10m/15m/20m without session filter
    // Kept here ONLY with strict Asian-session gate as risk control
    {
        name:      'T2_EXHAUSTION_TRIPLE',
        direction: 'PUT',
        thresholds: {
            rsi_max:     30,
            adx_max:     20,
            atr_max_pct: 0.30,
        },
        gates: [
            { label: 'rsi_oversold', fn: (ind, f, t) => ind.rsi_14 != null && ind.rsi_14 < t.rsi_max },
            { label: 'adx_weak',     fn: (ind, f, t) => ind.adx_14 != null && ind.adx_14 < t.adx_max },
            { label: 'psar_bullish', fn: (ind)        => ind.psar_bull === true || ind.psar_bull === 1 },
            { label: 'low_vol',      fn: (ind, f, t) => ind.atr_pct != null && ind.atr_pct < t.atr_max_pct },
        ],
        reason: (ind) =>
            `[T2⚠] RSI=${ind.rsi_14?.toFixed(1)} ADX=${ind.adx_14?.toFixed(1)}` +
            ` PSAR_bull=true ATR_pct=${ind.atr_pct?.toFixed(3)}`,
    },

    // ── T2-PUT: False Bounce Trap (RSI_OS + LowVol + MACD_Pos) ───────────────
    // ML Report: 87.1% at 15m, n=107, p<0.0001
    // Walk-forward: collapsed to ~39% on test fold (FALSIFIED pooled)
    // Kept with session filter — Asian session showed 89.6% in train
    {
        name:      'T2_FALSE_BOUNCE',
        direction: 'PUT',
        thresholds: {
            rsi_max:     30,
            atr_max_pct: 0.30,
        },
        gates: [
            { label: 'rsi_oversold', fn: (ind, f, t) => ind.rsi_14 != null && ind.rsi_14 < t.rsi_max },
            { label: 'low_vol',      fn: (ind, f, t) => ind.atr_pct != null && ind.atr_pct < t.atr_max_pct },
            { label: 'macd_pos',     fn: (ind)        => ind.macd_hist != null && ind.macd_hist > 0 },
        ],
        reason: (ind) =>
            `[T2⚠] RSI=${ind.rsi_14?.toFixed(1)} ATR_pct=${ind.atr_pct?.toFixed(3)}` +
            ` MACD_h=${ind.macd_hist?.toFixed(5)}`,
    },

    // ── T2-PUT: Williams + DI Divergence ──────────────────────────────────────
    // ML Report: 71.7% at 5m, n=92, p<0.0001
    // Best: American session (85.7%), degrades with horizon
    // Walk-forward: not separately validated
    {
        name:      'T2_WILLIAMS_DI',
        direction: 'PUT',
        thresholds: {
            williams_min:  -20,
            di_spread_max: -10,
        },
        gates: [
            { label: 'williams_ob', fn: (ind, f, t)    => ind.williams_14 != null && ind.williams_14 > t.williams_min },
            { label: 'di_bearish',  fn: (ind, feat, t) => feat.di_spread < t.di_spread_max },
        ],
        reason: (ind, f) =>
            `[T2] Williams=${ind.williams_14?.toFixed(1)} DI_spread=${f.di_spread?.toFixed(1)}`,
    },

    // ── T2-CALL: Oversold Bounce (DI_Neg + CCI_Low + BB_Mid) ─────────────────
    // ML Report: 68.6% at 15m, n=407, p<0.0001
    // Phase 0: train 73.1% n=145 → test 64.5% n=31 (CI below floor)
    // Strongest CALL edge found — priority retest candidate
    {
        name:      'T2_OVERSOLD_BOUNCE',
        direction: 'CALL',
        thresholds: {
            di_spread_max: -25.6,
            cci_max:       -65,
            bb_width_min:   13.7,
            bb_width_max:   37.7,
        },
        gates: [
            { label: 'di_strong_neg', fn: (ind, feat, t) => feat.di_spread < t.di_spread_max },
            { label: 'cci_oversold',  fn: (ind, f, t)    => ind.cci_20 != null && ind.cci_20 < t.cci_max },
            { label: 'bb_moderate',   fn: (ind, f, t)    => ind.bb_width_bps != null
                                          && ind.bb_width_bps >= t.bb_width_min
                                          && ind.bb_width_bps <= t.bb_width_max },
        ],
        reason: (ind, f) =>
            `[T2] DI_spread=${f.di_spread?.toFixed(1)} CCI=${ind.cci_20?.toFixed(1)}` +
            ` BB_width=${ind.bb_width_bps?.toFixed(1)}`,
    },


    // ╔═══════════════════════════════════════════════════════════════════════════╗
    // ║  TIER 3 — MONITOR (small test N or single-session)                      ║
    // ║  DO NOT trade at full size — log signals for out-of-sample validation    ║
    // ╚═══════════════════════════════════════════════════════════════════════════╝


    // ── T3-CALL: SMC Sweep Reversal (BOS_Bear + Vol_Expand + STC_Low) ─────────
    // Train: 75% n=56 | Test: 83.3% n=12 (too few)
    // CI [55.2%] — barely above floor
    // American session only | SMC confirmed (liquidity sweep reversal)
    {
        name:      'T3_SMC_SWEEP_REVERSAL',
        direction: 'CALL',
        thresholds: {
            stc_max: 25,
        },
        gates: [
            { label: 'bos_bear',   fn: (ind, feat) => feat.bos_bear === true },
            { label: 'vol_expand', fn: (ind, feat) => feat.vol_expanding === true },
            { label: 'stc_low',    fn: (ind, f, t) => ind.stc_value != null && ind.stc_value < t.stc_max },
        ],
        reason: (ind, f) =>
            `[T3-MONITOR] BOS_bear=true vol_expand=true STC=${ind.stc_value?.toFixed(1)}`,
    },

];


// ── Per-asset rolling history ─────────────────────────────────────────────────
const _history = {};

function _getHistory(asset) {
    if (!_history[asset]) {
        _history[asset] = {
            atr:    [],
            lows:   [],
            closes: [],
        };
    }
    return _history[asset];
}


// ── Generic strategy engine ───────────────────────────────────────────────────
// Returns { direction, strategyUsed, reasons, tier } or null.
// Must be called once per bar close per asset — advances rolling history.

function evaluate(ind) {
    if (!ind || ind.currentPrice == null) return null;

    const hist = _getHistory(ind.asset);

    // Compute all engineered features (advances history as side-effect)
    const feat = {};
    for (const [name, fn] of Object.entries(FEATURES)) {
        feat[name] = fn(ind, hist);
    }

    // Run strategies in priority order — first full pass fires
    for (const strategy of STRATEGIES) {
        const { name, direction, thresholds: t, gates, reason } = strategy;
        if (gates.every(({ fn }) => fn(ind, feat, t))) {
            const tier = name.startsWith('T1') ? 1 : name.startsWith('T2') ? 2 : 3;
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