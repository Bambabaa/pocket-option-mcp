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

// ─── Statistical helpers ──────────────────────────────────────────────────────

// Normal CDF approximation (Abramowitz & Stegun 26.2.17) — max error 7.5e-8
function normCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.821256 + t * 1.3302744))));
    return z > 0 ? 1 - p : p;
}

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

    // G2 cross depth: K/D at C-2 (pre-cross) and C-1 (cross bar)
    const barC2_ref = candles[t - 2];
    const barC1_ref = candles[t - 1];
    const g2_preCrossK = g2_stochCross ? (barC2_ref?.stochastic_k_v2 ?? null) : null;
    const g2_preCrossD = g2_stochCross ? (barC2_ref?.stochastic_d_v2 ?? null) : null;
    const g2_crossK    = g2_stochCross ? (barC1_ref?.stochastic_k_v2 ?? null) : null;
    const g2_crossD    = g2_stochCross ? (barC1_ref?.stochastic_d_v2 ?? null) : null;

    const pass = g4_stcHook && g1_bbTouch && g2_stochCross && g3_cciCross;
    return {
        pass, direction, patternName: isBuy ? 'STC_CALL_8GSR' : 'STC_PUT_8GSR',
        gates:  { g4_stcHook, g1_bbTouch, g2_stochCross, g3_cciCross },
        values: { stcCurrent, stcPrev, stcDelta, bbBps,
                  k: bar0.stochastic_k_v2, d: bar0.stochastic_d_v2,
                  cci_8_current: bar0.cci_8,
                  g1_barsAgo, g2_preCrossK, g2_preCrossD, g2_crossK, g2_crossD, g3_depth, g3_crossBarsAgo },
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
        const priceList   = pricesByAsset[assetName] || null;
        const lastSignalT = { CALL: null, PUT: null };

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

            function buildSignal(direction, gateValues, gateFlags, barsSinceLastSignal, regime) {
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
                    bbPct, barsSinceLastSignal, regime,
                    ...gateValues, ...gateFlags,
                };
            }

            for (const dir of ['CALL', 'PUT']) {
                const result = check8GSR(candles, t, dir, params);
                if (result.pass) {
                    // Cooldown: bars elapsed since last same-direction signal on this asset
                    const barsSince   = lastSignalT[dir] != null ? t - lastSignalT[dir] : null;
                    lastSignalT[dir]  = t;

                    // Regime: classify market state from MA gap trend + BB expansion
                    const barM1       = candles[t - 1];
                    const maGapCurr   = bar0.ma1  && bar0.ma3  && bar0.ma3  > 0 ? (bar0.ma1  - bar0.ma3)  / bar0.ma3  * 10000 : null;
                    const maGapPrev   = barM1.ma1 && barM1.ma3 && barM1.ma3 > 0 ? (barM1.ma1 - barM1.ma3) / barM1.ma3 * 10000 : null;
                    let maGapTrend    = null;
                    if (maGapCurr != null && maGapPrev != null) {
                        const absCurr = Math.abs(maGapCurr), absPrev = Math.abs(maGapPrev);
                        maGapTrend    = absCurr > absPrev + 0.5 ? 'widening' : absCurr < absPrev - 0.5 ? 'narrowing' : 'stable';
                    }
                    const prevBbBps   = barM1.bb_upper && barM1.bb_lower && barM1.bb_middle && barM1.bb_middle > 0
                        ? (barM1.bb_upper - barM1.bb_lower) / barM1.bb_middle * 10000 : null;
                    const bbExpanding = result.values.bbBps != null && prevBbBps != null ? result.values.bbBps > prevBbBps : null;
                    let regime        = null;
                    if (maGapTrend != null && bbExpanding != null) {
                        const tl = maGapTrend === 'widening' ? 'TRENDING' : maGapTrend === 'narrowing' ? 'RANGING' : 'STABLE';
                        regime   = `${tl}_${bbExpanding ? 'EXPANDING' : 'COMPRESSING'}`;
                    }

                    signals.push(buildSignal(dir, result.values, result.gates, barsSince, regime));
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

        function bStats(arr) {
            const n      = arr.length;
            const wins   = arr.filter(s => s[resultKey] === 'WIN').length;
            const losses = n - wins;
            const gp     = arr.reduce((a, s) => s[resultKey] === 'WIN'  ? a + (s[plKey] || 0) : a, 0);
            const gl     = arr.reduce((a, s) => s[resultKey] === 'LOSS' ? a + Math.abs(s[plKey] || 0) : a, 0);
            const avg_win     = wins   > 0 ? parseFloat((gp / wins).toFixed(2))   : null;
            const avg_loss    = losses > 0 ? parseFloat((gl / losses).toFixed(2)) : null;
            const avg_wl_ratio = avg_win != null && avg_loss != null && avg_loss > 0
                ? parseFloat((avg_win / avg_loss).toFixed(2)) : null;
            let z_score = null, p_value = null, wilson_lower = null, wilson_upper = null;
            if (n >= 5) {
                const p_hat  = wins / n;
                z_score      = parseFloat(((p_hat - 0.5) / Math.sqrt(0.25 / n)).toFixed(3));
                p_value      = parseFloat((1 - normCDF(z_score)).toFixed(4));
                const z95    = 1.96, denom = 1 + z95 * z95 / n;
                const center = (p_hat + z95 * z95 / (2 * n)) / denom;
                const margin = z95 * Math.sqrt(p_hat * (1 - p_hat) / n + z95 * z95 / (4 * n * n)) / denom;
                wilson_lower = parseFloat(Math.max(0, center - margin).toFixed(3));
                wilson_upper = parseFloat(Math.min(1, center + margin).toFixed(3));
            }
            return {
                trades: n, wins, losses,
                win_rate:      n > 0 ? ((wins / n) * 100).toFixed(1) + '%' : 'N/A',
                net_pnl:       parseFloat((gp - gl).toFixed(2)),
                profit_factor: gl > 0 ? parseFloat((gp / gl).toFixed(2)) : null,
                avg_win, avg_loss, avg_wl_ratio,
                z_score, p_value,
                wilson_95ci:   wilson_lower != null ? [wilson_lower, wilson_upper] : null,
            };
        }

        // ── Direction breakdown ──
        const by_direction = {
            call: bStats(validSignals.filter(s => s.direction === 'CALL')),
            put:  bStats(validSignals.filter(s => s.direction === 'PUT')),
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
                return { direction: 'CALL', stc_prev_range: b.range, ...bStats(bt) };
            }),
            ...putStcBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.stcPrev != null && s.stcPrev >= b.min && s.stcPrev < b.max);
                return { direction: 'PUT', stc_prev_range: b.range, ...bStats(bt) };
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
                return { direction: 'CALL', stc_delta_range: b.range, ...bStats(bt) };
            }),
            ...putDeltaBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.stcDelta != null && s.stcDelta >= b.min && s.stcDelta < b.max);
                return { direction: 'PUT', stc_delta_range: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── G1 bars ago (how recent was the BB touch) ──
        const by_g1_barsAgo = [1, 2, 3].map(j => {
            const bt = validSignals.filter(s => s.g1_barsAgo === j);
            return { g1_bars_ago: j, ...bStats(bt) };
        }).filter(b => b.trades > 0);

        // ── G2 stoch cross depth (K at C-2, the pre-cross bar) ──
        const callCrossDepthBuckets = [
            { range: '0-5',   min: 0,  max: 5  }, { range: '5-10',  min: 5,  max: 10 },
            { range: '10-20', min: 10, max: 20 }, { range: '20-30', min: 20, max: 30 },
        ];
        const putCrossDepthBuckets = [
            { range: '95-100', min: 95, max: 101 }, { range: '90-95',  min: 90, max: 95 },
            { range: '80-90',  min: 80, max: 90  }, { range: '70-80',  min: 70, max: 80 },
        ];
        const by_g2_cross_depth = [
            ...callCrossDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.g2_preCrossK != null && s.g2_preCrossK >= b.min && s.g2_preCrossK < b.max);
                return { direction: 'CALL', k_before_cross: b.range, ...bStats(bt) };
            }),
            ...putCrossDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.g2_preCrossK != null && s.g2_preCrossK >= b.min && s.g2_preCrossK < b.max);
                return { direction: 'PUT', k_before_cross: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── G2 cross bar (K at C-1, the bar where the crossover happened) ──
        const callCrossBarBuckets = [
            { range: '0-10',  min: 0,  max: 10 }, { range: '10-20', min: 10, max: 20 },
            { range: '20-30', min: 20, max: 30 }, { range: '30-50', min: 30, max: 50 },
        ];
        const putCrossBarBuckets = [
            { range: '90-100', min: 90, max: 101 }, { range: '80-90', min: 80, max: 90 },
            { range: '70-80',  min: 70, max: 80  }, { range: '50-70', min: 50, max: 70 },
        ];
        const by_g2_cross_kd = [
            ...callCrossBarBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.g2_crossK != null && s.g2_crossK >= b.min && s.g2_crossK < b.max);
                return { direction: 'CALL', stage: 'k_at_cross', k_range: b.range, ...bStats(bt) };
            }),
            ...putCrossBarBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.g2_crossK != null && s.g2_crossK >= b.min && s.g2_crossK < b.max);
                return { direction: 'PUT', stage: 'k_at_cross', k_range: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── G3 CCI cross barsAgo (how recent was the CCI cross before signal) ──
        const g3AgoBuckets = [
            { range: '1-3 bars',   min: 1,  max: 4  }, { range: '4-6 bars',   min: 4,  max: 7  },
            { range: '7-10 bars',  min: 7,  max: 11 }, { range: '11-15 bars', min: 11, max: 16 },
            { range: '16-24 bars', min: 16, max: 25 },
        ];
        const by_g3_cross_bars_ago = g3AgoBuckets.map(b => {
            const bt = validSignals.filter(s => s.g3_crossBarsAgo != null && s.g3_crossBarsAgo >= b.min && s.g3_crossBarsAgo < b.max);
            return { bars_ago: b.range, ...bStats(bt) };
        }).filter(b => b.trades > 0);

        // ── CCI current value at signal bar (cci_8_current) ──
        const callCciBuckets = [
            { range: 'CCI < 0',          min: -Infinity, max: 0   },
            { range: 'CCI 0-50',         min: 0,         max: 50  },
            { range: 'CCI 50-100',       min: 50,        max: 100 },
            { range: 'CCI 100-200',      min: 100,       max: 200 },
            { range: 'CCI 200+',         min: 200,       max: Infinity },
        ];
        const putCciBuckets = [
            { range: 'CCI > 0',          min: 0,         max: Infinity  },
            { range: 'CCI -50 to 0',     min: -50,       max: 0         },
            { range: 'CCI -100 to -50',  min: -100,      max: -50       },
            { range: 'CCI -200 to -100', min: -200,      max: -100      },
            { range: 'CCI < -200',       min: -Infinity, max: -200      },
        ];
        const by_cci_current = [
            ...callCciBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.cci_8_current != null && s.cci_8_current >= b.min && s.cci_8_current < b.max);
                return { direction: 'CALL', cci_at_signal: b.range, ...bStats(bt) };
            }),
            ...putCciBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.cci_8_current != null && s.cci_8_current >= b.min && s.cci_8_current < b.max);
                return { direction: 'PUT', cci_at_signal: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── Stochastic levels: K at pre-cross bar (C-2) and current bar ──
        const callKBefore = [
            { range: 'K 0-10', min: 0, max: 10 }, { range: 'K 10-20', min: 10, max: 20 },
            { range: 'K 20-30', min: 20, max: 30 },
        ];
        const putKBefore = [
            { range: 'K 90-100', min: 90, max: 101 }, { range: 'K 80-90', min: 80, max: 90 },
            { range: 'K 70-80', min: 70, max: 80 },
        ];
        const callKCurrent = [
            { range: 'K 0-20',  min: 0, max: 20 }, { range: 'K 20-30', min: 20, max: 30 },
            { range: 'K 30-40', min: 30, max: 40 }, { range: 'K 40-50', min: 40, max: 50 },
        ];
        const putKCurrent = [
            { range: 'K 50-60', min: 50, max: 60 }, { range: 'K 60-70', min: 60, max: 70 },
            { range: 'K 70-80', min: 70, max: 80 }, { range: 'K 80+',   min: 80, max: 101 },
        ];
        const by_stoch_levels = [
            ...callKBefore.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.g2_preCrossK != null && s.g2_preCrossK >= b.min && s.g2_preCrossK < b.max);
                return { stage: 'pre_cross_K', direction: 'CALL', k_range: b.range, ...bStats(bt) };
            }),
            ...putKBefore.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.g2_preCrossK != null && s.g2_preCrossK >= b.min && s.g2_preCrossK < b.max);
                return { stage: 'pre_cross_K', direction: 'PUT', k_range: b.range, ...bStats(bt) };
            }),
            ...callKCurrent.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.k != null && s.k >= b.min && s.k < b.max);
                return { stage: 'current_K', direction: 'CALL', k_range: b.range, ...bStats(bt) };
            }),
            ...putKCurrent.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.k != null && s.k >= b.min && s.k < b.max);
                return { stage: 'current_K', direction: 'PUT', k_range: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── Coincidence window: how many gates fired at maximum intensity ──
        function gateScore(s) {
            let score = 0;
            if (s.direction === 'CALL') {
                if (s.stcPrev != null      && s.stcPrev <= 10)              score++;
                if (s.g1_barsAgo           === 1)                            score++;
                if (s.g2_preCrossK != null && s.g2_preCrossK <= 10)         score++;
                if (s.g3_depth != null     && s.g3_depth <= -200)           score++;
                if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    score++;
            } else {
                if (s.stcPrev != null      && s.stcPrev >= 95)              score++;
                if (s.g1_barsAgo           === 1)                            score++;
                if (s.g2_preCrossK != null && s.g2_preCrossK >= 95)         score++;
                if (s.g3_depth != null     && s.g3_depth >= 200)            score++;
                if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    score++;
            }
            return score;
        }
        const scoreBuckets = {};
        for (const s of validSignals) {
            const sc = gateScore(s);
            if (!scoreBuckets[sc]) scoreBuckets[sc] = [];
            scoreBuckets[sc].push(s);
        }
        const by_coincidence_score = [0,1,2,3,4,5].map(sc => {
            const arr = scoreBuckets[sc];
            if (!arr?.length) return null;
            return { gates_at_max: sc, ...bStats(arr) };
        }).filter(Boolean);

        // ── G3 CCI depth ──
        const callDepthBuckets = [
            { range: '< -250',       min: -Infinity, max: -250 }, { range: '-250 to -200', min: -250, max: -200 },
            { range: '-200 to -175', min: -200,      max: -175 }, { range: '-175 to -150', min: -175, max: -150 },
        ];
        const putDepthBuckets = [
            { range: '> 250',       min: 250, max: Infinity }, { range: '200 to 250', min: 200, max: 250 },
            { range: '175 to 200',  min: 175, max: 200     }, { range: '150 to 175', min: 150, max: 175 },
        ];
        const by_g3_depth = [
            ...callDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'CALL' && s.g3_depth != null && s.g3_depth >= b.min && s.g3_depth < b.max);
                return { direction: 'CALL', cci_depth_range: b.range, ...bStats(bt) };
            }),
            ...putDepthBuckets.map(b => {
                const bt = validSignals.filter(s => s.direction === 'PUT' && s.g3_depth != null && s.g3_depth >= b.min && s.g3_depth < b.max);
                return { direction: 'PUT', cci_depth_range: b.range, ...bStats(bt) };
            }),
        ].filter(b => b.trades > 0);

        // ── BB width at signal bar ──
        const bbBuckets = [
            { label: 'flat (<2)',      min: 0,  max: 2        }, { label: 'weak (2-5)',     min: 2,  max: 5  },
            { label: 'marginal (5-10)', min: 5, max: 10       }, { label: 'ok (10-20)',      min: 10, max: 20 },
            { label: 'good (20+)',     min: 20, max: Infinity },
        ];
        const by_bb_width = bbBuckets.map(b => {
            const bt = validSignals.filter(s => s.bbBps != null && s.bbBps >= b.min && s.bbBps < b.max);
            return { bb_range: b.label, ...bStats(bt) };
        }).filter(b => b.trades > 0);

        // ── Bars since last signal (cooldown / clustering analysis) ──
        const cooldownBuckets = [
            { label: '1-3 bars',   min: 1,  max: 4           },
            { label: '4-10 bars',  min: 4,  max: 11          },
            { label: '11-30 bars', min: 11, max: 31          },
            { label: '30+ bars',   min: 31, max: Infinity     },
        ];
        const by_bars_since_last = [
            { label: 'first (no prior)', arr: validSignals.filter(s => s.barsSinceLastSignal == null) },
            ...cooldownBuckets.map(b => ({
                label: b.label,
                arr: validSignals.filter(s => s.barsSinceLastSignal != null && s.barsSinceLastSignal >= b.min && s.barsSinceLastSignal < b.max),
            })),
        ].map(({ label, arr }) => ({ bars_since_last_signal: label, ...bStats(arr) })).filter(b => b.trades > 0);

        // ── Market regime at signal time (MA gap trend × BB expansion) ──
        const regimeLabels = [
            'TRENDING_EXPANDING', 'TRENDING_COMPRESSING',
            'RANGING_EXPANDING',  'RANGING_COMPRESSING',
            'STABLE_EXPANDING',   'STABLE_COMPRESSING',
        ];
        const by_regime = regimeLabels.map(r => {
            const arr = validSignals.filter(s => s.regime === r);
            return { regime: r, ...bStats(arr) };
        }).filter(b => b.trades > 0);

        // ── Hour of day ──
        const hourBuckets = {};
        for (const s of validSignals) {
            const hour = Math.floor((s.signalTs % 86400) / 3600);
            if (!hourBuckets[hour]) hourBuckets[hour] = [];
            hourBuckets[hour].push(s);
        }
        const by_hour = Object.entries(hourBuckets)
            .map(([hour, arr]) => ({ hour_utc: parseInt(hour), ...bStats(arr) }))
            .sort((a, b) => b.trades - a.trades);

        // ── By asset ──
        const assetBuckets = {};
        for (const s of validSignals) {
            if (!assetBuckets[s.asset]) assetBuckets[s.asset] = { all: [], call: [], put: [] };
            assetBuckets[s.asset].all.push(s);
            if (s.direction === 'CALL') assetBuckets[s.asset].call.push(s);
            else assetBuckets[s.asset].put.push(s);
        }
        const by_asset = Object.entries(assetBuckets).map(([asset, grp]) => {
            const st     = bStats(grp.all);
            const callSt = grp.call.length > 0 ? bStats(grp.call) : null;
            const putSt  = grp.put.length  > 0 ? bStats(grp.put)  : null;
            const callWR = callSt ? parseFloat(callSt.win_rate) : null;
            const putWR  = putSt  ? parseFloat(putSt.win_rate)  : null;
            let preferred = null;
            if (callWR !== null && putWR !== null) preferred = callWR >= putWR ? 'CALL' : 'PUT';
            else if (callWR !== null) preferred = 'CALL';
            else if (putWR  !== null) preferred = 'PUT';
            return { asset, ...st, call: callSt, put: putSt, preferred_direction: preferred };
        }).sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));

        // ── Best thresholds summary ──
        function bestBucket(rows, minTrades = 5) {
            const elig = rows.filter(r => r.trades >= minTrades);
            if (!elig.length) return null;
            return elig.reduce((best, b) => parseFloat(b.win_rate) > parseFloat(best.win_rate) ? b : best);
        }
        const best_thresholds = [
            { param: 'stc_prev',          direction: 'CALL', best: bestBucket(by_stc_prev.filter(b => b.direction === 'CALL')) },
            { param: 'stc_prev',          direction: 'PUT',  best: bestBucket(by_stc_prev.filter(b => b.direction === 'PUT'))  },
            { param: 'stc_delta',         direction: 'CALL', best: bestBucket(by_stc_delta.filter(b => b.direction === 'CALL')) },
            { param: 'stc_delta',         direction: 'PUT',  best: bestBucket(by_stc_delta.filter(b => b.direction === 'PUT'))  },
            { param: 'g1_bars_ago',       direction: 'BOTH', best: bestBucket(by_g1_barsAgo) },
            { param: 'g2_k_before_cross', direction: 'CALL', best: bestBucket(by_g2_cross_depth.filter(b => b.direction === 'CALL')) },
            { param: 'g2_k_before_cross', direction: 'PUT',  best: bestBucket(by_g2_cross_depth.filter(b => b.direction === 'PUT'))  },
            { param: 'g2_k_at_cross',     direction: 'CALL', best: bestBucket(by_g2_cross_kd.filter(b => b.direction === 'CALL')) },
            { param: 'g2_k_at_cross',     direction: 'PUT',  best: bestBucket(by_g2_cross_kd.filter(b => b.direction === 'PUT'))  },
            { param: 'g3_depth',          direction: 'CALL', best: bestBucket(by_g3_depth.filter(b => b.direction === 'CALL')) },
            { param: 'g3_depth',          direction: 'PUT',  best: bestBucket(by_g3_depth.filter(b => b.direction === 'PUT'))  },
            { param: 'g3_cross_bars_ago', direction: 'BOTH', best: bestBucket(by_g3_cross_bars_ago) },
            { param: 'coincidence_score', direction: 'BOTH', best: bestBucket(by_coincidence_score) },
        ].filter(b => b.best !== null);

        const totalWins = validSignals.filter(s => s[resultKey] === 'WIN').length;
        const totalGp   = validSignals.reduce((a, s) => s[resultKey] === 'WIN'  ? a + (s[plKey] || 0) : a, 0);
        const totalGl   = validSignals.reduce((a, s) => s[resultKey] === 'LOSS' ? a + Math.abs(s[plKey] || 0) : a, 0);
        return {
            expiry: expiryLabel,
            total_signals: validSignals.length,
            wins: totalWins, losses: validSignals.length - totalWins,
            overall_wr: ((totalWins / validSignals.length) * 100).toFixed(1) + '%',
            total_pl: parseFloat((totalGp - totalGl).toFixed(2)),
            profit_factor: totalGl > 0 ? parseFloat((totalGp / totalGl).toFixed(2)) : null,
            by_direction,
            by_stc_prev, by_stc_delta,
            by_g1_barsAgo,
            by_g2_cross_depth, by_g2_cross_kd, by_stoch_levels,
            by_g3_depth, by_g3_cross_bars_ago, by_cci_current,
            by_coincidence_score,
            by_bb_width, by_bars_since_last, by_regime, by_hour, by_asset,
            best_thresholds,
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

    // Time-based cross-validation: split 120s signals at median timestamp
    let cross_validation = null;
    if (valid120.length >= 20) {
        const sorted = [...valid120].sort((a, b) => a.signalTs - b.signalTs);
        const midIdx  = Math.floor(sorted.length / 2);
        const splitTs = sorted[midIdx].signalTs;
        const half1   = sorted.slice(0, midIdx);
        const half2   = sorted.slice(midIdx);
        if (half1.length >= 5 && half2.length >= 5) {
            cross_validation = {
                split_timestamp: splitTs,
                note: `120s signals split at bar ${midIdx}/${sorted.length}. In-sample = first half, out-of-sample = second half.`,
                in_sample:     analyzeSet(half1, '120s'),
                out_of_sample: analyzeSet(half2, '120s'),
            };
        }
    }

    return {
        success: true,
        exp_60s:  analyzeSet(valid60,  '60s'),
        exp_120s: analyzeSet(valid120, '120s'),
        cross_validation,
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

// ─── gridSearch() — Multivariate parameter grid search ───────────────────────
// Captures a loose signal pool (wide gates), then post-filters across all
// combinations of stc_prev / stc_delta / g3_depth / g1_bars_ago thresholds.
// Returns top 20 per direction (n≥20) ranked by 120s win rate with full stats.

export async function gridSearch(direction = 'both') {
    const replay = await replayCandles(null, {
        stc_floor: 30, stc_ceiling: 70,
        call_delta_max: 1.0, put_delta_min: -1.0,
        call_g3_depth_min: -100, put_g3_depth_max: 100,
    });
    if (!replay.success) return replay;

    const allSigs = (replay.signals_all || []).filter(s => s.result_120 != null);

    function bStatsGrid(arr) {
        const n      = arr.length;
        const wins   = arr.filter(s => s.result_120 === 'WIN').length;
        const losses = n - wins;
        const gp     = arr.reduce((a, s) => s.result_120 === 'WIN'  ? a + (s.profitLoss_120 || 0) : a, 0);
        const gl     = arr.reduce((a, s) => s.result_120 === 'LOSS' ? a + Math.abs(s.profitLoss_120 || 0) : a, 0);
        const avg_win  = wins   > 0 ? parseFloat((gp / wins).toFixed(2))   : null;
        const avg_loss = losses > 0 ? parseFloat((gl / losses).toFixed(2)) : null;
        let z_score = null, p_value = null, wl = null, wu = null;
        if (n >= 5) {
            const p_hat = wins / n;
            z_score = parseFloat(((p_hat - 0.5) / Math.sqrt(0.25 / n)).toFixed(3));
            p_value = parseFloat((1 - normCDF(z_score)).toFixed(4));
            const z95 = 1.96, denom = 1 + z95 * z95 / n;
            const center = (p_hat + z95 * z95 / (2 * n)) / denom;
            const margin = z95 * Math.sqrt(p_hat * (1 - p_hat) / n + z95 * z95 / (4 * n * n)) / denom;
            wl = parseFloat(Math.max(0, center - margin).toFixed(3));
            wu = parseFloat(Math.min(1, center + margin).toFixed(3));
        }
        return {
            trades: n, wins, losses,
            win_rate:      n > 0 ? ((wins / n) * 100).toFixed(1) + '%' : 'N/A',
            net_pnl:       parseFloat((gp - gl).toFixed(2)),
            profit_factor: gl > 0 ? parseFloat((gp / gl).toFixed(2)) : null,
            avg_win, avg_loss,
            avg_wl_ratio:  avg_win != null && avg_loss != null && avg_loss > 0
                ? parseFloat((avg_win / avg_loss).toFixed(2)) : null,
            z_score, p_value,
            wilson_95ci:   wl != null ? [wl, wu] : null,
        };
    }

    const callResults = [], putResults = [];
    const MIN_N = 20;

    if (direction === 'both' || direction === 'call') {
        const cs           = allSigs.filter(s => s.direction === 'CALL');
        const stcMaxVals   = [5, 10, 15, 20, 25, 30];
        const deltaMaxVals = [0.1, 0.2, 0.3, 0.5, 1.0];
        const depthMinVals = [-200, -175, -150, -125, -100];
        const g1Vals       = [1, 2, 3, null];
        for (const stcMax of stcMaxVals) for (const dMax of deltaMaxVals) for (const depth of depthMinVals) for (const g1 of g1Vals) {
            const sub = cs.filter(s =>
                s.stcPrev  != null && s.stcPrev  <= stcMax &&
                s.stcDelta != null && s.stcDelta <  dMax   &&
                s.g3_depth != null && s.g3_depth <  depth  &&
                (g1 === null || s.g1_barsAgo === g1)
            );
            if (sub.length >= MIN_N)
                callResults.push({ direction: 'CALL',
                    params: { stc_prev_max: stcMax, delta_max: dMax, g3_depth_min: depth, g1_bars_ago: g1 ?? 'any' },
                    ...bStatsGrid(sub) });
        }
        callResults.sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));
    }

    if (direction === 'both' || direction === 'put') {
        const ps           = allSigs.filter(s => s.direction === 'PUT');
        const stcMinVals   = [95, 90, 85, 80, 75, 70];
        const deltaMinVals = [-0.1, -0.2, -0.3, -0.5, -0.9, -1.0];
        const depthMaxVals = [200, 175, 150, 125, 100];
        const g1Vals       = [1, 2, 3, null];
        for (const stcMin of stcMinVals) for (const dMin of deltaMinVals) for (const depth of depthMaxVals) for (const g1 of g1Vals) {
            const sub = ps.filter(s =>
                s.stcPrev  != null && s.stcPrev  >= stcMin &&
                s.stcDelta != null && s.stcDelta >= dMin   &&
                s.g3_depth != null && s.g3_depth >  depth  &&
                (g1 === null || s.g1_barsAgo === g1)
            );
            if (sub.length >= MIN_N)
                putResults.push({ direction: 'PUT',
                    params: { stc_prev_min: stcMin, delta_min: dMin, g3_depth_max: depth, g1_bars_ago: g1 ?? 'any' },
                    ...bStatsGrid(sub) });
        }
        putResults.sort((a, b) => parseFloat(b.win_rate) - parseFloat(a.win_rate));
    }

    return {
        success: true,
        note: 'Loose pool: stc_floor=30/ceiling=70, delta=±1.0, g3_depth=±100. Post-filtered n≥20 at 120s expiry.',
        total_loose_signals: replay.signals_all?.length ?? 0,
        total_validated_120s: allSigs.length,
        call: { combinations_passing_n20: callResults.length, top_20: callResults.slice(0, 20) },
        put:  { combinations_passing_n20: putResults.length,  top_20: putResults.slice(0, 20) },
    };
}

// ─── walkForward() — Rolling window WR validation across N time folds ───────────
// Sorts 120s validated signals by timestamp, splits into N equal folds,
// computes WR per fold, and returns a stability verdict.

export async function walkForward(direction = 'both', folds = 5) {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSigs = (replay.signals_all || []).filter(s => s.result_120 != null);
    const filtered = direction === 'both' ? allSigs
        : allSigs.filter(s => s.direction === direction.toUpperCase());

    if (filtered.length < folds * 5) {
        return { success: false, error: `Need at least ${folds * 5} validated 120s signals for ${folds} folds. Have: ${filtered.length}` };
    }

    const sorted   = [...filtered].sort((a, b) => a.signalTs - b.signalTs);
    const foldSize = Math.floor(sorted.length / folds);

    function bStatsWF(arr) {
        const n    = arr.length;
        const wins = arr.filter(s => s.result_120 === 'WIN').length;
        const gp   = arr.reduce((a, s) => s.result_120 === 'WIN'  ? a + (s.profitLoss_120 || 0) : a, 0);
        const gl   = arr.reduce((a, s) => s.result_120 === 'LOSS' ? a + Math.abs(s.profitLoss_120 || 0) : a, 0);
        let z_score = null, p_value = null, wl = null, wu = null;
        if (n >= 5) {
            const p_hat = wins / n;
            z_score = parseFloat(((p_hat - 0.5) / Math.sqrt(0.25 / n)).toFixed(3));
            p_value = parseFloat((1 - normCDF(z_score)).toFixed(4));
            const z95 = 1.96, denom = 1 + z95 * z95 / n;
            const center = (p_hat + z95 * z95 / (2 * n)) / denom;
            const margin = z95 * Math.sqrt(p_hat * (1 - p_hat) / n + z95 * z95 / (4 * n * n)) / denom;
            wl = parseFloat(Math.max(0, center - margin).toFixed(3));
            wu = parseFloat(Math.min(1, center + margin).toFixed(3));
        }
        return {
            trades: n, wins, losses: n - wins,
            win_rate: n > 0 ? ((wins / n) * 100).toFixed(1) + '%' : 'N/A',
            net_pnl:  parseFloat((gp - gl).toFixed(2)),
            z_score, p_value,
            wilson_95ci: wl != null ? [wl, wu] : null,
        };
    }

    const foldResults = [];
    for (let i = 0; i < folds; i++) {
        const start   = i * foldSize;
        const end     = i === folds - 1 ? sorted.length : (i + 1) * foldSize;
        const foldSigs = sorted.slice(start, end);
        foldResults.push({
            fold:      i + 1,
            date_from: foldSigs[0] ? new Date(foldSigs[0].signalTs * 1000).toISOString().slice(0, 10) : null,
            date_to:   foldSigs[foldSigs.length - 1] ? new Date(foldSigs[foldSigs.length - 1].signalTs * 1000).toISOString().slice(0, 10) : null,
            ...bStatsWF(foldSigs),
        });
    }

    const overall  = bStatsWF(sorted);
    const oosSigs  = sorted.slice(foldSize);  // all folds except first (burn-in)
    const oos      = bStatsWF(oosSigs);

    const wrValues = foldResults.map(f => parseFloat(f.win_rate));
    const spread   = Math.max(...wrValues) - Math.min(...wrValues);
    const anyBelowBreakeven = wrValues.some(wr => wr < 52.2);

    let verdict, verdict_note;
    if (spread <= 15 && !anyBelowBreakeven) {
        verdict      = 'STABLE';
        verdict_note = `All folds within ${spread.toFixed(1)}% spread. Edge is consistent across time.`;
    } else if (spread <= 25 && !anyBelowBreakeven) {
        verdict      = 'MODERATE';
        verdict_note = `${spread.toFixed(1)}% spread across folds. Some variance — monitor as more data accumulates.`;
    } else {
        verdict      = 'UNSTABLE';
        verdict_note = `${spread.toFixed(1)}% spread across folds${anyBelowBreakeven ? ' — one or more folds below breakeven (52.2%)' : ''}. Edge may not be consistent.`;
    }

    return {
        success: true,
        direction_filter: direction,
        total_signals: sorted.length,
        folds,
        fold_size: foldSize,
        per_fold: foldResults,
        out_of_sample: { note: 'All folds except fold 1 (burn-in)', ...oos },
        overall,
        stability: {
            verdict, verdict_note,
            wr_spread:    parseFloat(spread.toFixed(1)),
            min_fold_wr:  Math.min(...wrValues),
            max_fold_wr:  Math.max(...wrValues),
        },
    };
}

// ─── scoreCalibration() — Map coincidence score → WR → sizing multiplier ────────
// Computes actual 120s WR per coincidence score (0-5) from replay data.
// Derives Kelly fraction per score and normalises to a sizing multiplier.

export async function scoreCalibration() {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSigs = (replay.signals_all || []).filter(s => s.result_120 != null);
    if (allSigs.length < 10) return { success: false, error: 'Need at least 10 validated 120s signals' };

    function gateScore(s) {
        let score = 0;
        if (s.direction === 'CALL') {
            if (s.stcPrev != null         && s.stcPrev <= 10)           score++;
            if (s.g1_barsAgo              === 1)                         score++;
            if (s.g2_preCrossK != null    && s.g2_preCrossK <= 10)      score++;
            if (s.g3_depth != null        && s.g3_depth <= -200)        score++;
            if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    score++;
        } else {
            if (s.stcPrev != null         && s.stcPrev >= 95)           score++;
            if (s.g1_barsAgo              === 1)                         score++;
            if (s.g2_preCrossK != null    && s.g2_preCrossK >= 95)      score++;
            if (s.g3_depth != null        && s.g3_depth >= 200)         score++;
            if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    score++;
        }
        return score;
    }

    const PAYOUT = 0.92;

    const rows = [0, 1, 2, 3, 4, 5].map(sc => {
        const group = allSigs.filter(s => gateScore(s) === sc);
        const n = group.length;
        if (n === 0) return { score: sc, trades: 0, wins: 0, losses: 0, win_rate: 'N/A',
            kelly_fraction: null, recommended_multiplier: null, z_score: null, p_value: null, wilson_95ci: null };

        const wins  = group.filter(s => s.result_120 === 'WIN').length;
        const p_hat = wins / n;
        const kelly = parseFloat((p_hat - (1 - p_hat) / PAYOUT).toFixed(3));

        let z_score = null, p_value = null, wl = null, wu = null;
        if (n >= 5) {
            z_score = parseFloat(((p_hat - 0.5) / Math.sqrt(0.25 / n)).toFixed(3));
            p_value = parseFloat((1 - normCDF(z_score)).toFixed(4));
            const z95 = 1.96, denom = 1 + z95 * z95 / n;
            const center = (p_hat + z95 * z95 / (2 * n)) / denom;
            const margin = z95 * Math.sqrt(p_hat * (1 - p_hat) / n + z95 * z95 / (4 * n * n)) / denom;
            wl = parseFloat(Math.max(0, center - margin).toFixed(3));
            wu = parseFloat(Math.min(1, center + margin).toFixed(3));
        }
        return { score: sc, trades: n, wins, losses: n - wins,
            win_rate: ((p_hat * 100).toFixed(1)) + '%',
            kelly_fraction: kelly, z_score, p_value,
            wilson_95ci: wl != null ? [wl, wu] : null,
            recommended_multiplier: null };
    });

    // Normalise kelly fractions to multipliers (relative to median of valid rows)
    const validRows = rows.filter(r => r.trades >= 5 && r.kelly_fraction != null && r.kelly_fraction > 0);
    if (validRows.length > 0) {
        const sorted = [...validRows].sort((a, b) => a.kelly_fraction - b.kelly_fraction);
        const medianKelly = sorted[Math.floor(sorted.length / 2)].kelly_fraction;
        for (const r of rows) {
            if (r.trades < 5 || r.kelly_fraction == null || r.kelly_fraction <= 0) {
                r.recommended_multiplier = null;
                r.multiplier_note = 'skip — insufficient data or negative Kelly';
            } else {
                r.recommended_multiplier = parseFloat(Math.min(2.0, Math.max(0.25, r.kelly_fraction / medianKelly)).toFixed(2));
            }
        }
    }

    const wrValues = validRows.map(r => parseFloat(r.win_rate));
    const isDifferentiated = validRows.length >= 2 && (Math.max(...wrValues) - Math.min(...wrValues)) > 10;

    return {
        success: true,
        note: 'Score 0-5 = count of gates firing at maximum intensity per signal. Multiplier scales trade amount relative to median Kelly.',
        total_signals_120s: allSigs.length,
        by_score: rows,
        calibration_verdict: isDifferentiated
            ? 'SCORE IS PREDICTIVE — scale trade amount by recommended_multiplier'
            : 'SCORE NOT YET DIFFERENTIATED — use uniform sizing (need more data to confirm)',
        usage: 'amount = base_amount × recommended_multiplier for each signal coincidence_score',
    };
}

// ─── lossAttribution() — Which gate was the weakest link on losing trades ────────
// For every 120s LOSS, computes each gate's margin-from-threshold at signal time.
// The gate with the smallest average margin = the leaky gate letting bad trades through.
// Compares margin distribution on wins vs losses to identify where tightening helps.

export async function lossAttribution() {
    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSigs = (replay.signals_all || []).filter(s => s.result_120 != null);
    const losses  = allSigs.filter(s => s.result_120 === 'LOSS');
    const wins    = allSigs.filter(s => s.result_120 === 'WIN');

    if (losses.length < 5) return { success: false, error: `Need at least 5 losses. Have: ${losses.length}` };

    const THRESHOLDS = {
        call: { stc_floor: 25, delta_max: 0.5,  g1_max: 3, g3_depth_min: -150, g3_bars_max: 24 },
        put:  { stc_ceil:  75, delta_min: -0.5,  g1_max: 3, g3_depth_max:  150, g3_bars_max: 24 },
    };

    function computeMargins(s) {
        const isCall = s.direction === 'CALL';
        const t = isCall ? THRESHOLDS.call : THRESHOLDS.put;
        const m = {};

        if (isCall) {
            // G4 STC zone: how far stcPrev sits below the floor (25). Smaller = barely in zone.
            m.g4_stc_zone = s.stcPrev    != null ? parseFloat((t.stc_floor - s.stcPrev).toFixed(3))                         : null;
            // G4 delta: how far stcDelta sits below the ceiling (0.5). Smaller = barely under limit.
            m.g4_delta    = s.stcDelta   != null ? parseFloat((t.delta_max - s.stcDelta).toFixed(3))                        : null;
            // G3 depth: how much deeper than -150 (excess below threshold).
            m.g3_depth    = s.g3_depth   != null ? parseFloat((Math.abs(s.g3_depth) - Math.abs(t.g3_depth_min)).toFixed(1)) : null;
        } else {
            // G4 STC zone: how far stcPrev sits above the ceiling (75). Smaller = barely over.
            m.g4_stc_zone = s.stcPrev    != null ? parseFloat((s.stcPrev - t.stc_ceil).toFixed(3))                          : null;
            // G4 delta: how far stcDelta sits above the floor (-0.5). Smaller = barely above limit.
            m.g4_delta    = s.stcDelta   != null ? parseFloat((s.stcDelta - t.delta_min).toFixed(3))                        : null;
            // G3 depth: how much above 150.
            m.g3_depth    = s.g3_depth   != null ? parseFloat((s.g3_depth - t.g3_depth_max).toFixed(1))                     : null;
        }

        // G1: bars of freshness buffer (3 - g1_barsAgo). 0 = barely within 3-bar window.
        m.g1_recency  = s.g1_barsAgo      != null ? (t.g1_max     - s.g1_barsAgo)      : null;
        // G3 recency: bars before the 24-bar CCI cross cutoff.
        m.g3_recency  = s.g3_crossBarsAgo != null ? (t.g3_bars_max - s.g3_crossBarsAgo) : null;

        return m;
    }

    const GATES = ['g4_stc_zone', 'g4_delta', 'g1_recency', 'g3_depth', 'g3_recency'];
    const gateNames = {
        g4_stc_zone: 'G4 — STC zone depth',
        g4_delta:    'G4 — STC delta (hook tightness)',
        g1_recency:  'G1 — BB touch recency',
        g3_depth:    'G3 — CCI depth margin',
        g3_recency:  'G3 — CCI cross recency',
    };

    const weakCount    = Object.fromEntries(GATES.map(g => [g, 0]));
    const marginsLoss  = Object.fromEntries(GATES.map(g => [g, []]));
    const marginsWin   = Object.fromEntries(GATES.map(g => [g, []]));

    for (const s of losses) {
        const m = computeMargins(s);
        for (const g of GATES) { if (m[g] != null) marginsLoss[g].push(m[g]); }
        const valid = GATES.map(g => [g, m[g]]).filter(([, v]) => v != null);
        if (valid.length > 0) {
            const weakest = valid.reduce((a, b) => b[1] < a[1] ? b : a);
            weakCount[weakest[0]]++;
        }
    }
    for (const s of wins) {
        const m = computeMargins(s);
        for (const g of GATES) { if (m[g] != null) marginsWin[g].push(m[g]); }
    }

    function avg(arr) {
        return arr.length > 0 ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)) : null;
    }

    const attribution = GATES.map(g => {
        const avgLoss = avg(marginsLoss[g]);
        const avgWin  = avg(marginsWin[g]);
        const gap     = avgLoss != null && avgWin != null ? parseFloat((avgWin - avgLoss).toFixed(3)) : null;
        return {
            gate:              g,
            gate_name:         gateNames[g],
            times_weakest:     weakCount[g],
            pct_of_losses:     losses.length > 0 ? ((weakCount[g] / losses.length) * 100).toFixed(1) + '%' : 'N/A',
            avg_margin_losses: avgLoss,
            avg_margin_wins:   avgWin,
            margin_gap:        gap,
            action:            gap != null && gap > 0
                ? `tighten — wins had ${gap.toFixed(2)} more margin on average`
                : 'monitor — no clear margin differential yet',
        };
    }).sort((a, b) => b.times_weakest - a.times_weakest);

    const top = attribution[0];

    return {
        success: true,
        total_signals: allSigs.length,
        total_wins:    wins.length,
        total_losses:  losses.length,
        attribution,
        leakiest_gate: {
            gate:          top.gate,
            gate_name:     top.gate_name,
            times_weakest: top.times_weakest,
            pct_of_losses: top.pct_of_losses,
            recommendation: top.margin_gap != null && top.margin_gap > 0
                ? `Tighten ${top.gate_name} — wins had ${top.margin_gap.toFixed(2)} more margin on average. Run po_simulate to test threshold changes.`
                : `${top.gate_name} is the most frequent weak link. Collect more data to confirm margin differential.`,
        },
        note: 'Margin = distance from gate threshold at signal time. Smaller = signal barely passed. margin_gap = avg_win_margin − avg_loss_margin. Positive gap means wins had more breathing room — tightening that gate would filter more losses than wins.',
    };
}

// ─── DIMENSION_BUCKETS — shared bucketers for gateInteraction() ──────────────────

const DIMENSION_BUCKETS = {
    stc_prev: s => {
        if (s.stcPrev == null) return null;
        if (s.direction === 'CALL') {
            if (s.stcPrev <  5) return 'CALL 0-5';
            if (s.stcPrev < 10) return 'CALL 5-10';
            if (s.stcPrev < 15) return 'CALL 10-15';
            if (s.stcPrev < 20) return 'CALL 15-20';
            return 'CALL 20-25';
        } else {
            if (s.stcPrev >= 95) return 'PUT 95-100';
            if (s.stcPrev >= 90) return 'PUT 90-95';
            if (s.stcPrev >= 85) return 'PUT 85-90';
            if (s.stcPrev >= 80) return 'PUT 80-85';
            return 'PUT 75-80';
        }
    },
    stc_delta: s => {
        if (s.stcDelta == null) return null;
        if (s.direction === 'CALL') {
            if (s.stcDelta < 0.1) return 'CALL 0-0.1';
            if (s.stcDelta < 0.2) return 'CALL 0.1-0.2';
            if (s.stcDelta < 0.3) return 'CALL 0.2-0.3';
            return 'CALL 0.3-0.5';
        } else {
            if (s.stcDelta > -0.1) return 'PUT 0 to -0.1';
            if (s.stcDelta > -0.2) return 'PUT -0.1 to -0.2';
            if (s.stcDelta > -0.3) return 'PUT -0.2 to -0.3';
            return 'PUT -0.3 to -0.9';
        }
    },
    g1_bars_ago: s => s.g1_barsAgo != null ? `${s.g1_barsAgo} bar${s.g1_barsAgo > 1 ? 's' : ''}` : null,
    g3_depth: s => {
        if (s.g3_depth == null) return null;
        if (s.direction === 'CALL') {
            if (s.g3_depth < -250) return 'CALL < -250';
            if (s.g3_depth < -200) return 'CALL -250 to -200';
            if (s.g3_depth < -175) return 'CALL -200 to -175';
            return 'CALL -175 to -150';
        } else {
            if (s.g3_depth > 250) return 'PUT > 250';
            if (s.g3_depth > 200) return 'PUT 200-250';
            if (s.g3_depth > 175) return 'PUT 175-200';
            return 'PUT 150-175';
        }
    },
    g3_cross_bars_ago: s => {
        if (s.g3_crossBarsAgo == null) return null;
        if (s.g3_crossBarsAgo <= 3)  return '1-3 bars';
        if (s.g3_crossBarsAgo <= 6)  return '4-6 bars';
        if (s.g3_crossBarsAgo <= 10) return '7-10 bars';
        return '11-24 bars';
    },
    bb_width: s => {
        if (s.bbBps == null) return null;
        if (s.bbBps < 5)  return 'flat <5';
        if (s.bbBps < 10) return 'weak 5-10';
        if (s.bbBps < 20) return 'ok 10-20';
        return 'good 20+';
    },
    coincidence_score: s => {
        let sc = 0;
        if (s.direction === 'CALL') {
            if (s.stcPrev != null         && s.stcPrev <= 10)           sc++;
            if (s.g1_barsAgo              === 1)                         sc++;
            if (s.g2_preCrossK != null    && s.g2_preCrossK <= 10)      sc++;
            if (s.g3_depth != null        && s.g3_depth <= -200)        sc++;
            if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    sc++;
        } else {
            if (s.stcPrev != null         && s.stcPrev >= 95)           sc++;
            if (s.g1_barsAgo              === 1)                         sc++;
            if (s.g2_preCrossK != null    && s.g2_preCrossK >= 95)      sc++;
            if (s.g3_depth != null        && s.g3_depth >= 200)         sc++;
            if (s.g3_crossBarsAgo != null && s.g3_crossBarsAgo <= 3)    sc++;
        }
        return `score_${sc}`;
    },
    regime: s => s.regime || null,
    bars_since_last_signal: s => {
        if (s.barsSinceLastSignal == null) return 'first';
        if (s.barsSinceLastSignal <= 3)  return '1-3 bars';
        if (s.barsSinceLastSignal <= 10) return '4-10 bars';
        if (s.barsSinceLastSignal <= 30) return '11-30 bars';
        return '30+ bars';
    },
};

// ─── gateInteraction() — 2D WR heatmap for any two dimensions ────────────────────
// Returns an N×M grid showing WR at every (bucket_a × bucket_b) intersection.
// Reveals combinations that po_find_edge univariate analysis cannot show.

export async function gateInteraction(dim_a, dim_b, direction = 'both') {
    const validDims = Object.keys(DIMENSION_BUCKETS);
    if (!validDims.includes(dim_a)) return { success: false, error: `Unknown dim_a: "${dim_a}". Valid: ${validDims.join(', ')}` };
    if (!validDims.includes(dim_b)) return { success: false, error: `Unknown dim_b: "${dim_b}". Valid: ${validDims.join(', ')}` };
    if (dim_a === dim_b) return { success: false, error: 'dim_a and dim_b must be different dimensions' };

    const replay = await replayCandles();
    if (!replay.success) return replay;

    const allSigs = (replay.signals_all || []).filter(s => s.result_120 != null);
    const filtered = direction === 'both' ? allSigs : allSigs.filter(s => s.direction === direction.toUpperCase());
    if (filtered.length < 10) return { success: false, error: `Need at least 10 validated 120s signals. Have: ${filtered.length}` };

    // Bucket every signal on both dimensions
    const matrix  = {};
    const labelsA = new Set(), labelsB = new Set();
    for (const s of filtered) {
        const la = DIMENSION_BUCKETS[dim_a](s);
        const lb = DIMENSION_BUCKETS[dim_b](s);
        if (la == null || lb == null) continue;
        labelsA.add(la); labelsB.add(lb);
        const key = `${la}|||${lb}`;
        if (!matrix[key]) matrix[key] = [];
        matrix[key].push(s);
    }

    const sortedA = [...labelsA].sort();
    const sortedB = [...labelsB].sort();

    function cellStats(arr) {
        if (!arr || arr.length === 0) return { trades: 0, win_rate: null };
        const wins = arr.filter(s => s.result_120 === 'WIN').length;
        const wr   = (wins / arr.length * 100).toFixed(1) + '%';
        const gp   = arr.reduce((a, s) => s.result_120 === 'WIN'  ? a + (s.profitLoss_120 || 0) : a, 0);
        const gl   = arr.reduce((a, s) => s.result_120 === 'LOSS' ? a + Math.abs(s.profitLoss_120 || 0) : a, 0);
        let z_score = null, p_value = null;
        if (arr.length >= 5) {
            const p_hat = wins / arr.length;
            z_score = parseFloat(((p_hat - 0.5) / Math.sqrt(0.25 / arr.length)).toFixed(3));
            p_value = parseFloat((1 - normCDF(z_score)).toFixed(4));
        }
        return { trades: arr.length, wins, losses: arr.length - wins, win_rate: wr,
            net_pnl: parseFloat((gp - gl).toFixed(2)), z_score, p_value };
    }

    const grid = sortedA.map(la => ({
        [dim_a]: la,
        cells: sortedB.map(lb => ({ [dim_b]: lb, ...cellStats(matrix[`${la}|||${lb}`]) })),
    }));

    // Find best cell (n >= 5, highest WR)
    let bestCell = null, bestWR = -Infinity;
    for (const [key, arr] of Object.entries(matrix)) {
        if (arr.length < 5) continue;
        const wins = arr.filter(s => s.result_120 === 'WIN').length;
        const wr   = wins / arr.length;
        if (wr > bestWR) { bestWR = wr; const [la, lb] = key.split('|||'); bestCell = { [dim_a]: la, [dim_b]: lb, ...cellStats(arr) }; }
    }

    // Worst cell (n >= 5, lowest WR)
    let worstCell = null, worstWR = Infinity;
    for (const [key, arr] of Object.entries(matrix)) {
        if (arr.length < 5) continue;
        const wins = arr.filter(s => s.result_120 === 'WIN').length;
        const wr   = wins / arr.length;
        if (wr < worstWR) { worstWR = wr; const [la, lb] = key.split('|||'); worstCell = { [dim_a]: la, [dim_b]: lb, ...cellStats(arr) }; }
    }

    return {
        success: true,
        dim_a, dim_b,
        direction_filter: direction,
        total_signals: filtered.length,
        labels_a: sortedA,
        labels_b: sortedB,
        grid,
        best_combination:  bestCell,
        worst_combination: worstCell,
        note: 'Focus on cells with trades >= 5. Use best_combination to identify which dim_a + dim_b pairing produces the highest 120s WR, then test with po_simulate.',
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
