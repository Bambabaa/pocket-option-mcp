/**
 * Analysis Engine — Local backtesting and signal simulation.
 *
 * Replays historical candles bar-by-bar, reconstructs ALL MODE D gate values,
 * fires simulated signals, and validates against the NEXT candle close.
 *
 * This is the same approach as tests/test_patterns.js but exposed as MCP tools
 * so Claude can query results conversationally.
 *
 * Column mapping (indicators table):
 *   ma1 = MA6, ma2 = MA50, ma3 = MA14
 *   stochastic_k_v2 / stochastic_d_v2 = video2 stochastic (5,3,3)
 *   stochastic_k / stochastic_d = video1 stochastic (13,3,3)
 */

import { all, get } from '../connection.js';

// ─── MODE D Gate Definitions (from indicators.js, matching test_patterns.js) ─

const CALL_GATES = {
    name: 'K Flash Crash Bounce',
    check: (barM2, barM1, bar0) => {
        const i1 = barM1, i0 = bar0;
        if (i1.stochastic_k_v2 == null || i0.stochastic_k_v2 == null) return { pass: false, gates: {}, values: {} };

        const g1_maStack = i0.ma1 != null && i0.ma3 != null && i0.ma2 != null &&
            i0.ma1 < i0.ma3 && i0.ma3 < i0.ma2;
        const kCrash = i1.stochastic_k_v2 - i0.stochastic_k_v2;
        const g2_kCrash = kCrash > 25;
        const g3_kOversold = i0.stochastic_k_v2 < 25;
        const g4_kWasMid = i1.stochastic_k_v2 >= 50;
        const g5_rsiDown = i0.rsi_5 != null && i0.rsi_5 < 40;
        const maTrendBps = i0.ma3 != null && i0.ma2 != null
            ? ((i0.ma3 - i0.ma2) / i0.ma2) * 10000 : null;
        const g6_maNotDeep = maTrendBps != null && maTrendBps > -20;

        const pass = g1_maStack && g2_kCrash && g3_kOversold && g4_kWasMid && g5_rsiDown && g6_maNotDeep;

        return {
            pass, direction: 'CALL', patternName: 'K_FLASH_CRASH',
            gates: { g1_maStack, g2_kCrash, g3_kOversold, g4_kWasMid, g5_rsiDown, g6_maNotDeep },
            values: {
                rsi_0: i0.rsi_5, rsi_m1: i1.rsi_5,
                k_m1: i1.stochastic_k_v2, k_0: i0.stochastic_k_v2,
                kCrash, d_0: i0.stochastic_d_v2,
                ma6_0: i0.ma1, ma14_0: i0.ma3, ma50_0: i0.ma2, maTrendBps,
            }
        };
    }
};

const PUT_GATES = {
    name: 'Late Overbought Reversal',
    check: (barM2, barM1, bar0) => {
        const i2 = barM2, i1 = barM1, i0 = bar0;
        if (i2.rsi_5 == null || i1.rsi_5 == null) return { pass: false, gates: {}, values: {} };

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
        const g5_maStack = i0.ma1 != null && i0.ma3 != null && i0.ma2 != null &&
            i0.ma1 > i0.ma3 && i0.ma3 > i0.ma2;
        const kdSpread = i0.stochastic_k_v2 != null && i0.stochastic_d_v2 != null
            ? i0.stochastic_k_v2 - i0.stochastic_d_v2 : null;
        const g6_kdCross = kdSpread != null && kdSpread < -3;
        const maTrendBps = i0.ma3 != null && i0.ma2 != null
            ? ((i0.ma3 - i0.ma2) / i0.ma2) * 10000 : null;
        const g7_maTrendWeak = maTrendBps != null && maTrendBps < 20;

        const pass = g1_rsiBaseline && g2_rsiRecovery && g3_kTurn && g4_dPosition && g5_maStack && g6_kdCross && g7_maTrendWeak;

        return {
            pass, direction: 'PUT', patternName: 'LATE_OVERBOUGHT',
            gates: { g1_rsiBaseline, g2_rsiRecovery, g3_kTurn, g4_dPosition, g5_maStack, g6_kdCross, g7_maTrendWeak },
            values: {
                rsi_m2: i2.rsi_5, rsi_m1: i1.rsi_5, rsi_0: i0.rsi_5,
                rsiVelocity, closeAboveMid,
                k_m1: i1.stochastic_k_v2, k_0: i0.stochastic_k_v2,
                d_0: i0.stochastic_d_v2, kdSpread,
                ma6_0: i0.ma1, ma14_0: i0.ma3, ma50_0: i0.ma2, maTrendBps,
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
               i.rsi_5, i.stochastic_k_v2 AS stochastic_k, i.stochastic_d_v2 AS stochastic_d,
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
    const callRejections = { g1_maStack: 0, g2_kCrash: 0, g3_kOversold: 0, g4_kWasMid: 0, g5_rsiDown: 0, g6_maNotDeep: 0 };
    const putRejections = { g1_rsiBaseline: 0, g2_rsiRecovery: 0, g3_kTurn: 0, g4_dPosition: 0, g5_maStack: 0, g6_kdCross: 0, g7_maTrendWeak: 0 };

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
                    gapFlag: isGap, ...callResult.values, ...callResult.gates,
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
                    gapFlag: isGap, ...putResult.values, ...putResult.gates,
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
        signals_detail: signals.slice(0, 50), // First 50 for inspection
    };
}

// ─── findEdge() — Analyze patterns in validated signals ──────────────────────

export async function findEdge() {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allValid = [
        ...replay.call.validated || [],
        ...replay.put.validated || [],
    ];

    // Re-fetch from signals array since replayCandles doesn't return validated separately
    const allSignals = replay.signals_detail || [];
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
            ma14_ma50_gap_bps: bucket.range,
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
        if (!assetAnalysis[s.asset]) assetAnalysis[s.asset] = { trades: 0, wins: 0, total_pl: 0 };
        assetAnalysis[s.asset].trades++;
        if (s.result === 'WIN') assetAnalysis[s.asset].wins++;
        assetAnalysis[s.asset].total_pl += (s.profitLoss || 0);
    }

    const assetData = Object.entries(assetAnalysis)
        .map(([asset, data]) => ({
            asset,
            trades: data.trades,
            wins: data.wins,
            losses: data.trades - data.wins,
            win_rate: ((data.wins / data.trades) * 100).toFixed(1) + '%',
            total_pl: Math.round(data.total_pl * 100) / 100,
        }))
        .sort((a, b) => b.win_rate.localeCompare(a.win_rate));

    return {
        success: true,
        total_signals: validSignals.length,
        wins: validSignals.filter(s => s.result === 'WIN').length,
        losses: validSignals.filter(s => s.result === 'LOSS').length,
        overall_wr: ((validSignals.filter(s => s.result === 'WIN').length / validSignals.length) * 100).toFixed(1) + '%',
        analyses: {
            by_rsi: rsiAnalysis,
            by_stochastic_k: stochAnalysis,
            by_ma_gap: maGapAnalysis,
            by_hour: hourData,
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

    const allSignals = replay.signals_detail || [];
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
