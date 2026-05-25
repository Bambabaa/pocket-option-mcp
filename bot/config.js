'use strict';

module.exports = {

    candle: {
        period:           300,  // 5-minute bars (seconds)
        lookAheadSeconds: 300,  // Validation expiry window (must match period)
    },

    // ── Single source of truth for all indicator math parameters AND gate thresholds ──
    indicators: {

        sma: [10, 20, 50],  // SMA periods: fast / mid / slow

        ema: [12, 26],  // EMA periods: fast / slow

        rsi: {
            period: 14,
        },

        macd: {
            fast:   12,
            slow:   26,
            signal:  9,
        },

        stoch: {
            // Math params — Full/Slow Stochastic (5,3,3)
            kPeriod:      5,
            dPeriod:      3,
            smoothPeriod: 3,
            // Gate 2 thresholds
            oversold:   30,   // K & D must both be < this at the cross bar (CALL)
            overbought: 80,   // K & D must both be > this at the cross bar (PUT)
            kMaxBuy:    50,   // Current K must be < this after cross (CALL)
            kMinSell:   50,   // Current K must be > this after cross (PUT)
            minSep:     0.5,  // |K - D| minimum separation at current bar
        },

        bb: {
            // Math params — Bollinger Bands (20, 2)
            period:  20,
            stdDev:   2,
            // Gate 1 thresholds
            touchLookback: 3,   // Bars to scan back for BB touch
            minWidthBps:  10,   // Minimum BB width in basis points (flat-market filter)
        },

        stc: {
            // Math params — Schaff Trend Cycle (23, 50, 10, 3, 3)
            emaFast:  23,
            emaSlow:  50,
            cycle:    10,
            smooth1:   3,
            smooth2:   3,
            // Gate 4 thresholds
            floor:        25,    // CALL: stcPrev must be ≤ this (STC in floor zone)
            ceiling:      85,    // PUT:  stcPrev must be ≥ this (STC in ceiling zone)
            deltaMaxBuy:  0.5,   // CALL: stcDelta must be >= 0 && < this
            deltaMinSell: -0.9,  // PUT:  stcDelta must be >= this && <= 0
        },

        cci: {
            // Math params
            period:      20,
            // Gate 3 thresholds
            crossLevel:  100,   // CCI must cross ±crossLevel to qualify
            minDepth:    150,   // Prior extreme must exceed ±minDepth before cross
            depthWindow: 10,    // Bars to look back when measuring depth
        },

        keltner: {
            emaPeriod: 20,   // EMA of close
            atrPeriod: 10,   // ATR period for channel width
            mult:       2,   // ATR multiplier
        },

        atr: {
            period: 14,      // Wilder's ATR
        },

        adx: {
            period: 14,      // ADX + DI calculation window
        },

        williams: {
            period: 14,      // Williams %R lookback
        },

        psar: {
            acceleration: 0.02,  // Initial acceleration factor
            max:           0.2,  // Maximum acceleration factor
        },

        zigzag: {
            deviationPct: 5,   // Minimum reversal % to confirm a pivot
            minBars:       4,  // Minimum bars between pivots
        },
    },

    execution: {
        tradeAmount:            500,
        maxDailyTrades:          50,
        minPayout:               70,   // Minimum payout % to allow trade
        expirationSec:          900,   // Option expiry (15 minutes)
        tradeDelayMs:             0,
        buttonWaitTimeoutMs:   4000,
        postAssetSelectWaitMs:  300,
        useEvaluateClick:      true,
        resultSyncIntervalMs:  60000,
        resultSyncFirstDelayMs: 25000,
        resultSyncStaleHours:    2,
        placeOrderTimeoutMs:  10000,
    },

};
