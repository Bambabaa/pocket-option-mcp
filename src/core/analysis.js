/**
 * Analysis Engine — Candle replay and signal simulation.
 *
 * Fires 8GSR (8-Gate STC Reversal) gates bar-by-bar against stored indicators,
 * validates against prices table at T+120s with next-bar-close fallback.
 *
 * Gates (match live signalstrade() in bot/indicators.js):
 *   G4: STC hook + delta bounds (primary, checked first — early exit on fail)
 *   G1: BB touch within last 3 bars
 *   G2: Stoch cross from deep zone, exactly 1 bar ago
 *   G3: CCI(8) cross ±100 with depth beyond ±150
 */

import { all, get } from '../connection.js';

// ─── Pattern label helpers ────────────────────────────────────────────────────

function parsePatternFromReasons(reasons, direction) {
    if (!reasons) return 'UNKNOWN';
    let text = reasons;
    try { const parsed = JSON.parse(reasons); text = Array.isArray(parsed) ? parsed.join(' ') : String(parsed); } catch { /* use raw */ }
    if (text.includes('STC_CALL_8GSR'))     return 'STC_CALL_8GSR';
    if (text.includes('STC_PUT_8GSR'))      return 'STC_PUT_8GSR';
    if (text.includes('STC_CALL_REVERSAL')) return 'STC_CALL_REVERSAL';
    if (text.includes('STC_PUT_REVERSAL'))  return 'STC_PUT_REVERSAL';
    return direction === 'CALL' ? 'CALL_OTHER' : 'PUT_OTHER';
}

// ─── 8GSR batch-mode gate check ───────────────────────────────────────────────
// Batch equivalent of live signalstrade(). Uses stored indicator columns.
// candles[t] = current bar (bar0), candles[t-1] = prior bar.
//
// Tunable params for simulateGates / optimizeGates:
//   stc_floor         (default 25)    — G4 CALL: max stcPrev
//   stc_ceiling       (default 75)    — G4 PUT:  min stcPrev
//   call_delta_max    (default 0.5)   — G4 CALL: max stcDelta (exclusive)
//   put_delta_min     (default -0.5)  — G4 PUT:  min stcDelta
//   call_g3_depth_min (default -150)  — G3 CALL: min CCI depth required
//   put_g3_depth_max  (default 150)   — G3 PUT:  max CCI depth required

function check8GSR(candles, t, direction, params = {}) {
    const {
        stc_floor         = 25,
        stc_ceiling       = 75,
        call_delta_max    = 0.5,
        put_delta_min     = -0.5,
        call_g3_depth_min = -150,
        put_g3_depth_max  = 150,
    } = params;

    const isBuy = direction === 'CALL';
    if (t < 2) return { pass: false, gates: {}, values: {} };

    const bar0  = candles[t];
    const barM1 = candles[t - 1];
    const stcCurrent = bar0.schaff_value;
    const stcPrev    = barM1.schaff_value;
    if (stcCurrent == null || stcPrev == null) return { pass: false, gates: {}, values: {} };

    const stcDelta = stcCurrent - stcPrev;

    // G4: STC hook + delta bounds (primary trigger)
    const g4_stcHook = isBuy
        ? stcPrev <= stc_floor   && stcDelta >= 0          && stcDelta < call_delta_max
        : stcPrev >= stc_ceiling && stcDelta >= put_delta_min && stcDelta <= 0;
    if (!g4_stcHook) return {
        pass: false,
        gates: { g4_stcHook: false, g1_bbTouch: null, g2_stochCross: null, g3_cciCross: null },
        values: { stcCurrent, stcPrev, stcDelta, bbBps: null, k: bar0.stochastic_k_v2, d: bar0.stochastic_d_v2, g1_barsAgo: null, g3_depth: null, g3_crossBarsAgo: null },
    };

    // G1: BB touch in last 3 bars (j=1,2,3 before bar0)
    let g1_bbTouch = false, g1_barsAgo = null;
    for (let j = 1; j <= 3; j++) {
        if (t - j < 0) break;
        const bar = candles[t - j];
        if (!bar) break;
        const hit = isBuy
            ? (bar.low != null && bar.bb_lower != null && bar.low <= bar.bb_lower)
            : (bar.high != null && bar.bb_upper != null && bar.high >= bar.bb_upper);
        if (hit) { g1_bbTouch = true; g1_barsAgo = j; break; }
    }

    // G2: Stoch cross from deep zone exactly 1 bar ago
    // cross at t-1: kT2 < dT2 (pre-cross at t-2), kT1 > dT1 (post-cross at t-1)
    // zone check: kT2 < 30 && dT2 < 30 (CALL) | kT2 > 80 && dT2 > 80 (PUT)
    // current: kT < 50 (CALL) | kT > 50 (PUT), |kT-dT| > 0.5
    let g2_stochCross = false;
    {
        const barC2 = candles[t - 2];
        const barC1 = candles[t - 1];
        const barC  = candles[t];
        const kT2 = barC2.stochastic_k_v2, dT2 = barC2.stochastic_d_v2;
        const kT1 = barC1.stochastic_k_v2, dT1 = barC1.stochastic_d_v2;
        const kT  = barC.stochastic_k_v2,  dT  = barC.stochastic_d_v2;
        if (kT2 != null && dT2 != null && kT1 != null && dT1 != null && kT != null && dT != null) {
            const crossedUp   = kT2 <= dT2 && kT1 > dT1 && kT2 < 30 && dT2 < 30;
            const crossedDown = kT2 >= dT2 && kT1 < dT1 && kT2 > 80 && dT2 > 80;
            if (isBuy)  g2_stochCross = crossedUp   && kT < 50 && Math.abs(kT - dT) > 0.5;
            if (!isBuy) g2_stochCross = crossedDown && kT > 50 && Math.abs(kT - dT) > 0.5;
        }
    }

    // G3: CCI(8) cross ±100 with depth beyond ±150
    // Walk backward from t-1 (up to 24 bars) to find most recent cross bar x.
    // Depth = min/max of CCI in the 10 bars before x (indices x-10 to x-2).
    let g3_cciCross = false, g3_depth = null, g3_crossBarsAgo = null;
    for (let x = t - 1; x >= 1 && x >= t - 24; x--) {
        const cciX   = candles[x].cci_8;
        const cciXm1 = candles[x - 1].cci_8;
        if (cciX == null || cciXm1 == null) continue;
        const crossed = isBuy ? (cciXm1 <= -100 && cciX > -100) : (cciXm1 >= 100 && cciX < 100);
        if (crossed) {
            const depthVals = [];
            for (let k = Math.max(0, x - 10); k <= x - 2; k++) {
                const v = candles[k]?.cci_8;
                if (v != null) depthVals.push(v);
            }
            const depth = depthVals.length > 0 ? (isBuy ? Math.min(...depthVals) : Math.max(...depthVals)) : null;
            g3_depth = depth;
            g3_crossBarsAgo = t - x;
            g3_cciCross = depth != null && (isBuy ? depth < call_g3_depth_min : depth > put_g3_depth_max);
            break;
        }
    }

    const bbBps = bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null && bar0.bb_middle > 0
        ? (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle * 10000 : null;

    const pass = g4_stcHook && g1_bbTouch && g2_stochCross && g3_cciCross;
    return {
        pass, direction, patternName: isBuy ? 'STC_CALL_8GSR' : 'STC_PUT_8GSR',
        gates:  { g4_stcHook, g1_bbTouch, g2_stochCross, g3_cciCross },
        values: { stcCurrent, stcPrev, stcDelta, bbBps,
                  k: bar0.stochastic_k_v2, d: bar0.stochastic_d_v2,
                  g1_barsAgo, g3_depth, g3_crossBarsAgo },
    };
}

// ─── replayCandles() — Candle-by-candle replay across all assets ──────────────
// Fires 8GSR gates for every bar. Validates at T+60s and T+120s.
// params also accepts gate threshold overrides for simulateGates().

export async function replayCandles(asset = null, params = {}) {
    let whereClause = '';
    let queryParams = [];
    if (asset) {
        whereClause = 'WHERE c.asset = ?';
        queryParams = [asset];
    }

    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
               i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower,
               i.schaff_value, i.cci_8
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ${whereClause}
        ORDER BY c.asset, c.timestamp
    `, queryParams);

    if (!rows.length) return { success: false, error: 'No candles found' };

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

    function resolveExpiry(direction, entryClose, tick, fallbackBar, fallbackBarTs, signalTs, expirySeconds) {
        const windowMax = signalTs + expirySeconds + 30;
        let exitPrice = tick;
        if (exitPrice == null && fallbackBar != null && fallbackBarTs <= windowMax) exitPrice = fallbackBar;
        if (exitPrice == null) return { exitPrice: null, result: null, validatedBy: null };
        const win = direction === 'CALL' ? exitPrice > entryClose : exitPrice < entryClose;
        return { exitPrice, result: win ? 'WIN' : 'LOSS', validatedBy: tick != null ? 'tick' : 'bar_close' };
    }

    const byAsset = {};
    for (const r of rows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = [];
        byAsset[r.asset].push(r);
    }

    const signals = [];
    let totalCandles = 0, candlesWithIndicators = 0, candlesWithHistory = 0;
    const callRejections = { g4_stcHook: 0, g1_bbTouch: 0, g2_stochCross: 0, g3_cciCross: 0 };
    const putRejections  = { g4_stcHook: 0, g1_bbTouch: 0, g2_stochCross: 0, g3_cciCross: 0 };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        const priceList = pricesByAsset[assetName] || null;

        for (let t = 2; t < candles.length; t++) {
            totalCandles++;
            const bar0 = candles[t];

            if (bar0.schaff_value == null) continue;
            candlesWithIndicators++;
            if (bar0.cci_8 == null) continue;
            candlesWithHistory++;

            const amount = params.amount || 500;
            const tick60  = findExpiryPrice(priceList, bar0.timestamp, 60);
            const tick120 = findExpiryPrice(priceList, bar0.timestamp, 120);
            const bar1    = candles[t + 1];
            const bar2    = candles[t + 2];

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
                    ...gateValues, ...gateFlags,
                };
            }

            for (const dir of ['CALL', 'PUT']) {
                const result = check8GSR(candles, t, dir, params);
                if (result.pass) {
                    signals.push(buildSignal(dir, result.values, result.gates));
                } else {
                    const rejMap = dir === 'CALL' ? callRejections : putRejections;
                    for (const [gn, val] of Object.entries(result.gates)) {
                        if (val === false && rejMap[gn] !== undefined) rejMap[gn]++;
                    }
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
        candles_with_cci: candlesWithHistory,
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

    function analyzeSet(validSignals, expiryLabel) {
        if (validSignals.length === 0) return null;
        const resultKey = expiryLabel === '60s' ? 'result_60' : 'result_120';
        const plKey     = expiryLabel === '60s' ? 'profitLoss_60' : 'profitLoss_120';

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

        // ── STC previous value (Gate 4 zone depth) ──
        const callStcBuckets = [
            { range: '0-5',   min: 0,  max: 5  }, { range: '5-10',  min: 5,  max: 10 },
            { range: '10-15', min: 10, max: 15 }, { range: '15-20', min: 15, max: 20 },
            { range: '20-25', min: 20, max: 25 },
        ];
        const putStcBuckets = [
            { range: '75-80', min: 75, max: 80 }, { range: '80-85', min: 80, max: 85 },
            { range: '85-90', min: 85, max: 90 }, { range: '90-95', min: 90, max: 95 },
            { range: '95-100', min: 95, max: 101 },
        ];
        const by_stc_prev = [
            ...callStcBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.stcPrev != null && s.stcPrev >= b.min && s.stcPrev < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'CALL', stc_prev_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
            ...putStcBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.stcPrev != null && s.stcPrev >= b.min && s.stcPrev < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'PUT', stc_prev_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
        ].filter(b => b.trades > 0);

        // ── STC delta (Gate 4 hook tightness) ──
        const callDeltaBuckets = [
            { range: '0.0-0.1', min: 0.0, max: 0.1 }, { range: '0.1-0.2', min: 0.1, max: 0.2 },
            { range: '0.2-0.3', min: 0.2, max: 0.3 }, { range: '0.3-0.5', min: 0.3, max: 0.5 },
        ];
        const putDeltaBuckets = [
            { range: '-0.1 to 0',    min: -0.1, max: 0    }, { range: '-0.2 to -0.1', min: -0.2, max: -0.1 },
            { range: '-0.3 to -0.2', min: -0.3, max: -0.2 }, { range: '-0.5 to -0.3', min: -0.5, max: -0.3 },
        ];
        const by_stc_delta = [
            ...callDeltaBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.stcDelta != null && s.stcDelta >= b.min && s.stcDelta < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'CALL', stc_delta_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
            ...putDeltaBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.stcDelta != null && s.stcDelta >= b.min && s.stcDelta < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'PUT', stc_delta_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
        ].filter(b => b.trades > 0);

        // ── G1 bars ago (how recent was the BB touch) ──
        const by_g1_barsAgo = [1, 2, 3].map(j => {
            const bt = validSignals.filter(s => s.g1_barsAgo === j);
            const wins = bt.filter(s => s[resultKey] === 'WIN').length;
            return { g1_bars_ago: j, trades: bt.length, wins, losses: bt.length - wins,
                win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
        }).filter(b => b.trades > 0);

        // ── G3 CCI depth ──
        const callDepthBuckets = [
            { range: '< -250', min: -Infinity, max: -250 }, { range: '-250 to -200', min: -250, max: -200 },
            { range: '-200 to -175', min: -200, max: -175 }, { range: '-175 to -150', min: -175, max: -150 },
        ];
        const putDepthBuckets = [
            { range: '> 250', min: 250, max: Infinity }, { range: '200 to 250', min: 200, max: 250 },
            { range: '175 to 200', min: 175, max: 200 }, { range: '150 to 175', min: 150, max: 175 },
        ];
        const by_g3_depth = [
            ...callDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.g3_depth != null && s.g3_depth >= b.min && s.g3_depth < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'CALL', cci_depth_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
            ...putDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.g3_depth != null && s.g3_depth >= b.min && s.g3_depth < b.max);
                const wins = bt.filter(s => s[resultKey] === 'WIN').length;
                return { direction: 'PUT', cci_depth_range: b.range, trades: bt.length, wins, losses: bt.length - wins,
                    win_rate: bt.length > 0 ? ((wins / bt.length) * 100).toFixed(1) + '%' : 'N/A' };
            }),
        ].filter(b => b.trades > 0);

        // ── BB width at signal bar ──
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

        // ── Hour of day ──
        const hourMap = {};
        for (const s of validSignals) {
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

        const totalWins = validSignals.filter(s => s[resultKey] === 'WIN').length;
        return {
            expiry: expiryLabel,
            total_signals: validSignals.length,
            wins: totalWins, losses: validSignals.length - totalWins,
            overall_wr: ((totalWins / validSignals.length) * 100).toFixed(1) + '%',
            total_pl: parseFloat(validSignals.reduce((a, s) => a + (s[plKey] || 0), 0).toFixed(2)),
            by_direction, by_stc_prev, by_stc_delta, by_g1_barsAgo, by_g3_depth,
            by_bb_width, by_hour, by_asset,
        };
    }

    // Live trade pattern breakdown from DB
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
    const livePatterns = ['STC_CALL_8GSR', 'STC_PUT_8GSR', 'STC_CALL_REVERSAL', 'STC_PUT_REVERSAL'];
    const dbPatternData = Array.from(new Set([...livePatterns, ...Object.keys(patternMap)])).map(pattern => {
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

// ─── optimizeGates() — Grid search over 8GSR gate thresholds ─────────────────
// Runs replay with loose gates to capture full pool, then post-filters.

export async function optimizeGates(direction = 'both') {
    const replay = await replayCandles(null, {
        stc_floor: 30, stc_ceiling: 70,
        call_delta_max: 1.0, put_delta_min: -1.0,
        call_g3_depth_min: -100, put_g3_depth_max: 100,
    });
    if (!replay.success) return replay;

    const allSignals = replay.signals_all || [];
    const valid60    = allSignals.filter(s => s.result_60  != null);
    const valid120   = allSignals.filter(s => s.result_120 != null);

    if (valid60.length < 10 && valid120.length < 10) {
        return { success: false, error: `Need at least 10 signals. 60s: ${valid60.length}, 120s: ${valid120.length}` };
    }

    function sweepExpiry(validSignals, resultKey, expiryLabel) {
        const res = [];
        const test = (label, param, filtered) => {
            const wins = filtered.filter(s => s[resultKey] === 'WIN').length;
            res.push({ expiry: expiryLabel, test: label, param, trades: filtered.length,
                wins, losses: filtered.length - wins,
                win_rate: filtered.length > 0 ? ((wins / filtered.length) * 100).toFixed(1) + '%' : 'N/A' });
        };

        if (direction === 'both' || direction === 'call') {
            const cs = validSignals.filter(s => s.direction === 'CALL');
            for (const floor of [5, 10, 15, 18, 20, 22, 25, 28, 30])
                test('CALL STC floor',      `stcPrev ≤ ${floor}`,  cs.filter(s => s.stcPrev != null && s.stcPrev <= floor));
            for (const dMax  of [0.1, 0.2, 0.3, 0.4, 0.5])
                test('CALL delta max',      `stcDelta < ${dMax}`,  cs.filter(s => s.stcDelta != null && s.stcDelta < dMax));
            for (const depth of [-250, -200, -175, -150, -125])
                test('CALL G3 depth min',   `g3_depth < ${depth}`, cs.filter(s => s.g3_depth != null && s.g3_depth < depth));
        }
        if (direction === 'both' || direction === 'put') {
            const ps = validSignals.filter(s => s.direction === 'PUT');
            for (const ceil of [70, 72, 75, 78, 80, 85, 90])
                test('PUT STC ceiling',     `stcPrev ≥ ${ceil}`,   ps.filter(s => s.stcPrev != null && s.stcPrev >= ceil));
            for (const dMin  of [-0.1, -0.2, -0.3, -0.4, -0.5])
                test('PUT delta min',       `stcDelta ≥ ${dMin}`,  ps.filter(s => s.stcDelta != null && s.stcDelta >= dMin));
            for (const depth of [250, 200, 175, 150, 125])
                test('PUT G3 depth max',    `g3_depth > ${depth}`, ps.filter(s => s.g3_depth != null && s.g3_depth > depth));
        }

        return res;
    }

    return {
        success: true,
        note: 'Loose gate base (stc_floor=30, call_delta_max=1.0, g3_depth_min=-100). Post-filter shows effect of tightening.',
        exp_60s:  { total_signals: valid60.length,  optimizations: sweepExpiry(valid60,  'result_60',  '60s')  },
        exp_120s: { total_signals: valid120.length, optimizations: sweepExpiry(valid120, 'result_120', '120s') },
        total_signals_analyzed: allSignals.length,
    };
}

// ─── simulateGates() — Compare 8GSR baseline vs custom thresholds ─────────────
//
// Supported params:
//   call_stc_floor     (default 25)    — G4 CALL: max stcPrev
//   put_stc_ceiling    (default 75)    — G4 PUT:  min stcPrev
//   call_delta_max     (default 0.5)   — G4 CALL: max stcDelta
//   put_delta_min      (default -0.5)  — G4 PUT:  min stcDelta
//   call_g3_depth_min  (default -150)  — G3 CALL: min CCI depth
//   put_g3_depth_max   (default 150)   — G3 PUT:  max CCI depth
//   amount             (default 500)   — trade size for P/L

export async function simulateGates(params = {}) {
    const {
        call_stc_floor    = 25,
        put_stc_ceiling   = 75,
        call_delta_max    = 0.5,
        put_delta_min     = -0.5,
        call_g3_depth_min = -150,
        put_g3_depth_max  = 150,
        amount            = 500,
    } = params;

    const rows = await all(`
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
               i.stochastic_k_v2, i.stochastic_d_v2,
               i.ma1, i.ma3, i.bb_middle, i.bb_upper, i.bb_lower,
               i.schaff_value, i.cci_8
        FROM candles c
        LEFT JOIN indicators i
          ON c.asset = i.asset AND c.timestamp = i.timestamp
        ORDER BY c.asset, c.timestamp
    `, []);

    if (!rows.length) return { success: false, error: 'No candles found' };

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

    const baseParams = {};  // all defaults
    const modParams  = { stc_floor: call_stc_floor, stc_ceiling: put_stc_ceiling,
                         call_delta_max, put_delta_min, call_g3_depth_min, put_g3_depth_max };

    const baselineSigs = { call: [], put: [] };
    const modifiedSigs = { call: [], put: [] };

    for (const [assetName, candles] of Object.entries(byAsset)) {
        const priceList = pricesByAsset[assetName] || null;

        for (let t = 2; t < candles.length; t++) {
            const bar0 = candles[t];
            if (bar0.schaff_value == null || bar0.cci_8 == null) continue;

            const bar1 = candles[t + 1];
            const bar2 = candles[t + 2];
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

            for (const dir of ['CALL', 'PUT']) {
                const bucket = dir === 'CALL' ? 'call' : 'put';
                if (check8GSR(candles, t, dir, baseParams).pass) pushSig(baselineSigs[bucket], dir);
                if (check8GSR(candles, t, dir, modParams).pass)  pushSig(modifiedSigs[bucket], dir);
            }
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
        params_used: { call_stc_floor, put_stc_ceiling, call_delta_max, put_delta_min, call_g3_depth_min, put_g3_depth_max },
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

// ─── replaySignal() — Reconstruct 8GSR gates for a specific historical signal ──

export async function replaySignal(signalId) {
    const signal = await get('SELECT * FROM signals WHERE id = ?', [signalId]);
    if (!signal) return { success: false, error: 'Signal not found' };

    // Fetch the 25 bars up to and including the signal bar (oldest first after reverse)
    const rows = await all(`
        SELECT c.timestamp, c.open, c.high, c.low, c.close,
               i.schaff_value, i.stochastic_k_v2, i.stochastic_d_v2,
               i.bb_upper, i.bb_lower, i.bb_middle, i.cci_8, i.ma1, i.ma3
        FROM candles c
        LEFT JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
        WHERE c.asset = ? AND c.timestamp <= ?
        ORDER BY c.timestamp DESC
        LIMIT 25
    `, [signal.asset, signal.timestamp]);

    if (!rows.length) return { success: false, error: 'No candle data found' };
    const candles = rows.reverse();
    const t = candles.length - 1;

    const callResult = check8GSR(candles, t, 'CALL');
    const putResult  = check8GSR(candles, t, 'PUT');

    const [price60Row, price120Row] = await Promise.all([
        get(`SELECT price FROM prices WHERE asset = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1`,
            [signal.asset, signal.timestamp + 30, signal.timestamp + 90,  signal.timestamp + 60]),
        get(`SELECT price FROM prices WHERE asset = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1`,
            [signal.asset, signal.timestamp + 90, signal.timestamp + 150, signal.timestamp + 120]),
    ]);

    const entryPrice = candles[t].close;
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
        bar_context: candles.slice(-3).map((b, i) => ({
            bar: `C-${2 - i}`,
            ts:      b.timestamp,
            schaff:  b.schaff_value?.toFixed(2),
            stoch_k: b.stochastic_k_v2?.toFixed(1),
            stoch_d: b.stochastic_d_v2?.toFixed(1),
            cci_8:   b.cci_8?.toFixed(1),
            close:   b.close,
        })),
    };
}
