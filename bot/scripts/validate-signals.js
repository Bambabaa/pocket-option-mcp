/**
 * validate-signals.js — Determ Bot Signal Validator
 *
 * Shared validation: signals → qualification_outcomes + streak + qualified_assets
 * Ported from ML_MODEL/validate-signals-to-trades.js with determ-specific table names
 * (signals, candles, prices — no _ml suffix).
 *
 * Used by:
 *  - pocket-option-bot.js  (integrated validation loop every N seconds)
 *  - scripts/paper-trading-tracker.js (batch post-run validation)
 *
 * Does NOT enqueue or write trades_ordered. Those are exclusively written by:
 *  - order-executor.js (live PO result sync → insertOrderedTradeClosed)
 *
 * See ML_MODEL/TRADES_VALIDATION_AND_BLOCKLIST.md §6 Three-Layer Design.
 */

'use strict';

const DEFAULT_PAYOUT_RATE = 0.92;
const PRICE_TOLERANCE = 5;

/**
 * Validate a single signal: lookup entry/exit candle, compute result,
 * write qualification_outcomes + streak + qualified_assets.
 *
 * @param {object} database     - TradingDatabase instance (initialized)
 * @param {object} signal       - Row from signals table: { id, asset, timestamp, direction }
 * @param {number} lookAheadSeconds - Option expiry (e.g. 60)
 * @param {number} tradeAmount  - Stake for P/L calculation
 * @param {number} [payoutRate] - Win payout multiplier (default 0.92)
 * @param {object} [options]
 * @param {boolean} [options.writeQualification=true]     - Write to qualification_outcomes + streak + qualified_assets
 * @param {number}  [options.minConsecutiveWinsForTrading=2] - Wins needed to qualify an asset
 * @returns {Promise<object|null>} { result, exitPrice, exitTimestamp, profitLoss, newStreak, qualified,
 *                                   wasQualifiedBefore, isQualifiedAfter, shouldEnqueue }
 *                                 or { skipped: true, reason: string }
 */
async function validateOneSignal(database, signal, lookAheadSeconds, tradeAmount, payoutRate = DEFAULT_PAYOUT_RATE, options = {}) {
    const {
        writeQualification = true,
        minConsecutiveWinsForTrading = 2
    } = options;

    // Normalize timestamp to seconds (DB stores seconds; signal.timestamp may be ms)
    const signalTsSeconds = signal.timestamp > 1e12 ? Math.floor(signal.timestamp / 1000) : signal.timestamp;

    // Capture qualification state BEFORE applying this outcome.
    // assets_trades only records outcomes where the asset was ALREADY qualified
    // (i.e. the 3rd+ signal while on a streak, not the trade that created the streak).
    const wasQualifiedBefore = writeQualification
        ? await database.isAssetQualified(signal.asset)
        : false;

    // --- Entry candle ---
    const entryCandle = await database.get(
        'SELECT * FROM candles WHERE asset = ? AND timestamp = ?',
        [signal.asset, signalTsSeconds]
    );
    if (!entryCandle) return { skipped: true, reason: 'no_entry_candle' };

    // --- Exit price ---
    const expirationTime = signalTsSeconds + lookAheadSeconds;
    const adjustedTolerance = Math.min(PRICE_TOLERANCE, Math.max(1, Math.floor(lookAheadSeconds / 2)));
    const minTimestamp = signalTsSeconds + 1;

    let exitPriceData = null;
    if (typeof database.getPriceAtTimestamp === 'function') {
        exitPriceData = await database.getPriceAtTimestamp(
            signal.asset, expirationTime, adjustedTolerance, minTimestamp
        );
    }

    let exitPrice, exitTimestamp;
    if (exitPriceData) {
        exitPrice = exitPriceData.price;
        exitTimestamp = exitPriceData.timestamp;
    } else {
        // Fallback: closest candle close near expiration time
        const exitCandle = await database.get(
            `SELECT * FROM candles
             WHERE asset = ? AND timestamp >= ? AND timestamp <= ?
             ORDER BY ABS(timestamp - ?) ASC LIMIT 1`,
            [signal.asset, signalTsSeconds, expirationTime + 60, expirationTime]
        );
        if (!exitCandle) return { skipped: true, reason: 'no_exit_price' };
        exitPrice = exitCandle.close;
        exitTimestamp = exitCandle.timestamp;
    }

    // --- Result ---
    const entryPrice = entryCandle.close;
    const priceChange = exitPrice - entryPrice;
    let result = 'DRAW';
    if (signal.direction === 'CALL' && priceChange > 0) result = 'WIN';
    else if (signal.direction === 'CALL' && priceChange < 0) result = 'LOSS';
    else if (signal.direction === 'PUT' && priceChange < 0) result = 'WIN';
    else if (signal.direction === 'PUT' && priceChange > 0) result = 'LOSS';

    const profitLoss = result === 'WIN'
        ? (tradeAmount * payoutRate)
        : (result === 'LOSS' ? -tradeAmount : 0);

    let newStreak = 0;
    let qualified = false;

    if (writeQualification) {
        // Layer 1: qualification_outcomes (every signal validated, track streak)
        await database.insertQualificationOutcome(
            signal.asset, signalTsSeconds, signal.id || null,
            signal.direction, entryPrice,
            exitTimestamp, exitPrice, result, profitLoss
        );

        // Layer 2: streak → qualified_assets
        newStreak = await database.updateAssetStreakAfterOutcome(signal.asset, result, signalTsSeconds);
        if (newStreak >= minConsecutiveWinsForTrading) {
            await database.addQualifiedAsset(signal.asset, newStreak);
            qualified = true;
        } else if (result !== 'WIN') {
            await database.removeQualifiedAsset(signal.asset);
        }

        // Layer 3: assets_trades — only when asset was ALREADY qualified before this outcome.
        // The trade that CREATES the streak is NOT written here; only trades taken while
        // the asset is already on the qualified list are written (3rd+, etc.).
        if (wasQualifiedBefore) {
            await database.insertAssetsTrade(
                signal.asset, signalTsSeconds, signal.id || null,
                signal.direction, entryPrice,
                exitTimestamp, exitPrice, result, profitLoss
            );
        }
    }

    const isQualifiedAfter = writeQualification ? await database.isAssetQualified(signal.asset) : wasQualifiedBefore;
    const shouldEnqueue = wasQualifiedBefore; // metadata only; enqueue happens at signal-generation time

    return { result, exitPrice, exitTimestamp, profitLoss, newStreak, qualified, wasQualifiedBefore, isQualifiedAfter, shouldEnqueue };
}

/** @returns {boolean} true if outcome is a skip (no row written) */
function isSkipOutcome(out) {
    return out && out.skipped === true;
}

/**
 * Find signals past expiry without a qualification outcome, validate each, update qualification chain.
 *
 * @param {object} database          - TradingDatabase instance
 * @param {number} lookAheadSeconds  - Option expiry (e.g. 60)
 * @param {number} tradeAmount       - Stake for P/L
 * @param {object} [options]
 * @param {boolean} [options.writeQualification=true]
 * @param {number}  [options.minConsecutiveWinsForTrading=2]
 * @param {number}  [options.payoutRate]
 * @param {boolean} [options.logNoPending=true]
 * @param {number}  [options.referenceNowSeconds]  - Override "now" with data time (backfill)
 * @param {number}  [options.staleHours=0]         - When >0, exclude in-flight orders older than N hours from block
 * @returns {Promise<{ validated: number, skipped: number, pendingCount: number, skipReasons: object }>}
 */
async function validatePendingSignals(database, lookAheadSeconds, tradeAmount, options = {}) {
    let nowSeconds = options.referenceNowSeconds;
    if (nowSeconds == null || typeof nowSeconds !== 'number') {
        nowSeconds = Math.floor(Date.now() / 1000);
    }
    const staleHours = options.staleHours != null ? options.staleHours : 0;
    const payoutRate = options.payoutRate != null ? options.payoutRate : DEFAULT_PAYOUT_RATE;
    const logNoPending = options.logNoPending !== false;

    const signals = await database.getPendingSignalsPastExpiry(lookAheadSeconds, nowSeconds, staleHours);

    let validated = 0;
    let skipped = 0;
    const skipReasons = { no_entry_candle: 0, no_exit_price: 0 };

    if (signals.length === 0 && logNoPending) {
        if (typeof database.getPendingSignalsDiagnostics === 'function') {
            const diag = await database.getPendingSignalsDiagnostics(lookAheadSeconds, nowSeconds);
            console.log('[Validation] No pending signals. Diagnostics: CALL/PUT signals=' + diag.totalCallPut +
                ', with qualification_outcome=' + diag.withOutcome +
                ', past expiry (ts<=' + diag.expiryCutoff + ')=' + diag.pastExpiry +
                ', pending=' + diag.pending +
                (diag.sampleTimestamp != null ? ', latest signal ts=' + diag.sampleTimestamp : '') +
                ', now=' + diag.nowSeconds + '.');
            if (diag.totalCallPut > 0 && diag.pastExpiry === 0) {
                if (diag.sampleTimestamp != null && diag.sampleTimestamp > diag.nowSeconds) {
                    console.log('[Validation] Hint: Signal timestamps are ahead of system clock. Use referenceNowSeconds.');
                } else {
                    console.log('[Validation] Hint: All CALL/PUT signals have timestamp > expiry cutoff (too recent or timestamp scale?).');
                }
            }
        } else {
            console.log('[Validation] No pending signals past expiry (signals table may be empty or all already validated).');
        }
    }

    for (const signal of signals) {
        const out = await validateOneSignal(database, signal, lookAheadSeconds, tradeAmount, payoutRate, options);
        if (isSkipOutcome(out)) {
            skipped++;
            if (out.reason) skipReasons[out.reason] = (skipReasons[out.reason] || 0) + 1;
        } else if (out) {
            validated++;
        } else {
            skipped++;
        }
    }

    if (skipped > 0 && (skipReasons.no_entry_candle > 0 || skipReasons.no_exit_price > 0)) {
        console.log('[Validation] Skipped: no_entry_candle=' + (skipReasons.no_entry_candle || 0) +
            ', no_exit_price=' + (skipReasons.no_exit_price || 0));
    }

    return { validated, skipped, pendingCount: signals.length, skipReasons };
}

module.exports = { validateOneSignal, validatePendingSignals, DEFAULT_PAYOUT_RATE };
