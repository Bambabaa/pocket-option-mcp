// Technical Indicators Module

const { indicators: INDICATOR_CONFIG } = require('./config');

class Indicators {
    constructor() {
        this._v2ConsecCount = {};
        this._v2LastTs = {};
        this._lastSchaffValues = {};
        this._stochHistory = {};  // last 4 [k,d] pairs per asset (cross detection)
        this._cciHistory = {};    // last 25 CCI(20) values per asset (cross + depth detection)
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

    // ==================== MACD — removed (not used in live gates) ====================
    // ==================== KELTNER CHANNEL — removed (not used in live gates) ====================
    // ==================== ZIG ZAG — removed (not used in live gates) ====================

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

    calculateAll(asset, candles, settings = {}, pushHistory = true) {
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

        // 4-bar stoch history for cross-age detection — only advance on bar close
        if (!this._stochHistory[asset]) this._stochHistory[asset] = [];
        if (pushHistory) {
            this._stochHistory[asset].push({ k: indicators.stoch_k, d: indicators.stoch_d });
            if (this._stochHistory[asset].length > 4) this._stochHistory[asset].shift();
        }

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

        // CCI(20) + rolling history for cross+depth detection — only advance on bar close
        indicators.cci_20 = this.calculateCCI(candles, INDICATOR_CONFIG.cci.period);
        if (!this._cciHistory[asset]) this._cciHistory[asset] = [];
        if (pushHistory) {
            this._cciHistory[asset].push(indicators.cci_20);
            if (this._cciHistory[asset].length > 25) this._cciHistory[asset].shift();
        }

        // Gate 1 — BB touch precomputation (configurable lookback)
        let _g1Buy = null, _g1Sell = null;
        for (let _j = 1; _j <= INDICATOR_CONFIG.bb.touchLookback; _j++) {
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
        const stc     = indicators.stc_value;
        const stcPrev = indicators.stc_prev;
        const k       = indicators.stoch_k;
        const d       = indicators.stoch_d;

        if (stc == null || stcPrev == null || k == null || d == null) return false;

        const stcDelta = stc - stcPrev;
        const asset    = indicators.asset;
        const _sh      = this._stochHistory[asset] || [];
        const _cciH    = this._cciHistory[asset]   || [];

        for (const direction of ['CALL', 'PUT']) {
            const isBuy = direction === 'CALL';

            // ── Gate 4: STC hook + delta bounds ──────────────────────────────────
            const g4_ok = isBuy
                ? stcPrev <= INDICATOR_CONFIG.stc.floor    && stcDelta >= 0 && stcDelta < INDICATOR_CONFIG.stc.deltaMaxBuy
                : stcPrev >= INDICATOR_CONFIG.stc.ceiling  && stcDelta >= INDICATOR_CONFIG.stc.deltaMinSell && stcDelta <= 0;
            if (!g4_ok) continue;

            // ── Gate 1: BB touch within last N bars (config: bb.touchLookback) ────
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
                    const crossedUp   = _prev.k <= _prev.d && _cur.k > _cur.d && _prev.k < INDICATOR_CONFIG.stoch.oversold   && _prev.d < INDICATOR_CONFIG.stoch.oversold;
                    const crossedDown = _prev.k >= _prev.d && _cur.k < _cur.d && _prev.k > INDICATOR_CONFIG.stoch.overbought && _prev.d > INDICATOR_CONFIG.stoch.overbought;
                    const kOkBuy  = _now.k < INDICATOR_CONFIG.stoch.kMaxBuy  && Math.abs(_now.k - _now.d) > INDICATOR_CONFIG.stoch.minSep;
                    const kOkSell = _now.k > INDICATOR_CONFIG.stoch.kMinSell && Math.abs(_now.k - _now.d) > INDICATOR_CONFIG.stoch.minSep;
                    if (isBuy  && crossedUp   && kOkBuy)  g2_ok = true;
                    if (!isBuy && crossedDown && kOkSell) g2_ok = true;
                }
            }
            if (!g2_ok) continue;

            // ── Gate 3: CCI cross ±crossLevel + depth ±minDepth ──────────────────
            // Walk _cciH backward from C-1 (index len-2), stop at first cross found
            let g3_ok = false;
            for (let _x = _cciH.length - 2; _x >= 1; _x--) {
                const _cX   = _cciH[_x];
                const _cXm1 = _cciH[_x - 1];
                if (_cX == null || _cXm1 == null) continue;
                const crossed = isBuy
                    ? (_cXm1 <= -INDICATOR_CONFIG.cci.crossLevel && _cX > -INDICATOR_CONFIG.cci.crossLevel)
                    : (_cXm1 >= INDICATOR_CONFIG.cci.crossLevel  && _cX < INDICATOR_CONFIG.cci.crossLevel);
                if (crossed) {
                    const _depthSlice = _cciH.slice(Math.max(0, _x - INDICATOR_CONFIG.cci.depthWindow), Math.max(0, _x - 1)).filter(v => v != null);
                    const _depth = _depthSlice.length > 0 ? (isBuy ? Math.min(..._depthSlice) : Math.max(..._depthSlice)) : null;
                    if (_depth != null && (isBuy ? _depth < -INDICATOR_CONFIG.cci.minDepth : _depth > INDICATOR_CONFIG.cci.minDepth)) g3_ok = true;
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
            indicators.stc_value != null && indicators.stc_prev != null && indicators.stoch_k != null && indicators.lastCandle
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
            if (indicators.sma_10 != null) parts.push(`MA10: ${indicators.sma_10.toFixed(5)}`);
            if (indicators.sma_20 != null) parts.push(`MA20: ${indicators.sma_20.toFixed(5)}`);
            if (indicators.sma_50 != null) parts.push(`MA50: ${indicators.sma_50.toFixed(5)}`);
            if (indicators.rsi_14 != null) parts.push(`RSI(14): ${indicators.rsi_14.toFixed(1)}`);
            if (indicators.stoch_k != null) parts.push(`Stoch K: ${indicators.stoch_k.toFixed(1)} D: ${(indicators.stoch_d ?? 0).toFixed(1)}`);
            if (indicators.bb_upper != null) parts.push(`BB(20,2): U ${indicators.bb_upper.toFixed(5)} M ${(indicators.bb_middle ?? 0).toFixed(5)} L ${(indicators.bb_lower ?? 0).toFixed(5)}`);
            if (indicators.stc_value != null) parts.push(`STC: ${indicators.stc_value.toFixed(2)}`);

            return parts.length > 0 ? parts.join(' | ') : 'Calculating...';
        } catch (error) {
            console.error('Error in formatIndicators:', error);
            return 'Error formatting indicators';
        }
    }

    static getMinCandlesForKT(settings = {}) {
        const buffer   = 5;
        const maMin    = Math.max(...INDICATOR_CONFIG.sma);
        const stcMin   = INDICATOR_CONFIG.stc.emaSlow + INDICATOR_CONFIG.stc.cycle + Math.max(INDICATOR_CONFIG.stc.smooth1, INDICATOR_CONFIG.stc.smooth2);
        return Math.max(maMin, stcMin) + buffer;
    }
}

module.exports = Indicators;