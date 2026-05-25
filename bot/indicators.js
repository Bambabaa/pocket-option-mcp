// Technical Indicators Module

const { indicators: INDICATOR_CONFIG } = require('./config');

class Indicators {
    constructor() {
        this._lastSchaffValues = {};
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

    // Relative Strength Index (RSI) — Wilder's smoothing
    calculateRSI(candles, period = 14) {
        if (!candles || candles.length < period + 1) {
            return null;
        }

        const closes = candles.map(c => c[2]);
        const changes = [];
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        if (changes.length < period) return null;

        // Seed: SMA of first `period` gains/losses
        let avgGain = 0, avgLoss = 0;
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }
        avgGain /= period;
        avgLoss /= period;

        // Wilder's smoothing for all subsequent bars
        for (let i = period; i < changes.length; i++) {
            const gain = changes[i] > 0 ? changes[i] : 0;
            const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    // ==================== MACD (12, 26, 9) ====================

    calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (!candles || candles.length < slowPeriod + signalPeriod) return null;

        const closes = candles.map(c => c[2]);

        function emaArray(arr, period) {
            if (arr.length < period) return [];
            const k = 2 / (period + 1);
            const result = [];
            let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
            result.push(ema);
            for (let i = period; i < arr.length; i++) {
                ema = (arr[i] - ema) * k + ema;
                result.push(ema);
            }
            return result;
        }

        const fastEMAs = emaArray(closes, fastPeriod);
        const slowEMAs = emaArray(closes, slowPeriod);
        if (!fastEMAs.length || !slowEMAs.length) return null;

        // Align: slowEMAs[i] and fastEMAs[offset+i] both refer to the same bar
        const offset   = slowPeriod - fastPeriod;
        const macdLine = slowEMAs.map((v, i) => fastEMAs[offset + i] - v);
        if (macdLine.length < signalPeriod) return null;

        const sigEMAs = emaArray(macdLine, signalPeriod);
        if (!sigEMAs.length) return null;

        const macd   = macdLine[macdLine.length - 1];
        const signal = sigEMAs[sigEMAs.length - 1];
        return { macd, signal, histogram: macd - signal };
    }

    // ==================== ATR (Average True Range) — Wilder's smoothing ====================

    calculateATR(candles, period = 14) {
        if (!candles || candles.length < period + 1) return null;

        const trs = [];
        for (let i = 1; i < candles.length; i++) {
            const high      = candles[i][3]     ?? candles[i][2];
            const low       = candles[i][4]     ?? candles[i][1];
            const prevClose = candles[i - 1][2];
            trs.push(Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low  - prevClose)
            ));
        }

        if (trs.length < period) return null;

        let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < trs.length; i++) {
            atr = (atr * (period - 1) + trs[i]) / period;
        }
        return atr;
    }

    // ==================== KELTNER CHANNEL (EMA 20, ATR 10, mult 2) ====================

    calculateKeltnerChannel(candles, emaPeriod = 20, atrPeriod = 10, mult = 2) {
        const middle = this.calculateEMA(candles, emaPeriod);
        const atr    = this.calculateATR(candles, atrPeriod);
        if (middle == null || atr == null) return null;
        return {
            upper:  middle + mult * atr,
            middle,
            lower:  middle - mult * atr,
        };
    }

    // ==================== ADX (Average Directional Index, period 14) ====================

    calculateADX(candles, period = 14) {
        if (!candles || candles.length < period * 2 + 1) return null;

        const plusDM = [], minusDM = [], trs = [];
        for (let i = 1; i < candles.length; i++) {
            const high      = candles[i][3]     ?? candles[i][2];
            const low       = candles[i][4]     ?? candles[i][1];
            const prevHigh  = candles[i - 1][3] ?? candles[i - 1][2];
            const prevLow   = candles[i - 1][4] ?? candles[i - 1][1];
            const prevClose = candles[i - 1][2];

            const upMove   = high - prevHigh;
            const downMove = prevLow - low;
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            trs.push(Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low  - prevClose)
            ));
        }

        if (trs.length < period) return null;

        let smoothTR      = trs.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothPlusDM  = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
        let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

        const dxValues = [];
        for (let i = period; i < trs.length; i++) {
            smoothTR      = smoothTR      - (smoothTR      / period) + trs[i];
            smoothPlusDM  = smoothPlusDM  - (smoothPlusDM  / period) + plusDM[i];
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];

            if (smoothTR === 0) { dxValues.push(0); continue; }
            const pDI   = 100 * smoothPlusDM  / smoothTR;
            const mDI   = 100 * smoothMinusDM / smoothTR;
            const diSum = pDI + mDI;
            dxValues.push(diSum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / diSum);
        }

        if (dxValues.length < period) return null;

        let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < dxValues.length; i++) {
            adx = (adx * (period - 1) + dxValues[i]) / period;
        }

        const plusDI  = smoothTR > 0 ? 100 * smoothPlusDM  / smoothTR : 0;
        const minusDI = smoothTR > 0 ? 100 * smoothMinusDM / smoothTR : 0;
        return { adx, plusDI, minusDI };
    }

    // ==================== WILLIAMS %R (period 14) ====================

    calculateWilliamsR(candles, period = 14) {
        if (!candles || candles.length < period) return null;

        const recent      = candles.slice(-period);
        const highestHigh = Math.max(...recent.map(c => c[3] ?? c[2]));
        const lowestLow   = Math.min(...recent.map(c => c[4] ?? c[1]));
        const close       = recent[recent.length - 1][2];

        if (highestHigh === lowestLow) return -50;
        return ((highestHigh - close) / (highestHigh - lowestLow)) * -100;
    }

    // ==================== PARABOLIC SAR ====================

    calculatePSAR(candles, acceleration = 0.02, max = 0.2) {
        if (!candles || candles.length < 2) return null;

        let bull = true;
        let af   = acceleration;
        let ep   = candles[0][3] ?? candles[0][2];  // extreme point (high for bull start)
        let sar  = candles[0][4] ?? candles[0][1];  // initial SAR = first low

        for (let i = 1; i < candles.length; i++) {
            const high      = candles[i][3]     ?? candles[i][2];
            const low       = candles[i][4]     ?? candles[i][1];
            const prevHigh  = candles[i - 1][3] ?? candles[i - 1][2];
            const prevLow   = candles[i - 1][4] ?? candles[i - 1][1];
            const prev2Low  = i >= 2 ? (candles[i - 2][4] ?? candles[i - 2][1]) : prevLow;
            const prev2High = i >= 2 ? (candles[i - 2][3] ?? candles[i - 2][2]) : prevHigh;

            let newSar = sar + af * (ep - sar);

            if (bull) {
                newSar = Math.min(newSar, prevLow, prev2Low);
                if (low < newSar) {
                    bull = false; newSar = ep; ep = low; af = acceleration;
                } else {
                    if (high > ep) { ep = high; af = Math.min(af + acceleration, max); }
                }
            } else {
                newSar = Math.max(newSar, prevHigh, prev2High);
                if (high > newSar) {
                    bull = true; newSar = ep; ep = high; af = acceleration;
                } else {
                    if (low < ep) { ep = low; af = Math.min(af + acceleration, max); }
                }
            }

            sar = newSar;
        }

        return { sar, bull };
    }

    // ==================== ZIG ZAG ====================

    calculateZigZag(candles, deviationPct = 5, minBars = 4) {
        if (!candles || candles.length < minBars + 1) return null;

        const dev   = deviationPct / 100;
        const highs = candles.map(c => c[3] ?? c[2]);
        const lows  = candles.map(c => c[4] ?? c[1]);

        let trend      = 'UP';      // initial assumption: bullish until a reversal is seen
        let pivotPrice = lows[0];
        let pivotIdx   = 0;
        const pivots   = [];

        for (let i = 1; i < candles.length; i++) {
            if (trend === 'UP') {
                if (highs[i] > pivotPrice) {
                    pivotPrice = highs[i];
                    pivotIdx   = i;
                } else if ((pivotPrice - lows[i]) / pivotPrice >= dev && (i - pivotIdx) >= minBars) {
                    pivots.push({ type: 'HIGH', price: pivotPrice, idx: pivotIdx });
                    trend      = 'DOWN';
                    pivotPrice = lows[i];
                    pivotIdx   = i;
                }
            } else {
                if (lows[i] < pivotPrice) {
                    pivotPrice = lows[i];
                    pivotIdx   = i;
                } else if ((highs[i] - pivotPrice) / pivotPrice >= dev && (i - pivotIdx) >= minBars) {
                    pivots.push({ type: 'LOW', price: pivotPrice, idx: pivotIdx });
                    trend      = 'UP';
                    pivotPrice = highs[i];
                    pivotIdx   = i;
                }
            }
        }

        if (pivots.length === 0) return null;
        const last = pivots[pivots.length - 1];
        return {
            direction: last.type === 'HIGH' ? 'DOWN' : 'UP',  // trend after last confirmed pivot
            pivot:     last.price,
        };
    }

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

        const upper = sma + (standardDeviation * stdDev);
        const lower = sma - (standardDeviation * stdDev);
        return {
            upper,
            middle: sma,
            lower,
            bb_width_bps: sma > 0 ? ((upper - lower) / sma) * 10000 : null
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

    // ==================== SCHAFF TREND CYCLE ====================

    calculateSchaffTrendCycle(candles, emaFast = 23, emaSlow = 50, cyclePeriod = 10, smooth1 = 3, smooth2 = 3) {
        if (!candles || candles.length < emaSlow + cyclePeriod + Math.max(smooth1, smooth2)) return null;

        const n = candles.length;
        const cycleRaw = [];
        for (let i = emaSlow; i < n; i++) {
            const slice = candles.slice(0, i);
            const fast = this.calculateEMA(slice, emaFast);
            const slow = this.calculateEMA(slice, emaSlow);
            if (fast != null && slow != null) cycleRaw.push(fast - slow);
        }
        if (cycleRaw.length < cyclePeriod) return null;

        function stochK(arr, period, idx) {
            const start = Math.max(0, idx - period + 1);
            const window = arr.slice(start, idx + 1);
            const low = Math.min(...window), high = Math.max(...window);
            if (high === low) return 50;
            return 100 * (arr[idx] - low) / (high - low);
        }

        const stochCycle = [];
        for (let i = cyclePeriod - 1; i < cycleRaw.length; i++) {
            stochCycle.push(stochK(cycleRaw, cyclePeriod, i));
        }
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
        for (let i = smooth2; i < smoothed1.length; i++) {
            ema2 = (smoothed1[i] - ema2) * k2 + ema2;
        }
        const value = ema2;
        const signal = smoothed1.length >= 2 ? smoothed1[smoothed1.length - 2] : value;
        return { value, signal };
    }

    // ==================== CCI (COMMODITY CHANNEL INDEX) ====================

    calculateCCI(candles, period = 20) {
        if (!candles || candles.length < period) return null;

        const recentCandles = candles.slice(-period);
        const typicalPrices = recentCandles.map(c => (c[3] + c[4] + c[2]) / 3);
        const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;
        const meanDeviation = typicalPrices.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;

        if (meanDeviation === 0) return 0;

        const currentTP = typicalPrices[typicalPrices.length - 1];
        return (currentTP - sma) / (0.015 * meanDeviation);
    }

    // ==================== CALCULATE ALL INDICATORS ====================

    calculateAll(asset, candles, pushHistory = true) {
        if (!candles || candles.length === 0) return null;

        const indicators = { asset, timestamp: Date.now() };

        // SMAs — flat names matching indicators.cjs reference
        indicators.sma_10 = this.calculateSMA(candles, INDICATOR_CONFIG.sma[0]);
        indicators.sma_20 = this.calculateSMA(candles, INDICATOR_CONFIG.sma[1]);
        indicators.sma_50 = this.calculateSMA(candles, INDICATOR_CONFIG.sma[2]);

        indicators.rsi_14 = this.calculateRSI(candles, INDICATOR_CONFIG.rsi.period);

        const stoch = this.calculateStochastic(candles, INDICATOR_CONFIG.stoch.kPeriod, INDICATOR_CONFIG.stoch.dPeriod, INDICATOR_CONFIG.stoch.smoothPeriod);
        indicators.stoch_k      = stoch?.k     ?? null;
        indicators.stoch_d      = stoch?.d     ?? null;
        indicators.stoch_prev_d = stoch?.prevD ?? null;

        const bb = this.calculateBollingerBands(candles, INDICATOR_CONFIG.bb.period, INDICATOR_CONFIG.bb.stdDev);
        indicators.bb_upper     = bb?.upper        ?? null;
        indicators.bb_middle    = bb?.middle       ?? null;
        indicators.bb_lower     = bb?.lower        ?? null;
        indicators.bb_width_bps = bb?.bb_width_bps ?? null;

        const stcResult = this.calculateSchaffTrendCycle(
            candles,
            INDICATOR_CONFIG.stc.emaFast, INDICATOR_CONFIG.stc.emaSlow,
            INDICATOR_CONFIG.stc.cycle, INDICATOR_CONFIG.stc.smooth1, INDICATOR_CONFIG.stc.smooth2
        );
        indicators.stc_value  = stcResult?.value  ?? null;
        indicators.stc_signal = stcResult?.signal ?? null;

        // stc_prev — last bar's stc_value; stc_delta — momentum of STC cycle
        indicators.stc_prev  = this._lastSchaffValues[asset] ?? null;
        indicators.stc_delta = (indicators.stc_value != null && indicators.stc_prev != null)
            ? indicators.stc_value - indicators.stc_prev : null;
        if (pushHistory) {
            this._lastSchaffValues[asset] = indicators.stc_value;
        }

        // CCI(20)
        indicators.cci_20 = this.calculateCCI(candles, INDICATOR_CONFIG.cci.period);

        // EMA (12, 26)
        indicators.ema_12 = this.calculateEMA(candles, INDICATOR_CONFIG.ema[0]);
        indicators.ema_26 = this.calculateEMA(candles, INDICATOR_CONFIG.ema[1]);

        // MACD (12, 26, 9)
        const macd = this.calculateMACD(candles, INDICATOR_CONFIG.macd.fast, INDICATOR_CONFIG.macd.slow, INDICATOR_CONFIG.macd.signal);
        indicators.macd_macd   = macd?.macd      ?? null;
        indicators.macd_signal = macd?.signal    ?? null;
        indicators.macd_hist   = macd?.histogram ?? null;

        // Keltner Channel (EMA 20, ATR 10, mult 2)
        const kc = this.calculateKeltnerChannel(candles, INDICATOR_CONFIG.keltner.emaPeriod, INDICATOR_CONFIG.keltner.atrPeriod, INDICATOR_CONFIG.keltner.mult);
        indicators.kc_upper  = kc?.upper  ?? null;
        indicators.kc_middle = kc?.middle ?? null;
        indicators.kc_lower  = kc?.lower  ?? null;

        // ATR (14) — Wilder's smoothing
        indicators.atr_14 = this.calculateATR(candles, INDICATOR_CONFIG.atr.period);

        // ADX + DI (14)
        const adx = this.calculateADX(candles, INDICATOR_CONFIG.adx.period);
        indicators.adx_14       = adx?.adx    ?? null;
        indicators.adx_plus_di  = adx?.plusDI ?? null;
        indicators.adx_minus_di = adx?.minusDI ?? null;

        // Williams %R (14)
        indicators.williams_14 = this.calculateWilliamsR(candles, INDICATOR_CONFIG.williams.period);

        // Parabolic SAR — { sar, bull } where bull=true means price > SAR (uptrend)
        const psarResult = this.calculatePSAR(candles, INDICATOR_CONFIG.psar.acceleration, INDICATOR_CONFIG.psar.max);
        indicators.psar      = psarResult?.sar  ?? null;
        indicators.psar_bull = psarResult?.bull ?? null;

        // ZigZag — last confirmed pivot direction + price
        const zz = this.calculateZigZag(candles, INDICATOR_CONFIG.zigzag.deviationPct, INDICATOR_CONFIG.zigzag.minBars);
        indicators.zz_direction = zz?.direction ?? null;
        indicators.zz_pivot     = zz?.pivot     ?? null;

        indicators.lastCandle   = candles[candles.length - 1];
        indicators.currentPrice = indicators.lastCandle[2];
        indicators.atr_pct      = (indicators.atr_14 != null && indicators.currentPrice)
            ? (indicators.atr_14 / indicators.currentPrice) * 100 : null;

        return indicators;
    }

    // ==================== FORMAT INDICATORS FOR DISPLAY ====================

    formatIndicators(indicators) {
        if (!indicators || typeof indicators !== 'object') return 'No data';

        try {
            const fmt = (v, d=5) => v != null ? v.toFixed(d) : '—';
            const f1  = (v)      => v != null ? v.toFixed(1)  : '—';
            const f2  = (v)      => v != null ? v.toFixed(2)  : '—';

            const line1 = [
                indicators.currentPrice  != null ? `P:${fmt(indicators.currentPrice)}` : null,
                indicators.sma_10        != null ? `MA10:${fmt(indicators.sma_10)}` : null,
                indicators.sma_20        != null ? `MA20:${fmt(indicators.sma_20)}` : null,
                indicators.rsi_14        != null ? `RSI:${f1(indicators.rsi_14)}` : null,
                indicators.stoch_k       != null ? `K:${f1(indicators.stoch_k)} D:${f1(indicators.stoch_d)}` : null,
                indicators.stc_value     != null ? `STC:${f1(indicators.stc_value)} Δ${f2(indicators.stc_delta)}` : null,
                indicators.bb_width_bps  != null ? `BBw:${Math.round(indicators.bb_width_bps)}bps` : null,
            ].filter(Boolean).join(' | ');

            const line2 = [
                indicators.macd_hist     != null ? `MACD-H:${f2(indicators.macd_hist)}` : null,
                indicators.atr_14        != null ? `ATR:${fmt(indicators.atr_14)}` : null,
                indicators.adx_14        != null ? `ADX:${f1(indicators.adx_14)}` : null,
                indicators.psar          != null ? `PSAR:${fmt(indicators.psar)}(${indicators.psar_bull ? '▲' : '▼'})` : null,
                indicators.zz_direction  != null ? `ZZ:${indicators.zz_direction}` : null,
            ].filter(Boolean).join(' | ');

            if (!line1 && !line2) return 'Calculating...';
            return line2 ? `${line1}\n  ${line2}` : line1;
        } catch (error) {
            console.error('Error in formatIndicators:', error);
            return 'Error formatting indicators';
        }
    }

    static getMinCandles() {
        const buffer   = 5;
        const maMin    = Math.max(...INDICATOR_CONFIG.sma);
        const stcMin   = INDICATOR_CONFIG.stc.emaSlow + INDICATOR_CONFIG.stc.cycle + Math.max(INDICATOR_CONFIG.stc.smooth1, INDICATOR_CONFIG.stc.smooth2);
        return Math.max(maMin, stcMin) + buffer;
    }
}

module.exports = Indicators;