// Technical Indicators Module

const INDICATOR_CONFIG = {
    ma1: 6,    // MA6  — fast trend (Green)
    ma2: 50,   // MA50 — slow reference (Red, not in   gates)
    ma3: 14,   // MA14 — slow trend (White)
    rsi: 5,
    stoch: { kPeriod: 5, dPeriod: 3, smoothPeriod: 3 },
    bb: { period: 20, stdDev: 2 },
    schaff: { emaFast: 10, emaSlow: 20, cycle: 5, smooth1: 3, smooth2: 3 },
};

class Indicators {
    constructor() {
        this._v2ConsecCount = {};
        this._v2LastTs = {};
        this._lastSchaffValues = {};
        this._stochHistory = {};  // last 4 [k,d] pairs per asset (cross detection)
        this._cciHistory = {};    // last 25 CCI(8) values per asset (cross + depth detection)
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
     *  (30, 55, 8, 4, 3). Returns { value, signal } (main line = "pink", signal = "blue").
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
        const typicalPrices = recentCandles.map(c => (c[3] + c[4] + c[2]) / 3); // (High + Low + Close) / 3

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

    calculateAll(asset, candles, settings = {}) {
        if (!candles || candles.length === 0) return null;

        candles.asset = asset;

        const indicators = {
            asset,
            timestamp: Date.now(),
        };

        indicators.ma1 = indicators.ma6 = this.calculateSMA(candles, INDICATOR_CONFIG.ma1);
        indicators.ma2 = indicators.ma50 = this.calculateSMA(candles, INDICATOR_CONFIG.ma2);
        indicators.ma3 = indicators.ma14 = this.calculateSMA(candles, INDICATOR_CONFIG.ma3);

        indicators.rsi_5 = this.calculateRSI(candles, INDICATOR_CONFIG.rsi);

        const stoch = this.calculateStochastic(candles, INDICATOR_CONFIG.stoch.kPeriod, INDICATOR_CONFIG.stoch.dPeriod, INDICATOR_CONFIG.stoch.smoothPeriod);
        indicators.stochastic_k = stoch ? stoch.k : null;
        indicators.stochastic_d = stoch ? stoch.d : null;
        indicators.stochastic_prevD = stoch ? stoch.prevD : null;

        // 4-bar stoch history for cross-age detection (barsAgo=1 gate)
        if (!this._stochHistory[asset]) this._stochHistory[asset] = [];
        this._stochHistory[asset].push({ k: indicators.stochastic_k, d: indicators.stochastic_d });
        if (this._stochHistory[asset].length > 4) this._stochHistory[asset].shift();

        indicators.bollinger = this.calculateBollingerBands(candles, INDICATOR_CONFIG.bb.period, INDICATOR_CONFIG.bb.stdDev);
        indicators.schaffTrendCycle = this.calculateSchaffTrendCycle(
            candles,
            INDICATOR_CONFIG.schaff.emaFast, INDICATOR_CONFIG.schaff.emaSlow,
            INDICATOR_CONFIG.schaff.cycle, INDICATOR_CONFIG.schaff.smooth1, INDICATOR_CONFIG.schaff.smooth2
        );

        // Previous STC value — cached per asset to avoid recomputing full history
        indicators.prevSchaffValue = this._lastSchaffValues[asset] ?? null;
        this._lastSchaffValues[asset] = indicators.schaffTrendCycle ? indicators.schaffTrendCycle.value : null;

        // CCI(8) + rolling history for cross+depth detection (Gate 3)
        indicators.cci_8 = this.calculateCCI(candles, 8);
        if (!this._cciHistory[asset]) this._cciHistory[asset] = [];
        this._cciHistory[asset].push(indicators.cci_8);
        if (this._cciHistory[asset].length > 25) this._cciHistory[asset].shift();

        // Gate 1 — BB touch precomputation (j=1..3 bars before current bar)
        let _g1Buy = null, _g1Sell = null;
        for (let _j = 1; _j <= 3; _j++) {
            const _jIdx = candles.length - 1 - _j;
            if (_jIdx < 0) break;
            const _bbAtJ = this.calculateBollingerBands(candles.slice(0, _jIdx + 1), INDICATOR_CONFIG.bb.period, INDICATOR_CONFIG.bb.stdDev);
            if (!_bbAtJ) continue;
            const _c = candles[_jIdx];
            if (_g1Buy  == null && _c[4] != null && _c[4] <= _bbAtJ.lower) _g1Buy  = { barsAgo: _j, price: _c[4], band: _bbAtJ.lower };
            if (_g1Sell == null && _c[3] != null && _c[3] >= _bbAtJ.upper) _g1Sell = { barsAgo: _j, price: _c[3], band: _bbAtJ.upper };
        }
        indicators.g1_buy  = _g1Buy;
        indicators.g1_sell = _g1Sell;

        indicators.lastCandle = candles[candles.length - 1];
        indicators.currentPrice = indicators.lastCandle[2];

        indicators.signals = this.generateSignals(indicators, settings);

        return indicators;
    }

    // ==================== SIGNAL TRADE GENERATION ====================

    signalstrade(indicators, settings, signals) {
        const stc     = indicators.schaffTrendCycle ? indicators.schaffTrendCycle.value : null;
        const stcPrev = indicators.prevSchaffValue;
        const k       = indicators.stochastic_k;
        const d       = indicators.stochastic_d;

        if (stc == null || stcPrev == null || k == null || d == null) return false;

        const stcDelta = stc - stcPrev;
        const asset    = indicators.asset;
        const _sh      = this._stochHistory[asset] || [];
        const _cciH    = this._cciHistory[asset]   || [];

        for (const direction of ['CALL', 'PUT']) {
            const isBuy = direction === 'CALL';

            // ── Gate 4: STC hook + delta bounds ──────────────────────────────────
            const g4_ok = isBuy
                ? stcPrev <= 25 && stcDelta >= 0    && stcDelta < 0.5
                : stcPrev >= 85 && stcDelta >= -0.9 && stcDelta <= 0;
            if (!g4_ok) continue;

            // ── Gate 1: BB touch within last 3 bars ──────────────────────────────
            const g1 = isBuy ? indicators.g1_buy : indicators.g1_sell;
            if (!g1) continue;

            // ── Gate 2: Stoch cross from deep, exactly 1 bar ago ─────────────────
            // _sh after push: [..., C-2, C-1, C] — barsAgo=1: prev=C-2, cross=C-1
            let g2_ok = false;
            if (_sh.length >= 3) {
                const _prev = _sh[_sh.length - 3]; // C-2
                const _cur  = _sh[_sh.length - 2]; // C-1
                const _now  = _sh[_sh.length - 1]; // C
                if (_prev.k != null && _prev.d != null && _cur.k != null && _cur.d != null && _now.k != null && _now.d != null) {
                    const crossedUp   = _prev.k <= _prev.d && _cur.k > _cur.d && _prev.k < 30 && _prev.d < 30;
                    const crossedDown = _prev.k >= _prev.d && _cur.k < _cur.d && _prev.k > 80 && _prev.d > 80;
                    const kOkBuy  = _now.k < 50  && Math.abs(_now.k - _now.d) > 0.5;
                    const kOkSell = _now.k > 50  && Math.abs(_now.k - _now.d) > 0.5;
                    if (isBuy  && crossedUp   && kOkBuy)  g2_ok = true;
                    if (!isBuy && crossedDown && kOkSell) g2_ok = true;
                }
            }
            if (!g2_ok) continue;

            // ── Gate 3: CCI cross ±100 + depth ±150 ──────────────────────────────
            // Walk _cciH backward from C-1 (index len-2), stop at first cross found
            let g3_ok = false;
            for (let _x = _cciH.length - 2; _x >= 1; _x--) {
                const _cX   = _cciH[_x];
                const _cXm1 = _cciH[_x - 1];
                if (_cX == null || _cXm1 == null) continue;
                const crossed = isBuy ? (_cXm1 <= -100 && _cX > -100) : (_cXm1 >= 100 && _cX < 100);
                if (crossed) {
                    const _depthSlice = _cciH.slice(Math.max(0, _x - 10), Math.max(0, _x - 1)).filter(v => v != null);
                    const _depth = _depthSlice.length > 0 ? (isBuy ? Math.min(..._depthSlice) : Math.max(..._depthSlice)) : null;
                    if (_depth != null && (isBuy ? _depth < -150 : _depth > 175)) g3_ok = true;
                    break;
                }
            }
            if (!g3_ok) continue;

            // ── All gates passed ──────────────────────────────────────────────────
            if (isBuy) {
                signals.buy = true;
                signals.direction = 'CALL';
                signals.strategyUsed = 'STC_CALL_8GSR';
                signals.reasons.push(
                    `STC_CALL_8GSR: stc=${stc.toFixed(1)} prev=${stcPrev.toFixed(1)} delta=${stcDelta.toFixed(3)} g1=BB${g1.barsAgo}b k=${k.toFixed(1)} d=${d.toFixed(1)}`
                );
            } else {
                signals.sell = true;
                signals.direction = 'PUT';
                signals.strategyUsed = 'STC_PUT_8GSR';
                signals.reasons.push(
                    `STC_PUT_8GSR: stc=${stc.toFixed(1)} prev=${stcPrev.toFixed(1)} delta=${stcDelta.toFixed(3)} g1=BB${g1.barsAgo}b k=${k.toFixed(1)} d=${d.toFixed(1)}`
                );
            }
            return true;
        }
        return false;
    }

    // Generate trading signals —   indicator values available as inputs
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
            indicators.schaffTrendCycle != null && indicators.prevSchaffValue != null && indicators.stochastic_k != null && indicators.lastCandle
                ? this.signalstrade(indicators, settings, signals)
                : false;

        if (!fired) {
            signals.reasons.push('No Strategy Conditions Met');
        }
        return signals;
    }

    // ==================== FORMAT INDICATORS FOR DISPLAY ====================

    formatIndicators(indicators) {
        if (!indicators || typeof indicators !== 'object') return 'No data';

        try {
            const parts = [];
            if (indicators.currentPrice != null) parts.push(`Price: ${indicators.currentPrice.toFixed(5)}`);
            if (indicators.ma6 != null) parts.push(`MA6: ${indicators.ma6.toFixed(5)}`);
            if (indicators.ma14 != null) parts.push(`MA14: ${indicators.ma14.toFixed(5)}`);
            if (indicators.ma50 != null) parts.push(`MA50: ${indicators.ma50.toFixed(5)}`);
            if (indicators.rsi_5 != null) parts.push(`RSI(5): ${indicators.rsi_5.toFixed(1)}`);
            if (indicators.stochastic_k != null) parts.push(`Stoch K: ${indicators.stochastic_k.toFixed(1)} D: ${(indicators.stochastic_d ?? 0).toFixed(1)}`);
            const bb = indicators.bollinger;
            if (bb) parts.push(`BB(20,2): U ${(bb.upper || 0).toFixed(5)} M ${(bb.middle || 0).toFixed(5)} L ${(bb.lower || 0).toFixed(5)}`);
            if (indicators.schaffTrendCycle) parts.push(`Schaff: ${indicators.schaffTrendCycle.value.toFixed(2)}`);

            return parts.length > 0 ? parts.join(' | ') : 'Calculating...';
        } catch (error) {
            console.error('Error in formatIndicators:', error);
            return 'Error formatting indicators';
        }
    }

    static getMinCandlesForKT(settings = {}) {
        const buffer = 5;
        const maMin = Math.max(INDICATOR_CONFIG.ma1, INDICATOR_CONFIG.ma2, INDICATOR_CONFIG.ma3);
        const schaffMin = INDICATOR_CONFIG.schaff.emaSlow + INDICATOR_CONFIG.schaff.cycle + Math.max(INDICATOR_CONFIG.schaff.smooth1, INDICATOR_CONFIG.schaff.smooth2);
        return Math.max(maMin, schaffMin) + buffer;
    }
}

module.exports = Indicators;