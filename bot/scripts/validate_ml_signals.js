'use strict';

/**
 * ML Gate Signal Validator — Drop-in replacement for validate-signals.js
 *
 * Validates ML_REVERSAL_GATE_* signals at 15m (3 bars) horizon only.
 * Writes outcomes to signal_outcomes table for MCP analysis tools.
 *
 * Uses per-asset leak-proof logic (same as test-ml-gate.mjs):
 *   - Per-asset ordered candle series (no cross-asset contamination)
 *   - Position-based lookups (gap-safe, never steps to different asset)
 *   - Direction validated against fade logic
 */

const DEFAULT_PAYOUT_RATE = 0.92;

/**
 * Build per-asset ordered candle series (leak-proof structure)
 */
function buildAssetSeries(candles) {
  const byAsset = new Map();
  for (const c of candles) {
    if (!byAsset.has(c.asset)) byAsset.set(c.asset, []);
    byAsset.get(c.asset).push(c);
  }
  for (const arr of byAsset.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  const posByKey = new Map();
  for (const [a, arr] of byAsset) {
    arr.forEach((c, p) => posByKey.set(`${a}|${c.timestamp}`, p));
  }
  return { byAsset, posByKey };
}

/**
 * Validate direction against fade logic
 */
function validateDirection(signal, byAsset, posByKey) {
  const arr = byAsset.get(signal.asset);
  const p = posByKey.get(`${signal.asset}|${signal.timestamp}`);
  if (arr == null || p == null || p < 3) return null;
  const recentMove = signal.close - arr[p - 3].close;
  if (recentMove === 0) return null;
  return recentMove > 0 ? 'PUT' : 'CALL';
}

/**
 * Get outcome at 15m (stepsAhead=3)
 */
function getOutcome15m(signal, byAsset, posByKey) {
  const arr = byAsset.get(signal.asset);
  const p = posByKey.get(`${signal.asset}|${signal.timestamp}`);
  if (arr == null || p == null || p + 3 >= arr.length) return null;

  const futureCandle = arr[p + 3];
  const exitPrice = futureCandle.close;
  const moved = exitPrice > signal.close;

  if (signal.direction === 'CALL') return moved ? 'WIN' : 'LOSS';
  if (signal.direction === 'PUT') return !moved ? 'WIN' : 'LOSS';
  return null;
}

/**
 * Validate ML signals at 15m horizon — replaces validatePendingSignals
 * @param {Object} database - TradingDatabase instance
 * @param {number} lookAheadSeconds - Option expiry (60 for 5m candle = 15m at 3-bar horizon)
 * @param {number} tradeAmount - Stake for P/L calculation
 * @param {Object} [options] - { payoutRate, referenceNowSeconds, staleHours, logNoPending }
 * @returns {Promise<{ validated: number, skipped: number, pendingCount: number, skipReasons: object }>}
 */
async function validatePendingSignals(database, lookAheadSeconds, tradeAmount, options = {}) {
  const nowSeconds = options.referenceNowSeconds || Math.floor(Date.now() / 1000);
  const payoutRate = options.payoutRate || DEFAULT_PAYOUT_RATE;
  const logNoPending = options.logNoPending !== false;

  // Load ML gate signals (CALL/PUT only) that don't have outcomes yet
  const pendingSignals = await database.all(
    `SELECT s.id, s.asset, s.timestamp, s.direction, s.strategy_used, c.close
     FROM signals s
     JOIN candles c ON s.asset = c.asset AND s.timestamp = c.timestamp
     LEFT JOIN signal_outcomes so ON s.id = so.signal_id
     WHERE s.direction IN ('CALL', 'PUT')
       AND s.strategy_used LIKE 'ML_REVERSAL_GATE%'
       AND so.signal_id IS NULL
       AND s.timestamp <= ?
     ORDER BY s.asset ASC, s.timestamp ASC`,
    [nowSeconds - lookAheadSeconds]
  );

  if (pendingSignals.length === 0 && logNoPending) {
    console.log('[ML-Validation] No pending ML signals past expiry.');
    return { validated: 0, skipped: 0, pendingCount: 0, skipReasons: {} };
  }

  // Load all candles for per-asset series
  const allCandles = await database.all(
    `SELECT timestamp, asset, close, open, high, low FROM candles ORDER BY asset ASC, timestamp ASC`
  );
  const { byAsset, posByKey } = buildAssetSeries(allCandles);

  let validated = 0;
  let skipped = 0;
  const skipReasons = { direction_mismatch: 0, no_future_candle: 0 };

  for (const sig of pendingSignals) {
    // Validate direction against fade logic
    const fadeDir = validateDirection(sig, byAsset, posByKey);
    if (fadeDir !== sig.direction) {
      skipped++;
      skipReasons.direction_mismatch++;
      continue;
    }

    // Get outcome at 15m horizon
    const result = getOutcome15m(sig, byAsset, posByKey);
    if (result == null) {
      skipped++;
      skipReasons.no_future_candle++;
      continue;
    }

    // Get exit price (15m ahead = 3 bars in 5m chart)
    const arr = byAsset.get(sig.asset);
    const p = posByKey.get(`${sig.asset}|${sig.timestamp}`);
    const exitCandle = arr[p + 3];
    const exitPrice = exitCandle.close;
    const exitTimestamp = exitCandle.timestamp;

    // Calculate P/L
    const profitLoss = result === 'WIN'
      ? (tradeAmount * payoutRate)
      : (result === 'LOSS' ? -tradeAmount : 0);

    // Write to signal_outcomes
    await database.insertSignalOutcome(
      sig.asset, sig.timestamp, sig.id,
      sig.direction, sig.close,
      exitTimestamp, exitPrice, result, profitLoss
    );

    validated++;
  }

  if (skipped > 0 && Object.values(skipReasons).some(v => v > 0)) {
    console.log('[ML-Validation] Skipped: direction_mismatch=' + (skipReasons.direction_mismatch || 0) +
      ', no_future_candle=' + (skipReasons.no_future_candle || 0));
  }

  return { validated, skipped, pendingCount: pendingSignals.length, skipReasons };
}

module.exports = { validatePendingSignals, DEFAULT_PAYOUT_RATE };
