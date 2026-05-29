'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  ws-replay.js
//
//  Simulates the bot's WebSocket → candle-finalize pipeline using pre-recorded
//  OHLC candles from agent.db.
//
//  Source candles in agent.db are 5-minute bars. This script aggregates them
//  into 15-minute bars at candle close before feeding the pipeline.
//
//  Aggregation: 3 × 5m bars → 1 × 15m bar
//    open  = first 5m bar's open
//    high  = max of all three highs
//    low   = min of all three lows
//    close = last 5m bar's close
//    ts    = floor(first_ts / 900) * 900  (15m boundary)
//
//  What this replicates exactly:
//    pocket-option-bot.js lines 736-896 (candle finalize path):
//      insertCandle → push STATE.CANDLES → calculateAll → insertIndicators
//      → strategy.evaluate → insertSignal → enqueueOrder
//
//  Usage:
//    node tests/ws-replay.js
//    node tests/ws-replay.js --asset EURUSD_otc
//    node tests/ws-replay.js --asset EURUSD_otc --dry-run
//    node tests/ws-replay.js --limit 500          (cap 15m candles per asset)
//    node tests/ws-replay.js --verbose
//
//  Output: writes to data/trading_data.db (same file the live bot uses).
//          Use --dry-run to run the full pipeline without any DB writes.
// ═══════════════════════════════════════════════════════════════════════════════

const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const Indicators       = require('../indicators');
const strategy         = require('../strategy');
const { TradingDatabase } = require('../database');
const { validatePendingSignals } = require('../scripts/validate-signals');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const VERBOSE  = args.includes('--verbose');
const assetArg = (() => { const i = args.indexOf('--asset'); return i !== -1 ? args[i + 1] : null; })();
const limitArg = (() => { const i = args.indexOf('--limit'); return i !== -1 ? parseInt(args[i + 1], 10) : null; })();

// ── Paths ─────────────────────────────────────────────────────────────────────
const AGENT_DB_PATH = path.join(__dirname, '../../agent/data/agent.db');
const BOT_DB_PATH   = path.join(__dirname, '../../data/trading_data.db');

// ── Timeframe ─────────────────────────────────────────────────────────────────
const PERIOD_SECONDS = 900; // 15 minutes (3 × 5m source candles)

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg)    { console.log(msg); }
function vlog(msg)   { if (VERBOSE) console.log(msg); }

/**
 * Aggregate 5-minute source rows into 15-minute candles.
 * Each bucket's timestamp is the 15m period start.
 * @param {Array<{timestamp,open,high,low,close}>} rows - sorted ascending
 * @returns {Array<{timestamp,open,high,low,close}>} 15m candles, sorted ascending
 */
function aggregateTo15m(rows) {
    const buckets = new Map();
    for (const row of rows) {
        const bucketTs = Math.floor(row.timestamp / PERIOD_SECONDS) * PERIOD_SECONDS;
        if (!buckets.has(bucketTs)) {
            buckets.set(bucketTs, {
                timestamp: bucketTs,
                open:  row.open,
                high:  row.high,
                low:   row.low,
                close: row.close
            });
        } else {
            const b = buckets.get(bucketTs);
            b.high  = Math.max(b.high, row.high);
            b.low   = Math.min(b.low,  row.low);
            b.close = row.close; // last bar's close is the 15m close
        }
    }
    return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// ── Promisified agent.db helpers ──────────────────────────────────────────────
function agentAll(db, sql, params = []) {
    return new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    log('\n══════════════════════════════════════════════════════════════');
    log('  ws-replay — 15m candle close pipeline replay');
    log(`  Timeframe : 15m  (aggregated from 5m source bars)`);
    if (DRY_RUN) log('  ⚠️  DRY-RUN mode: no writes to trading_data.db');
    log('══════════════════════════════════════════════════════════════\n');

    // 1. Open agent.db (read-only source)
    const agentDb = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(AGENT_DB_PATH, sqlite3.OPEN_READONLY, err =>
            err ? reject(err) : resolve(db));
    });
    log(`✅ Opened agent.db: ${AGENT_DB_PATH}`);

    // 2. Open / initialize trading_data.db (write target)
    let botDb = null;
    if (!DRY_RUN) {
        botDb = new TradingDatabase(BOT_DB_PATH);
        await botDb.initialize();
        log(`✅ Opened trading_data.db: ${BOT_DB_PATH}`);
    } else {
        log('⏭️  Skipping trading_data.db open (dry-run)');
    }

    // 3. Fetch list of assets to replay
    let assetRows;
    if (assetArg) {
        assetRows = [{ asset: assetArg }];
    } else {
        assetRows = await agentAll(agentDb,
            `SELECT DISTINCT asset FROM candles ORDER BY asset`);
    }
    log(`\n📋 Assets to replay: ${assetRows.length}`);

    // ── Shared per-run state (mirrors STATE in pocket-option-bot.js) ──────────
    const CANDLES    = {};   // STATE.CANDLES[asset] = [[ts, open, close, high, low], ...]
    const indicators = new Indicators();
    const MIN_CANDLES = Indicators.getMinCandles();

    // ── Counters ──────────────────────────────────────────────────────────────
    let totalCandles   = 0;
    let totalIndicator = 0;
    let totalSignals   = 0;
    let totalOrders    = 0;
    let maxTs          = 0;   // latest candle timestamp seen — used as referenceNow for validation
    const signalLog    = [];   // {asset, ts, direction, strategy}

    // 4. Replay each asset
    for (const { asset } of assetRows) {
        // Load 5m source candles, aggregate into 15m bars at candle close
        const rawRows = await agentAll(agentDb,
            `SELECT timestamp, open, high, low, close
             FROM candles
             WHERE asset = ?
             ORDER BY timestamp ASC`,
            [asset]);

        let rows = aggregateTo15m(rawRows);
        if (limitArg && rows.length > limitArg) rows = rows.slice(0, limitArg);
        if (rows.length === 0) continue;

        vlog(`\n▶  ${asset}  (${rawRows.length} × 5m → ${rows.length} × 15m candles)`);

        CANDLES[asset] = [];
        indicators._lastSchaffValues = indicators._lastSchaffValues || {};
        indicators._lastSchaffValues[asset] = null; // clear STC state before replay

        let assetSignals = 0;

        for (const row of rows) {
            const { timestamp: ts, open, high, low, close } = row;

            // ── 4a. Write candle to bot DB (mirrors insertCandle in finalize path) ──
            if (!DRY_RUN) {
                try {
                    await botDb.insertCandle(asset, ts, open, high, low, close, 0);
                } catch (err) {
                    if (!err.message?.includes('UNIQUE constraint')) {
                        console.error(`  ❌ insertCandle ${asset}@${ts}: ${err.message}`);
                    }
                }
            }
            totalCandles++;
            if (ts > maxTs) maxTs = ts;

            // ── 4b. Push to CANDLES state as [ts, open, close, high, low] ──────────
            // (bot format: index 0=ts, 1=open, 2=close, 3=high, 4=low)
            CANDLES[asset].push([ts, open, close, high, low]);

            // ── 4c. Guard: need MIN_CANDLES before indicators are valid ─────────────
            if (CANDLES[asset].length < MIN_CANDLES) continue;

            // ── 4d. Calculate indicators ──────────────────────────────────────────
            const ind = indicators.calculateAll(asset, CANDLES[asset]);
            if (!ind) continue;

            if (!DRY_RUN) {
                try {
                    await botDb.insertIndicators(asset, ts, ind);
                    totalIndicator++;
                } catch (err) {
                    if (!err.message?.includes('UNIQUE constraint')) {
                        console.error(`  ❌ insertIndicators ${asset}@${ts}: ${err.message}`);
                    }
                }
            } else {
                totalIndicator++;
            }

            // ── 4e. Evaluate strategy ─────────────────────────────────────────────
            const signal = strategy.evaluate(ind);
            if (!signal) continue;

            totalSignals++;
            assetSignals++;
            signalLog.push({ asset, ts, direction: signal.direction, strategyUsed: signal.strategyUsed });
            vlog(`  🔔 Signal: ${asset} @ ${new Date(ts * 1000).toISOString()}  ${signal.direction}  [${signal.strategyUsed}]`);
            vlog(`     reasons: ${signal.reasons?.join(' | ')}`);

            if (!DRY_RUN) {
                // ── 4f. Insert signal ──────────────────────────────────────────────
                let sigId = null;
                try {
                    const sigResult = await botDb.insertSignal(asset, ts, signal);
                    sigId = sigResult?.id;
                } catch (err) {
                    if (!err.message?.includes('UNIQUE constraint')) {
                        console.error(`  ❌ insertSignal ${asset}@${ts}: ${err.message}`);
                    }
                }

                // ── 4g. Enqueue order (mirrors bot: skip if in-flight) ─────────────
                if (sigId) {
                    const inFlight = await botDb.hasAssetInFlightLiveOrder(asset);
                    if (!inFlight) {
                        try {
                            await botDb.enqueueOrder(sigId, asset, signal.direction, ts);
                            totalOrders++;
                        } catch (err) {
                            if (!err.message?.includes('UNIQUE constraint')) {
                                console.error(`  ❌ enqueueOrder ${asset}@${ts}: ${err.message}`);
                            }
                        }
                    } else {
                        vlog(`  ⏭️  In-flight order exists for ${asset} — skipping enqueue`);
                    }
                }
            } else {
                totalOrders++;
            }
        }

        if (assetSignals > 0 || VERBOSE) {
            log(`  ${asset.padEnd(18)} 15m_candles=${rows.length}  signals=${assetSignals}`);
        }
    }

    // 5. Validate signal outcomes at 15m expiry (non-dry-run only)
    let validated = 0, validSkipped = 0;
    if (!DRY_RUN && totalSignals > 0 && maxTs > 0) {
        log(`\n⏱️  Running 15m expiry validation (referenceNow=${new Date(maxTs * 1000).toISOString()})...`);
        const vResult = await validatePendingSignals(botDb, PERIOD_SECONDS, 1.00, {
            referenceNowSeconds: maxTs,
            logNoPending: false
        });
        validated    = vResult.validated ?? 0;
        validSkipped = vResult.skipped   ?? 0;
        log(`✅ Validation done: ${validated} validated, ${validSkipped} skipped`);
    }

    // 6. Close connections
    agentDb.close();
    if (botDb) await botDb.close();

    // 7. Summary
    log(`\n${'═'.repeat(62)}`);
    log(`  REPLAY SUMMARY`);
    log(`${'─'.repeat(62)}`);
    log(`  15m candles processed : ${totalCandles}`);
    log(`  Indicator rows        : ${totalIndicator}`);
    log(`  Signals fired         : ${totalSignals}`);
    log(`  Orders enqueued       : ${totalOrders}`);
    log(`  Validated (15m expiry): ${DRY_RUN ? 'N/A (dry-run)' : validated}`);
    log(`  Validation skipped    : ${DRY_RUN ? 'N/A (dry-run)' : validSkipped}`);
    if (DRY_RUN) log(`  Mode                  : DRY-RUN (no writes)`);
    log(`${'═'.repeat(62)}\n`);

    if (signalLog.length > 0) {
        log('  SIGNAL DETAIL');
        log(`${'─'.repeat(62)}`);
        signalLog.forEach(s =>
            log(`  ${new Date(s.ts * 1000).toISOString().slice(0, 16)}  ${s.direction.padEnd(5)}  ${s.strategyUsed.padEnd(28)}  ${s.asset}`));
        log(`${'─'.repeat(62)}\n`);
    }
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
