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
    // _generateSignalsKTVideo2 - 4 patterns: Reversal + Continuation
    //
    // CALL Reversal (MA-independent): K crash 20+pts into <30 from >=50, RSI <45,
    //   price near lower BB, BB stable/contracting, 3-bar lookback confirms
    // PUT Reversal (MA-independent): RSI >70x2 (not 75-80), RSI falling [38,70) not [55,65),
    //   velocity >-15, close >= BB mid, K exiting OB, D >=75, K-D <-3, 3-bar lookback confirms
    // CALL Continuation (pre-cross): MA6<MA14 converging, RSI>50 rising, Stoch>30 rising, 3-bar lookback
    // PUT Continuation (pre-cross): MA6>MA14 converging, RSI falling from >50, Stoch<70 falling, 3-bar lookback
    //
    _generateSignalsKTVideo2(indicators, settings, signals) {
        const ma6 = indicators.ma6;
        const ma14 = indicators.ma14;
        // const ma50 = indicators.ma50; //NOT CURRENTLY IN USE
        const rsi = indicators.rsi_5;
        const stochK = indicators.stochastic_k;
        const stochD = indicators.stochastic_d;
        const prevStochD = indicators.stochastic_prevD;
        const history = indicators.v2History || [];
        const candle = indicators.lastCandle;
        const bb = indicators.bollingerKT;
        const asset = indicators.asset || null;

        if (ma6 == null || ma14 == null || rsi == null || !candle) return false;

        const minPayout = settings?.minPayout ?? 70;
        if (indicators.payout != null && indicators.payout < minPayout) return false;

        const openPrice = candle[1];
        const closePrice = candle[2];
        const isGreen = closePrice > openPrice;
        const isRed = closePrice < openPrice;
        const bps = closePrice / 10000;
        const maxGap = bps * 5.0;
        const currentGap = Math.abs(ma6 - ma14);
        const candleTs = candle[0];

        // History lookups
        const ma6_1 = history.length > 0 ? history[0].ma6 : ma6;
        const ma14_1 = history.length > 0 ? history[0].ma14 : ma14;
        const rsi_1 = history.length > 0 ? (history[0].rsi_5 ?? rsi) : rsi;
        const rsi_2 = history.length > 1 ? (history[1].rsi_5 ?? rsi_1) : rsi_1;
        const rsi_3 = history.length > 2 ? (history[2].rsi_5 ?? rsi_2) : rsi_2;
        const k_1 = history.length > 0 ? (history[0].stochastic_k ?? stochK) : stochK;
        const k_2 = history.length > 1 ? (history[1].stochastic_k ?? k_1) : k_1;
        const k_3 = history.length > 2 ? (history[2].stochastic_k ?? k_2) : k_2;
        const d_1 = history.length > 0 ? (history[0].stochastic_d ?? stochD) : stochD;
        const d_2 = history.length > 1 ? (history[1].stochastic_d ?? stochD) : stochD;
        const d_3 = history.length > 2 ? (history[2].stochastic_d ?? stochD) : stochD;

        // MA convergence rates
        const ma6Delta = ma6 - ma6_1;
        const ma14Delta = ma14 - ma14_1;
        const ma6Rising = ma6Delta > 0;
        const ma6Falling = ma6Delta < 0;
        const rsiRising = rsi > rsi_1;
        const rsiFalling = rsi < rsi_1;
        const rsiVelocity = rsi - rsi_1;
        const kRising = stochK != null && k_1 != null && stochK > k_1;
        const kFalling = stochK != null && k_1 != null && stochK < k_1;

        // BB state
        const bbWidth = bb != null && bb.upper != null && bb.lower != null && bb.middle
            ? (bb.upper - bb.lower) / bb.middle : 0;
        const bbWidth_1 = history.length > 0 && history[0].bb_upper != null && history[0].bb_lower != null && history[0].bb_middle
            ? (history[0].bb_upper - history[0].bb_lower) / history[0].bb_middle : bbWidth;
        const bbWidth_2 = history.length > 1 && history[1].bb_upper != null && history[1].bb_lower != null && history[1].bb_middle
            ? (history[1].bb_upper - history[1].bb_lower) / history[1].bb_middle : bbWidth;
        const bbStable = bbWidth > 0 && bbWidth_1 > 0 && bbWidth_2 > 0
            ? Math.abs(bbWidth - bbWidth_1) / bbWidth < 0.05 && Math.abs(bbWidth_1 - bbWidth_2) / bbWidth_1 < 0.05
            : true;
        const bbWidthBps = bbWidth * 10000;
        const bbWidthSufficient = bbWidthBps >= 10; // < 10 bps = flat/dead market, 45.8% WR → losing zone
        const closeAboveMid = bb != null && bb.middle != null && closePrice >= bb.middle;
        const closeBelowMid = bb != null && bb.middle != null && closePrice < bb.middle;
        const priceNearLowerBB = bb != null && bb.lower != null
            ? closePrice <= bb.lower + (bb.upper - bb.lower) * 0.15
            : false;

        // Streak guard
        let streakBlocked = false;
        if (asset) {
            if (!this._v2LastTs) this._v2LastTs = {};
            if (!this._v2ConsecCount) this._v2ConsecCount = {};
            const lastTs = this._v2LastTs[asset];
            const isConsec = (lastTs != null) && (candleTs - lastTs <= 120);
            const streak = isConsec ? (this._v2ConsecCount[asset] || 1) : 1;
            if (streak >= 3) streakBlocked = true;
        }

        const _updateStreak = () => {
            if (!asset) return;
            if (!this._v2LastTs) this._v2LastTs = {};
            if (!this._v2ConsecCount) this._v2ConsecCount = {};
            const lastTs = this._v2LastTs[asset];
            const isConsec = (lastTs != null) && (candleTs - lastTs <= 120);
            this._v2ConsecCount[asset] = isConsec ? (this._v2ConsecCount[asset] || 1) + 1 : 1;
            this._v2LastTs[asset] = candleTs;
        };

        // ═════════════════════════════════════════════════════════════════════
        // 1. CALL REVERSAL (MA-independent, with 3-bar lookback)
        // K crash 20+pts into <30 from >=50, RSI <45, price near lower BB, BB stable
        // 3-bar lookback: crash within 3-4 bars, RSI stayed <45, no premature bullish cross
        // ═════════════════════════════════════════════════════════════════════
        if (!streakBlocked && rsi < 80) {
            const kCrash = k_1 != null && stochK != null ? k_1 - stochK : null;
            const kFlashCrash = kCrash != null && kCrash >= 25; // replay 2026-04-17: >=30 killed pattern (1 signal/3d); relaxed to 25
            const kOversold = stochK != null && stochK >= 25 && stochK < 30; // session_report_2026-04-17: 25-30 landing zone = 58.9% WR
            const kWasMid = k_1 != null && k_1 >= 50;
            const rsiDown = rsi < 30; // replay 2026-04-17: <20 killed pattern; relaxed to <30 (still tighter than original <45)

            // 3-bar lookback for CALL reversal confirmation
            let lookbackOk = false;
            if (history.length >= 3 && kFlashCrash && kOversold) {
                // RSI stayed <45 throughout the 3-bar window
                const rsiAllLow = rsi < 45 && rsi_1 < 45 && rsi_2 < 45 && rsi_3 < 45;

                // Stoch crash occurred within last 3-4 bars (not stale)
                const k_4 = history.length >= 4 ? (history[3].stochastic_k ?? k_3) : k_3;
                const crashRecent = k_1 >= 50 || k_2 >= 50 || k_3 >= 50 || k_4 >= 50;

                // No premature bullish crossover during crash (K didn't cross above D early)
                const noPrematureCross = !(k_1 > d_1 && k_2 <= d_2);

                lookbackOk = rsiAllLow && crashRecent && noPrematureCross;
            }

            // Relaxed: align with tightened strict branch — no looser kCrash/K/RSI than validated
            // replay 2026-04-17: relaxed from kDrop>=30 to >=25 after signal-count collapse
            const kCrashRelaxed = kCrash != null && kCrash >= 25;
            const kDeepOversold = stochK != null && stochK >= 25 && stochK < 30;
            const kWasMidRelaxed = k_1 != null && k_1 >= 50;
            const lookbackRelaxed = (kCrashRelaxed || kDeepOversold) && rsiDown;

            if ((kFlashCrash && kOversold && kWasMid && rsiDown && priceNearLowerBB && bbStable && bbWidthSufficient && lookbackOk) ||
                (kCrashRelaxed && kOversold && kWasMidRelaxed && rsiDown && bbStable && bbWidthSufficient && lookbackRelaxed)) {

                const candleHour = new Date(candleTs * 1000).getUTCHours();
                signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                signals.buy = true; signals.sell = false;
                signals.reasons.push('OVERSOLD | Reversal | ' +
                    'K crash ' + kCrash.toFixed(1) + 'pts (' + k_1.toFixed(1) + '->' + stochK.toFixed(1) + ') | ' +
                    'RSI ' + rsi.toFixed(1) + ' (<45) | ' +
                    'Price near lower BB | BB stable | BB ' + bbWidthBps.toFixed(1) + 'bps | UTC ' + candleHour);
                _updateStreak(); return true;
            }
        }

        // ═════════════════════════════════════════════════════════════════════
        // 2. PUT REVERSAL (MA-independent, with 3-bar lookback)
        // RSI >70x2 (not 75-80), RSI falling [38,70) not [55,65), velocity >-15
        // close >= BB mid, K exiting OB, D >=75, K-D <-3
        // 3-bar lookback: RSI >70 for 2-3 bars, Stoch overbought, no early bullish cross
        // ═════════════════════════════════════════════════════════════════════
        if (!streakBlocked && isRed) {
            const rsiWasOverbought1 = rsi_1 != null && rsi_1 > 70;
            const rsiWasOverbought2 = rsi_2 != null && rsi_2 >= 80; // session_report_2026-04-17: 88.9% WR at rsiFrom 80-82
            const notFastDrop = rsi_1 == null || !(rsi_1 >= 75 && rsi_1 < 80);
            const rsiInReversal = rsiFalling && rsi >= 38 && rsi < 70 &&
                !(rsi >= 55 && rsi < 65) && rsiVelocity >= -15 && rsiVelocity <= -8; // session_report_2026-04-17: vel -15 to -8 = golden band
            const kExitingOB = k_1 != null && k_1 > 65 && kFalling &&
                stochK != null && stochK >= 55 && stochK < 80;
            const dLaggingHigh = stochD != null && stochD >= 75;
            const kdSpread = stochK != null && stochD != null ? stochK - stochD : null;
            const kBelowD = kdSpread != null && kdSpread < -3;

            // 3-bar lookback for PUT reversal confirmation
            let lookbackOk = false;
            if (history.length >= 3 && rsiWasOverbought1 && rsiWasOverbought2) {
                // RSI stayed >70 for at least prior 2-3 bars
                const rsiAllHigh = rsi_1 > 70 && rsi_2 > 70 && rsi_3 > 70;

                // Stochastic remained overbought the whole time before exit
                const stochAllOB = k_1 > 65 && k_2 > 65 && k_3 > 65;

                // No early bullish Stoch crossover during overbought phase
                const noEarlyBullishCross = !(k_1 < d_1 && k_2 >= d_2);

                lookbackOk = rsiAllHigh && stochAllOB && noEarlyBullishCross;
            }

            // Relaxed: align with tightened strict branch — prior bar RSI must confirm true overbought
            // session_report_2026-04-17: golden band requires RSI[-2] >= 80 and velocity in [-15,-8]
            const rsiWasHigh1 = rsi_1 != null && rsi_1 > 70;
            const rsiWasHigh2 = rsi_2 != null && rsi_2 >= 80;
            const rsiInReversalRelaxed = rsiFalling && rsi >= 35 && rsi < 70 && rsiVelocity >= -15 && rsiVelocity <= -8;
            const kExitingOBRelaxed = k_1 != null && k_1 > 60 && kFalling &&
                stochK != null && stochK >= 50 && stochK < 80;
            const dLaggingRelaxed = stochD != null && stochD >= 70;
            const kdSpreadRelaxed = kdSpread != null && kdSpread < -2;

            if ((rsiWasOverbought1 && rsiWasOverbought2 && notFastDrop &&
                rsiInReversal && closeAboveMid && bbWidthSufficient &&
                kExitingOB && dLaggingHigh && kBelowD &&
                lookbackOk) ||
                (rsiWasHigh1 && rsiWasHigh2 && rsiInReversalRelaxed &&
                    closeAboveMid && bbWidthSufficient && kExitingOBRelaxed && dLaggingRelaxed && kdSpreadRelaxed)) {

                const candleHour = new Date(candleTs * 1000).getUTCHours();
                signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                signals.sell = true; signals.buy = false;
                signals.reasons.push('OVERBOUGHT | Reversal | ' +
                    'RSI ' + rsi.toFixed(1) + ' (from ' + rsi_1.toFixed(1) + ', vel=' + rsiVelocity.toFixed(1) + ') | ' +
                    'K ' + stochK.toFixed(1) + ' (55-80, from ' + k_1.toFixed(1) + ') | ' +
                    'D ' + stochD.toFixed(1) + ' (>=75) | K-D ' + kdSpread.toFixed(1) + ' (<-3) | ' +
                    'Price >= BB mid | BB ' + bbWidthBps.toFixed(1) + 'bps | UTC ' + candleHour);
                _updateStreak(); return true;
            }
        }

        // ═════════════════════════════════════════════════════════════════════
        // 3. CALL CONTINUATION (pre-cross with 3-bar lookback)
        // MA6 < MA14 converging up, RSI >50 rising, Stoch >30 rising
        // 3-bar lookback: MA6 stays below MA14, gap shrinks, Stoch dips but recovers >30
        // ═════════════════════════════════════════════════════════════════════
        if (!streakBlocked && isGreen) {
            const ma6BelowMa14 = ma6 < ma14;
            const ma6ConvergingUp = ma6BelowMa14 && ma6Rising;
            const rsiAbove50Rising = rsi > 50 && rsiRising;
            const stochRisingFromOversold = stochK != null && stochK > 30 && kRising;

            // 3-bar lookback: MA gap shrinking, Stoch stays >30, no bearish crossover
            let lookbackOk = false;
            let gap0 = Math.abs(ma6 - ma14);
            if (history.length >= 3 && ma6BelowMa14) {
                const gap3 = Math.abs((history[2].ma6 ?? ma6) - (history[2].ma14 ?? ma14));
                const gapShrinking = gap0 < gap3;

                const ma14_3 = history[2].ma14 ?? ma14;
                const ma14FlatOrRising = ma14 >= ma14_3;

                const stochAbove30 = stochK > 30 && k_1 > 30 && k_2 > 30 && k_3 > 30;
                const stochRecovering = stochK > k_2;

                const noBearishCross = !(k_1 > d_1 && stochK <= stochD);

                lookbackOk = gapShrinking && ma14FlatOrRising && stochAbove30 && stochRecovering && noBearishCross;
            }

            // Relaxed: MA convergence with RSI bullish and Stoch rising
            const ma6ConvergingUpRelaxed = ma6BelowMa14 && ma6Rising;
            const rsiBullish = rsi > 50;
            const stochRising = stochK != null && stochK > 25 && kRising;
            const lookbackRelaxed = history.length >= 2 && ma6BelowMa14 && gap0 < Math.abs((history[0].ma6 ?? ma6) - (history[0].ma14 ?? ma14));

            if ((ma6ConvergingUp && rsiAbove50Rising && stochRisingFromOversold &&
                bbStable && lookbackOk && currentGap <= maxGap) ||
                (ma6ConvergingUpRelaxed && rsiBullish && stochRising &&
                    lookbackRelaxed && currentGap <= maxGap * 2)) {

                // session_gemini_2026-04-17 (replay-verified): K>=85 + bbW<=30 flips CALL UT from -$29.5k/4d to +$1.9k/4d
                if (!(stochK != null && stochK >= 85 && bbWidthBps <= 30)) return false;

                const candleHour = new Date(candleTs * 1000).getUTCHours();
                signals.direction = 'CALL'; signals.strategyUsed = 'video2';
                signals.buy = true; signals.sell = false;
                signals.reasons.push('UP TREND | ' +
                    'MA6 ' + ma6.toFixed(4) + ' conv up to MA14 ' + ma14.toFixed(4) + ' | ' +
                    'RSI ' + rsi.toFixed(1) + ' (>50 rising) | ' +
                    'Stoch K ' + stochK.toFixed(1) + ' (>30 rising, recovered) | ' +
                    'BB stable | UTC ' + candleHour);
                _updateStreak(); return true;
            }
        }

        // ═════════════════════════════════════════════════════════════════════
        // 4. PUT CONTINUATION (pre-cross with 3-bar lookback)
        // MA6 > MA14 converging down, price < MA14, RSI falling from >50, Stoch <70 falling
        // 3-bar lookback: MA6 stays above MA14, gap shrinks, Stoch pops but resumes <70
        // ═════════════════════════════════════════════════════════════════════
        // session_report_2026-04-17: PUT DT kill zone bbW 10-30 (27-38% WR); 30-60 = 67.6% WR
        if (!streakBlocked && isRed && bbWidthBps >= 30) {
            const ma6AboveMa14 = ma6 > ma14;
            const ma6ConvergingDown = ma6AboveMa14 && ma6Falling;
            const priceBelowMa14 = closePrice < ma14;
            const rsiFallingFrom50 = rsi_1 > 50 && rsiFalling && rsi < 55;
            const stochFallingFromOverbought = stochK != null && stochK < 70 && kFalling;

            // 3-bar lookback: MA gap shrinking, Stoch stays <70, no bullish crossover
            let lookbackOk = false;
            let gap0 = Math.abs(ma6 - ma14);
            if (history.length >= 3 && ma6AboveMa14) {
                const gap3 = Math.abs((history[2].ma6 ?? ma6) - (history[2].ma14 ?? ma14));
                const gapShrinking = gap0 < gap3;

                const ma14_3 = history[2].ma14 ?? ma14;
                const ma14FlatOrFalling = ma14 <= ma14_3;

                const stochBelow70 = stochK < 70 && k_1 < 70 && k_2 < 70 && k_3 < 70;
                const stochResumingDown = stochK < k_2;

                const noBullishCross = !(k_1 < d_1 && stochK >= stochD);

                lookbackOk = gapShrinking && ma14FlatOrFalling && stochBelow70 && stochResumingDown && noBullishCross;
            }

            // Relaxed: MA divergence with RSI bearish and Stoch falling
            const ma6ConvergingDownRelaxed = ma6AboveMa14 && ma6Falling;
            const rsiBearish = rsi < 55 && rsiFalling;
            const stochFalling = stochK != null && stochK < 75 && kFalling;
            const lookbackRelaxed = history.length >= 2 && ma6AboveMa14 && gap0 < Math.abs((history[0].ma6 ?? ma6) - (history[0].ma14 ?? ma14));

            if ((ma6ConvergingDown && priceBelowMa14 && rsiFallingFrom50 &&
                stochFallingFromOverbought && bbStable && lookbackOk &&
                currentGap <= maxGap) ||
                (ma6ConvergingDownRelaxed && rsiBearish && stochFalling &&
                    lookbackRelaxed && currentGap <= maxGap * 2)) {

                const candleHour = new Date(candleTs * 1000).getUTCHours();
                signals.direction = 'PUT'; signals.strategyUsed = 'video2';
                signals.sell = true; signals.buy = false;
                signals.reasons.push('DOWN TREND | ' +
                    'MA6 ' + ma6.toFixed(4) + ' conv down to MA14 ' + ma14.toFixed(4) + ' | ' +
                    'Price ' + closePrice.toFixed(4) + ' < MA14 | ' +
                    'RSI ' + rsi.toFixed(1) + ' (falling from ' + rsi_1.toFixed(1) + ') | ' +
                    'Stoch K ' + stochK.toFixed(1) + ' (<70 falling, resumed) | ' +
                    'BB stable | UTC ' + candleHour);
                _updateStreak(); return true;
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
            indicators.ma6 != null && indicators.ma14 != null && indicators.rsi_5 != null && indicators.lastCandle
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