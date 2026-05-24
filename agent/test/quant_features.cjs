'use strict';

/**
 * Feature Engineering Module for Quantitative Reversal Research
 * Calculates derived behavioral features and classifies market regimes.
 */

function getRollingHighLow(data, currentIndex, lookback) {
    if (currentIndex < lookback) return { high: null, low: null };
    let high = -Infinity;
    let low = Infinity;
    for (let i = currentIndex - lookback; i < currentIndex; i++) {
        if (data[i].high > high) high = data[i].high;
        if (data[i].low < low) low = data[i].low;
    }
    return { high, low };
}

function classifyRegime(row, prevRows) {
    if (!row.adx || !row.bb_width_bps) return 'UNKNOWN';
    if (prevRows.length < 20) return 'UNKNOWN';
    
    let sumBB = 0;
    for (let i = prevRows.length - 20; i < prevRows.length; i++) {
        sumBB += prevRows[i].bb_width_bps;
    }
    const avgBB = sumBB / 20;

    let sqDiffSum = 0;
    for (let i = prevRows.length - 20; i < prevRows.length; i++) {
        sqDiffSum += Math.pow(prevRows[i].bb_width_bps - avgBB, 2);
    }
    const stdDevBB = Math.sqrt(sqDiffSum / 20);

    const isExpanding = row.bb_width_bps > (avgBB + stdDevBB);
    const isCompressing = row.bb_width_bps < (avgBB - stdDevBB);
    
    const zScore = row.atr_14 > 0 ? (row.close - row.sma_20) / row.atr_14 : 0;

    if (row.adx > 35 && Math.abs(zScore) > 2.5) return 'EXHAUSTION';
    if (isExpanding) return 'VOLATILITY_EXPANSION';
    if (isCompressing) return 'COMPRESSION';
    if (row.adx > 25) return 'TRENDING';
    if (row.adx < 20) return 'RANGING';
    
    return 'NORMAL';
}

function processAssetData(rows) {
    let consecutiveBull = 0;
    let consecutiveBear = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        
        // --- 1. Candle Structure ---
        const range = row.high - row.low;
        const bodySize = Math.abs(row.close - row.open);
        const isBull = row.close > row.open;
        
        row.feat_range = range;
        row.feat_body_size = bodySize;
        row.feat_is_bull = isBull;
        
        if (range > 0) {
            row.feat_body_percent = bodySize / range;
            if (isBull) {
                row.feat_upper_wick_percent = (row.high - row.close) / range;
                row.feat_lower_wick_percent = (row.open - row.low) / range;
            } else {
                row.feat_upper_wick_percent = (row.high - row.open) / range;
                row.feat_lower_wick_percent = (row.close - row.low) / range;
            }
            row.feat_close_position = (row.close - row.low) / range;
        } else {
            row.feat_body_percent = 0;
            row.feat_upper_wick_percent = 0;
            row.feat_lower_wick_percent = 0;
            row.feat_close_position = 0.5;
        }

        // Candle expansion ratio vs previous bar
        if (i > 0 && rows[i - 1].feat_range > 0) {
            row.feat_candle_expansion = range / rows[i - 1].feat_range;
        } else {
            row.feat_candle_expansion = 1;
        }

        // --- 2. Exhaustion Metrics ---
        if (isBull) {
            consecutiveBull++;
            consecutiveBear = 0;
        } else if (row.close < row.open) {
            consecutiveBear++;
            consecutiveBull = 0;
        } else {
            // doji
            consecutiveBull = 0;
            consecutiveBear = 0;
        }
        row.feat_consecutive_bull = consecutiveBull;
        row.feat_consecutive_bear = consecutiveBear;

        if (i > 0) {
            const prevRow = rows[i - 1];
            row.feat_body_shrinkage = prevRow.feat_body_size > 0 ? bodySize / prevRow.feat_body_size : 1;
            const currentWick = Math.max(row.feat_upper_wick_percent, row.feat_lower_wick_percent) * range;
            const prevWick = Math.max(prevRow.feat_upper_wick_percent, prevRow.feat_lower_wick_percent) * prevRow.feat_range;
            row.feat_wick_growth = prevWick > 0 ? currentWick / prevWick : 1;
        } else {
            row.feat_body_shrinkage = 1;
            row.feat_wick_growth = 1;
        }

        // Momentum decay: bodies shrinking over last 3 bars
        if (i >= 3) {
            const b0 = rows[i].feat_body_size;
            const b1 = rows[i - 1].feat_body_size;
            const b2 = rows[i - 2].feat_body_size;
            row.feat_momentum_decay = (b2 > 0 && b1 > 0) ? (b0 / b2) : 1; // < 1 means decay
        } else {
            row.feat_momentum_decay = 1;
        }

        // --- 3. Mean Reversion Metrics ---
        if (row.sma_20 && row.atr_14 && row.atr_14 > 0) {
            row.feat_z_score = (row.close - row.sma_20) / row.atr_14;
            row.feat_distance_from_ema20 = row.close - row.sma_20;
        } else {
            row.feat_z_score = 0;
            row.feat_distance_from_ema20 = 0;
        }

        // --- 4. Breakout & Sweep Metrics ---

        // 20-bar lookback (original)
        const local20 = getRollingHighLow(rows, i, 20);
        if (local20.high !== null) {
            row.feat_sweep_above_high_20 = (row.high > local20.high) && (row.close <= local20.high) && (row.open <= local20.high);
            row.feat_sweep_below_low_20 = (row.low < local20.low) && (row.close >= local20.low) && (row.open >= local20.low);
            row.feat_broke_high_20 = row.close > local20.high;
            row.feat_broke_low_20 = row.close < local20.low;
            if (row.atr_14 > 0) {
                row.feat_breakout_dist_atr_20 = row.feat_broke_high_20 ? (row.close - local20.high) / row.atr_14
                    : row.feat_broke_low_20 ? (local20.low - row.close) / row.atr_14
                    : 0;
            } else {
                row.feat_breakout_dist_atr_20 = 0;
            }
        } else {
            row.feat_sweep_above_high_20 = false;
            row.feat_sweep_below_low_20 = false;
            row.feat_broke_high_20 = false;
            row.feat_broke_low_20 = false;
            row.feat_breakout_dist_atr_20 = 0;
        }

        // 10-bar lookback (wider net for sweeps)
        const local10 = getRollingHighLow(rows, i, 10);
        if (local10.high !== null) {
            row.feat_sweep_above_high_10 = (row.high > local10.high) && (row.close <= local10.high) && (row.open <= local10.high);
            row.feat_sweep_below_low_10 = (row.low < local10.low) && (row.close >= local10.low) && (row.open >= local10.low);
            row.feat_broke_high_10 = row.close > local10.high;
            row.feat_broke_low_10 = row.close < local10.low;
        } else {
            row.feat_sweep_above_high_10 = false;
            row.feat_sweep_below_low_10 = false;
            row.feat_broke_high_10 = false;
            row.feat_broke_low_10 = false;
        }

        // Breakout Failure (failed acceptance): bar T closes above 10-bar high,
        // checked at bar T+1 if it closes back below. Flagged on bar T+1.
        row.feat_breakout_failure_high = false;
        row.feat_breakout_failure_low = false;
        if (i > 0) {
            const prev = rows[i - 1];
            if (prev.feat_broke_high_10 && row.close <= (local10.high !== null ? local10.high : Infinity)) {
                row.feat_breakout_failure_high = true;
            }
            if (prev.feat_broke_low_10 && row.close >= (local10.low !== null ? local10.low : -Infinity)) {
                row.feat_breakout_failure_low = true;
            }
        }

        // --- 5. Candle Exhaustion Pattern ---
        // 3+ consecutive directional candles followed by a reversal candle
        // (body shrinking + wick growing = rejection)
        row.feat_bull_exhaustion_pattern = false;
        row.feat_bear_exhaustion_pattern = false;
        if (i >= 3) {
            const prev = rows[i - 1];
            // Bull exhaustion: 3+ bull candles, current bar is bearish with body shrinkage and wick growth
            if (prev.feat_consecutive_bull >= 3 && !isBull && row.feat_body_shrinkage < 0.7 && row.feat_wick_growth > 1.5) {
                row.feat_bull_exhaustion_pattern = true;
            }
            // Bear exhaustion: 3+ bear candles, current bar is bullish with body shrinkage and wick growth
            if (prev.feat_consecutive_bear >= 3 && isBull && row.feat_body_shrinkage < 0.7 && row.feat_wick_growth > 1.5) {
                row.feat_bear_exhaustion_pattern = true;
            }
        }

        // --- 6. Regime Classification ---
        row.feat_regime = classifyRegime(row, rows.slice(Math.max(0, i - 20), i));
    }
    
    return rows;
}

module.exports = {
    processAssetData
};
