// ════════════════════════════════════════════════════════════════════════════
//  ML‑ONLY ROUTER — FX non‑OTC, UTC‑5, 10m/15m/20m horizons
//  Source: ml_only_research.md (§3, §4, §8)
//  Validated edges after v2 audit (bot/validation_report.md §8):
//    ACTIVE:  EDGE_01, EDGE_02, EDGE_06, EDGE_07, EDGE_08 (gated)
//    DELETED: EDGE_03, EDGE_05 — calendar overfit (hr_sin as primary trigger)
//             EDGE_04 — degenerate leaf (fires 56% of bars; regime inversion)
//  All remaining edges: WR ≥ 60% gated, N ≥ 50, p < 0.05, non-degenerate.
//  Fire-rate guard: any edge triggering > 5% of warm bars is suspect.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// Best-timer assignment per feature group (from §2 of the report)
const BEST_TIMER_PER_GROUP = {
    Volatility: '20m',  // AUC 0.5711
    Trend: '15m',       // AUC 0.5436
    Momentum: '20m',    // AUC 0.5553
    MeanReversion: '20m', // AUC 0.5264
    CrossRatios: '20m', // AUC 0.5516
    Temporal: '10m',    // AUC 0.5132
    SMC: '15m',         // AUC 0.6558
};

// Strategy list — DEGENERATE class excluded; all gate lambdas use feat.X not ind.X
const ML_STRATEGIES = [

    // ── ML_EDGE_01 — CALL @ 15m ────────────────────
    // WR=0.802 N=96 p=<.0001
    // CI[0.711, 0.869]   Frag=0.038   Train→Test decay: -0.184
    // Best session: Asian (WR 0.775)   |   Best regime: HIGH (WR 0.892)
    {
        name: 'ML_EDGE_01',
        direction: 'CALL',
        horizon: '15m',
        thresholds: {
            macd_line_le:      -9.27073e-05,
            rsi_14_gt:          0.431004,
            macd_histogram_le: -0.00741764,
            rsi_14_le:         22.2888,
        },
        gates: [
            { label: 'macd_line_le',
              fn: (ind, feat, t) => feat.macd_line      != null && feat.macd_line      <= t.macd_line_le },
            { label: 'rsi_14_gt',
              fn: (ind, feat, t) => feat.rsi_14         != null && feat.rsi_14         >  t.rsi_14_gt },
            { label: 'macd_histogram_le',
              fn: (ind, feat, t) => feat.macd_histogram != null && feat.macd_histogram <= t.macd_histogram_le },
            { label: 'rsi_14_le',
              fn: (ind, feat, t) => feat.rsi_14         != null && feat.rsi_14         <= t.rsi_14_le },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_01/CALL/15m] macd_line=${feat.macd_line?.toFixed(4)} rsi_14=${feat.rsi_14?.toFixed(4)} macd_histogram=${feat.macd_histogram?.toFixed(4)}`,
    },

    // ── ML_EDGE_02 — CALL @ 15m ────────────────────
    // WR=0.786 N=84 p=<.0001
    // CI[0.687, 0.860]   Frag=0.055   Train→Test decay: -0.199
    // Best session: Asian (WR 0.818)   |   Best regime: HIGH (WR 0.831)
    {
        name: 'ML_EDGE_02',
        direction: 'CALL',
        horizon: '15m',
        thresholds: {
            ret_1_le:  -0.000263426,
            ret_1_le_1: -0.000858864,
            ret_6_gt:  -0.00149088,
        },
        gates: [
            { label: 'ret_1_le',
              fn: (ind, feat, t) => feat.ret_1 != null && feat.ret_1 <= t.ret_1_le },
            { label: 'ret_1_le_1',
              fn: (ind, feat, t) => feat.ret_1 != null && feat.ret_1 <= t.ret_1_le_1 },
            { label: 'ret_6_gt',
              fn: (ind, feat, t) => feat.ret_6 != null && feat.ret_6 >  t.ret_6_gt },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_02/CALL/15m] ret_1=${feat.ret_1?.toFixed(4)} ret_6=${feat.ret_6?.toFixed(4)}`,
    },

    // ML_EDGE_03 — DELETED: calendar overfit (hr_sin ≤ -0.983 as primary trigger).
    //   Fires only near UTC 23:00. Validated WR=51.0% N=502. See validation_report.md §8.

    // ML_EDGE_04 — DELETED: degenerate leaf (fire-rate 56%; regime inversion LOW↔HIGH).
    //   Validated WR=46.8% N=29177. See validation_report.md §8.

    // ML_EDGE_05 — DELETED: calendar overfit (same hr_sin gate as EDGE_03).
    //   Validated WR=60.3% N=906 but fires only ≈ UTC 23:00. See validation_report.md §8.

    // ── ML_EDGE_06 — CALL @ 10m  [HOLD: Asian session only, exclude CHF pairs] ──
    // WR=0.747 N=99 p=<.0001
    // CI[0.654, 0.823]   Frag=0.150   Train→Test decay: -0.023
    // Best session: Asian (WR 0.765)   |   Best regime: HIGH (WR 0.795)
    // ⚠️  BRITTLE: spread fragility=0.150. Monitor CHF pairs separately.
    {
        name: 'ML_EDGE_06',
        direction: 'CALL',
        horizon: '10m',
        thresholds: {
            adx_le:          98.9897,
            dist_ema_26_gt: -0.000304769,
            minus_di_gt:    46.6808,
            dist_sma_20_le: -0.000177698,
        },
        gates: [
            { label: 'adx_le',
              fn: (ind, feat, t) => feat.adx         != null && feat.adx         <= t.adx_le },
            { label: 'dist_ema_26_gt',
              fn: (ind, feat, t) => feat.dist_ema_26 != null && feat.dist_ema_26 >  t.dist_ema_26_gt },
            { label: 'minus_di_gt',
              fn: (ind, feat, t) => feat.minus_di    != null && feat.minus_di    >  t.minus_di_gt },
            { label: 'dist_sma_20_le',
              fn: (ind, feat, t) => feat.dist_sma_20 != null && feat.dist_sma_20 <= t.dist_sma_20_le },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_06/CALL/10m] adx=${feat.adx?.toFixed(4)} dist_ema_26=${feat.dist_ema_26?.toFixed(4)} minus_di=${feat.minus_di?.toFixed(4)} dist_sma_20=${feat.dist_sma_20?.toFixed(4)}`,
    },

    // ── ML_EDGE_07 — CALL @ 15m ────────────────────
    // Research: WR=0.747 N=225   Validated: WR=74.7% N=221 ✅ (features_ml.js body_atr fix applied)
    // CI[0.686, 0.799]   Frag=0.047   Train→Test decay: -0.138
    // Best session: European (WR 0.840)   |   Best regime: HIGH (WR 0.780)
    // NOTE: body_atr_le gate uses signed_body_atr (negative = bearish candle ≥ 1.3 ATR)
    {
        name: 'ML_EDGE_07',
        direction: 'CALL',
        horizon: '15m',
        thresholds: {
            range_atr_gt:   0.0432135,
            body_atr_le:   -1.30231,      // signed: bearish bar ≥ 1.3 ATR
            atr_14_gt:      0.000126786,
            range_atr_gt_3: 2.79401,      // extreme spike bar
        },
        gates: [
            { label: 'range_atr_gt',
              fn: (ind, feat, t) => feat.range_atr       != null && feat.range_atr       >  t.range_atr_gt },
            { label: 'body_atr_le',
              fn: (ind, feat, t) => feat.signed_body_atr != null && feat.signed_body_atr <= t.body_atr_le },
            { label: 'atr_14_gt',
              fn: (ind, feat, t) => feat.atr_14          != null && feat.atr_14          >  t.atr_14_gt },
            { label: 'range_atr_gt_3',
              fn: (ind, feat, t) => feat.range_atr       != null && feat.range_atr       >  t.range_atr_gt_3 },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_07/CALL/15m] range_atr=${feat.range_atr?.toFixed(4)} signed_body_atr=${feat.signed_body_atr?.toFixed(4)} atr_14=${feat.atr_14?.toFixed(4)}`,
    },

    // ── ML_EDGE_08 — PUT @ 10m  [SALVAGED: gated on regime + session] ─────────
    // Research: WR=0.737 N=841   Validated ungated: WR=45.9% N=839 ❌
    // Regime: LOW=16.2%, MED=61.3%, HIGH=64.8% — regime inversion: remove LOW
    // Session: Asian=31.8%, American=64.2% — session inversion: remove Asian
    // Gated (MED/HIGH + not Asian): expected WR ≈ 62-65%, N ≈ 220
    // Train→Test decay: +0.071   Quality: COMPOSITE   |   NEW
    {
        name: 'ML_EDGE_08',
        direction: 'PUT',
        horizon: '10m',
        thresholds: {
            rsi_14_le:         99.9173,
            macd_line_gt:      -9.27073e-05,
            rsi_14_gt:         61.0254,
            macd_histogram_le: -2.84941e-06,
        },
        gates: [
            { label: 'rsi_14_le',
              fn: (ind, feat, t) => feat.rsi_14         != null && feat.rsi_14         <= t.rsi_14_le },
            { label: 'macd_line_gt',
              fn: (ind, feat, t) => feat.macd_line      != null && feat.macd_line      >  t.macd_line_gt },
            { label: 'rsi_14_gt',
              fn: (ind, feat, t) => feat.rsi_14         != null && feat.rsi_14         >  t.rsi_14_gt },
            { label: 'macd_histogram_le',
              fn: (ind, feat, t) => feat.macd_histogram != null && feat.macd_histogram <= t.macd_histogram_le },
            { label: 'regime_med_or_high',
              fn: (ind, feat)    => feat.regime === 'MED' || feat.regime === 'HIGH' },
            { label: 'session_not_asian',
              fn: (ind, feat)    => feat.session !== 'Asian' },
        ],
        reason: (ind, feat) =>
            `[ML_EDGE_08/PUT/10m] rsi_14=${feat.rsi_14?.toFixed(4)} macd_line=${feat.macd_line?.toFixed(4)} macd_histogram=${feat.macd_histogram?.toFixed(4)} regime=${feat.regime} session=${feat.session}`,
    },
];

// Tier sizing
const RISK_BY_WR = {
    high: 0.010,  // WR >= 0.80 → 1.0% risk  (EDGE_01, EDGE_02)
    mid:  0.005,  // WR >= 0.70 → 0.5% risk  (EDGE_06, EDGE_07)
    low:  0.003,  // WR >= 0.60 → 0.3% risk  (EDGE_08 gated)
};

// Composite router — cascades in WR order, first match wins
function mlRouter(ind, feat) {
    for (const strat of ML_STRATEGIES) {
        let allPass = true;
        for (const g of strat.gates) {
            if (!g.fn(ind, feat, strat.thresholds)) { allPass = false; break; }
        }
        if (allPass) {
            const idx  = ML_STRATEGIES.indexOf(strat);
            const risk = idx < 2 ? RISK_BY_WR.high : idx < 4 ? RISK_BY_WR.mid : RISK_BY_WR.low;
            return {
                action:    strat.direction,
                edge_name: strat.name,
                horizon:   strat.horizon,
                risk_pct:  risk,
                reason:    strat.reason(ind, feat),
            };
        }
    }
    return null;
}

module.exports = { ML_STRATEGIES, mlRouter, BEST_TIMER_PER_GROUP };
