/**
 * Analysis Engine — Local backtesting and signal simulation.
 *
 * Replays historical candles bar-by-bar, reconstructs ALL   gate values,
 * fires simulated signals, and validates against the NEXT candle close.
 *
 * This is the same approach as tests/test_patterns.js but exposed as MCP tools
 * so Claude can query results conversationally.
 *
 * Column mapping (indicators table):
 *   ma1 = MA6, ma2 = MA50, ma3 = MA14
 *   stochastic_k_v2 / stochastic_d_v2 =   stochastic (5,3,3)
 *   stochastic_k / stochastic_d =   stochastic (13,3,3)
 */

import { all, get } from '../connection.js';

// ─── Pattern label helpers ────────────────────────────────────────────────────
// Maps the exact reasons strings the bot writes to signal pattern names.
// reasons field examples:
//   CALL Reversal:     "OVERSOLD | Reversal | K crash ..."
//   PUT Reversal:      "OVERBOUGHT | Reversal | RSI ..."
//   CALL Continuation: "UP TREND | MA6 ... conv up ..."
//   PUT Continuation:  "DOWN TREND | MA6 ... conv down ..."

function parsePatternFromReasons(reasons, direction) {
    if (!reasons) return 'UNKNOWN';
    // reasons is stored as JSON array string e.g. '["OVERSOLD | Reversal | ..."]'
    let text = reasons;
    try { const parsed = JSON.parse(reasons); text = Array.isArray(parsed) ? parsed.join(' ') : String(parsed); } catch { /* use raw */ }
    if (text.includes('OVERSOLD') && text.includes('Reversal')) return 'CALL_REVERSAL';
    if (text.includes('OVERBOUGHT') && text.includes('Reversal')) return 'PUT_REVERSAL';
    if (text.includes('UP TREND')) return 'CALL_CONTINUATION';
    if (text.includes('DOWN TREND')) return 'PUT_CONTINUATION';
    return direction === 'CALL' ? 'CALL_OTHER' : 'PUT_OTHER';
}

// ─── Lookback context helper ──────────────────────────────────────────────────
// Computes "where did indicators come from" for the N bars before bar at index t.
// Returns context fields that describe the retracement depth and trend state.
//
// Fields produced:
//   rsi_peak_10      — max RSI in last 10 bars (PUT: how overbought was it?)
//   rsi_trough_10    — min RSI in last 10 bars (CALL: how oversold was it?)
//   k_bars_above_65  — consecutive bars K was above 65 before bar0 (PUT extension depth)
//   k_bars_below_35  — consecutive bars K was below 35 before bar0 (CALL extension depth)
//   ma_gap_trend     — 'widening' | 'narrowing' | 'flat' — is MA6/MA14 gap changing?
//   bb_expanding     — true if BB width at bar0 > BB width 5 bars ago (volatility rising)

function computeLookback(candles, t) {
    const LOOKBACK = 10;
    const GAP_LOOKBACK = 3;

    // Gather up to LOOKBACK bars before t (exclusive)
    const history = [];
    for (let i = Math.max(0, t - LOOKBACK); i < t; i++) {
        history.push(candles[i]);
    }

    // RSI peak and trough over last 10 bars
    const rsiVals = history.map(c => c.rsi_5).filter(v => v != null);
    const rsi_peak_10 = rsiVals.length > 0 ? Math.max(...rsiVals) : null;
    const rsi_trough_10 = rsiVals.length > 0 ? Math.min(...rsiVals) : null;

    // K extension: count consecutive bars from barM1 backwards where K > 65 (PUT)
    let k_bars_above_65 = 0;
    for (let i = t - 1; i >= 0; i--) {
        const k = candles[i].stochastic_k_v2;
        if (k == null) break;
        if (k > 65) k_bars_above_65++;
        else break;
    }

    // K extension: count consecutive bars from barM1 backwards where K < 35 (CALL)
    let k_bars_below_35 = 0;
    for (let i = t - 1; i >= 0; i--) {
        const k = candles[i].stochastic_k_v2;
        if (k == null) break;
        if (k < 35) k_bars_below_35++;
        else break;
    }

    // MA gap trend: compare MA6/MA14 gap now vs GAP_LOOKBACK bars ago
    const bar0 = candles[t];
    const barPrev = t >= GAP_LOOKBACK ? candles[t - GAP_LOOKBACK] : null;
    let ma_gap_trend = 'unknown';
    if (bar0.ma1 != null && bar0.ma3 != null && barPrev && barPrev.ma1 != null && barPrev.ma3 != null) {
        const gapNow = bar0.ma1 - bar0.ma3;
        const gapPrev = barPrev.ma1 - barPrev.ma3;
        const delta = gapNow - gapPrev;
        // Normalise by price to get bps change
        const deltaBps = (delta / bar0.ma3) * 10000;
        if (Math.abs(deltaBps) < 1) ma_gap_trend = 'flat';
        else if (deltaBps > 0) ma_gap_trend = 'widening_up';   // MA6 pulling away above MA14
        else ma_gap_trend = 'widening_down';  // MA6 pulling away below MA14
        // For reversals: narrowing = gap moving toward zero from either side
        const absNow = Math.abs(gapNow);
        const absPrev = Math.abs(gapPrev);
        if (absPrev - absNow > (bar0.ma3 * 0.0001)) ma_gap_trend = 'narrowing'; // gap shrinking = exhaustion
    }

    // BB expansion: is BB width growing vs 5 bars ago?
    let bb_expanding = null;
    const barBbPrev = t >= 5 ? candles[t - 5] : null;
    if (bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null &&
        barBbPrev && barBbPrev.bb_upper != null && barBbPrev.bb_lower != null && barBbPrev.bb_middle != null) {
        const widthNow = (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle;
        const widthPrev = (barBbPrev.bb_upper - barBbPrev.bb_lower) / barBbPrev.bb_middle;
        bb_expanding = widthNow > widthPrev;
    }

    return { rsi_peak_10, rsi_trough_10, k_bars_above_65, k_bars_below_35, ma_gap_trend, bb_expanding };
}

// ───   Gate Definitions (from indicators.js, matching test_patterns.js) ─

const CALL_GATES = {
    name: 'K Flash Crash Bounce',
    check: (barM2, barM1, bar0) => {
        const i1 = barM1, i0 = bar0;
        if (i1.stochastic_k_v2 == null || i0.stochastic_k_v2 == null) return { pass: false, gates: {}, values: {} };

        const g1_maStack = i0.ma1 != null && i0.ma3 != null &&
            i0.ma1 < i0.ma3;
        const kCrash = i1.stochastic_k_v2 - i0.stochastic_k_v2;
        const g2_kCrash = kCrash > 25;
        const g3_kOversold = i0.stochastic_k_v2 < 25;
        const g4_kWasMid = i1.stochastic_k_v2 >= 50;
        const g5_rsiDown = i0.rsi_5 != null && i0.rsi_5 < 20; // Change 4: tightened from 40 → 20
        const maTrendBps = i0.ma1 != null && i0.ma3 != null
            ? ((i0.ma1 - i0.ma3) / i0.ma3) * 10000 : null;
        const g6_maNotDeep = maTrendBps != null && maTrendBps > -20;
        const bbBps = i0.bb_upper != null && i0.bb_lower != null && i0.bb_middle != null && i0.bb_middle > 0
            ? (i0.bb_upper - i0.bb_lower) / i0.bb_middle * 10000 : null;
        const g7_bbWide = bbBps != null && bbBps >= 20; // Change 2: tightened from 10 → 20 bps

        const pass = g1_maStack && g2_kCrash && g3_kOversold && g4_kWasMid && g5_rsiDown && g6_maNotDeep && g7_bbWide;

        return {
            pass, direction: 'CALL', patternName: 'OVERSOLD',
            gates: { g1_maStack, g2_kCrash, g3_kOversold, g4_kWasMid, g5_rsiDown, g6_maNotDeep, g7_bbWide },
            values: {
                rsi_0: i0.rsi_5, rsi_m1: i1.rsi_5,
                k_m1: i1.stochastic_k_v2, k_0: i0.stochastic_k_v2,
                kCrash, d_0: i0.stochastic_d_v2,
                ma6_0: i0.ma1, ma14_0: i0.ma3, ma6_ma14_bps: maTrendBps,
                bb_bps: bbBps,
            }
        };
    }
};

const PUT_GATES = {
    name: 'Overbought Reversal',
    check: (barM2, barM1, bar0) => {
        const i2 = barM2, i1 = barM1, i0 = bar0;
        if (i2.rsi_5 == null || i1.rsi_5 == null) return { pass: false, gates: {}, values: {} };

        const g0_rsiPriorOB = i2.rsi_5 > 80; // Change 3: bar-2 RSI must have been genuinely overbought (>80)
        const g1_rsiBaseline = i2.rsi_5 > 70 && i1.rsi_5 > 70 &&
            !(i1.rsi_5 >= 75 && i1.rsi_5 < 80);
        const rsiFalling = i0.rsi_5 != null && i0.rsi_5 < i1.rsi_5;
        const rsiVelocity = i0.rsi_5 != null && i1.rsi_5 != null ? i0.rsi_5 - i1.rsi_5 : null;
        const closeAboveMid = i0.close != null && i0.bb_middle != null && i0.close >= i0.bb_middle;
        const g2_rsiRecovery = rsiFalling && i0.rsi_5 >= 38 && i0.rsi_5 < 70 &&
            !(i0.rsi_5 >= 55 && i0.rsi_5 < 65) &&
            rsiVelocity != null && rsiVelocity > -12 && closeAboveMid;
        const kFalling = i0.stochastic_k_v2 != null && i1.stochastic_k_v2 != null && i0.stochastic_k_v2 < i1.stochastic_k_v2;
        const g3_kTurn = i1.stochastic_k_v2 != null && i1.stochastic_k_v2 > 65 &&
            kFalling && i0.stochastic_k_v2 >= 55 && i0.stochastic_k_v2 < 80;
        const g4_dPosition = i0.stochastic_d_v2 != null && i0.stochastic_d_v2 >= 80;
        const g5_maStack = i0.ma1 != null && i0.ma3 != null &&
            i0.ma1 > i0.ma3;
        const kdSpread = i0.stochastic_k_v2 != null && i0.stochastic_d_v2 != null
            ? i0.stochastic_k_v2 - i0.stochastic_d_v2 : null;
        const g6_kdCross = kdSpread != null && kdSpread < -3;
        const maTrendBps = i0.ma1 != null && i0.ma3 != null
            ? ((i0.ma1 - i0.ma3) / i0.ma3) * 10000 : null;
        const g7_maTrendWeak = maTrendBps != null && maTrendBps < 20;
        const bbBps = i0.bb_upper != null && i0.bb_lower != null && i0.bb_middle != null && i0.bb_middle > 0
            ? (i0.bb_upper - i0.bb_lower) / i0.bb_middle * 10000 : null;
        const g8_bbWide = bbBps != null && bbBps >= 20; // Change 2: tightened from 10 → 20 bps

        const pass = g0_rsiPriorOB && g1_rsiBaseline && g2_rsiRecovery && g3_kTurn && g4_dPosition && g5_maStack && g6_kdCross && g7_maTrendWeak && g8_bbWide;

        return {
            pass, direction: 'PUT', patternName: 'OVERBOUGHT',
            gates: { g0_rsiPriorOB, g1_rsiBaseline, g2_rsiRecovery, g3_kTurn, g4_dPosition, g5_maStack, g6_kdCross, g7_maTrendWeak, g8_bbWide },
            values: {
                rsi_m2: i2.rsi_5, rsi_m1: i1.rsi_5, rsi_0: i0.rsi_5,
                rsiVelocity, closeAboveMid,
                k_m1: i1.stochastic_k_v2, k_0: i0.stochastic_k_v2,
                d_0: i0.stochastic_d_v2, kdSpread,
                ma6_0: i0.ma1, ma14_0: i0.ma3, ma6_ma14_bps: maTrendBps,
                bb_bps: bbBps,
            }
        };
    }
};

// ─── replayCandles() — Candle-by-candle replay across all assets ─────────────

export async function replayCandles(asset = null, params = {}) {
    // Build query
    let whereClause = '';
    let queryParams = [];
    if (asset) {
        whereClause = 'WHERE c.asset = ?';
        queryParams = [asset];
    }

    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma2, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ${whereClause}
        ORDER BY c.asset, c.timestamp
    `, queryParams);

    if (!rows.length) return { success: false, error: 'No candles found' };

    // Group by asset, sorted by timestamp
    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    const signals = [];
    let totalCandles = 0, candlesWithIndicators = 0, candlesWithHistory = 0;
    const callRejections = { g1_maStack: 0, g2_kCrash: 0, g3_kOversold: 0, g4_kWasMid: 0, g5_rsiDown: 0, g6_maNotDeep: 0, g7_bbWide: 0 };
    const putRejections = { g0_rsiPriorOB: 0, g1_rsiBaseline: 0, g2_rsiRecovery: 0, g3_kTurn: 0, g4_dPosition: 0, g5_maStack: 0, g6_kdCross: 0, g7_maTrendWeak: 0, g8_bbWide: 0 };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        for (let t = 2; t < candles.length; t++) {
            totalCandles++;
            const barM2 = candles[t - 2];
            const barM1 = candles[t - 1];
            const bar0 = candles[t];

            if (bar0.rsi_5 == null) continue;
            candlesWithIndicators++;
            if (barM1.rsi_5 == null || barM2.rsi_5 == null) continue;
            candlesWithHistory++;

            // Compute lookback context once per bar (shared by CALL and PUT)
            const ctx = computeLookback(candles, t);

            // Check CALL
            const callResult = CALL_GATES.check(barM2, barM1, bar0);
            if (callResult.pass) {
                const nextBar = candles[t + 1];
                const isGap = !nextBar || (nextBar.timestamp - bar0.timestamp > 120);
                let result = null, exitPrice = null;
                const amount = params.amount || 500;
                if (!isGap) {
                    exitPrice = nextBar.close;
                    result = nextBar.close > bar0.close ? 'WIN' : 'LOSS';
                }
                signals.push({
                    asset: assetName, signalTs: bar0.timestamp,
                    direction: 'CALL', entryPrice: bar0.close, exitPrice,
                    result, profitLoss: result === 'WIN' ? amount * 0.92 : -amount,
                    gapFlag: isGap, ...callResult.values, ...callResult.gates, ...ctx,
                });
            } else {
                for (const [gn, val] of Object.entries(callResult.gates)) {
                    if (val === false) callRejections[gn]++;
                }
            }

            // Check PUT
            const putResult = PUT_GATES.check(barM2, barM1, bar0);
            if (putResult.pass) {
                const nextBar = candles[t + 1];
                const isGap = !nextBar || (nextBar.timestamp - bar0.timestamp > 120);
                let result = null, exitPrice = null;
                const amount = params.amount || 500;
                if (!isGap) {
                    exitPrice = nextBar.close;
                    result = nextBar.close < bar0.close ? 'WIN' : 'LOSS';
                }
                signals.push({
                    asset: assetName, signalTs: bar0.timestamp,
                    direction: 'PUT', entryPrice: bar0.close, exitPrice,
                    result, profitLoss: result === 'WIN' ? amount * 0.92 : -amount,
                    gapFlag: isGap, ...putResult.values, ...putResult.gates, ...ctx,
                });
            } else {
                for (const [gn, val] of Object.entries(putResult.gates)) {
                    if (val === false) putRejections[gn]++;
                }
            }
        }
    }

    // Aggregate results
    const callSignals = signals.filter(s => s.direction === 'CALL');
    const putSignals = signals.filter(s => s.direction === 'PUT');
    const callValid = callSignals.filter(s => s.result != null);
    const putValid = putSignals.filter(s => s.result != null);
    const callWins = callValid.filter(s => s.result === 'WIN').length;
    const putWins = putValid.filter(s => s.result === 'WIN').length;

    return {
        success: true,
        asset_filter: asset || 'all',
        total_candles: totalCandles,
        candles_with_indicators: candlesWithIndicators,
        candles_with_history: candlesWithHistory,
        call: {
            total_fired: callSignals.length,
            validated: callValid.length,
            wins: callWins,
            losses: callValid.length - callWins,
            win_rate: callValid.length > 0 ? ((callWins / callValid.length) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: callValid.reduce((a, s) => a + (s.profitLoss || 0), 0),
            gate_rejections: callRejections,
        },
        put: {
            total_fired: putSignals.length,
            validated: putValid.length,
            wins: putWins,
            losses: putValid.length - putWins,
            win_rate: putValid.length > 0 ? ((putWins / putValid.length) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: putValid.reduce((a, s) => a + (s.profitLoss || 0), 0),
            gate_rejections: putRejections,
        },
        signals_all: signals, // Full signal list for findEdge / optimizeGates
        signals_detail: signals.slice(0, 50), // First 50 for inspection
    };
}

// ─── findEdge() — Analyze patterns in validated signals ──────────────────────

export async function findEdge() {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    // Use full signal list — signals_all contains every signal, not just first 50
    const allSignals = replay.signals_all || replay.signals_detail || [];
    const validSignals = allSignals.filter(s => s.result != null);

    if (validSignals.length < 5) {
        return { success: false, error: `Need at least 5 validated signals, have ${validSignals.length}` };
    }

    // ── Analysis 1: RSI distribution ──
    const rsiBuckets = [
        { range: '0-20', min: 0, max: 20 },
        { range: '20-30', min: 20, max: 30 },
        { range: '30-40', min: 30, max: 40 },
        { range: '40-50', min: 40, max: 50 },
        { range: '50-60', min: 50, max: 60 },
        { range: '60-70', min: 60, max: 70 },
        { range: '70-80', min: 70, max: 80 },
        { range: '80-100', min: 80, max: 100 },
    ];

    const rsiAnalysis = rsiBuckets.map(bucket => {
        const bucketTrades = validSignals.filter(s => s.rsi_0 != null && s.rsi_0 >= bucket.min && s.rsi_0 < bucket.max);
        const bucketWins = bucketTrades.filter(s => s.result === 'WIN').length;
        return {
            rsi_range: bucket.range,
            trades: bucketTrades.length,
            wins: bucketWins,
            losses: bucketTrades.length - bucketWins,
            win_rate: bucketTrades.length > 0 ? ((bucketWins / bucketTrades.length) * 100).toFixed(1) + '%' : 'N/A',
        };
    }).filter(b => b.trades > 0);

    // ── Analysis 2: Stochastic K distribution ──
    const stochBuckets = [
        { range: '0-20', min: 0, max: 20 },
        { range: '20-40', min: 20, max: 40 },
        { range: '40-60', min: 40, max: 60 },
        { range: '60-80', min: 60, max: 80 },
        { range: '80-100', min: 80, max: 100 },
    ];

    const stochAnalysis = stochBuckets.map(bucket => {
        const bucketTrades = validSignals.filter(s => s.k_0 != null && s.k_0 >= bucket.min && s.k_0 < bucket.max);
        const bucketWins = bucketTrades.filter(s => s.result === 'WIN').length;
        return {
            stoch_k_range: bucket.range,
            trades: bucketTrades.length,
            wins: bucketWins,
            losses: bucketTrades.length - bucketWins,
            win_rate: bucketTrades.length > 0 ? ((bucketWins / bucketTrades.length) * 100).toFixed(1) + '%' : 'N/A',
        };
    }).filter(b => b.trades > 0);

    // ── Analysis 3: MA gap distribution ──
    const maGapBuckets = [
        { range: '< -20', max: -20 },
        { range: '-20 to -10', min: -20, max: -10 },
        { range: '-10 to 0', min: -10, max: 0 },
        { range: '0 to 10', min: 0, max: 10 },
        { range: '10 to 20', min: 10, max: 20 },
        { range: '20+', min: 20 },
    ];

    const maGapAnalysis = maGapBuckets.map(bucket => {
        const bucketTrades = validSignals.filter(s => {
            if (s.maTrendBps == null) return false;
            if (bucket.min != null && bucket.max != null) return s.maTrendBps >= bucket.min && s.maTrendBps < bucket.max;
            if (bucket.max != null) return s.maTrendBps < bucket.max;
            if (bucket.min != null) return s.maTrendBps >= bucket.min;
            return false;
        });
        const bucketWins = bucketTrades.filter(s => s.result === 'WIN').length;
        return {
            ma6_ma14_gap_bps: bucket.range,
            trades: bucketTrades.length,
            wins: bucketWins,
            losses: bucketTrades.length - bucketWins,
            win_rate: bucketTrades.length > 0 ? ((bucketWins / bucketTrades.length) * 100).toFixed(1) + '%' : 'N/A',
        };
    }).filter(b => b.trades > 0);

    // ── Analysis 4: Hour of day ──
    const hourAnalysis = {};
    for (const s of validSignals) {
        const hour = Math.floor((s.signalTs % 86400) / 3600);
        if (!hourAnalysis[hour]) hourAnalysis[hour] = { trades: 0, wins: 0 };
        hourAnalysis[hour].trades++;
        if (s.result === 'WIN') hourAnalysis[hour].wins++;
    }

    const hourData = Object.entries(hourAnalysis)
        .map(([hour, data]) => ({
            hour_utc: parseInt(hour),
            trades: data.trades,
            wins: data.wins,
            losses: data.trades - data.wins,
            win_rate: ((data.wins / data.trades) * 100).toFixed(1) + '%',
        }))
        .sort((a, b) => b.trades - a.trades);

    // ── Analysis 5: By asset ──
    const assetAnalysis = {};
    for (const s of validSignals) {
        if (!assetAnalysis[s.asset]) assetAnalysis[s.asset] = { trades: 0, wins: 0, total_pl: 0, call_w: 0, call_l: 0, put_w: 0, put_l: 0 };
        assetAnalysis[s.asset].trades++;
        if (s.result === 'WIN') assetAnalysis[s.asset].wins++;
        assetAnalysis[s.asset].total_pl += (s.profitLoss || 0);
        if (s.direction === 'CALL') {
            if (s.result === 'WIN') assetAnalysis[s.asset].call_w++;
            else assetAnalysis[s.asset].call_l++;
        } else {
            if (s.result === 'WIN') assetAnalysis[s.asset].put_w++;
            else assetAnalysis[s.asset].put_l++;
        }
    }

    const assetData = Object.entries(assetAnalysis)
        .map(([asset, data]) => {
            const callTotal = data.call_w + data.call_l;
            const putTotal = data.put_w + data.put_l;
            const callWR = callTotal > 0 ? (data.call_w / callTotal) * 100 : null;
            const putWR = putTotal > 0 ? (data.put_w / putTotal) * 100 : null;
            let preferred_direction = null;
            if (callWR !== null && putWR !== null) preferred_direction = callWR >= putWR ? 'CALL' : 'PUT';
            else if (callWR !== null) preferred_direction = 'CALL';
            else if (putWR !== null) preferred_direction = 'PUT';
            return {
                asset,
                trades: data.trades,
                wins: data.wins,
                losses: data.trades - data.wins,
                win_rate: ((data.wins / data.trades) * 100).toFixed(1) + '%',
                total_pl: Math.round(data.total_pl * 100) / 100,
                call: callTotal > 0 ? { w: data.call_w, l: data.call_l, wr: callWR.toFixed(1) + '%' } : null,
                put: putTotal > 0 ? { w: data.put_w, l: data.put_l, wr: putWR.toFixed(1) + '%' } : null,
                preferred_direction,
            };
        })
        .sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

    // ── Analysis 6: BB width buckets ──
    const bbBuckets = [
        { label: 'flat (<2 bps)', min: 0, max: 2 },
        { label: 'weak (2-5 bps)', min: 2, max: 5 },
        { label: 'marginal (5-10)', min: 5, max: 10 },
        { label: 'ok (10-20)', min: 10, max: 20 },
        { label: 'good (20+ bps)', min: 20, max: Infinity },
    ];

    // Compute bb_bps per signal from raw indicator values stored in signal
    const bbAnalysis = bbBuckets.map(b => {
        const bucket = validSignals.filter(s => {
            if (s.bb_upper == null || s.bb_lower == null || s.bb_middle == null || s.bb_middle === 0) return false;
            const bps = (s.bb_upper - s.bb_lower) / s.bb_middle * 10000;
            return bps >= b.min && bps < b.max;
        });
        const wins = bucket.filter(s => s.result === 'WIN').length;
        return {
            bb_range: b.label,
            trades: bucket.length,
            wins,
            losses: bucket.length - wins,
            win_rate: bucket.length > 0 ? ((wins / bucket.length) * 100).toFixed(1) + '%' : 'N/A',
        };
    }).filter(b => b.trades > 0);

    // ── Analysis 7: Retracement depth — RSI peak/trough before signal ───────────
    // PUT: how overbought was RSI in the 10 bars before the signal?
    // CALL: how oversold was RSI in the 10 bars before the signal?
    // Deeper retracement = stronger setup hypothesis — validate against actual WR.

    const putSignalsCtx = validSignals.filter(s => s.direction === 'PUT' && s.rsi_peak_10 != null);
    const callSignalsCtx = validSignals.filter(s => s.direction === 'CALL' && s.rsi_trough_10 != null);

    const rsiPeakBuckets = [
        { label: '< 70 (weak)', min: 0, max: 70 },
        { label: '70-80 (mild)', min: 70, max: 80 },
        { label: '80-90 (strong)', min: 80, max: 90 },
        { label: '90+ (extreme)', min: 90, max: 101 },
    ];
    const rsiTroughBuckets = [
        { label: '< 10 (extreme)', min: 0, max: 10 },
        { label: '10-20 (strong)', min: 10, max: 20 },
        { label: '20-30 (mild)', min: 20, max: 30 },
        { label: '30+ (weak)', min: 30, max: 101 },
    ];

    const byRsiPeak = rsiPeakBuckets.map(b => {
        const bucket = putSignalsCtx.filter(s => s.rsi_peak_10 >= b.min && s.rsi_peak_10 < b.max);
        const wins = bucket.filter(s => s.result === 'WIN').length;
        return {
            direction: 'PUT', rsi_peak_before: b.label, trades: bucket.length, wins, losses: bucket.length - wins,
            win_rate: bucket.length > 0 ? ((wins / bucket.length) * 100).toFixed(1) + '%' : 'N/A'
        };
    }).filter(b => b.trades > 0);

    const byRsiTrough = rsiTroughBuckets.map(b => {
        const bucket = callSignalsCtx.filter(s => s.rsi_trough_10 >= b.min && s.rsi_trough_10 < b.max);
        const wins = bucket.filter(s => s.result === 'WIN').length;
        return {
            direction: 'CALL', rsi_trough_before: b.label, trades: bucket.length, wins, losses: bucket.length - wins,
            win_rate: bucket.length > 0 ? ((wins / bucket.length) * 100).toFixed(1) + '%' : 'N/A'
        };
    }).filter(b => b.trades > 0);

    const retracementDepth = { put_by_rsi_peak: byRsiPeak, call_by_rsi_trough: byRsiTrough };

    // ── Analysis 8: K extension duration before signal ────────────────────────
    // How many consecutive bars was K extended before the crash/reversal?
    // More bars extended = more exhausted = higher probability reversal.

    const kExtBuckets = [
        { label: '1 bar', min: 1, max: 2 },
        { label: '2 bars', min: 2, max: 3 },
        { label: '3 bars', min: 3, max: 4 },
        { label: '4+ bars', min: 4, max: 999 },
    ];

    const byKExtPut = kExtBuckets.map(b => {
        const bucket = validSignals.filter(s => s.direction === 'PUT' && s.k_bars_above_65 != null &&
            s.k_bars_above_65 >= b.min && s.k_bars_above_65 < b.max);
        const wins = bucket.filter(s => s.result === 'WIN').length;
        return {
            direction: 'PUT', k_bars_above_65: b.label, trades: bucket.length, wins, losses: bucket.length - wins,
            win_rate: bucket.length > 0 ? ((wins / bucket.length) * 100).toFixed(1) + '%' : 'N/A'
        };
    }).filter(b => b.trades > 0);

    const byKExtCall = kExtBuckets.map(b => {
        const bucket = validSignals.filter(s => s.direction === 'CALL' && s.k_bars_below_35 != null &&
            s.k_bars_below_35 >= b.min && s.k_bars_below_35 < b.max);
        const wins = bucket.filter(s => s.result === 'WIN').length;
        return {
            direction: 'CALL', k_bars_below_35: b.label, trades: bucket.length, wins, losses: bucket.length - wins,
            win_rate: bucket.length > 0 ? ((wins / bucket.length) * 100).toFixed(1) + '%' : 'N/A'
        };
    }).filter(b => b.trades > 0);

    const kExtension = { put_by_k_duration: byKExtPut, call_by_k_duration: byKExtCall };

    // ── Analysis 9: MA gap trend direction at signal time ────────────────────
    // Is the MA6/MA14 gap narrowing (exhaustion) or widening (momentum)?
    // Narrowing into a reversal signal = trend losing steam = better setup.

    const maGapTrendAnalysis = {};
    for (const s of validSignals) {
        if (!s.ma_gap_trend) continue;
        const key = `${s.direction}|${s.ma_gap_trend}`;
        if (!maGapTrendAnalysis[key]) maGapTrendAnalysis[key] = { direction: s.direction, ma_gap_trend: s.ma_gap_trend, wins: 0, losses: 0 };
        if (s.result === 'WIN') maGapTrendAnalysis[key].wins++;
        else maGapTrendAnalysis[key].losses++;
    }

    const byMaGapTrend = Object.values(maGapTrendAnalysis).map(d => {
        const total = d.wins + d.losses;
        return { ...d, trades: total, win_rate: total > 0 ? ((d.wins / total) * 100).toFixed(1) + '%' : 'N/A' };
    }).sort((a, b) => b.trades - a.trades);

    // ── Analysis 10: BB expansion state at signal time ────────────────────────
    // Signal fires while BB expanding (breakout) vs contracting (squeeze resolve)?

    const bbExpAnalysis = { true: { wins: 0, losses: 0 }, false: { wins: 0, losses: 0 } };
    for (const s of validSignals) {
        if (s.bb_expanding == null) continue;
        const key = String(s.bb_expanding);
        if (!bbExpAnalysis[key]) bbExpAnalysis[key] = { wins: 0, losses: 0 };
        if (s.result === 'WIN') bbExpAnalysis[key].wins++;
        else bbExpAnalysis[key].losses++;
    }
    const byBbExpansion = Object.entries(bbExpAnalysis).map(([expanding, d]) => {
        const total = d.wins + d.losses;
        return {
            bb_expanding: expanding === 'true', trades: total, wins: d.wins, losses: d.losses,
            win_rate: total > 0 ? ((d.wins / total) * 100).toFixed(1) + '%' : 'N/A'
        };
    }).filter(b => b.trades > 0);

    // ── Analysis 11: By pattern — all 4 patterns from DB signals table ──────────
    // The replay engine only knows CALL (K_FLASH_CRASH) and PUT (LATE_OVERBOUGHT).
    // The bot also fires CALL_CONTINUATION (UP TREND) and PUT_CONTINUATION (DOWN TREND).
    // Read trades_ordered joined to signals to get pattern labels from reasons field,
    // then cross with replay results for gate-level analysis.

    // DB pattern breakdown: join trades_ordered → signals on asset + timestamp proximity
    const dbPatternRows = await all(
        `SELECT t.direction, t.result, t.profit_loss, s.reasons
         FROM trades_ordered t
         JOIN signals s ON s.asset = t.asset
           AND s.timestamp >= t.entry_timestamp - 120
           AND s.timestamp <= t.entry_timestamp + 120
         WHERE t.result IN ('WIN','LOSS')
         ORDER BY t.entry_timestamp DESC`,
        []
    );

    const patternMap = {};
    for (const r of dbPatternRows) {
        const label = parsePatternFromReasons(r.reasons, r.direction);
        if (!patternMap[label]) patternMap[label] = { wins: 0, losses: 0, pl: 0 };
        if (r.result === 'WIN') patternMap[label].wins++;
        else patternMap[label].losses++;
        patternMap[label].pl += (r.profit_loss || 0);
    }

    // Also tag replay signals by gate set name
    const replayPatternMap = {};
    for (const s of validSignals) {
        // replay signals carry patternName from CALL_GATES / PUT_GATES
        const label = s.direction === 'CALL' ? 'CALL_REVERSAL' : 'PUT_REVERSAL';
        if (!replayPatternMap[label]) replayPatternMap[label] = { wins: 0, losses: 0, pl: 0 };
        if (s.result === 'WIN') replayPatternMap[label].wins++;
        else replayPatternMap[label].losses++;
        replayPatternMap[label].pl += (s.profitLoss || 0);
    }

    // Merge DB patterns (all 4) with replay results (2 gate sets)
    const allPatternKeys = new Set([
        'CALL_REVERSAL', 'PUT_REVERSAL', 'CALL_CONTINUATION', 'PUT_CONTINUATION',
        ...Object.keys(patternMap), ...Object.keys(replayPatternMap),
    ]);

    const patternData = Array.from(allPatternKeys).map(pattern => {
        const db = patternMap[pattern] || null;
        const rp = replayPatternMap[pattern] || null;
        // Prefer DB data (real executed trades); fall back to replay if no DB data
        const src = db || rp;
        if (!src) return null;
        const total = src.wins + src.losses;
        return {
            pattern,
            type: pattern.includes('REVERSAL') ? 'Reversal' : 'Continuation',
            direction: pattern.startsWith('CALL') ? 'CALL' : 'PUT',
            source: db ? 'live_trades' : 'replay',
            trades: total,
            wins: src.wins,
            losses: src.losses,
            win_rate: total > 0 ? ((src.wins / total) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: parseFloat(src.pl.toFixed(2)),
        };
    }).filter(Boolean).sort((a, b) => b.trades - a.trades);

    const totalWins = validSignals.filter(s => s.result === 'WIN').length;
    return {
        success: true,
        total_signals: validSignals.length,
        wins: totalWins,
        losses: validSignals.length - totalWins,
        overall_wr: ((totalWins / validSignals.length) * 100).toFixed(1) + '%',
        analyses: {
            by_rsi: rsiAnalysis,
            by_stochastic_k: stochAnalysis,
            by_ma_gap: maGapAnalysis,
            by_hour: hourData,
            by_bb_width: bbAnalysis,
            by_pattern: patternData,
            by_retracement_depth: retracementDepth,
            by_k_extension: kExtension,
            by_ma_gap_trend: byMaGapTrend,
            by_bb_expansion: byBbExpansion,
            by_asset: assetData,
            by_direction: {
                call: {
                    trades: validSignals.filter(s => s.direction === 'CALL').length,
                    wins: validSignals.filter(s => s.direction === 'CALL' && s.result === 'WIN').length,
                    wr: validSignals.filter(s => s.direction === 'CALL').length > 0
                        ? ((validSignals.filter(s => s.direction === 'CALL' && s.result === 'WIN').length / validSignals.filter(s => s.direction === 'CALL').length) * 100).toFixed(1) + '%' : 'N/A',
                },
                put: {
                    trades: validSignals.filter(s => s.direction === 'PUT').length,
                    wins: validSignals.filter(s => s.direction === 'PUT' && s.result === 'WIN').length,
                    wr: validSignals.filter(s => s.direction === 'PUT').length > 0
                        ? ((validSignals.filter(s => s.direction === 'PUT' && s.result === 'WIN').length / validSignals.filter(s => s.direction === 'PUT').length) * 100).toFixed(1) + '%' : 'N/A',
                },
            },
        },
    };
}

// ─── optimizeGates() — Grid search over gate thresholds ──────────────────────

export async function optimizeGates(direction = 'both') {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSignals = replay.signals_all || replay.signals_detail || [];
    const validSignals = allSignals.filter(s => s.result != null);

    if (validSignals.length < 10) {
        return { success: false, error: `Need at least 10 signals, have ${validSignals.length}` };
    }

    const results = [];

    // ── Test 1: RSI threshold for CALL ──
    if (direction === 'both' || direction === 'call') {
        const callSignals = validSignals.filter(s => s.direction === 'CALL');
        for (const rsiThreshold of [25, 30, 35, 38, 40, 42, 45, 50]) {
            const filtered = callSignals.filter(s => s.rsi_0 != null && s.rsi_0 < rsiThreshold);
            const wins = filtered.filter(s => s.result === 'WIN').length;
            results.push({
                test: 'CALL RSI threshold',
                param: `RSI < ${rsiThreshold}`,
                trades: filtered.length,
                wins,
                losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A',
            });
        }
    }

    // ── Test 2: K crash size for CALL ──
    if (direction === 'both' || direction === 'call') {
        const callSignals = validSignals.filter(s => s.direction === 'CALL');
        for (const crashThreshold of [15, 20, 25, 30, 35, 40]) {
            const filtered = callSignals.filter(s => s.kCrash != null && s.kCrash >= crashThreshold);
            const wins = filtered.filter(s => s.result === 'WIN').length;
            results.push({
                test: 'CALL K crash size',
                param: `K crash >= ${crashThreshold}`,
                trades: filtered.length,
                wins,
                losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A',
            });
        }
    }

    // ── Test 3: D threshold for PUT ──
    if (direction === 'both' || direction === 'put') {
        const putSignals = validSignals.filter(s => s.direction === 'PUT');
        for (const dThreshold of [70, 75, 80, 85, 90]) {
            const filtered = putSignals.filter(s => s.d_0 != null && s.d_0 >= dThreshold);
            const wins = filtered.filter(s => s.result === 'WIN').length;
            results.push({
                test: 'PUT D threshold',
                param: `D >= ${dThreshold}`,
                trades: filtered.length,
                wins,
                losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A',
            });
        }
    }

    // ── Test 4: MA gap for PUT ──
    if (direction === 'both' || direction === 'put') {
        const putSignals = validSignals.filter(s => s.direction === 'PUT');
        for (const maGapThreshold of [10, 15, 20, 25, 30]) {
            const filtered = putSignals.filter(s => s.maTrendBps != null && s.maTrendBps < maGapThreshold);
            const wins = filtered.filter(s => s.result === 'WIN').length;
            results.push({
                test: 'PUT MA gap threshold',
                param: `MA14-MA50 < ${maGapThreshold} bps`,
                trades: filtered.length,
                wins,
                losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A',
            });
        }
    }

    // ── Test 5: RSI velocity for PUT ──
    if (direction === 'both' || direction === 'put') {
        const putSignals = validSignals.filter(s => s.direction === 'PUT');
        for (const velThreshold of [-20, -15, -12, -10, -8, -5]) {
            const filtered = putSignals.filter(s => s.rsiVelocity != null && s.rsiVelocity > velThreshold);
            const wins = filtered.filter(s => s.result === 'WIN').length;
            results.push({
                test: 'PUT RSI velocity',
                param: `RSI velocity > ${velThreshold}`,
                trades: filtered.length,
                wins,
                losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A',
            });
        }
    }

    return {
        success: true,
        total_signals_analyzed: validSignals.length,
        optimizations: results,
    };
}

// ─── simulateGates() — Replay with custom gate thresholds vs baseline ────────
//
// Accepts override params for any gate threshold. Runs two full replays:
//   1. Baseline (current defaults)
//   2. Modified (your overrides)
// Returns side-by-side comparison: signal count, win rate, P/L per direction.
//
// Supported params:
//   call_rsi_max         (default 20)   — max RSI for CALL (g5_rsiDown)
//   call_k_crash_min     (default 25)   — min K drop size (g2_kCrash)
//   call_k_oversold_max  (default 25)   — max K at bar0 (g3_kOversold)
//   call_k_was_mid_min   (default 50)   — min K at barM1 (g4_kWasMid)
//   call_ma_trend_min    (default -20)  — min maTrendBps (g6_maNotDeep)
//   put_d_min            (default 80)   — min D for (g4_dPosition)
//   put_rsi_velocity_min (default -12)  — min RSI velocity (g2_rsiRecovery)
//   put_ma_trend_max     (default 20)   — max maTrendBps (g7_maTrendWeak)
//   put_k_turn_d_min     (default 65)   — min K at barM1 for (g3_kTurn)
//   min_bb_bps           (default 0)    — skip assets with avg BB width below this (asset-level)
//   bar_bb_bps_min       (default 0)    — skip individual bars where BB width < this (bar-level, more precise)

export async function simulateGates(params = {}) {
    const {
        call_rsi_max = 20,
        call_k_crash_min = 25,
        call_k_oversold_max = 25,
        call_k_was_mid_min = 50,
        call_ma_trend_min = -20,
        put_d_min = 80,
        put_rsi_velocity_min = -12,
        put_ma_trend_max = 20,
        put_k_turn_d_min = 65,
        min_bb_bps = 0,
        bar_bb_bps_min = 0,
        amount = 500,
    } = params;

    // Load candle+indicator data (same as replayCandles)
    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma2, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ORDER BY c.asset, c.timestamp
    `, []);

    if (!rows.length) return { success: false, error: 'No candles found' };

    // Group by asset
    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    // BB width per asset (avg last 100 bars with indicator data)
    const bbWidthByAsset = {};
    for (const [assetName, candles] of Object.entries(byAsset)) {
        const withBb = candles.filter(c => c.bb_upper != null && c.bb_lower != null && c.bb_middle != null);
        const last100 = withBb.slice(-100);
        if (last100.length > 0) {
            const avgBps = last100.reduce((s, c) => s + ((c.bb_upper - c.bb_lower) / c.bb_middle * 10000), 0) / last100.length;
            bbWidthByAsset[assetName] = avgBps;
        }
    }

    // Run baseline and modified replays
    const baselineSigs = { call: [], put: [] };
    const modifiedSigs = { call: [], put: [] };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        const bbBps = bbWidthByAsset[assetName] ?? 999;

        for (let t = 2; t < candles.length; t++) {
            const barM2 = candles[t - 2];
            const barM1 = candles[t - 1];
            const bar0 = candles[t];

            if (bar0.rsi_5 == null || barM1.rsi_5 == null || barM2.rsi_5 == null) continue;

            const nextBar = candles[t + 1];
            const isGap = !nextBar || (nextBar.timestamp - bar0.timestamp > 120);
            // MA trend: MA6 vs MA14 gap in bps (positive = MA6 above MA14 = uptrend)
            const maTrendBps = bar0.ma1 != null && bar0.ma3 != null
                ? ((bar0.ma1 - bar0.ma3) / bar0.ma3) * 10000 : null;
            // Per-bar BB width — used in modified blocks only (baseline is frozen)
            const barBbBps = bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null && bar0.bb_middle > 0
                ? (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle * 10000 : 999;
            const barBbSkip = bar_bb_bps_min > 0 && barBbBps < bar_bb_bps_min;

            // ── Baseline CALL (current defaults) ──
            {
                const i0 = bar0, i1 = barM1;
                const kCrash = i1.stochastic_k_v2 - i0.stochastic_k_v2;
                const basePass =
                    (i0.ma1 != null && i0.ma3 != null && i0.ma1 < i0.ma3) &&
                    kCrash > 25 &&
                    i0.stochastic_k_v2 < 25 &&
                    i1.stochastic_k_v2 >= 50 &&
                    (i0.rsi_5 != null && i0.rsi_5 < 20) &&
                    (maTrendBps != null && maTrendBps > -20) &&
                    (barBbBps >= 20);
                if (basePass) {
                    const result = !isGap ? (nextBar.close > bar0.close ? 'WIN' : 'LOSS') : null;
                    baselineSigs.call.push({ asset: assetName, result, pl: result === 'WIN' ? amount * 0.92 : result === 'LOSS' ? -amount : 0 });
                }
            }

            // ── Modified CALL ──
            {
                const i0 = bar0, i1 = barM1;
                const kCrash = i1.stochastic_k_v2 - i0.stochastic_k_v2;
                const bbSkip = min_bb_bps > 0 && bbBps < min_bb_bps;
                const modPass = !bbSkip && !barBbSkip &&
                    (i0.ma1 != null && i0.ma3 != null && i0.ma1 < i0.ma3) &&
                    kCrash > call_k_crash_min &&
                    i0.stochastic_k_v2 < call_k_oversold_max &&
                    i1.stochastic_k_v2 >= call_k_was_mid_min &&
                    (i0.rsi_5 != null && i0.rsi_5 < call_rsi_max) &&
                    (maTrendBps != null && maTrendBps > call_ma_trend_min);
                if (modPass) {
                    const result = !isGap ? (nextBar.close > bar0.close ? 'WIN' : 'LOSS') : null;
                    modifiedSigs.call.push({ asset: assetName, result, pl: result === 'WIN' ? amount * 0.92 : result === 'LOSS' ? -amount : 0 });
                }
            }

            // ── Baseline PUT (current defaults) ──
            {
                const i2 = barM2, i1 = barM1, i0 = bar0;
                const kFalling = i0.stochastic_k_v2 != null && i1.stochastic_k_v2 != null && i0.stochastic_k_v2 < i1.stochastic_k_v2;
                const rsiVelocity = i0.rsi_5 != null && i1.rsi_5 != null ? i0.rsi_5 - i1.rsi_5 : null;
                const closeAboveMid = i0.close != null && i0.bb_middle != null && i0.close >= i0.bb_middle;
                const kdSpread = i0.stochastic_k_v2 != null && i0.stochastic_d_v2 != null ? i0.stochastic_k_v2 - i0.stochastic_d_v2 : null;
                const basePass =
                    (i2.rsi_5 > 80) &&
                    (i2.rsi_5 > 70 && i1.rsi_5 > 70 && !(i1.rsi_5 >= 75 && i1.rsi_5 < 80)) &&
                    (i0.rsi_5 != null && i0.rsi_5 >= 38 && i0.rsi_5 < 70 && !(i0.rsi_5 >= 55 && i0.rsi_5 < 65) &&
                        rsiVelocity != null && rsiVelocity > -12 && closeAboveMid) &&
                    (i1.stochastic_k_v2 != null && i1.stochastic_k_v2 > 65 && kFalling && i0.stochastic_k_v2 >= 55 && i0.stochastic_k_v2 < 80) &&
                    (i0.stochastic_d_v2 != null && i0.stochastic_d_v2 >= 80) &&
                    (i0.ma1 != null && i0.ma3 != null && i0.ma1 > i0.ma3) &&
                    (kdSpread != null && kdSpread < -3) &&
                    (maTrendBps != null && maTrendBps < 20) &&
                    (barBbBps >= 20);
                if (basePass) {
                    const result = !isGap ? (nextBar.close < bar0.close ? 'WIN' : 'LOSS') : null;
                    baselineSigs.put.push({ asset: assetName, result, pl: result === 'WIN' ? amount * 0.92 : result === 'LOSS' ? -amount : 0 });
                }
            }

            // ── Modified PUT ──
            {
                const i2 = barM2, i1 = barM1, i0 = bar0;
                const bbSkip = min_bb_bps > 0 && bbBps < min_bb_bps;

                const kFalling = i0.stochastic_k_v2 != null && i1.stochastic_k_v2 != null && i0.stochastic_k_v2 < i1.stochastic_k_v2;
                const rsiVelocity = i0.rsi_5 != null && i1.rsi_5 != null ? i0.rsi_5 - i1.rsi_5 : null;
                const closeAboveMid = i0.close != null && i0.bb_middle != null && i0.close >= i0.bb_middle;
                const kdSpread = i0.stochastic_k_v2 != null && i0.stochastic_d_v2 != null ? i0.stochastic_k_v2 - i0.stochastic_d_v2 : null;
                const modPass = !bbSkip && !barBbSkip &&
                    (i2.rsi_5 > 70 && i1.rsi_5 > 70 && !(i1.rsi_5 >= 75 && i1.rsi_5 < 80)) &&
                    (i0.rsi_5 != null && i0.rsi_5 >= 38 && i0.rsi_5 < 70 && !(i0.rsi_5 >= 55 && i0.rsi_5 < 65) &&
                        rsiVelocity != null && rsiVelocity > put_rsi_velocity_min && closeAboveMid) &&
                    (i1.stochastic_k_v2 != null && i1.stochastic_k_v2 > put_k_turn_d_min && kFalling && i0.stochastic_k_v2 >= 55 && i0.stochastic_k_v2 < 80) &&
                    (i0.stochastic_d_v2 != null && i0.stochastic_d_v2 >= put_d_min) &&
                    (i0.ma1 != null && i0.ma3 != null && i0.ma1 > i0.ma3) &&
                    (kdSpread != null && kdSpread < -3) &&
                    (maTrendBps != null && maTrendBps < put_ma_trend_max);
                if (modPass) {
                    const result = !isGap ? (nextBar.close < bar0.close ? 'WIN' : 'LOSS') : null;
                    modifiedSigs.put.push({ asset: assetName, result, pl: result === 'WIN' ? amount * 0.92 : result === 'LOSS' ? -amount : 0 });
                }
            }
        }
    }

    const summarize = (sigs) => {
        const valid = sigs.filter(s => s.result != null);
        const wins = valid.filter(s => s.result === 'WIN').length;
        return {
            total_fired: sigs.length,
            validated: valid.length,
            wins,
            losses: valid.length - wins,
            win_rate: valid.length > 0 ? ((wins / valid.length) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: parseFloat(valid.reduce((s, x) => s + x.pl, 0).toFixed(2)),
        };
    };

    const base = { call: summarize(baselineSigs.call), put: summarize(baselineSigs.put) };
    const mod = { call: summarize(modifiedSigs.call), put: summarize(modifiedSigs.put) };

    const diff = (b, m, key) => {
        const bv = parseFloat(b[key]);
        const mv = parseFloat(m[key]);
        if (isNaN(bv) || isNaN(mv)) return 'N/A';
        const delta = mv - bv;
        return (delta >= 0 ? '+' : '') + (key === 'total_pl' ? delta.toFixed(2) : key === 'win_rate' ? delta.toFixed(1) + '%' : delta);
    };

    return {
        success: true,
        params_used: { call_rsi_max, call_k_crash_min, call_k_oversold_max, call_k_was_mid_min, call_ma_trend_min, put_d_min, put_rsi_velocity_min, put_ma_trend_max, put_k_turn_d_min, min_bb_bps, bar_bb_bps_min },
        baseline: base,
        modified: mod,
        delta: {
            call: {
                signal_count: diff(base.call, mod.call, 'total_fired'),
                win_rate: diff(base.call, mod.call, 'win_rate'),
                total_pl: diff(base.call, mod.call, 'total_pl'),
            },
            put: {
                signal_count: diff(base.put, mod.put, 'total_fired'),
                win_rate: diff(base.put, mod.put, 'win_rate'),
                total_pl: diff(base.put, mod.put, 'total_pl'),
            },
        },
        note: 'delta = modified − baseline. Positive win_rate/pl delta means improvement.',
    };
}

// ─── replaySignal() — Reconstruct gates for a specific historical signal ─────

export async function replaySignal(signalId) {
    const signal = await get(
        'SELECT * FROM signals WHERE id = ?', [signalId]
    );
    if (!signal) return { success: false, error: 'Signal not found' };

    // Get indicator rows: signal bar + 2 history bars
    const ind = await get(
        'SELECT * FROM indicators WHERE asset = ? AND timestamp = ?',
        [signal.asset, signal.timestamp]
    );
    if (!ind) return { success: false, error: 'No indicator data at signal time' };

    const hist = await all(
        'SELECT * FROM indicators WHERE asset = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 5',
        [signal.asset, signal.timestamp]
    );

    // Get trade outcome
    const trade = await get(
        `SELECT result, profit_loss, amount, entry_timestamp
         FROM trades_ordered
         WHERE asset = ? AND entry_timestamp >= ? AND entry_timestamp <= ?
         ORDER BY entry_timestamp ASC LIMIT 1`,
        [signal.asset, signal.timestamp, signal.timestamp + 120]
    );

    const barM2 = hist[1] ? {
        rsi_5: hist[1].rsi_5,
        stochastic_k_v2: hist[1].stochastic_k_v2,
        stochastic_d_v2: hist[1].stochastic_d_v2,
        ma1: hist[1].ma1, ma2: hist[1].ma2, ma3: hist[1].ma3,
        bb_middle: hist[1].bb_middle,
    } : null;

    const barM1 = hist[0] ? {
        rsi_5: hist[0].rsi_5,
        stochastic_k_v2: hist[0].stochastic_k_v2,
        stochastic_d_v2: hist[0].stochastic_d_v2,
        ma1: hist[0].ma1, ma2: hist[0].ma2, ma3: hist[0].ma3,
        bb_middle: hist[0].bb_middle,
    } : null;

    const bar0 = {
        rsi_5: ind.rsi_5,
        stochastic_k_v2: ind.stochastic_k_v2,
        stochastic_d_v2: ind.stochastic_d_v2,
        ma1: ind.ma1, ma2: ind.ma2, ma3: ind.ma3,
        bb_middle: ind.bb_middle,
    };

    const callResult = barM1 && barM2 ? CALL_GATES.check(barM2, barM1, bar0) : { pass: false, gates: {}, values: {} };
    const putResult = barM1 && barM2 ? PUT_GATES.check(barM2, barM1, bar0) : { pass: false, gates: {}, values: {} };

    return {
        success: true,
        signal: {
            id: signal.id,
            asset: signal.asset,
            timestamp: signal.timestamp,
            direction: signal.direction,
            strategy: signal.strategy_used,
        },
        outcome: trade ? {
            result: trade.result,
            profit_loss: trade.profit_loss,
            amount: trade.amount,
        } : null,
        call_gates: {
            passed: callResult.pass,
            details: callResult.gates,
            values: callResult.values,
        },
        put_gates: {
            passed: putResult.pass,
            details: putResult.gates,
            values: putResult.values,
        },
        history: [barM2, barM1, bar0].filter(Boolean).map((b, i) => ({
            bar: i === 2 ? 'signal' : `-${2 - i}`,
            rsi_5: b.rsi_5?.toFixed(1),
            stoch_k: b.stochastic_k_v2?.toFixed(1),
            stoch_d: b.stochastic_d_v2?.toFixed(1),
        })),
    };
}
