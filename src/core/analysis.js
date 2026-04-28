/**
 * Analysis Engine — Local backtesting and signal simulation.
 *
 * Replays historical candles bar-by-bar, fires STC reversal gates,
 * and validates against prices table (T+120s) with next-bar-close fallback.
 *
 * Column mapping (indicators table):
 *   ma1 = MA6, ma2 = MA50, ma3 = MA14
 *   stochastic_k_v2 / stochastic_d_v2 = stochastic (5,3,3)
 *   schaff_value = Schaff Trend Cycle current value (prior bar used as signal proxy)
 */

import { all, get } from '../connection.js';

// ─── Pattern label helpers ────────────────────────────────────────────────────

function parsePatternFromReasons(reasons, direction) {
    if (!reasons) return 'UNKNOWN';
    let text = reasons;
    try { const parsed = JSON.parse(reasons); text = Array.isArray(parsed) ? parsed.join(' ') : String(parsed); } catch { /* use raw */ }
    if (text.includes('STC_CALL_REVERSAL')) return 'STC_CALL_REVERSAL';
    if (text.includes('STC_PUT_REVERSAL')) return 'STC_PUT_REVERSAL';
    return direction === 'CALL' ? 'CALL_OTHER' : 'PUT_OTHER';
}

// ─── Lookback context helper ──────────────────────────────────────────────────
// Fields produced:
//   rsi_peak_10      — max RSI in last 10 bars
//   rsi_trough_10    — min RSI in last 10 bars
//   k_bars_above_65  — consecutive bars K was above 65 before bar0
//   k_bars_below_35  — consecutive bars K was below 35 before bar0
//   ma_gap_trend     — 'widening_up' | 'widening_down' | 'narrowing' | 'flat'
//   bb_expanding     — true if BB width at bar0 > BB width 5 bars ago

function computeLookback(candles, t) {
    const LOOKBACK = 10;
    const GAP_LOOKBACK = 3;

    const history = [];
    for (let i = Math.max(0, t - LOOKBACK); i < t; i++) history.push(candles[i]);

    const rsiVals = history.map(c => c.rsi_5).filter(v => v != null);
    const rsi_peak_10   = rsiVals.length > 0 ? Math.max(...rsiVals) : null;
    const rsi_trough_10 = rsiVals.length > 0 ? Math.min(...rsiVals) : null;

    let k_bars_above_65 = 0;
    for (let i = t - 1; i >= 0; i--) {
        const k = candles[i].stochastic_k_v2;
        if (k == null) break;
        if (k > 65) k_bars_above_65++; else break;
    }

    let k_bars_below_35 = 0;
    for (let i = t - 1; i >= 0; i--) {
        const k = candles[i].stochastic_k_v2;
        if (k == null) break;
        if (k < 35) k_bars_below_35++; else break;
    }

    const bar0    = candles[t];
    const barPrev = t >= GAP_LOOKBACK ? candles[t - GAP_LOOKBACK] : null;
    let ma_gap_trend = 'unknown';
    if (bar0.ma1 != null && bar0.ma3 != null && barPrev && barPrev.ma1 != null && barPrev.ma3 != null) {
        const gapNow  = bar0.ma1 - bar0.ma3;
        const gapPrev = barPrev.ma1 - barPrev.ma3;
        const deltaBps = ((gapNow - gapPrev) / bar0.ma3) * 10000;
        if (Math.abs(deltaBps) < 1) ma_gap_trend = 'flat';
        else if (deltaBps > 0) ma_gap_trend = 'widening_up';
        else ma_gap_trend = 'widening_down';
        if (Math.abs(gapPrev) - Math.abs(gapNow) > (bar0.ma3 * 0.0001)) ma_gap_trend = 'narrowing';
    }

    let bb_expanding = null;
    const barBbPrev = t >= 5 ? candles[t - 5] : null;
    if (bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null &&
        barBbPrev && barBbPrev.bb_upper != null && barBbPrev.bb_lower != null && barBbPrev.bb_middle != null) {
        const widthNow  = (bar0.bb_upper  - bar0.bb_lower)  / bar0.bb_middle;
        const widthPrev = (barBbPrev.bb_upper - barBbPrev.bb_lower) / barBbPrev.bb_middle;
        bb_expanding = widthNow > widthPrev;
    }

    return { rsi_peak_10, rsi_trough_10, k_bars_above_65, k_bars_below_35, ma_gap_trend, bb_expanding };
}

// ─── STC Gate Definitions ─────────────────────────────────────────────────────
// barM1.schaff_value is used as the signal-line proxy (prior bar = prior smoothed value).

// ctx = { bb_expanding, ma_gap_trend } from computeLookback()
function checkCallReversal(barM1, bar0, params = {}, ctx = {}) {
    const { stc_floor = 25, rsi_max = 40, bb_bps_min = 10 } = params;

    if (bar0.schaff_value == null || barM1.schaff_value == null) return { pass: false, gates: {}, values: {} };

    const stcValue   = bar0.schaff_value;
    const stcPrev    = barM1.schaff_value;
    const rsi        = bar0.rsi_5;
    const k          = bar0.stochastic_k_v2;
    const d          = bar0.stochastic_d_v2;
    const bbBps      = bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null && bar0.bb_middle > 0
        ? (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle * 10000 : null;
    const maTrendBps = bar0.ma1 != null && bar0.ma3 != null
        ? ((bar0.ma1 - bar0.ma3) / bar0.ma3) * 10000 : null;

    const g1_stcFloor    = stcValue <= stc_floor;
    const g2_stcRising   = stcValue > stcPrev;
    const g3_rsiOversold = rsi != null && rsi < rsi_max;
    const g4_stochBull   = k != null && d != null && k > d && k < 50;
    const g5_bbWide      = bbBps != null && bbBps >= bb_bps_min;

    const pass = g1_stcFloor && g2_stcRising && g3_rsiOversold && g4_stochBull && g5_bbWide;

    return {
        pass, direction: 'CALL', patternName: 'STC_CALL_REVERSAL',
        gates: { g1_stcFloor, g2_stcRising, g3_rsiOversold, g4_stochBull, g5_bbWide },
        values: { stcValue, stcPrev, rsi, k, d, bbBps, maTrendBps, bb_expanding: ctx.bb_expanding, ma_gap_trend: ctx.ma_gap_trend },
    };
}

function checkPutReversal(barM1, bar0, params = {}, ctx = {}) {
    const { stc_ceiling = 75, rsi_min = 60, bb_bps_min = 10 } = params;

    if (bar0.schaff_value == null || barM1.schaff_value == null) return { pass: false, gates: {}, values: {} };

    const stcValue   = bar0.schaff_value;
    const stcPrev    = barM1.schaff_value;
    const rsi        = bar0.rsi_5;
    const k          = bar0.stochastic_k_v2;
    const d          = bar0.stochastic_d_v2;
    const bbBps      = bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null && bar0.bb_middle > 0
        ? (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle * 10000 : null;
    const maTrendBps = bar0.ma1 != null && bar0.ma3 != null
        ? ((bar0.ma1 - bar0.ma3) / bar0.ma3) * 10000 : null;

    const g1_stcCeiling  = stcValue >= stc_ceiling;
    const g2_stcFalling  = stcValue < stcPrev;
    const g3_rsiOB       = rsi != null && rsi > rsi_min;
    const g4_stochBear   = k != null && d != null && k < d && k > 50;
    const g5_bbWide      = bbBps != null && bbBps >= bb_bps_min;

    const pass = g1_stcCeiling && g2_stcFalling && g3_rsiOB && g4_stochBear && g5_bbWide;

    return {
        pass, direction: 'PUT', patternName: 'STC_PUT_REVERSAL',
        gates: { g1_stcCeiling, g2_stcFalling, g3_rsiOB, g4_stochBear, g5_bbWide },
        values: { stcValue, stcPrev, rsi, k, d, bbBps, maTrendBps, bb_expanding: ctx.bb_expanding, ma_gap_trend: ctx.ma_gap_trend },
    };
}

// ─── replayCandles() — Candle-by-candle replay across all assets ─────────────
// Validation priority: prices table at T+120s → next bar close → unvalidated.

export async function replayCandles(asset = null, params = {}) {
    let whereClause = '';
    let queryParams = [];
    if (asset) {
        whereClause = 'WHERE c.asset = ?';
        queryParams = [asset];
    }

    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma2, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower,
               i.schaff_value
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ${whereClause}
        ORDER BY c.asset, c.timestamp
    `, queryParams);

    if (!rows.length) return { success: false, error: 'No candles found' };

    // Load prices table — sorted so the expiry lookup can break early
    const priceWhereClause = asset ? 'WHERE asset = ?' : '';
    const priceRows = await all(
        `SELECT asset, timestamp, price FROM prices ${priceWhereClause} ORDER BY asset, timestamp`,
        asset ? [asset] : []
    );
    const pricesByAsset = {};
    for (const p of priceRows) {
        if (!pricesByAsset[p.asset]) pricesByAsset[p.asset] = [];
        pricesByAsset[p.asset].push(p);
    }

    // Find closest price to signalTs + expirySeconds (within ±30s window)
    function findExpiryPrice(priceList, signalTs, expirySeconds) {
        if (!priceList) return null;
        const target = signalTs + expirySeconds;
        let closest = null, minDiff = Infinity;
        for (const p of priceList) {
            if (p.timestamp < target - 30) continue;
            if (p.timestamp > target + 30) break;
            const diff = Math.abs(p.timestamp - target);
            if (diff < minDiff) { minDiff = diff; closest = p.price; }
        }
        return closest;
    }

    // Resolve exit price and result for a given expiry window.
    // Priority: tick price → bar close (only if bar lands within the window) → null.
    function resolveExpiry(direction, entryClose, tick, fallbackBar, fallbackBarTs, signalTs, expirySeconds) {
        const windowMax = signalTs + expirySeconds + 30;
        let exitPrice = tick;
        if (exitPrice == null && fallbackBar != null && fallbackBarTs <= windowMax) {
            exitPrice = fallbackBar;
        }
        if (exitPrice == null) return { exitPrice: null, result: null, validatedBy: null };
        const win = direction === 'CALL' ? exitPrice > entryClose : exitPrice < entryClose;
        const validatedBy = tick != null ? 'tick' : 'bar_close';
        return { exitPrice, result: win ? 'WIN' : 'LOSS', validatedBy };
    }

    // Group candles by asset
    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    const signals = [];
    let totalCandles = 0, candlesWithIndicators = 0, candlesWithHistory = 0;
    const callRejections = { g1_stcFloor: 0, g2_stcRising: 0, g3_rsiOversold: 0, g4_stochBull: 0, g5_bbWide: 0 };
    const putRejections  = { g1_stcCeiling: 0, g2_stcFalling: 0, g3_rsiOB: 0, g4_stochBear: 0, g5_bbWide: 0 };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        const priceMap = pricesByAsset[assetName] || null;

        for (let t = 1; t < candles.length; t++) {
            totalCandles++;
            const barM1 = candles[t - 1];
            const bar0  = candles[t];

            if (bar0.schaff_value == null) continue;
            candlesWithIndicators++;
            if (barM1.schaff_value == null) continue;
            candlesWithHistory++;

            const ctx    = computeLookback(candles, t);
            const amount = params.amount || 500;

            const priceList = pricesByAsset[assetName] || null;
            const tick60    = findExpiryPrice(priceList, bar0.timestamp, 60);
            const tick120   = findExpiryPrice(priceList, bar0.timestamp, 120);
            const bar1      = candles[t + 1];  // ~60s bar
            const bar2      = candles[t + 2];  // ~120s bar

            function buildSignal(direction, gateValues, gateFlags) {
                const e60  = resolveExpiry(direction, bar0.close, tick60,  bar1?.close, bar1?.timestamp, bar0.timestamp, 60);
                const e120 = resolveExpiry(direction, bar0.close, tick120, bar2?.close, bar2?.timestamp, bar0.timestamp, 120);
                const bbRange = (bar0.bb_upper != null && bar0.bb_lower != null && (bar0.bb_upper - bar0.bb_lower) > 0)
                    ? bar0.bb_upper - bar0.bb_lower : null;
                const bbPct = (bbRange != null && bar0.close != null)
                    ? (bar0.close - bar0.bb_lower) / bbRange : null;
                return {
                    asset: assetName, signalTs: bar0.timestamp,
                    direction, entryPrice: bar0.close,
                    exitPrice_60:  e60.exitPrice,  result_60:  e60.result,  validatedBy_60:  e60.validatedBy,
                    exitPrice_120: e120.exitPrice, result_120: e120.result, validatedBy_120: e120.validatedBy,
                    profitLoss_60:  e60.result  === 'WIN' ? amount * 0.92 : e60.result  === 'LOSS' ? -amount : 0,
                    profitLoss_120: e120.result === 'WIN' ? amount * 0.92 : e120.result === 'LOSS' ? -amount : 0,
                    bbPct,
                    ...gateValues, ...gateFlags, ...ctx,
                };
            }

            // CALL
            const callResult = checkCallReversal(barM1, bar0, params, ctx);
            if (callResult.pass) {
                signals.push(buildSignal('CALL', callResult.values, callResult.gates));
            } else {
                for (const [gn, val] of Object.entries(callResult.gates)) {
                    if (val === false && callRejections[gn] !== undefined) callRejections[gn]++;
                }
            }

            // PUT
            const putResult = checkPutReversal(barM1, bar0, params, ctx);
            if (putResult.pass) {
                signals.push(buildSignal('PUT', putResult.values, putResult.gates));
            } else {
                for (const [gn, val] of Object.entries(putResult.gates)) {
                    if (val === false && putRejections[gn] !== undefined) putRejections[gn]++;
                }
            }
        }
    }

    function aggExpiry(sigs, expKey, plKey) {
        const valid = sigs.filter(s => s[expKey] != null);
        const wins  = valid.filter(s => s[expKey] === 'WIN').length;
        return {
            validated: valid.length, wins, losses: valid.length - wins,
            win_rate: valid.length > 0 ? ((wins / valid.length) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: parseFloat(valid.reduce((a, s) => a + (s[plKey] || 0), 0).toFixed(2)),
        };
    }

    const callSignals = signals.filter(s => s.direction === 'CALL');
    const putSignals  = signals.filter(s => s.direction === 'PUT');

    return {
        success: true,
        asset_filter: asset || 'all',
        total_candles: totalCandles,
        candles_with_schaff: candlesWithIndicators,
        candles_with_history: candlesWithHistory,
        call: {
            total_fired: callSignals.length,
            exp_60s:  aggExpiry(callSignals, 'result_60',  'profitLoss_60'),
            exp_120s: aggExpiry(callSignals, 'result_120', 'profitLoss_120'),
            gate_rejections: callRejections,
        },
        put: {
            total_fired: putSignals.length,
            exp_60s:  aggExpiry(putSignals, 'result_60',  'profitLoss_60'),
            exp_120s: aggExpiry(putSignals, 'result_120', 'profitLoss_120'),
            gate_rejections: putRejections,
        },
        signals_all: signals,
        signals_detail: signals.slice(0, 50),
    };
}

// ─── findEdge() — Analyze patterns in validated signals ──────────────────────

export async function findEdge() {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSignals = replay.signals_all || replay.signals_detail || [];
    const valid60    = allSignals.filter(s => s.result_60  != null);
    const valid120   = allSignals.filter(s => s.result_120 != null);

    if (valid60.length < 5 && valid120.length < 5) {
        return { success: false, error: `Need at least 5 validated signals. 60s: ${valid60.length}, 120s: ${valid120.length}` };
    }

    // Run all analyses for one expiry set, return structured result
    function analyzeSet(validSignals, expiryLabel) {
        if (validSignals.length === 0) return null;
        const resultKey = expiryLabel === '60s' ? 'result_60' : 'result_120';
        const plKey     = expiryLabel === '60s' ? 'profitLoss_60' : 'profitLoss_120';

        // ── RSI ──
        const rsiBuckets = [
            { range: '0-20', min: 0, max: 20 }, { range: '20-30', min: 20, max: 30 },
            { range: '30-40', min: 30, max: 40 }, { range: '40-50', min: 40, max: 50 },
            { range: '50-60', min: 50, max: 60 }, { range: '60-70', min: 60, max: 70 },
            { range: '70-80', min: 70, max: 80 }, { range: '80-100', min: 80, max: 100 },
        ];
        const by_rsi = rsiBuckets.map(b => {
            const bt = validSignals.filter(s => s.rsi != null && s.rsi >= b.min && s.rsi < b.max);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { rsi_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── Stochastic K ──
        const stochBuckets = [
            { range: '0-20', min: 0, max: 20 }, { range: '20-40', min: 20, max: 40 },
            { range: '40-60', min: 40, max: 60 }, { range: '60-80', min: 60, max: 80 },
            { range: '80-100', min: 80, max: 100 },
        ];
        const by_stochastic_k = stochBuckets.map(b => {
            const bt = validSignals.filter(s => s.k != null && s.k >= b.min && s.k < b.max);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { stoch_k_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── STC value ──
        const callStcBuckets = [
            { range: '0-10', min: 0, max: 10 }, { range: '10-15', min: 10, max: 15 },
            { range: '15-20', min: 15, max: 20 }, { range: '20-25', min: 20, max: 25 },
            { range: '25-30', min: 25, max: 30 },
        ];
        const putStcBuckets = [
            { range: '70-75', min: 70, max: 75 }, { range: '75-80', min: 75, max: 80 },
            { range: '80-90', min: 80, max: 90 }, { range: '90-100', min: 90, max: 101 },
        ];
        const by_stc_value = [
            ...callStcBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.stcValue != null && s.stcValue >= b.min && s.stcValue < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'CALL', stc_value_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
            ...putStcBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.stcValue != null && s.stcValue >= b.min && s.stcValue < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'PUT', stc_value_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
        ].filter(b => b.trades > 0);

        // ── MA gap ──
        const maGapBuckets = [
            { range: '< -20', max: -20 }, { range: '-20 to -10', min: -20, max: -10 },
            { range: '-10 to 0', min: -10, max: 0 }, { range: '0 to 10', min: 0, max: 10 },
            { range: '10 to 20', min: 10, max: 20 }, { range: '20+', min: 20 },
        ];
        const by_ma_gap = maGapBuckets.map(bucket => {
            const bt = validSignals.filter(s => {
                if (s.maTrendBps == null) return false;
                if (bucket.min != null && bucket.max != null) return s.maTrendBps >= bucket.min && s.maTrendBps < bucket.max;
                if (bucket.max != null) return s.maTrendBps < bucket.max;
                if (bucket.min != null) return s.maTrendBps >= bucket.min;
                return false;
            });
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { ma6_ma14_gap_bps: bucket.range, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── Hour of day ──
        const hourMap = {};
        for (const s of validSignals) {
            if (s[resultKey] == null) continue;
            const hour = Math.floor((s.signalTs % 86400) / 3600);
            if (!hourMap[hour]) hourMap[hour] = { trades: 0, wins: 0 };
            hourMap[hour].trades++;
            if (s[resultKey] === 'WIN') hourMap[hour].wins++;
        }
        const by_hour = Object.entries(hourMap)
            .map(([hour, d]) => ({ hour_utc: parseInt(hour), trades: d.trades, wins: d.wins,
                losses: d.trades - d.wins, win_rate: ((d.wins / d.trades) * 100).toFixed(1) + '%' }))
            .sort((a, b) => b.trades - a.trades);

        // ── By asset ──
        const assetMap = {};
        for (const s of validSignals) {
            if (!assetMap[s.asset]) assetMap[s.asset] = { trades: 0, wins: 0, total_pl: 0, call_w: 0, call_l: 0, put_w: 0, put_l: 0 };
            assetMap[s.asset].trades++;
            if (s[resultKey] === 'WIN') assetMap[s.asset].wins++;
            assetMap[s.asset].total_pl += (s[plKey] || 0);
            if (s.direction === 'CALL') { if (s[resultKey] === 'WIN') assetMap[s.asset].call_w++; else assetMap[s.asset].call_l++; }
            else { if (s[resultKey] === 'WIN') assetMap[s.asset].put_w++; else assetMap[s.asset].put_l++; }
        }
        const by_asset = Object.entries(assetMap).map(([asset, d]) => {
            const callTotal = d.call_w + d.call_l, putTotal = d.put_w + d.put_l;
            const callWR = callTotal > 0 ? (d.call_w / callTotal) * 100 : null;
            const putWR  = putTotal  > 0 ? (d.put_w  / putTotal)  * 100 : null;
            let preferred = null;
            if (callWR !== null && putWR !== null) preferred = callWR >= putWR ? 'CALL' : 'PUT';
            else if (callWR !== null) preferred = 'CALL';
            else if (putWR  !== null) preferred = 'PUT';
            return { asset, trades: d.trades, wins: d.wins, losses: d.trades - d.wins,
                win_rate: ((d.wins / d.trades) * 100).toFixed(1) + '%',
                total_pl: Math.round(d.total_pl * 100) / 100,
                call: callTotal > 0 ? { w: d.call_w, l: d.call_l, wr: callWR.toFixed(1) + '%' } : null,
                put:  putTotal  > 0 ? { w: d.put_w,  l: d.put_l,  wr: putWR.toFixed(1)  + '%' } : null,
                preferred_direction: preferred,
            };
        }).sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

        // ── BB width ──
        const bbBuckets = [
            { label: 'flat (<2)', min: 0, max: 2 }, { label: 'weak (2-5)', min: 2, max: 5 },
            { label: 'marginal (5-10)', min: 5, max: 10 }, { label: 'ok (10-20)', min: 10, max: 20 },
            { label: 'good (20+)', min: 20, max: Infinity },
        ];
        const by_bb_width = bbBuckets.map(b => {
            const bt = validSignals.filter(s => s.bbBps != null && s.bbBps >= b.min && s.bbBps < b.max);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { bb_range: b.label, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── RSI retracement depth ──
        const putCtx  = validSignals.filter(s => s.direction === 'PUT'  && s.rsi_peak_10  != null);
        const callCtx = validSignals.filter(s => s.direction === 'CALL' && s.rsi_trough_10 != null);
        const rsiPeakBuckets   = [{ label: '< 70', min: 0, max: 70 }, { label: '70-80', min: 70, max: 80 }, { label: '80-90', min: 80, max: 90 }, { label: '90+', min: 90, max: 101 }];
        const rsiTroughBuckets = [{ label: '< 10', min: 0, max: 10 }, { label: '10-20', min: 10, max: 20 }, { label: '20-30', min: 20, max: 30 }, { label: '30+', min: 30, max: 101 }];
        const byRsiPeak = rsiPeakBuckets.map(b => {
            const bt = putCtx.filter(s => s.rsi_peak_10 >= b.min && s.rsi_peak_10 < b.max);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { direction: 'PUT', rsi_peak_before: b.label, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);
        const byRsiTrough = rsiTroughBuckets.map(b => {
            const bt = callCtx.filter(s => s.rsi_trough_10 >= b.min && s.rsi_trough_10 < b.max);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { direction: 'CALL', rsi_trough_before: b.label, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── MA gap trend ──
        const maGapTrendMap = {};
        for (const s of validSignals) {
            if (!s.ma_gap_trend || s[resultKey] == null) continue;
            const key = `${s.direction}|${s.ma_gap_trend}`;
            if (!maGapTrendMap[key]) maGapTrendMap[key] = { direction: s.direction, ma_gap_trend: s.ma_gap_trend, wins: 0, losses: 0 };
            if (s[resultKey] === 'WIN') maGapTrendMap[key].wins++; else maGapTrendMap[key].losses++;
        }
        const by_ma_gap_trend = Object.values(maGapTrendMap).map(d => {
            const total = d.wins + d.losses;
            return { ...d, trades: total, win_rate: total > 0 ? ((d.wins / total) * 100).toFixed(1) + '%' : 'N/A' };
        }).sort((a, b) => b.trades - a.trades);

        // ── BB expansion ──
        const bbExpMap = { true: { wins: 0, losses: 0 }, false: { wins: 0, losses: 0 } };
        for (const s of validSignals) {
            if (s.bb_expanding == null || s[resultKey] == null) continue;
            const key = String(s.bb_expanding);
            if (s[resultKey] === 'WIN') bbExpMap[key].wins++; else bbExpMap[key].losses++;
        }
        const by_bb_expansion = Object.entries(bbExpMap).map(([expanding, d]) => {
            const total = d.wins + d.losses;
            return { bb_expanding: expanding === 'true', trades: total, wins: d.wins, losses: d.losses,
                win_rate: total > 0 ? ((d.wins / total) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── Direction breakdown ──
        const callSigs = validSignals.filter(s => s.direction === 'CALL');
        const putSigs  = validSignals.filter(s => s.direction === 'PUT');
        const callWins = callSigs.filter(s => s[resultKey] === 'WIN').length;
        const putWins  = putSigs.filter(s => s[resultKey] === 'WIN').length;
        const by_direction = {
            call: { trades: callSigs.length, wins: callWins, losses: callSigs.length - callWins,
                win_rate: callSigs.length > 0 ? ((callWins / callSigs.length) * 100).toFixed(1) + '%' : 'N/A' },
            put:  { trades: putSigs.length,  wins: putWins,  losses: putSigs.length  - putWins,
                win_rate: putSigs.length  > 0 ? ((putWins  / putSigs.length)  * 100).toFixed(1) + '%' : 'N/A' },
        };

        const totalWins = validSignals.filter(s => s[resultKey] === 'WIN').length;
        return {
            expiry: expiryLabel,
            total_signals: validSignals.length,
            wins: totalWins, losses: validSignals.length - totalWins,
            overall_wr: ((totalWins / validSignals.length) * 100).toFixed(1) + '%',
            total_pl: parseFloat(validSignals.reduce((a, s) => a + (s[plKey] || 0), 0).toFixed(2)),
            by_direction, by_stc_value, by_rsi, by_stochastic_k, by_ma_gap,
            by_hour, by_bb_width, by_asset,
            by_retracement: { put_by_rsi_peak: byRsiPeak, call_by_rsi_trough: byRsiTrough },
            by_ma_gap_trend, by_bb_expansion,
        };
    }

    // DB pattern breakdown (live trades, both expiries lumped together)
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
        if (r.result === 'WIN') patternMap[label].wins++; else patternMap[label].losses++;
        patternMap[label].pl += (r.profit_loss || 0);
    }
    const dbPatternData = Array.from(new Set(['STC_CALL_REVERSAL', 'STC_PUT_REVERSAL', ...Object.keys(patternMap)])).map(pattern => {
        const src = patternMap[pattern];
        if (!src) return null;
        const total = src.wins + src.losses;
        return { pattern, direction: pattern.includes('CALL') ? 'CALL' : 'PUT',
            source: 'live_trades', trades: total, wins: src.wins, losses: src.losses,
            win_rate: total > 0 ? ((src.wins / total) * 100).toFixed(1) + '%' : 'N/A',
            total_pl: parseFloat(src.pl.toFixed(2)) };
    }).filter(Boolean).sort((a, b) => b.trades - a.trades);

    return {
        success: true,
        exp_60s:  analyzeSet(valid60,  '60s'),
        exp_120s: analyzeSet(valid120, '120s'),
        live_trade_patterns: dbPatternData,
    };
}

// ─── optimizeGates() — Grid search over STC gate thresholds ─────────────────
// Post-filters signals from replayCandles (default gates) to find tighter thresholds.

export async function optimizeGates(direction = 'both') {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSignals = replay.signals_all || replay.signals_detail || [];
    const valid60    = allSignals.filter(s => s.result_60  != null);
    const valid120   = allSignals.filter(s => s.result_120 != null);

    if (valid60.length < 10 && valid120.length < 10) {
        return { success: false, error: `Need at least 10 signals. 60s: ${valid60.length}, 120s: ${valid120.length}` };
    }

    // Run threshold sweep on one expiry set
    function sweepExpiry(validSignals, resultKey, expiryLabel) {
        const res = [];

        const testFilter = (label, filtered) => {
            const wins = filtered.filter(s => s[resultKey] === 'WIN').length;
            res.push({ expiry: expiryLabel, test: label.test, param: label.param,
                trades: filtered.length, wins, losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A' });
        };

        if (direction === 'both' || direction === 'call') {
            const cs = validSignals.filter(s => s.direction === 'CALL');
            for (const floor   of [10, 15, 18, 20, 22, 25, 28, 30]) testFilter({ test: 'CALL STC floor', param: `STC ≤ ${floor}`   }, cs.filter(s => s.stcValue != null && s.stcValue <= floor));
            for (const rsiMax  of [20, 25, 30, 35, 40, 45, 50])     testFilter({ test: 'CALL RSI max',   param: `RSI < ${rsiMax}`  }, cs.filter(s => s.rsi != null && s.rsi < rsiMax));
            for (const kMax    of [30, 40, 50])                      testFilter({ test: 'CALL K max',     param: `K < ${kMax}`      }, cs.filter(s => s.k != null && s.k < kMax));
        }
        if (direction === 'both' || direction === 'put') {
            const ps = validSignals.filter(s => s.direction === 'PUT');
            for (const ceiling of [70, 72, 75, 78, 80, 85, 90]) testFilter({ test: 'PUT STC ceiling', param: `STC ≥ ${ceiling}` }, ps.filter(s => s.stcValue != null && s.stcValue >= ceiling));
            for (const rsiMin  of [50, 55, 60, 65, 70, 75])     testFilter({ test: 'PUT RSI min',     param: `RSI > ${rsiMin}`  }, ps.filter(s => s.rsi != null && s.rsi > rsiMin));
            for (const kMin    of [50, 60, 70])                  testFilter({ test: 'PUT K min',       param: `K > ${kMin}`      }, ps.filter(s => s.k != null && s.k > kMin));
        }
        for (const bbMin of [5, 8, 10, 12, 15, 20, 25]) {
            testFilter({ test: 'BB width minimum', param: `BB ≥ ${bbMin} bps` }, validSignals.filter(s => s.bbBps != null && s.bbBps >= bbMin));
        }
        return res;
    }

    return {
        success: true,
        exp_60s:  { total_signals: valid60.length,  optimizations: sweepExpiry(valid60,  'result_60',  '60s')  },
        exp_120s: { total_signals: valid120.length, optimizations: sweepExpiry(valid120, 'result_120', '120s') },
        total_signals_analyzed: allSignals.length,
    };
}

// ─── simulateGates() — Run STC gates with custom thresholds vs defaults ──────
//
// Supported params:
//   call_stc_floor   (default 25)  — max STC value for CALL (g1_stcFloor)
//   call_rsi_max     (default 40)  — max RSI for CALL (g3_rsiOversold)
//   put_stc_ceiling  (default 75)  — min STC value for PUT (g1_stcCeiling)
//   put_rsi_min      (default 60)  — min RSI for PUT (g3_rsiOB)
//   bb_bps_min       (default 10)  — BB width gate (g5_bbWide)
//   amount           (default 500) — trade size for P/L calculation
//
// 5-gate baseline: CALL STC≤25 rising RSI<40 K>D&&K<50 BB≥10bps
//                  PUT  STC≥75 falling RSI>60 K<D&&K>50 BB≥10bps

export async function simulateGates(params = {}) {
    const {
        call_stc_floor  = 25,
        call_rsi_max    = 40,
        put_stc_ceiling = 75,
        put_rsi_min     = 60,
        bb_bps_min      = 10,
        amount          = 500,
    } = params;

    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close, c.volume,
               i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma2, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower,
               i.schaff_value
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ORDER BY c.asset, c.timestamp
    `, []);

    if (!rows.length) return { success: false, error: 'No candles found' };

    // Load prices — sorted array per asset for expiry lookup
    const priceRows = await all('SELECT asset, timestamp, price FROM prices ORDER BY asset, timestamp', []);
    const pricesByAsset = {};
    for (const p of priceRows) {
        if (!pricesByAsset[p.asset]) pricesByAsset[p.asset] = [];
        pricesByAsset[p.asset].push(p);
    }
    function findExpiryPrice(priceList, signalTs, expirySeconds) {
        if (!priceList) return null;
        const target = signalTs + expirySeconds;
        let closest = null, minDiff = Infinity;
        for (const p of priceList) {
            if (p.timestamp < target - 30) continue;
            if (p.timestamp > target + 30) break;
            const diff = Math.abs(p.timestamp - target);
            if (diff < minDiff) { minDiff = diff; closest = p.price; }
        }
        return closest;
    }
    function resolveExpiry(direction, entryClose, tick, fallbackClose, fallbackTs, signalTs, expirySeconds) {
        const windowMax = signalTs + expirySeconds + 30;
        let exit = tick;
        if (exit == null && fallbackClose != null && fallbackTs <= windowMax) exit = fallbackClose;
        if (exit == null) return null;
        return exit > entryClose === (direction === 'CALL') ? 'WIN' : 'LOSS';
    }

    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    // Each bucket stores { result_60, result_120, pl_60, pl_120 }
    const baselineSigs = { call: [], put: [] };
    const modifiedSigs = { call: [], put: [] };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        const priceList = pricesByAsset[assetName] || null;

        for (let t = 1; t < candles.length; t++) {
            const barM1 = candles[t - 1];
            const bar0  = candles[t];
            if (bar0.schaff_value == null || barM1.schaff_value == null) continue;

            const ctx   = computeLookback(candles, t);
            const bar1  = candles[t + 1];
            const bar2  = candles[t + 2];
            const tick60  = findExpiryPrice(priceList, bar0.timestamp, 60);
            const tick120 = findExpiryPrice(priceList, bar0.timestamp, 120);

            function pushSig(bucket, direction) {
                const r60  = resolveExpiry(direction, bar0.close, tick60,  bar1?.close, bar1?.timestamp, bar0.timestamp, 60);
                const r120 = resolveExpiry(direction, bar0.close, tick120, bar2?.close, bar2?.timestamp, bar0.timestamp, 120);
                bucket.push({
                    result_60: r60,   pl_60:  r60  === 'WIN' ? amount * 0.92 : r60  === 'LOSS' ? -amount : 0,
                    result_120: r120, pl_120: r120 === 'WIN' ? amount * 0.92 : r120 === 'LOSS' ? -amount : 0,
                });
            }

            // Baseline CALL
            if (checkCallReversal(barM1, bar0, { stc_floor: 25, rsi_max: 30, bb_bps_min: 10 }, ctx).pass)
                pushSig(baselineSigs.call, 'CALL');
            // Modified CALL
            if (checkCallReversal(barM1, bar0, { stc_floor: call_stc_floor, rsi_max: call_rsi_max, bb_bps_min }, ctx).pass)
                pushSig(modifiedSigs.call, 'CALL');

            // Baseline PUT
            if (checkPutReversal(barM1, bar0, { stc_ceiling: 90, rsi_min: 70, bb_bps_min: 10 }, ctx).pass)
                pushSig(baselineSigs.put, 'PUT');
            // Modified PUT
            if (checkPutReversal(barM1, bar0, { stc_ceiling: put_stc_ceiling, rsi_min: put_rsi_min, bb_bps_min }, ctx).pass)
                pushSig(modifiedSigs.put, 'PUT');
        }
    }

    function summarize(sigs) {
        const agg = (resultKey, plKey) => {
            const valid = sigs.filter(s => s[resultKey] != null);
            const wins  = valid.filter(s => s[resultKey] === 'WIN').length;
            return {
                validated: valid.length, wins, losses: valid.length - wins,
                win_rate: valid.length > 0 ? ((wins / valid.length) * 100).toFixed(1) + '%' : 'N/A',
                total_pl: parseFloat(valid.reduce((a, s) => a + s[plKey], 0).toFixed(2)),
            };
        };
        return { total_fired: sigs.length, exp_60s: agg('result_60', 'pl_60'), exp_120s: agg('result_120', 'pl_120') };
    }

    const base = { call: summarize(baselineSigs.call), put: summarize(baselineSigs.put) };
    const mod  = { call: summarize(modifiedSigs.call), put: summarize(modifiedSigs.put) };

    function diff(b, m, expKey, statKey) {
        const bv = parseFloat(b[expKey]?.[statKey]), mv = parseFloat(m[expKey]?.[statKey]);
        if (isNaN(bv) || isNaN(mv)) return 'N/A';
        const delta = mv - bv;
        return (delta >= 0 ? '+' : '') + (statKey === 'total_pl' ? delta.toFixed(2) : statKey === 'win_rate' ? delta.toFixed(1) + '%' : delta);
    }

    return {
        success: true,
        params_used: { call_stc_floor, call_rsi_max, put_stc_ceiling, put_rsi_min, bb_bps_min },
        baseline: base,
        modified: mod,
        delta: {
            call: {
                signal_count: mod.call.total_fired - base.call.total_fired,
                exp_60s:  { win_rate: diff(base.call, mod.call, 'exp_60s',  'win_rate'), total_pl: diff(base.call, mod.call, 'exp_60s',  'total_pl') },
                exp_120s: { win_rate: diff(base.call, mod.call, 'exp_120s', 'win_rate'), total_pl: diff(base.call, mod.call, 'exp_120s', 'total_pl') },
            },
            put: {
                signal_count: mod.put.total_fired - base.put.total_fired,
                exp_60s:  { win_rate: diff(base.put, mod.put, 'exp_60s',  'win_rate'), total_pl: diff(base.put, mod.put, 'exp_60s',  'total_pl') },
                exp_120s: { win_rate: diff(base.put, mod.put, 'exp_120s', 'win_rate'), total_pl: diff(base.put, mod.put, 'exp_120s', 'total_pl') },
            },
        },
        note: 'delta = modified − baseline. Positive win_rate/pl delta means improvement.',
    };
}

// ─── replaySignal() — Reconstruct STC gates for a specific historical signal ──

export async function replaySignal(signalId) {
    const signal = await get('SELECT * FROM signals WHERE id = ?', [signalId]);
    if (!signal) return { success: false, error: 'Signal not found' };

    const ind = await get(
        'SELECT * FROM indicators WHERE asset = ? AND timestamp = ?',
        [signal.asset, signal.timestamp]
    );
    if (!ind) return { success: false, error: 'No indicator data at signal time' };

    const hist = await all(
        'SELECT * FROM indicators WHERE asset = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 2',
        [signal.asset, signal.timestamp]
    );

    // Prices at T+60s and T+120s for both expiry validations
    const [price60Row, price120Row] = await Promise.all([
        get(`SELECT price FROM prices WHERE asset = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1`,
            [signal.asset, signal.timestamp + 30, signal.timestamp + 90,  signal.timestamp + 60]),
        get(`SELECT price FROM prices WHERE asset = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1`,
            [signal.asset, signal.timestamp + 90, signal.timestamp + 150, signal.timestamp + 120]),
    ]);

    const makeBar = (row) => row ? {
        rsi_5: row.rsi_5, schaff_value: row.schaff_value,
        stochastic_k_v2: row.stochastic_k_v2, stochastic_d_v2: row.stochastic_d_v2,
        ma1: row.ma1, ma2: row.ma2, ma3: row.ma3,
        bb_upper: row.bb_upper, bb_lower: row.bb_lower, bb_middle: row.bb_middle,
        close: row.close,
    } : null;

    const barM1 = makeBar(hist[0]);
    const bar0  = makeBar({ ...ind, close: ind.close ?? null });

    const callResult = barM1 ? checkCallReversal(barM1, bar0) : { pass: false, gates: {}, values: {} };
    const putResult  = barM1 ? checkPutReversal(barM1, bar0)  : { pass: false, gates: {}, values: {} };

    const entryPrice = ind.close ?? null;
    function expiryResult(direction, exitPrice) {
        if (exitPrice == null || entryPrice == null) return null;
        return direction === 'CALL' ? (exitPrice > entryPrice ? 'WIN' : 'LOSS') : (exitPrice < entryPrice ? 'WIN' : 'LOSS');
    }

    return {
        success: true,
        signal: { id: signal.id, asset: signal.asset, timestamp: signal.timestamp, direction: signal.direction, strategy: signal.strategy_used },
        expiry_60s:  { price: price60Row?.price  ?? null, result: expiryResult(signal.direction, price60Row?.price)  },
        expiry_120s: { price: price120Row?.price ?? null, result: expiryResult(signal.direction, price120Row?.price) },
        call_gates: { passed: callResult.pass, details: callResult.gates, values: callResult.values },
        put_gates:  { passed: putResult.pass,  details: putResult.gates,  values: putResult.values  },
        history: [barM1, bar0].filter(Boolean).map((b, i) => ({
            bar: i === 0 ? '-1' : 'signal',
            rsi_5:   b.rsi_5?.toFixed(1),
            schaff:  b.schaff_value?.toFixed(2),
            stoch_k: b.stochastic_k_v2?.toFixed(1),
            stoch_d: b.stochastic_d_v2?.toFixed(1),
        })),
    };
}
