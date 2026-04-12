// Technical Indicators Module
// Pure video logic only: no ATR, no regime or alignment gates (see docs/youtube_strategies.md).
// KT strategies calibrated to docs/youtube_strategies.md

// KT calibration (youtube_strategies.md): single source of truth
const KT_CAL = {
    video1: {
        keltner: { ema: 18, atr: 11, mult: 2 },
        zigzag: { deviationPct: 0.5, minBars: 4 }, // "Periods 6 and 4" → deviation + minBars 4
        stochastic: { kPeriod: 13, dPeriod: 3 },   // 13, 3, 3
    },
    video2: {
        ma1: 6,   // Moving Average 1, Green, Period 6
        ma2: 50,  // Moving Average 2, Red,   Period 50
        ma3: 14,  // Moving Average 3, White, Period 14
        rsi: 5,
        rsiUpper: 65,  // upper signal line (green) over 70
        rsiLower: 45,  // lower signal line under 30
        stoch: { kPeriod: 5, dPeriod: 3 },  // Stochastic 5,3,3 — entry trigger for LayerIndicators 7
    },
    video3: {
        bb: { period: 20, stdDev: 2 },
        rsi: 8,
        rsiUpper: 80,
        rsiLower: 20,
        schaff: { emaFast: 30, emaSlow: 55, cycle: 8, smooth1: 4, smooth2: 3 },
    },
};

class Indicators {
    constructor() {
        this.cache = {};
        this.macdHistory = {}; // for MACD signal line (used by calculateMACD if ever needed)
        // Phase 30: per-asset consecutive signal tracking (used by video2 streak filter)
        this._v2ConsecCount = {};  // asset -> consecutive signal streak length
        this._v2LastTs = {};  // asset -> timestamp of last fired signal candle
    }

    // ==================== BASIC INDICATORS ====================

    // Simple Moving Average (SMA)
    calculateSMA(candles, period) {
        if (!candles || candles.length < period) {
            return null;
        }

        const closes = candles.slice(-period).map(c => c[2]); // Close prices
        const sum = closes.reduce((a, b) => a + b, 0);
        return sum / period;
    }

    // Exponential Moving Average (EMA)
    calculateEMA(candles, period) {
        if (!candles || candles.length < period) {
            return null;
        }

        const multiplier = 2 / (period + 1);
        const closes = candles.map(c => c[2]); // Close prices

        // Start with SMA
        let ema = this.calculateSMA(candles.slice(0, period), period);

        // Calculate EMA for remaining candles
        for (let i = period; i < closes.length; i++) {
            ema = (closes[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    // Relative Strength Index (RSI)
    calculateRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) {
            return null;
        }

        const closes = candles.map(c => c[2]); // Close prices
        const changes = [];

        // Calculate price changes
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        if (changes.length < period) {
            return null;
        }

        // Calculate average gain and loss
        const recentChanges = changes.slice(-period);
        let avgGain = 0;
        let avgLoss = 0;

        recentChanges.forEach(change => {
            if (change > 0) {
                avgGain += change;
            } else {
                avgLoss += Math.abs(change);
            }
        });

        avgGain = avgGain / period;
        avgLoss = avgLoss / period;

        if (avgLoss === 0) {
            return 100; // All gains, no losses
        }

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        return rsi;
    }

    // ==================== MACD (COMPLETE IMPLEMENTATION) ====================

    // Complete MACD with signal line and histogram
    calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (!candles || candles.length < slowPeriod + signalPeriod) {
            return null;
        }

        const fastEMA = this.calculateEMA(candles, fastPeriod);
        const slowEMA = this.calculateEMA(candles, slowPeriod);

        if (!fastEMA || !slowEMA) {
            return null;
        }

        const macdLine = fastEMA - slowEMA;

        // Calculate MACD history for signal line
        const asset = candles.asset || 'default';
        if (!this.macdHistory[asset]) {
            this.macdHistory[asset] = [];
        }

        // Calculate MACD for all candles to build history
        const macdValues = [];
        for (let i = slowPeriod; i < candles.length; i++) {
            const fastEMA_i = this.calculateEMA(candles.slice(0, i + 1), fastPeriod);
            const slowEMA_i = this.calculateEMA(candles.slice(0, i + 1), slowPeriod);
            if (fastEMA_i && slowEMA_i) {
                macdValues.push(fastEMA_i - slowEMA_i);
            }
        }

        // Calculate signal line (EMA of MACD values)
        let signalLine = null;
        if (macdValues.length >= signalPeriod) {
            // Use EMA on MACD values
            const multiplier = 2 / (signalPeriod + 1);
            let signalEMA = macdValues.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;

            for (let i = signalPeriod; i < macdValues.length; i++) {
                signalEMA = (macdValues[i] - signalEMA) * multiplier + signalEMA;
            }
            signalLine = signalEMA;
        }

        const histogram = signalLine !== null ? macdLine - signalLine : null;

        return {
            macd: macdLine,
            signal: signalLine,
            histogram: histogram
        };
    }

    // ==================== BOLLINGER BANDS ====================

    // Bollinger Bands
    calculateBollingerBands(candles, period = 20, stdDev = 2) {
        if (!candles || candles.length < period) {
            return null;
        }

        const sma = this.calculateSMA(candles, period);
        if (!sma) return null;

        const closes = candles.slice(-period).map(c => c[2]);
        const variance = closes.reduce((sum, price) => {
            return sum + Math.pow(price - sma, 2);
        }, 0) / period;

        const standardDeviation = Math.sqrt(variance);

        return {
            upper: sma + (standardDeviation * stdDev),
            middle: sma,
            lower: sma - (standardDeviation * stdDev),
            width: (standardDeviation * stdDev * 2) / sma // Band width as percentage
        };
    }

    // ==================== STOCHASTIC OSCILLATOR ====================

    // Stochastic Oscillator — Full/Slow Stochastic matching Pocket Option 5,3,3 SMA standard:
    //   %K Period   = kPeriod  (default 5)  — look back window for highest high / lowest low
    //   Smooth %K   = smoothPeriod (default 3) — SMA of raw %K values → the displayed %K line
    //   %D Period   = dPeriod  (default 3)  — SMA of smoothed %K → the displayed %D line
    //
    // Returns: { k, d, prevD } where prevD is %D of previous bar (for slope detection)
    // Returns null if insufficient candle history.
    calculateStochastic(candles, kPeriod = 5, dPeriod = 3, smoothPeriod = 3) {
        // Need enough candles to compute: kPeriod raw values + smoothPeriod - 1 extras +
        // dPeriod - 1 extras for %D = kPeriod + smoothPeriod + dPeriod - 2 minimum
        const minCandles = kPeriod + smoothPeriod + dPeriod - 2;
        if (!candles || candles.length < minCandles) return null;

        // Step 1: Compute raw %K for each bar (sliding window of kPeriod candles)
        const rawKs = [];
        for (let i = kPeriod - 1; i < candles.length; i++) {
            const window = candles.slice(i - kPeriod + 1, i + 1);
            const hi = Math.max(...window.map(c => c[3] ?? c[2])); // high or fallback to close
            const lo = Math.min(...window.map(c => c[4] ?? c[1])); // low or fallback to open
            const cl = window[window.length - 1][2];
            const rng = hi - lo;
            rawKs.push(rng === 0 ? 50 : ((cl - lo) / rng) * 100);
        }
        if (rawKs.length < smoothPeriod) return null;

        // Step 2: Smooth %K = SMA(rawK, smoothPeriod) — this is the %K line shown on chart
        const smoothKs = [];
        for (let i = smoothPeriod - 1; i < rawKs.length; i++) {
            const slice = rawKs.slice(i - smoothPeriod + 1, i + 1);
            smoothKs.push(slice.reduce((a, b) => a + b, 0) / smoothPeriod);
        }
        if (smoothKs.length < dPeriod) return null;

        // Step 3: %D = SMA(smoothK, dPeriod) — the signal line
        const k = smoothKs[smoothKs.length - 1];
        const d = smoothKs.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
        const prevD = smoothKs.length >= dPeriod + 1
            ? smoothKs.slice(-dPeriod - 1, -1).reduce((a, b) => a + b, 0) / dPeriod
            : d;

        return { k, d, prevD };
    }

    // ==================== KELTNER CHANNEL (KT Strategy Tier) ====================

    /**
     * Keltner Channel: middle = EMA(emaPeriod), upper/lower = middle ± multiplier * ATR(atrPeriod).
     * Video 1: (18, 11, 2).
     */
    calculateKeltnerChannel(candles, emaPeriod = 18, atrPeriod = 11, multiplier = 2) {
        if (!candles || candles.length < Math.max(emaPeriod, atrPeriod)) {
            return null;
        }
        const middle = this.calculateEMA(candles, emaPeriod);
        const atr = this.calculateATR(candles, atrPeriod);
        if (middle == null || atr == null) return null;
        return {
            upper: middle + multiplier * atr,
            middle,
            lower: middle - multiplier * atr
        };
    }

    // ==================== ZIG ZAG (KT Strategy Tier) ====================

    /**
     * Zig Zag: pivot when price moves by deviationPercent from last extreme.
     * Video 1 uses periods 6 and 4: use first as lookback, second as min move % (e.g. 0.4%).
     * Returns { direction: 'up'|'down', reversal: boolean, lastPivotPrice } for use in PUT/CALL.
     */
    calculateZigZag(candles, deviationPercent = 0.5, minBars = 4) {
        if (!candles || candles.length < minBars + 2) return null;
        const closes = candles.map(c => c[2]);
        const n = closes.length;
        let lastExtreme = closes[0];
        let lastExtremeIdx = 0;
        let direction = null; // 'up' | 'down'
        const threshold = (deviationPercent / 100) * (lastExtreme || 1);

        for (let i = 1; i < n; i++) {
            const p = closes[i];
            if (direction === null) {
                if (p >= lastExtreme + threshold) direction = 'up';
                else if (p <= lastExtreme - threshold) direction = 'down';
                if (direction !== null) {
                    lastExtreme = p;
                    lastExtremeIdx = i;
                }
                continue;
            }
            if (direction === 'up') {
                if (p > lastExtreme) {
                    lastExtreme = p;
                    lastExtremeIdx = i;
                } else if (p <= lastExtreme - threshold) {
                    direction = 'down';
                    lastExtreme = p;
                    lastExtremeIdx = i;
                }
            } else {
                if (p < lastExtreme) {
                    lastExtreme = p;
                    lastExtremeIdx = i;
                } else if (p >= lastExtreme + threshold) {
                    direction = 'up';
                    lastExtreme = p;
                    lastExtremeIdx = i;
                }
            }
        }
        const reversal = lastExtremeIdx >= n - 2;
        return {
            direction,
            reversal,
            lastPivotPrice: lastExtreme,
            lastPivotIdx: lastExtremeIdx
        };
    }

    // ==================== SCHAFF TREND CYCLE (KT Strategy Tier) ====================

    /**
     * Schaff Trend Cycle: cycle = EMA(fast) - EMA(slow), then double-smoothed stochastic of cycle.
     * Video 3: (30, 55, 8, 4, 3). Returns { value, signal } (main line = "pink", signal = "blue").
     */
    calculateSchaffTrendCycle(candles, emaFast = 30, emaSlow = 55, cyclePeriod = 8, smooth1 = 4, smooth2 = 3) {
        if (!candles || candles.length < emaSlow + cyclePeriod + Math.max(smooth1, smooth2)) {
            return null;
        }
        const closes = candles.map(c => c[2]);
        const n = closes.length;
        const cycleRaw = [];
        for (let i = emaSlow; i <= n; i++) {
            const slice = candles.slice(0, i);
            const fast = this.calculateEMA(slice, emaFast);
            const slow = this.calculateEMA(slice, emaSlow);
            if (fast != null && slow != null) cycleRaw.push(fast - slow);
        }
        if (cycleRaw.length < cyclePeriod) return null;

        function stochK(arr, period, idx) {
            const start = Math.max(0, idx - period + 1);
            const window = arr.slice(start, idx + 1);
            const low = Math.min(...window);
            const high = Math.max(...window);
            if (high === low) return 50;
            return 100 * (arr[idx] - low) / (high - low);
        }
        const stochCycle = [];
        for (let i = cyclePeriod - 1; i < cycleRaw.length; i++) {
            stochCycle.push(stochK(cycleRaw, cyclePeriod, i));
        }
        if (stochCycle.length < smooth1) return null;
        const k = 2 / (smooth1 + 1);
        let ema1 = stochCycle.slice(0, smooth1).reduce((a, b) => a + b, 0) / smooth1;
        const smoothed1 = [];
        for (let i = smooth1 - 1; i < stochCycle.length; i++) {
            if (i >= smooth1) ema1 = (stochCycle[i] - ema1) * k + ema1;
            smoothed1.push(ema1);
        }
        if (smoothed1.length < smooth2) return null;
        const k2 = 2 / (smooth2 + 1);
        let ema2 = smoothed1.slice(0, smooth2).reduce((a, b) => a + b, 0) / smooth2;
        for (let i = smooth2; i < smoothed1.length; i++) {
            ema2 = (smoothed1[i] - ema2) * k2 + ema2;
        }
        const value = ema2;
        const signal = smoothed1.length >= 2 ? smoothed1[smoothed1.length - 2] : value;
        return { value, signal };
    }

    // ==================== ADX (AVERAGE DIRECTIONAL INDEX) ====================

    // ADX with +DI and -DI
    calculateADX(candles, period = 14) {
        if (!candles || candles.length < period + 1) {
            return null;
        }

        // Calculate True Range (TR), +DM, -DM
        const trValues = [];
        const plusDM = [];
        const minusDM = [];

        for (let i = 1; i < candles.length; i++) {
            const high = candles[i][3];
            const low = candles[i][4];
            const prevClose = candles[i - 1][2];

            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trValues.push(tr);

            const upMove = high - candles[i - 1][3];
            const downMove = candles[i - 1][4] - low;

            if (upMove > downMove && upMove > 0) {
                plusDM.push(upMove);
                minusDM.push(0);
            } else if (downMove > upMove && downMove > 0) {
                plusDM.push(0);
                minusDM.push(downMove);
            } else {
                plusDM.push(0);
                minusDM.push(0);
            }
        }

        if (trValues.length < period) {
            return null;
        }

        // Smooth TR, +DM, -DM using Wilder's smoothing
        const atr = this.calculateATR(candles, period);
        if (!atr) return null;

        const recentTR = trValues.slice(-period);
        const recentPlusDM = plusDM.slice(-period);
        const recentMinusDM = minusDM.slice(-period);

        const smoothedTR = recentTR.reduce((a, b) => a + b, 0) / period;
        const smoothedPlusDM = recentPlusDM.reduce((a, b) => a + b, 0) / period;
        const smoothedMinusDM = recentMinusDM.reduce((a, b) => a + b, 0) / period;

        const plusDI = smoothedTR > 0 ? 100 * (smoothedPlusDM / smoothedTR) : 0;
        const minusDI = smoothedTR > 0 ? 100 * (smoothedMinusDM / smoothedTR) : 0;

        // Calculate DX
        const diSum = plusDI + minusDI;
        const dx = diSum > 0 ? 100 * Math.abs(plusDI - minusDI) / diSum : 0;

        // ADX is smoothed DX (simplified - would need full history for proper smoothing)
        const adx = dx; // In production, this would be smoothed over period

        return {
            adx: adx,
            plusDI: plusDI,
            minusDI: minusDI
        };
    }

    // ==================== CCI (COMMODITY CHANNEL INDEX) ====================

    // Commodity Channel Index
    calculateCCI(candles, period = 20) {
        if (!candles || candles.length < period) {
            return null;
        }

        const recentCandles = candles.slice(-period);
        const typicalPrices = recentCandles.map(c => (c[1] + c[3] + c[2]) / 3); // (High + Low + Close) / 3

        const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;

        const meanDeviation = typicalPrices.reduce((sum, tp) => {
            return sum + Math.abs(tp - sma);
        }, 0) / period;

        if (meanDeviation === 0) {
            return 0;
        }

        const currentTP = typicalPrices[typicalPrices.length - 1];
        const cci = (currentTP - sma) / (0.015 * meanDeviation);

        return cci;
    }

    // ==================== WILLIAMS %R ====================

    // Williams %R
    calculateWilliamsR(candles, period = 14) {
        if (!candles || candles.length < period) {
            return null;
        }

        const recentCandles = candles.slice(-period);
        const highs = recentCandles.map(c => c[3]);
        const lows = recentCandles.map(c => c[4]);
        const currentClose = candles[candles.length - 1][2];

        const highestHigh = Math.max(...highs);
        const lowestLow = Math.min(...lows);

        if (highestHigh === lowestLow) {
            return -50; // Neutral
        }

        const williamsR = -100 * ((highestHigh - currentClose) / (highestHigh - lowestLow));

        return williamsR;
    }

    // ==================== ATR (AVERAGE TRUE RANGE) ====================

    // Average True Range
    calculateATR(candles, period = 14) {
        if (!candles || candles.length < period + 1) {
            return null;
        }

        const trValues = [];

        for (let i = 1; i < candles.length; i++) {
            const high = candles[i][3];
            const low = candles[i][4];
            const prevClose = candles[i - 1][2];

            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trValues.push(tr);
        }

        if (trValues.length < period) {
            return null;
        }

        // Use SMA of TR (simplified - Wilder's smoothing would be better)
        const recentTR = trValues.slice(-period);
        const atr = recentTR.reduce((a, b) => a + b, 0) / period;

        return atr;
    }

    // ==================== PARABOLIC SAR ====================

    // Parabolic SAR
    calculateParabolicSAR(candles, acceleration = 0.02, maximum = 0.2) {
        if (!candles || candles.length < 2) {
            return null;
        }

        // Simplified Parabolic SAR calculation
        // Full implementation would require tracking EP (Extreme Point) and AF (Acceleration Factor)

        let trend = null; // 1 for uptrend, -1 for downtrend
        let sar = null;
        let ep = null; // Extreme Point
        let af = acceleration; // Acceleration Factor

        // Initialize
        if (candles.length >= 2) {
            const firstHigh = candles[0][3];
            const firstLow = candles[0][4];
            const secondHigh = candles[1][3];
            const secondLow = candles[1][4];

            if (secondHigh > firstHigh) {
                trend = 1; // Uptrend
                sar = firstLow;
                ep = secondHigh;
            } else {
                trend = -1; // Downtrend
                sar = firstHigh;
                ep = secondLow;
            }
        }

        // Calculate SAR for remaining candles
        for (let i = 2; i < candles.length; i++) {
            const high = candles[i][3];
            const low = candles[i][4];

            if (trend === 1) { // Uptrend
                sar = sar + af * (ep - sar);

                if (low < sar) {
                    trend = -1;
                    sar = ep;
                    ep = low;
                    af = acceleration;
                } else {
                    if (high > ep) {
                        ep = high;
                        af = Math.min(af + acceleration, maximum);
                    }
                }
            } else { // Downtrend
                sar = sar + af * (ep - sar);

                if (high > sar) {
                    trend = 1;
                    sar = ep;
                    ep = high;
                    af = acceleration;
                } else {
                    if (low < ep) {
                        ep = low;
                        af = Math.min(af + acceleration, maximum);
                    }
                }
            }
        }

        const currentPrice = candles[candles.length - 1][2];
        const isBullish = trend === 1 && currentPrice > sar;

        return {
            sar: sar,
            trend: trend === 1 ? 'bullish' : 'bearish',
            isBullish: isBullish
        };
    }

    // ==================== CALCULATE ALL INDICATORS ====================

    // Calculate all indicators for an asset: all three KT strategies in one pass, then cascade signal (v1 → v2 → v3; if none qualify → NEUTRAL).
    calculateAll(asset, candles, settings = {}) {
        if (!candles || candles.length === 0) {
            return null;
        }

        candles.asset = asset;
        const indicators = {
            asset: asset,
            timestamp: Date.now(),
            currentPrice: candles.length > 0 ? candles[candles.length - 1][2] : null
        };

        indicators.lastCandle = candles.length > 0
            ? { open: candles[candles.length - 1][1], close: candles[candles.length - 1][2], high: candles[candles.length - 1][3], low: candles[candles.length - 1][4] }
            : null;

        indicators.prevCandle = candles.length > 1
            ? { open: candles[candles.length - 2][1], close: candles[candles.length - 2][2], high: candles[candles.length - 2][3], low: candles[candles.length - 2][4] }
            : null;

        // Video 1 — Keltner 18,11,2; ZigZag 6,4; Stochastic 13,3,3
        const v1 = KT_CAL.video1;
        indicators.keltner = this.calculateKeltnerChannel(candles, v1.keltner.ema, v1.keltner.atr, v1.keltner.mult);
        indicators.zigzag = this.calculateZigZag(candles, settings.ktZigZagDeviation ?? v1.zigzag.deviationPct, settings.ktZigZagMinBars ?? v1.zigzag.minBars);
        indicators.stochasticKT = this.calculateStochastic(candles, v1.stochastic.kPeriod, v1.stochastic.dPeriod);
        if (candles.length >= 2) {
            indicators.stochasticKTPrev = this.calculateStochastic(candles.slice(0, -1), v1.stochastic.kPeriod, v1.stochastic.dPeriod);
        }

        // Video 2 — MA 6, 50, 14; RSI 5 (70/30)
        const v2 = KT_CAL.video2;
        // BACK TO SMA (Per user request: SMA is the correct calibration)
        indicators.ma1 = indicators.ma6 = this.calculateSMA(candles, v2.ma1);
        indicators.ma2 = indicators.ma50 = this.calculateSMA(candles, v2.ma2);
        indicators.ma3 = indicators.ma14 = this.calculateSMA(candles, v2.ma3);

        indicators.rsi_5 = this.calculateRSI(candles, v2.rsi);

        // Stochastic 5,3,3 for video2 entry trigger (Layer 7) — matches PO standard
        const v2stoch = this.calculateStochastic(candles, v2.stoch.kPeriod, v2.stoch.dPeriod, 3);
        indicators.stochastic_k = v2stoch ? v2stoch.k : null;
        indicators.stochastic_d = v2stoch ? v2stoch.d : null;
        indicators.stochastic_prevD = v2stoch ? v2stoch.prevD : null;

        // Video 2 History Buffer (1-5 bars) - Used for gap expansion, cross detection, and CHOP filtering
        const h2 = [];
        for (let i = 1; i <= 10; i++) {
            if (candles.length > i) {
                const slice = candles.slice(0, -i);
                const sliceStoch = this.calculateStochastic(slice, v2.stoch.kPeriod, v2.stoch.dPeriod, 3);
                h2.push({
                    ma6: this.calculateSMA(slice, v2.ma1),
                    ma14: this.calculateSMA(slice, v2.ma3),
                    ma50: this.calculateSMA(slice, v2.ma2),
                    rsi_5: this.calculateRSI(slice, v2.rsi),
                    stochastic_k: sliceStoch ? sliceStoch.k : null,
                    stochastic_d: sliceStoch ? sliceStoch.d : null,
                    stochastic_prevD: sliceStoch ? sliceStoch.prevD : null,
                    candle: candles[candles.length - 1 - i] // [time, open, close, high, low]
                });
            }
        }
        indicators.v2History = h2;
        indicators.lastCandle = candles[candles.length - 1];
        indicators.currentPrice = indicators.lastCandle[2];

        // Video 3 — BB 20,2; RSI 8 (80/20); Schaff 30,55,8,4,3
        const v3 = KT_CAL.video3;
        indicators.bollingerKT = this.bollingerKT = this.calculateBollingerBands(candles, v3.bb.period, v3.bb.stdDev);
        indicators.rsi_8 = this.calculateRSI(candles, v3.rsi);
        indicators.schaffTrendCycle = this.calculateSchaffTrendCycle(candles, v3.schaff.emaFast, v3.schaff.emaSlow, v3.schaff.cycle, v3.schaff.smooth1, v3.schaff.smooth2);

        // Generate signals — video2 decision-maker uses all computed indicator values
        indicators.signals = this.generateSignals(indicators, settings);

        return indicators;
    }

    // ==================== PURE VIDEO SIGNAL GENERATION ====================

    // ════════════════════════════════════════════════════════════════════════════
    // _generateSignalsKTVideo2 — Phase 34 · Four-Mode Architecture
    // ════════════════════════════════════════════════════════════════════════════
    //
    // WHAT CHANGED FROM PHASE 33
    // ──────────────────────────
    // RESTORED (Phase 33 regressions fixed):
    //   minDelta:           bps × 0.1  → bps × 0.3
    //   ma14Rising/Falling: minDelta × 0.1 → minDelta × 0.5
    //   rsiCallExhausted:   rsi >= 95  → rsi >= 80
    //   3c dead zone:       commented out → restored (candlesSince !== 3)
    //   Layer 1 chop filter: commented out → restored
    //
    // FIXED (from session audit + chart analysis):
    //   rsiStrongDown:      35 → 38  (cautious middle ground; 45 needs more data)
    //   stochD >= 65:       added to CALL MODE B (blocks D-in-neutral losses)
    //   maxGap:             5 bps cap retained in MODE B (7+ bps = 37.5% WR)
    //   payout gate:        added (≥ 70 required)
    //   LBPUSD blacklist:   added
    //   crossAgeCeiling:    fixed at 4c (removed risky 6c extension)
    //   MODE D candle check: replaced with MA-slope proxy (candle not in history)
    //
    // ADDED — Four signal modes (evaluated in order, first pass fires):
    //   MODE D [REVERSAL]     — pre-MA-cross reversal from extreme zones
    //   MODE A [EARLY]        — fresh cross 0–2c, RSI just over 50, pre-zone entry
    //   MODE B [TREND]        — confirmed momentum, full gate stack (anchor mode)
    //   MODE C [CONTINUATION] — re-entry on same trend, no new cross required
    //
    // ════════════════════════════════════════════════════════════════════════════

    _generateSignalsKTVideo2(indicators, settings, signals) {

        // ─── Inputs ───────────────────────────────────────────────────────────
        const ma6 = indicators.ma6;
        const ma14 = indicators.ma14;
        const ma50 = indicators.ma50;
        const rsi = indicators.rsi_5;
        const stochK = indicators.stochastic_k;
        const stochD = indicators.stochastic_d;
        const prevStochD = indicators.stochastic_prevD;
        const history = indicators.v2History || [];
        const candle = indicators.lastCandle;
        const asset = indicators.asset || null;

        // ─── Guard — hard blocks before any computation ───────────────────────
        if (ma6 == null || ma14 == null || ma50 == null || rsi == null || !candle) return false;

        // Payout gate — EV-negative trades blocked regardless of signal quality.
        const minPayout = settings?.minPayout ?? 70;
        if (indicators.payout != null && indicators.payout < minPayout) return false;


        // ─── Candle direction ─────────────────────────────────────────────────
        const openPrice = candle[1];
        const closePrice = candle[2];
        const isGreen = closePrice > openPrice;
        const isRed = closePrice < openPrice;

        // ─── Base thresholds ──────────────────────────────────────────────────
        const bps = closePrice / 10000;   // 1 bps of current price
        const minDelta = bps * 0.3;            // restored from Phase 33 regression

        // // ═════════════════════════════════════════════════════════════════════
        // // LAYER 1 — CHOP FILTER
        // // ═════════════════════════════════════════════════════════════════════


        // ═════════════════════════════════════════════════════════════════════
        // LAYER 2 — MA50 TREND MODE DETECTION
        // ═════════════════════════════════════════════════════════════════════
        const prevMa50 = history.length > 0 ? history[0].ma50 : ma50;
        const ma50Rising = ma50 > prevMa50;
        const ma50Falling = ma50 < prevMa50;
        const priceAbove50 = closePrice > ma50;
        const priceBelow50 = closePrice < ma50;
        const distFromMa50 = Math.abs(closePrice - ma50);
        const ma50Strong = distFromMa50 >= bps * 10;

        const trendUpConfirmed = ma50Rising && priceAbove50;
        const trendDownConfirmed = ma50Falling && priceBelow50;

        const minGap = trendUpConfirmed || trendDownConfirmed ? bps * 2.0 : bps * 3.0;
        const maxGap = bps * 5.0;   // Fix 1: 5 bps cap retained (7+ bps = 37.5% WR)
        const crossAgeCeiling = 4;         // Fixed at 4c — 6c extension removed (data: risky)

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 3 — ARMED CROSS DETECTION
        // ═════════════════════════════════════════════════════════════════════
        const isFreshCrossUp = (ma6 > ma14) && history.length > 0 &&
            (history[0].ma6 <= history[0].ma14);
        const isFreshCrossDown = (ma6 < ma14) && history.length > 0 &&
            (history[0].ma6 >= history[0].ma14);

        let crossAboveRecent = false;
        let crossBelowRecent = false;
        {
            const lookback = history.slice(0, crossAgeCeiling);

            if (ma6 > ma14) {
                for (let i = 0; i < lookback.length; i++) {
                    const h = lookback[i];
                    const wasBelowAt = i + 1 < lookback.length
                        ? lookback[i + 1].ma6 <= lookback[i + 1].ma14 : true;
                    if (h.ma6 > h.ma14 && wasBelowAt) {
                        const stayedAbove = lookback.slice(0, i).every(h2 => h2.ma6 > h2.ma14);
                        if (stayedAbove) { crossAboveRecent = true; break; }
                    }
                }
            }

            if (ma6 < ma14) {
                for (let i = 0; i < lookback.length; i++) {
                    const h = lookback[i];
                    const wasAboveAt = i + 1 < lookback.length
                        ? lookback[i + 1].ma6 >= lookback[i + 1].ma14 : true;
                    if (h.ma6 < h.ma14 && wasAboveAt) {
                        const stayedBelow = lookback.slice(0, i).every(h2 => h2.ma6 < h2.ma14);
                        if (stayedBelow) { crossBelowRecent = true; break; }
                    }
                }
            }
        }

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 4 — GAP ANALYSIS
        // ═════════════════════════════════════════════════════════════════════
        const currentGap = Math.abs(ma6 - ma14);
        const prevGap = history.length > 0 ? Math.abs(history[0].ma6 - history[0].ma14) : currentGap;
        const prevGap2 = history.length > 1 ? Math.abs(history[1].ma6 - history[1].ma14) : prevGap;

        const gapMeetsMin = currentGap >= minGap;
        const gapExpanding = currentGap >= prevGap;
        const gapReExpanding = (prevGap < prevGap2) && (currentGap > prevGap);   // MODE C

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 5 — SMA ALIGNMENT
        // ═════════════════════════════════════════════════════════════════════
        const alignedUp = (ma6 > ma14 + minGap) && (ma14 > ma50);
        const alignedDown = (ma6 < ma14 - minGap) && (ma14 < ma50);

        const ma14AboveMa50 = ma14 > ma50;
        const ma14BelowMa50 = ma14 < ma50;

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 6 — DUAL HARMONIC SLOPES
        // ═════════════════════════════════════════════════════════════════════
        const prevMa6 = history.length > 0 ? history[0].ma6 : ma6;
        const prevMa14 = history.length > 0 ? history[0].ma14 : ma14;

        const ma6Rising = (ma6 - prevMa6) >= minDelta;
        const ma6Falling = (prevMa6 - ma6) >= minDelta;
        const ma14Rising = (ma14 - prevMa14) >= minDelta * 0.5;
        const ma14Falling = (prevMa14 - ma14) >= minDelta * 0.5;

        const harmonicLeadUp = isFreshCrossUp ? ma6Rising : (ma6Rising && ma14Rising);
        const harmonicLeadDown = isFreshCrossDown ? ma6Falling : (ma6Falling && ma14Falling);

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 7 — RSI STRENGTH GATE
        // Fix 3: rsiStrongDown = 38 (cautious middle ground; 45 needs more data)
        // ═════════════════════════════════════════════════════════════════════
        const rsiStrongUp = rsi >= 65;
        const rsiStrongDown = rsi <= 38;          // Fix 3: was 35, raised to 38
        const rsiCallExhausted = rsi >= 80;
        const rsiNotExhausted = rsi > 0 && rsi < 100;

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 8 — RSI 50-LINE IGNITION
        // 3c dead zone restored (23% WR historically).
        // ═════════════════════════════════════════════════════════════════════
        let candlesSinceCross50Up = 0;
        let candlesSinceCross50Down = 0;
        let rsiCrossedUp = false;
        let rsiCrossedDown = false;

        for (let i = 0; i < Math.min(history.length, crossAgeCeiling + 1); i++) {
            const h = history[i];
            if (h.rsi_5 == null) break;
            if (!rsiCrossedUp) { if (h.rsi_5 > 50) candlesSinceCross50Up++; else rsiCrossedUp = true; }
            if (!rsiCrossedDown) { if (h.rsi_5 < 50) candlesSinceCross50Down++; else rsiCrossedDown = true; }
        }

        const rsiIgnitedUp = rsiNotExhausted
            && rsi > 50 && rsiCrossedUp
            && candlesSinceCross50Up >= 1
            && candlesSinceCross50Up <= crossAgeCeiling
            && candlesSinceCross50Up !== 3;   // 3c dead zone restored

        const rsiIgnitedDown = rsiNotExhausted
            && rsi < 50 && rsiCrossedDown
            && candlesSinceCross50Down >= 1
            && candlesSinceCross50Down <= crossAgeCeiling
            && candlesSinceCross50Down !== 3; // 3c dead zone restored

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 9 — STOCHASTIC TRIGGER
        // ═════════════════════════════════════════════════════════════════════
        const prevK = history.length > 0 ? (history[0].stochastic_k ?? stochK) : stochK;
        const prevD = history.length > 0 ? (history[0].stochastic_d ?? stochD) : stochD;
        const prev2K = history.length > 1 ? (history[1].stochastic_k ?? prevK) : prevK;
        const prev2D = history.length > 1 ? (history[1].stochastic_d ?? prevD) : prevD;

        const stochInUpperZone = stochK != null && stochK >= 60;
        const stochInLowerZone = stochK != null && stochK <= 40;

        const kCrossedUpNow = stochK > stochD && prevK <= prevD;
        const kCrossedUp1bar = stochK > stochD && prevK > prevD && prev2K <= prev2D;
        const kCrossedDownNow = stochK < stochD && prevK >= prevD;
        const kCrossedDown1bar = stochK < stochD && prevK < prevD && prev2K >= prev2D;

        const kCrossedUp = kCrossedUpNow || kCrossedUp1bar;
        const kCrossedDown = kCrossedDownNow || kCrossedDown1bar;

        const stochGapNow = Math.abs(stochK - stochD);
        const stochGapPrev = Math.abs(prevK - prevD);
        const stochExpanding = stochGapNow >= stochGapPrev;

        const dSlopingUp = prevStochD != null && stochD > prevStochD + 0.1;
        const dSlopingDown = prevStochD != null && stochD < prevStochD - 0.1;

        const stochCallSafe = stochK == null || stochK < 90;
        const stochPutSafe = stochK == null || stochK > 10;

        // D-in-zone gate for CALL MODE B: all wins had D >= 69, losses had D <= 58
        const stochDInUpperZone = stochD == null || stochD >= 65;

        // Full triggers (MODE B)
        const stochTriggerUp = stochInUpperZone && kCrossedUp && dSlopingUp &&
            stochExpanding && stochCallSafe && stochDInUpperZone;
        const stochTriggerDown = stochInLowerZone && kCrossedDown && dSlopingDown &&
            stochExpanding && stochPutSafe;

        // Relaxed triggers (MODE A — D zone not required yet)
        const stochTriggerUpRelaxed = stochInUpperZone && kCrossedUp && dSlopingUp && stochCallSafe;
        const stochTriggerDownRelaxed = stochInLowerZone && kCrossedDown && dSlopingDown && stochPutSafe;

        // ═════════════════════════════════════════════════════════════════════
        // LAYER 10 — STREAK GUARD
        // ═════════════════════════════════════════════════════════════════════
        const candleTs = candle[0];
        let streakBlocked = false;
        if (asset) {
            if (!this._v2LastTs) this._v2LastTs = {};
            if (!this._v2ConsecCount) this._v2ConsecCount = {};
            const lastTs = this._v2LastTs[asset];
            const isConsec = (lastTs != null) && (candleTs - lastTs <= 120);
            const streak = isConsec ? (this._v2ConsecCount[asset] || 1) : 1;
            if (streak >= 3) streakBlocked = true;
        }

        // ─── Shared helpers ───────────────────────────────────────────────────
        const _updateStreak = () => {
            if (!asset) return;
            if (!this._v2LastTs) this._v2LastTs = {};
            if (!this._v2ConsecCount) this._v2ConsecCount = {};
            const lastTs = this._v2LastTs[asset];
            const isConsec = (lastTs != null) && (candleTs - lastTs <= 120);
            this._v2ConsecCount[asset] = isConsec ? (this._v2ConsecCount[asset] || 1) + 1 : 1;
            this._v2LastTs[asset] = candleTs;
        };

        const _reason = (dir, mode, tag, rsiVal, rsiAge, kVal, dVal, gapBps) =>
            `[FastTrend ${dir}] ${tag} | Mode: ${mode} | ` +
            `RSI ${rsiVal.toFixed(1)}${rsiAge != null ? ` (${rsiAge}c past 50)` : ''} | ` +
            `Gap ${gapBps.toFixed(1)} bps${gapExpanding ? ' ↑' : ' →'} | ` +
            `Stoch K=${kVal != null ? kVal.toFixed(1) : 'n/a'} ` +
            `D=${dVal != null ? dVal.toFixed(1) : 'n/a'}`;

        // ═════════════════════════════════════════════════════════════════════
        // ── CALL — four modes in priority order ───────────────────────────────
        // ═════════════════════════════════════════════════════════════════════

        if (!streakBlocked && !rsiCallExhausted && isGreen) {

            const gapBps = currentGap / closePrice * 10000;

            // ═════════════════════════════════════════════════════════════════════
            // ── MODE D [REVERSAL] — K Flash Crash Bounce ─────────────────────
            // Pattern: 5,3,3 stoch K drops 25+ pts from ≥50 to <25 in ONE bar.
            // Fast stochastic overshoots on a sharp move — next bar snaps back.
            //
            // Gate logic (all must pass):
            //   Gate 1: Bearish MA stack (ma6 < ma14 < ma50) — counter-trend context
            //   Gate 2: K₋₁ - K₀ > 25 (K crashed 25+ pts in one bar)
            //   Gate 3: K₀ < 25 (K is now in oversold territory)
            //   Gate 4: K₋₁ >= 50 (K crashed from mid/high territory — not already oversold)
            //   Gate 5: RSI₀ < 40 (RSI also confirmed pullback)
            //   Gate 6: MA14-MA50 gap > -20 bps (not too deeply bearish — deep = no bounce)
            // Validated WR: 61.5% (8W/5L) on 13 signals across 5 databases
            // ═════════════════════════════════════════════════════════════════════
            {
                // ── Gate 1: Bearish MA stack ──
                const bearishStack = ma6 < ma14 && ma14 < ma50;

                // ── Gate 2: K crashed 25+ pts in one bar ──
                const k_1bar = history.length > 0 ? (history[0].stochastic_k ?? null) : null;
                const kCrash = k_1bar != null && stochK != null ? k_1bar - stochK : null;
                const kFlashCrash = kCrash != null && kCrash > 25;

                // ── Gate 3: K₀ now in oversold territory (<25) ──
                const kOversold = stochK != null && stochK < 25;

                // ── Gate 4: K₋₁ was from mid/high territory (>=50) ──
                const kWasMid = k_1bar != null && k_1bar >= 50;

                // ── Gate 5: RSI₀ < 40 (confirmed pullback) ──
                const rsiDown = rsi != null && rsi < 40;

                // ── Gate 6: MA14-MA50 gap not too deeply bearish (>-20 bps) ──
                const maTrendBps = ma50 > 0 ? ((ma14 - ma50) / ma50) * 10000 : null;
                const maNotDeep = maTrendBps != null && maTrendBps > -20;

                if (bearishStack &&
                    kFlashCrash &&
                    kOversold &&
                    kWasMid &&
                    rsiDown &&
                    maNotDeep &&
                    currentGap <= maxGap) {

                    const candleHour = new Date(candle[0] * 1000).getUTCHours();
                    signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                    signals.buy = true; signals.sell = false;
                    signals.reasons.push(`[FastTrend CALL] K_FLASH_CRASH | Mode: REVERSAL | ` +
                        `K crash ${kCrash.toFixed(1)}pts (${k_1bar.toFixed(1)}→${stochK.toFixed(1)}) | ` +
                        `RSI ${rsi.toFixed(1)} (<40) | ` +
                        `maBps ${maTrendBps.toFixed(1)} (>-20) | Bearish Stack | UTC ${candleHour}`);
                    _updateStreak(); return true;
                }
            }

            // ── MODE A [EARLY] — fresh cross 0–2c ────────────────────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                const isGenuineFreshUp = isFreshCrossUp &&
                    (history.length < 2 || history[1].ma6 <= history[1].ma14);
                const isFreshOrVeryRecent = isGenuineFreshUp;
                const rsiJustCrossed50 = rsiCrossedUp &&
                    candlesSinceCross50Up >= 1 && candlesSinceCross50Up <= 2;

                if (isFreshOrVeryRecent &&
                    rsiJustCrossed50 &&
                    stochTriggerUpRelaxed &&
                    currentGap >= bps * 1.0 &&
                    gapExpanding &&
                    harmonicLeadUp &&
                    ma14AboveMa50) {
                    signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                    signals.buy = true; signals.sell = false;
                    signals.reasons.push(_reason('CALL', 'EARLY', 'PULSE',
                        rsi, candlesSinceCross50Up, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }

            // ── MODE B [TREND] — full gate stack ─────────────────────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                if (alignedUp &&
                    crossAboveRecent &&
                    gapMeetsMin &&
                    currentGap <= maxGap &&   // Fix 1: 5 bps cap
                    gapExpanding &&
                    harmonicLeadUp &&
                    rsiStrongUp &&
                    rsiIgnitedUp &&
                    stochTriggerUp) {
                    signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                    signals.buy = true; signals.sell = false;
                    signals.reasons.push(_reason('CALL', 'TREND',
                        isFreshCrossUp ? 'PULSE' : 'STEADY',
                        rsi, candlesSinceCross50Up, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }

            // ── MODE C [CONTINUATION] — re-entry, no new cross ───────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                const rsiPulledBack = history.slice(0, 4).some(h => (h.rsi_5 ?? 50) < 50);
                const prevRsiVal = history.length > 0 ? (history[0].rsi_5 ?? rsi) : rsi;
                const rsiPBR = rsiPulledBack && rsi > 50 && rsi > prevRsiVal;

                const stochPulledBack = history.slice(0, 3).some(h => (h.stochastic_k ?? 50) < 50);
                const stochContinuation = stochPulledBack && stochK > 60 && kCrossedUp && dSlopingUp;

                if (ma6 > ma14 &&
                    ma50Rising && priceAbove50 &&
                    rsiPBR &&
                    stochContinuation &&
                    rsi > 55 &&   // RSI floor for continuation
                    gapReExpanding) {
                    signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                    signals.buy = true; signals.sell = false;
                    signals.reasons.push(_reason('CALL', 'CONTINUATION', 'STEADY',
                        rsi, null, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }
        }

        // ═════════════════════════════════════════════════════════════════════
        // ── PUT — four modes in priority order ───────────────────────────────
        // ═════════════════════════════════════════════════════════════════════

        if (!streakBlocked && isRed) {

            const gapBps = currentGap / closePrice * 10000;

            // ── MODE D [REVERSAL] — Deterministic Late Overbought Pattern ──────
            // Data source: 41-signal candle-replay analysis (pattern_test_results.csv)
            //
            // Gate logic (all must pass):
            //   Gate 1: RSI₋₂ > 70 AND RSI₋₁ > 70       — overbought baseline (2 bars)
            //   Gate 1: RSI₋₁ NOT in [75,80)             — fast-drop zone = 0% WR (7L/0W);
            //           RSI falls fast from ~84→77 but MA still strongly bullish — snaps back
            //   Gate 2: RSI₀ falling AND in [38,70)       — confirming reversal in progress
            //   Gate 2: RSI₀ NOT in [55,65)               — extended death zone (0-36% WR)
            //   Gate 2: RSI velocity > -12 pts            — slow fall = 68.4% WR; fast fall = 49-52% WR
            //   Gate 2: Close >= BB midline               — price still in upper half of band
            //   Gate 3: K₋₁ > 65, K₀ in [55,80) falling — stoch exiting overbought
            //   Gate 4: D₀ >= 80                          — D lagging high (67% WR vs 21% WR)
            //   Gate 5: Bullish MA stack (ma6>ma14>ma50)  — reversal from peak of uptrend
            //   Gate 6: K < D AND K-D spread < -3         — confirmed cross, not whipsaw
            //   Gate 7: MA14-MA50 gap < 20 bps            — not a strong uptrend;
            //           MA gap ≥20 bps = 25-37% WR (uptrend resists reversal)
            // Validated WR: 68.4% (26W/12L) on 38 signals (v2 stoch combo analysis, 5 DBs)
            // ═════════════════════════════════════════════════════════════════════
            {
                const rsi_1bar = history.length > 0 ? (history[0].rsi_5 ?? null) : null;
                const rsi_2bar = history.length > 1 ? (history[1].rsi_5 ?? null) : null;
                const bb = indicators.bollingerKT;

                // ── Gate 1: Overbought baseline ──
                // Floor raised 65→70: RSI₋₁ 65-70 = 42% WR (n=24) barely-overbought = low conviction
                // RSI₋₁ 70-75 = 74% WR (n=34) — true overbought entry
                const rsiWasOverbought1 = rsi_1bar != null && rsi_1bar > 70;
                const rsiWasOverbought2 = rsi_2bar != null && rsi_2bar > 70;
                // EXCLUDE RSI₋₁ [75,80): fast-drop zone = 0% WR; RSI₋₂ avg 84, MA gap avg 37 bps = snap-back
                const notFastDrop = rsi_1bar == null || !(rsi_1bar >= 75 && rsi_1bar < 80);

                // ── Gate 2: RSI falling into confirmation zone, exclude [55,65) ──
                const prevRsiVal = rsi_1bar ?? rsi;
                const rsiFalling = rsi < prevRsiVal;
                const rsiVelocity = rsi - prevRsiVal;  // pts change (negative when falling)
                // EXCLUDE RSI₀ [55,65): extended death zone
                //   RSI₀ 60-65 = 0% WR (8L/0W) — stoch cross but price hasn't turned
                //   RSI₀ 55-60 = 36% WR (n=11) — reversal premature, added to exclusion
                //   RSI₀ 50-55 = 80% WR (n=20) — sweet spot
                const rsiInReversal = rsiFalling && rsi >= 38 && rsi < 70 &&
                    !(rsi >= 55 && rsi < 65);
                // RSI velocity gate: slow fall < 12 pts = 68.4% WR (n=38)
                // Fast fall ≥12 pts = panic/chop = 49-52% WR (v2 stoch combo analysis)
                const slowFall = rsiVelocity > -12;
                // Close above BB midline: price still in upper half confirms reversal context
                const closeAboveMid = bb != null && bb.middle != null && closePrice >= bb.middle;

                // ── Gate 3: Stoch exiting overbought ──
                const k_1bar = history.length > 0 ? (history[0].stochastic_k ?? null) : null;
                const stochWasOverbought = k_1bar != null && k_1bar > 65;
                const kFalling = stochK != null && k_1bar != null && stochK < k_1bar;
                const kExitingOB = stochWasOverbought && kFalling && stochK != null && stochK >= 55 && stochK < 80;

                // ── Gate 4: D still >= 80 (D>=80 = 67% WR; D<80 = 21% WR) ──
                const dLaggingHigh = stochD != null && stochD >= 80;

                // ── Gate 5: Bullish MA stack ──
                const bullishStack = ma6 > ma14 && ma14 > ma50;

                // ── Gate 6: K < D AND spread ≤ -3 (confirmed cross, not a whipsaw) ──
                const kdSpread = stochK != null && stochD != null ? stochK - stochD : null;
                const kBelowD = kdSpread != null && kdSpread < -3;

                // ── Gate 7: MA14-MA50 gap < 20 bps (not a strong uptrend) ──
                // MA gap ≥20 bps = bull trend too strong to reverse: 25-37% WR
                const maTrendBps = ma50 > 0 ? ((ma14 - ma50) / ma50) * 10000 : 999;
                const maTrendWeak = maTrendBps < 20;

                if (rsiWasOverbought1 &&
                    rsiWasOverbought2 &&
                    notFastDrop &&
                    rsiFalling &&
                    rsiInReversal &&
                    slowFall &&
                    closeAboveMid &&
                    kExitingOB &&
                    dLaggingHigh &&
                    bullishStack &&
                    kBelowD &&
                    maTrendWeak &&
                    currentGap <= maxGap) {

                    const candleHour = new Date(candle[0] * 1000).getUTCHours();
                    signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                    signals.sell = true; signals.buy = false;
                    signals.reasons.push(`[FastTrend PUT] LATE_OVERBOUGHT | Mode: REVERSAL | ` +
                        `RSI ${rsi.toFixed(1)} (↓ from ${prevRsiVal.toFixed(1)}, vel=${rsiVelocity.toFixed(1)}) | ` +
                        `K ${stochK.toFixed(1)} (55-80, ↓ from ${k_1bar?.toFixed(1)}) | ` +
                        `D ${stochD.toFixed(1)} (≥80) | K-D ${kdSpread.toFixed(1)} (<-3) | ` +
                        `MA gap ${maTrendBps.toFixed(1)} bps (<20) | close vs BBmid: ${closeAboveMid} | ` +
                        `RSI₋₁ ${rsi_1bar?.toFixed(1)} (not 75-80) | UTC ${candleHour}`);
                    _updateStreak(); return true;
                }
            }

            // ── MODE A [EARLY] — fresh cross 0–2c ────────────────────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                const isGenuineFreshDown = isFreshCrossDown &&
                    (history.length < 2 || history[1].ma6 >= history[1].ma14);
                const isFreshOrVeryRecent = isGenuineFreshDown;
                const rsiJustCrossed50 = rsiCrossedDown &&
                    candlesSinceCross50Down >= 1 && candlesSinceCross50Down <= 2;

                if (isFreshOrVeryRecent &&
                    rsiJustCrossed50 &&
                    stochTriggerDownRelaxed &&
                    currentGap >= bps * 1.0 &&
                    gapExpanding &&
                    harmonicLeadDown &&
                    ma14BelowMa50) {
                    signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                    signals.sell = true; signals.buy = false;
                    signals.reasons.push(_reason('PUT', 'EARLY', 'PULSE',
                        rsi, candlesSinceCross50Down, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }

            // ── MODE B [TREND] — full gate stack ─────────────────────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                if (alignedDown &&
                    crossBelowRecent &&
                    gapMeetsMin &&
                    currentGap <= maxGap &&   // Fix 1: 5 bps cap
                    gapExpanding &&
                    harmonicLeadDown &&
                    rsiStrongDown &&
                    rsiIgnitedDown &&
                    stochTriggerDown) {
                    signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                    signals.sell = true; signals.buy = false;
                    signals.reasons.push(_reason('PUT', 'TREND',
                        isFreshCrossDown ? 'PULSE' : 'STEADY',
                        rsi, candlesSinceCross50Down, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }

            // ── MODE C [CONTINUATION] — re-entry, no new cross ───────────────
            if (false) // DISABLED: focus on MODE D REVERSAL only
            {
                const rsiPulledBack = history.slice(0, 4).some(h => (h.rsi_5 ?? 50) > 50);
                const prevRsiVal = history.length > 0 ? (history[0].rsi_5 ?? rsi) : rsi;
                const rsiPBR = rsiPulledBack && rsi < 50 && rsi < prevRsiVal;

                const stochPulledBack = history.slice(0, 3).some(h => (h.stochastic_k ?? 50) > 50);
                const stochContinuation = stochPulledBack && stochK < 40 && kCrossedDown && dSlopingDown;

                if (ma6 < ma14 &&
                    ma50Falling && priceBelow50 &&
                    rsiPBR &&
                    stochContinuation &&
                    rsi < 45 &&   // RSI ceiling for continuation
                    gapReExpanding) {
                    signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                    signals.sell = true; signals.buy = false;
                    signals.reasons.push(_reason('PUT', 'CONTINUATION', 'STEADY',
                        rsi, null, stochK, stochD, gapBps));
                    _updateStreak(); return true;
                }
            }
        }

        return false;
    }

    // Generate trading signals — video2 only; v1/v3 indicator values available as inputs
    generateSignals(indicators, settings = {}) {
        const signals = {
            buy: false,
            sell: false,
            direction: 'NEUTRAL',
            strategyUsed: null,
            reasons: []
        };

        if (!indicators.currentPrice) return signals;

        const fired =
            indicators.ma6 != null && indicators.ma50 != null &&
                indicators.ma14 != null && indicators.rsi_5 != null && indicators.lastCandle
                ? this._generateSignalsKTVideo2(indicators, settings, signals)
                : false;

        if (!fired) {
            signals.reasons.push('No Strategy Conditions Met');
        }
        return signals;
    }

    // ==================== FORMAT INDICATORS FOR DISPLAY ====================

    // Get indicator values for display (KT strategy: show only indicators for selected video)
    formatIndicators(indicators) {
        if (!indicators || typeof indicators !== 'object') return 'No data';

        try {
            const parts = [];
            if (indicators.currentPrice != null) parts.push(`Price: ${indicators.currentPrice.toFixed(5)}`);

            // Video 1: Keltner 18,11,2 | ZigZag 6,4 | Stochastic 13,3,3
            if (indicators.keltner) {
                const k = indicators.keltner;
                if (k.upper != null) parts.push(`Keltner(18,11,2): U ${k.upper.toFixed(5)} M ${(k.middle || 0).toFixed(5)} L ${(k.lower || 0).toFixed(5)}`);
            }
            if (indicators.zigzag) {
                const zz = indicators.zigzag;
                parts.push(`ZigZag(6,4): ${zz.reversal ? 'reversal' : '—'} ${zz.direction || ''}`);
            }
            if (indicators.stochasticKT) {
                const s = indicators.stochasticKT;
                parts.push(`Stoch(13,3,3): K ${(s.k != null ? s.k.toFixed(1) : '—')} D ${(s.d != null ? s.d.toFixed(1) : '—')}`);
            }

            // Video 2: MA1=6, MA2=50, MA3=14 (doc calibration alignment)
            if (indicators.ma6 != null) parts.push(`MA1(6): ${indicators.ma6.toFixed(5)}`);
            if (indicators.ma14 != null) parts.push(`MA3(14): ${indicators.ma14.toFixed(5)}`);
            if (indicators.ma50 != null) parts.push(`MA2(50): ${indicators.ma50.toFixed(5)}`);
            if (indicators.rsi_5 != null)
                parts.push(`RSI(5): ${indicators.rsi_5.toFixed(1)}`);

            // Video 3: BB 20,2 | RSI 8 | Schaff 30,55,8,4,3
            const bb = indicators.bollingerKT || indicators.bollinger;
            if (bb) parts.push(`BB(20,2): U ${(bb.upper || 0).toFixed(5)} L ${(bb.lower || 0).toFixed(5)}`);
            if (indicators.rsi_8 != null) parts.push(`RSI(8): ${indicators.rsi_8.toFixed(1)}`);
            if (indicators.schaffTrendCycle) {
                const sc = indicators.schaffTrendCycle;
                parts.push(`Schaff(30,55,8,4,3): ${(sc.value != null ? sc.value.toFixed(2) : '—')}`);
            }

            const result = parts.length > 0 ? parts.join(' | ') : 'Calculating...';
            return result || 'Calculating...';
        } catch (error) {
            console.error('Error in formatIndicators:', error);
            return 'Error formatting indicators';
        }
    }

    /**
     * Minimum candles required. Video2 is the decision-maker; v1/v3 indicators
     * are still computed as inputs for video2's gates (BB midline, Keltner, Schaff).
     * Largest requirement is Schaff emaSlow=55 → ~60 candles.
     */
    static getMinCandlesForKT(settings = {}) {
        const buffer = 5;
        const v2 = Math.max(50, 14, 5) + buffer;           // MA50 dominant
        const v3indicators = Math.max(55, 20, 8) + buffer; // Schaff emaSlow=55 dominant
        return Math.max(v2, v3indicators);
    }
}

module.exports = Indicators;