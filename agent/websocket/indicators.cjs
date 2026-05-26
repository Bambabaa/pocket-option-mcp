'use strict';
// Pure indicator math — PO platform defaults.
// All functions accept candles as [timestamp, open, close, high, low] arrays
// and return a value or null when insufficient data.

// ── SMA ──────────────────────────────────────────────────────────────────────
function calculateSMA(candles, period) {
    if (!candles || candles.length < period) return null;
    const closes = candles.slice(-period).map(c => c[2]);
    return closes.reduce((a, b) => a + b, 0) / period;
}

// ── EMA ──────────────────────────────────────────────────────────────────────
function calculateEMA(candles, period) {
    if (!candles || candles.length < period) return null;
    const multiplier = 2 / (period + 1);
    const closes = candles.map(c => c[2]);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
    }
    return ema;
}

// ── RSI (Wilder) ─────────────────────────────────────────────────────────────
function calculateRSI(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const closes = candles.map(c => c[2]);
    const changes = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
    if (changes.length < period) return null;
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period; i < changes.length; i++) {
        const gain = changes[i] > 0 ? changes[i] : 0;
        const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── MACD ─────────────────────────────────────────────────────────────────────
function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!candles || candles.length < slowPeriod + signalPeriod) return null;
    const fastEMA = calculateEMA(candles, fastPeriod);
    const slowEMA = calculateEMA(candles, slowPeriod);
    if (fastEMA == null || slowEMA == null) return null;
    const macdLine = fastEMA - slowEMA;
    const macdValues = [];
    for (let i = slowPeriod; i < candles.length; i++) {
        const fe = calculateEMA(candles.slice(0, i + 1), fastPeriod);
        const se = calculateEMA(candles.slice(0, i + 1), slowPeriod);
        if (fe != null && se != null) macdValues.push(fe - se);
    }
    if (macdValues.length < signalPeriod) return null;
    const mult = 2 / (signalPeriod + 1);
    let signalLine = macdValues.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
    for (let i = signalPeriod; i < macdValues.length; i++) {
        signalLine = (macdValues[i] - signalLine) * mult + signalLine;
    }
    return { macd_line: macdLine, macd_signal: signalLine, macd_histogram: macdLine - signalLine };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
    if (!candles || candles.length < period) return null;
    const sma = calculateSMA(candles, period);
    if (sma == null) return null;
    const closes = candles.slice(-period).map(c => c[2]);
    const variance = closes.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
    const sd = Math.sqrt(variance);
    const upper = sma + sd * stdDev;
    const lower = sma - sd * stdDev;
    const bb_width_bps = sma > 0 ? ((upper - lower) / sma) * 10000 : null;
    return { bb_upper: upper, bb_middle: sma, bb_lower: lower, bb_width_bps };
}

// ── Stochastic (Full, K=5 D=3 smooth=3) ─────────────────────────────────────
function calculateStochastic(candles, kPeriod = 5, dPeriod = 3, smoothPeriod = 3) {
    const minCandles = kPeriod + smoothPeriod + dPeriod - 2;
    if (!candles || candles.length < minCandles) return null;
    const rawKs = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
        const window = candles.slice(i - kPeriod + 1, i + 1);
        const hi = Math.max(...window.map(c => c[3] ?? c[2]));
        const lo = Math.min(...window.map(c => c[4] ?? c[1]));
        const cl = window[window.length - 1][2];
        const rng = hi - lo;
        rawKs.push(rng === 0 ? 50 : ((cl - lo) / rng) * 100);
    }
    if (rawKs.length < smoothPeriod) return null;
    const smoothKs = [];
    for (let i = smoothPeriod - 1; i < rawKs.length; i++) {
        const slice = rawKs.slice(i - smoothPeriod + 1, i + 1);
        smoothKs.push(slice.reduce((a, b) => a + b, 0) / smoothPeriod);
    }
    if (smoothKs.length < dPeriod) return null;
    const stoch_k = smoothKs[smoothKs.length - 1];
    const stoch_d = smoothKs.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
    const stoch_prev_d = smoothKs.length >= dPeriod + 1
        ? smoothKs.slice(-dPeriod - 1, -1).reduce((a, b) => a + b, 0) / dPeriod
        : stoch_d;
    return { stoch_k, stoch_d, stoch_prev_d };
}

// ── ATR ──────────────────────────────────────────────────────────────────────
function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][3], low = candles[i][4], prevClose = candles[i - 1][2];
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trs.length < period) return null;
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Keltner Channel (ema=20, atr=10, mult=2) ─────────────────────────────────
function calculateKeltnerChannel(candles, emaPeriod = 20, atrPeriod = 10, multiplier = 2) {
    if (!candles || candles.length < Math.max(emaPeriod, atrPeriod)) return null;
    const middle = calculateEMA(candles, emaPeriod);
    const atr = calculateATR(candles, atrPeriod);
    if (middle == null || atr == null) return null;
    return {
        keltner_upper: middle + multiplier * atr,
        keltner_middle: middle,
        keltner_lower: middle - multiplier * atr
    };
}

// ── Zig Zag (deviation=0.5%, minBars=4) ─────────────────────────────────────
// Uses H/L for pivot detection (matches bot/indicators.js pattern).
// 0.5% default is appropriate for 5m bars; 5% (PO platform default) is too
// large and produces nulls on almost every bar at 5m timeframe.
function calculateZigZag(candles, deviationPercent = 0.5, minBars = 4) {
    if (!candles || candles.length < minBars + 2) return null;
    const n      = candles.length;
    const highs  = candles.map(c => c[3]);
    const lows   = candles.map(c => c[4]);

    let trend      = 'UP';
    let pivotPrice = lows[0];
    let pivotIdx   = 0;
    const pivots   = [];
    const dev      = deviationPercent / 100;

    for (let i = 1; i < n; i++) {
        if (trend === 'UP') {
            if (highs[i] > pivotPrice) { pivotPrice = highs[i]; pivotIdx = i; }
            else if ((pivotPrice - lows[i]) / pivotPrice >= dev && (i - pivotIdx) >= minBars) {
                pivots.push({ type: 'HIGH', price: pivotPrice, idx: pivotIdx });
                trend = 'DOWN'; pivotPrice = lows[i]; pivotIdx = i;
            }
        } else {
            if (lows[i] < pivotPrice) { pivotPrice = lows[i]; pivotIdx = i; }
            else if ((highs[i] - pivotPrice) / pivotPrice >= dev && (i - pivotIdx) >= minBars) {
                pivots.push({ type: 'LOW', price: pivotPrice, idx: pivotIdx });
                trend = 'UP'; pivotPrice = highs[i]; pivotIdx = i;
            }
        }
    }

    if (pivots.length === 0) return null;
    const last = pivots[pivots.length - 1];
    return {
        zigzag_direction: last.type === 'HIGH' ? -1 : 1,  // after HIGH pivot → DOWN trend; after LOW → UP
        zigzag_reversal:  last.idx >= n - 2 ? 1 : 0,       // 1 if last pivot is current or previous bar
        zigzag_pivot:     last.price,
    };
}

// ── Schaff Trend Cycle (emaFast=23, emaSlow=50, cycle=10, smooth1=3, smooth2=3) ──
function calculateSTC(candles, emaFast = 23, emaSlow = 50, cyclePeriod = 10, smooth1 = 3, smooth2 = 3) {
    if (!candles || candles.length < emaSlow + cyclePeriod + Math.max(smooth1, smooth2)) return null;
    const n = candles.length;
    const cycleRaw = [];
    for (let i = emaSlow; i < n; i++) {
        const fast = calculateEMA(candles.slice(0, i), emaFast);
        const slow = calculateEMA(candles.slice(0, i), emaSlow);
        if (fast != null && slow != null) cycleRaw.push(fast - slow);
    }
    if (cycleRaw.length < cyclePeriod) return null;

    function stochK(arr, period, idx) {
        const start = Math.max(0, idx - period + 1);
        const window = arr.slice(start, idx + 1);
        const lo = Math.min(...window), hi = Math.max(...window);
        if (hi === lo) return 50;
        return 100 * (arr[idx] - lo) / (hi - lo);
    }

    const stochCycle = [];
    for (let i = cyclePeriod - 1; i < cycleRaw.length; i++) stochCycle.push(stochK(cycleRaw, cyclePeriod, i));
    if (stochCycle.length < smooth1) return null;

    const k1 = 2 / (smooth1 + 1);
    let ema1 = stochCycle.slice(0, smooth1).reduce((a, b) => a + b, 0) / smooth1;
    const smoothed1 = [];
    for (let i = smooth1 - 1; i < stochCycle.length; i++) {
        if (i >= smooth1) ema1 = (stochCycle[i] - ema1) * k1 + ema1;
        smoothed1.push(ema1);
    }
    if (smoothed1.length < smooth2) return null;

    const k2 = 2 / (smooth2 + 1);
    let ema2 = smoothed1.slice(0, smooth2).reduce((a, b) => a + b, 0) / smooth2;
    for (let i = smooth2; i < smoothed1.length; i++) ema2 = (smoothed1[i] - ema2) * k2 + ema2;

    const stc_value = ema2;
    const stc_signal = smoothed1.length >= 2 ? smoothed1[smoothed1.length - 2] : stc_value;
    return { stc_value, stc_signal };
}

// ── ADX ──────────────────────────────────────────────────────────────────────
function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][3], low = candles[i][4], prevClose = candles[i - 1][2];
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        const upMove = high - candles[i - 1][3];
        const downMove = candles[i - 1][4] - low;
        if (upMove > downMove && upMove > 0) { plusDMs.push(upMove); minusDMs.push(0); }
        else if (downMove > upMove && downMove > 0) { plusDMs.push(0); minusDMs.push(downMove); }
        else { plusDMs.push(0); minusDMs.push(0); }
    }
    if (trs.length < period) return null;
    const smoothedTR = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothedPlus = plusDMs.slice(-period).reduce((a, b) => a + b, 0) / period;
    const smoothedMinus = minusDMs.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plus_di = smoothedTR > 0 ? 100 * (smoothedPlus / smoothedTR) : 0;
    const minus_di = smoothedTR > 0 ? 100 * (smoothedMinus / smoothedTR) : 0;
    const diSum = plus_di + minus_di;
    const adx = diSum > 0 ? 100 * Math.abs(plus_di - minus_di) / diSum : 0;
    return { adx, plus_di, minus_di };
}

// ── CCI ──────────────────────────────────────────────────────────────────────
function calculateCCI(candles, period = 20) {
    if (!candles || candles.length < period) return null;
    const recent = candles.slice(-period);
    const tps = recent.map(c => (c[3] + c[4] + c[2]) / 3);
    const sma = tps.reduce((a, b) => a + b, 0) / period;
    const meanDev = tps.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;
    if (meanDev === 0) return 0;
    return (tps[tps.length - 1] - sma) / (0.015 * meanDev);
}

// ── Williams %R ───────────────────────────────────────────────────────────────
function calculateWilliamsR(candles, period = 14) {
    if (!candles || candles.length < period) return null;
    const recent = candles.slice(-period);
    const highestHigh = Math.max(...recent.map(c => c[3]));
    const lowestLow = Math.min(...recent.map(c => c[4]));
    const close = candles[candles.length - 1][2];
    if (highestHigh === lowestLow) return -50;
    return -100 * ((highestHigh - close) / (highestHigh - lowestLow));
}

// ── Parabolic SAR ─────────────────────────────────────────────────────────────
function calculateParabolicSAR(candles, acceleration = 0.02, maximum = 0.2) {
    if (!candles || candles.length < 2) return null;
    let trend = candles[1][3] > candles[0][3] ? 1 : -1;
    let sar = trend === 1 ? candles[0][4] : candles[0][3];
    let ep = trend === 1 ? candles[1][3] : candles[1][4];
    let af = acceleration;
    for (let i = 2; i < candles.length; i++) {
        const high = candles[i][3], low = candles[i][4];
        if (trend === 1) {
            sar = sar + af * (ep - sar);
            if (low < sar) { trend = -1; sar = ep; ep = low; af = acceleration; }
            else if (high > ep) { ep = high; af = Math.min(af + acceleration, maximum); }
        } else {
            sar = sar + af * (ep - sar);
            if (high > sar) { trend = 1; sar = ep; ep = high; af = acceleration; }
            else if (low < ep) { ep = low; af = Math.min(af + acceleration, maximum); }
        }
    }
    const close = candles[candles.length - 1][2];
    return {
        psar_value: sar,
        psar_trend: trend,
        psar_is_bullish: (trend === 1 && close > sar) ? 1 : 0
    };
}

// ── Master compute — returns full indicator row for latest bar ────────────────
// Tracks stc_prev per-asset via the prevStc map passed in from caller.
function computeAll(candles, cfg, prevStc) {
    if (!candles || candles.length < 2) return null;

    const bb = calculateBollingerBands(candles, cfg.bb.period, cfg.bb.std_dev);
    const stoch = calculateStochastic(candles, cfg.stoch.k_period, cfg.stoch.d_period, cfg.stoch.smooth);
    const macd = calculateMACD(candles, cfg.macd.fast, cfg.macd.slow, cfg.macd.signal);
    const keltner = calculateKeltnerChannel(candles, cfg.keltner.ema, cfg.keltner.atr, cfg.keltner.mult);
    const zigzag = calculateZigZag(candles, cfg.zigzag.deviation_pct, cfg.zigzag.min_bars);
    const stcResult = calculateSTC(candles, cfg.stc.ema_fast, cfg.stc.ema_slow, cfg.stc.cycle, cfg.stc.smooth1, cfg.stc.smooth2);
    const adx = calculateADX(candles, cfg.adx_period);
    const psar = calculateParabolicSAR(candles, cfg.psar.acceleration, cfg.psar.max);

    const stc_value = stcResult?.stc_value ?? null;
    const stc_signal = stcResult?.stc_signal ?? null;
    const stc_prev = prevStc ?? null;
    const stc_delta = stc_value != null && stc_prev != null ? stc_value - stc_prev : null;

    return {
        sma_10: calculateSMA(candles, cfg.sma_periods[0]),
        sma_20: calculateSMA(candles, cfg.sma_periods[1]),
        sma_50: calculateSMA(candles, cfg.sma_periods[2]),
        ema_12: calculateEMA(candles, cfg.ema_periods[0]),
        ema_26: calculateEMA(candles, cfg.ema_periods[1]),
        rsi_14: calculateRSI(candles, cfg.rsi_period),
        macd_line:      macd?.macd_line      ?? null,
        macd_signal:    macd?.macd_signal    ?? null,
        macd_histogram: macd?.macd_histogram ?? null,
        bb_upper:     bb?.bb_upper     ?? null,
        bb_middle:    bb?.bb_middle    ?? null,
        bb_lower:     bb?.bb_lower     ?? null,
        bb_width_bps: bb?.bb_width_bps ?? null,
        stoch_k:      stoch?.stoch_k      ?? null,
        stoch_d:      stoch?.stoch_d      ?? null,
        stoch_prev_d: stoch?.stoch_prev_d ?? null,
        keltner_upper:  keltner?.keltner_upper  ?? null,
        keltner_middle: keltner?.keltner_middle ?? null,
        keltner_lower:  keltner?.keltner_lower  ?? null,
        zigzag_direction: zigzag?.zigzag_direction ?? null,
        zigzag_reversal:  zigzag?.zigzag_reversal  ?? null,
        zigzag_pivot:     zigzag?.zigzag_pivot     ?? null,
        stc_value, stc_signal, stc_prev, stc_delta,
        adx:      adx?.adx      ?? null,
        plus_di:  adx?.plus_di  ?? null,
        minus_di: adx?.minus_di ?? null,
        cci_20: calculateCCI(candles, cfg.cci_period),
        williams_r: calculateWilliamsR(candles, cfg.williams_period),
        atr_14: calculateATR(candles, cfg.atr_period),
        psar_value:      psar?.psar_value      ?? null,
        psar_trend:      psar?.psar_trend      ?? null,
        psar_is_bullish: psar?.psar_is_bullish ?? null,
    };
}

module.exports = { computeAll, calculateSMA, calculateEMA, calculateRSI, calculateMACD, calculateBollingerBands, calculateStochastic, calculateATR, calculateKeltnerChannel, calculateZigZag, calculateSTC, calculateADX, calculateCCI, calculateWilliamsR, calculateParabolicSAR };
