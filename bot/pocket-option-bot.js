// Pocket Option Trading Bot - Based on Python bot approach
// Uses Puppeteer to automate browser and intercept WebSocket messages

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();
const Indicators = require('./indicators');
const { TradingDatabase, initMcpSchema } = require('./database');
const { executeOneOrder, syncLiveTradeResultsFromDOM, resetSessionCalibration, getBalanceFromDOM } = require('./scripts/order-executor');
const { validatePendingSignals } = require('./scripts/validate-signals');
const CONFIG = require('./config');
const strategy = require('./strategy');

// ============================================================================
// MCP ORDERS WORKER
// Polls ../data/mcp.db for PENDING manual orders placed via `po trade` and
// executes them through the same execution path as bot-generated signals.
// ============================================================================
const MCP_DB_PATH = path.join(__dirname, '../data/mcp.db');
let _mcpDb = null;

function getMcpDb() {
    if (_mcpDb) return _mcpDb;
    if (!fs.existsSync(MCP_DB_PATH)) return null; // MCP server not started yet — silently skip
    _mcpDb = new sqlite3.Database(MCP_DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
        if (err) {
            console.error(`[MCP-WORKER] Failed to open MCP DB: ${err.message}`);
            _mcpDb = null;
        }
    });
    return _mcpDb;
}

function mcpDbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getMcpDb();
        if (!db) return resolve([]);
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function mcpDbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getMcpDb();
        if (!db) return resolve({ changes: 0 });
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

async function isAssetBlocked(asset) {
    const now = Math.floor(Date.now() / 1000);
    const rows = await mcpDbAll(
        `SELECT reason FROM asset_controls
         WHERE active = 1
           AND (asset = ? OR asset = 'ALL')
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        [asset, now]
    );
    return rows[0] || null;
}

async function runMcpOrdersWorker(page) {
    const exec = STATE.SETTINGS.execution;
    if (!exec?.enabled) return; // Only run when live execution is on

    let pending;
    try {
        pending = await mcpDbAll(
            `SELECT * FROM mcp_orders WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 5`
        );
    } catch (e) {
        return; // DB not ready yet — skip silently
    }

    for (const row of pending) {
        const order = {
            id: `mcp-${row.id}`,
            signal_id: null,
            asset: row.asset,
            direction: row.direction,
            signal_timestamp: row.signal_ts,
        };

        const config = {
            tradeAmount: row.amount || STATE.SETTINGS.tradeAmount || 1,
            skipQualifiedGate: true, // Manual orders bypass the qualification layer
            riskMax: null,
            page,
            execution: exec,
            requireLiveExecution: true,
        };

        // Atomically claim the row using a transitional status — prevents double-pickup
        // on the next poll cycle without tripping executeOneOrder's EXECUTED early-exit guard.
        try {
            const claim = await mcpDbRun(
                `UPDATE mcp_orders SET status = 'SKIPPED', status_reason = 'claimed-for-execution', updated_at = strftime('%s','now') WHERE id = ? AND status = 'PENDING'`,
                [row.id]
            );
            if (!claim.changes) continue; // Another process claimed it first
        } catch (e) {
            console.log(`[MCP-WORKER] Could not claim order ${row.id}: ${e.message}`);
            continue;
        }

        // Asset block check — respects asset_controls written by Claude/agents.
        // Runs after claim so the row is owned; writes final SKIPPED status if blocked.
        const blockEntry = await isAssetBlocked(row.asset);
        if (blockEntry) {
            log(`[BLOCK] MCP order ${row.id} skipped — ${row.asset} is blocked: ${blockEntry.reason}`, 'yellow');
            await mcpDbRun(
                `UPDATE mcp_orders SET status = 'SKIPPED', status_reason = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                [`asset-blocked: ${blockEntry.reason}`, row.id]
            );
            continue;
        }

        // Shim database: delegates price lookups to the real bot DB,
        // routes status updates back to mcp_orders instead of orders_queue.
        // get() intercepts the orders_queue status check inside executeOneOrder and
        // returns the current mcp_orders row so the status guard works correctly.
        const shimDb = {
            hasOrderedTradeForOrder: async () => false,
            get: async (sql, params) => {
                // executeOneOrder checks: SELECT status FROM orders_queue WHERE id = ?
                // Redirect that to mcp_orders using the real numeric row id
                if (/orders_queue/i.test(sql)) {
                    return mcpDbAll(`SELECT * FROM mcp_orders WHERE id = ?`, [row.id])
                        .then(rows => rows[0] || null);
                }
                return database.get(sql, params);
            },
            getPrices: async (asset, n) => database.getPrices(asset, n),
            getPriceAtTimestamp: async (a, ts, w) => database.getPriceAtTimestamp(a, ts, w),
            getSignalById: async () => null,
            isAssetQualified: async () => true,
            hasAssetInFlightLiveOrder: async () => false,
            updateOrderStatus: async (id, status, reason) => {
                await mcpDbRun(
                    `UPDATE mcp_orders SET status = ?, status_reason = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                    [status, reason, row.id]
                );
            },
            insertOrderedTradeClosed: async () => { },
        };

        try {
            const result = await executeOneOrder(shimDb, order, config);
            console.log(`[MCP-WORKER] Order ${row.id} ${row.asset} ${row.direction}: ${result}`);
        } catch (e) {
            console.error(`[MCP-WORKER] Order ${row.id} failed: ${e.message}`);
            try {
                await mcpDbRun(
                    `UPDATE mcp_orders SET status = 'FAILED', status_reason = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                    [e.message, row.id]
                );
            } catch (_) { }
        }
    }
}

const executionQueue = [];
let executionWorkerRunning = false;

/** 
 * WebSocket Message Queue: Processes all incoming data sequentially.
 * This prevents intensive parallel operations (history flood/batch inserts) 
 * from starving the event loop and blocking the Order Executor.
 */
const messageTaskQueue = [];
let messageWorkerRunning = false;

async function runMessageWorker(page) {
    if (messageWorkerRunning || messageTaskQueue.length === 0) return;
    messageWorkerRunning = true;
    while (messageTaskQueue.length > 0) {
        const { payload, page } = messageTaskQueue.shift();
        try {
            await processWebSocketMessage(payload, page);
        } catch (err) {
            console.error(`   [MSG-QUEUE] Error:`, err.message);
        }
    }
    messageWorkerRunning = false;
}

/**
 * Price Batch Buffer: Accumulates per-tick price updates to reduce database IO pressure.
 * Flushed every 10 seconds or when 200 items accumulated.
 */
const priceBatchBuffer = [];
let lastBatchFlush = Date.now();
const BATCH_SIZE_LIMIT = 200;
const BATCH_TIME_LIMIT_MS = 10000;

async function flushPriceBatch(database) {
    if (priceBatchBuffer.length === 0) return;
    const items = [...priceBatchBuffer];
    priceBatchBuffer.length = 0;
    try {
        await database.insertPriceBatch(items);
        // console.log(`   [BATCH] Flushed ${items.length} prices to database`);
    } catch (err) {
        console.error(`   [BATCH] Flush failed:`, err.message);
    }
    lastBatchFlush = Date.now();
}

async function runExecutionWorker(page) {
    if (executionWorkerRunning || executionQueue.length === 0) return;
    executionWorkerRunning = true;
    while (executionQueue.length > 0) {
        const { database, order, config } = executionQueue.shift();
        try {
            await executeOneOrder(database, order, { ...config, page });
        } catch (err) {
            console.error(`   [QUEUE] Execute ${order?.asset} failed:`, err.message);
        }
    }
    executionWorkerRunning = false;
}

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    bright: '\x1b[1m',
};

// Temporary debug toggle for OHLC aggregation
const DEBUG_OHLC = false;

function formatTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

// Converts a WebSocket timestamp to local time (UTC-5) for display purposes.
// Actual timezone conversion for DB storage is handled in database.js via toLocalTimestamp().
// Maintains original function name (convertToUTC6) for compatibility.
function convertToUTC6(timestamp) {
    if (timestamp < 1e12) {
        timestamp *= 1000;
    }
    // Offset set to 0 — DB handles timezone conversion
    const OFFSET_SECONDS = 0;
    const offsetMs = OFFSET_SECONDS * 1000;
    const corrected = new Date(timestamp + offsetMs);
    return Math.floor(corrected.getTime() / 1000);
}

// Converts any timestamp (ms or s) to a formatted America/Chicago time string for display.
function convertToChicagoTime(timestamp) {
    if (timestamp < 1e12) {
        timestamp *= 1000;
    }
    const date = new Date(timestamp);

    // Intl.DateTimeFormat provides robust timezone formatting.
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

function log(msg, color = 'reset') {
    // Prevent logging undefined, null, or the string "undefined"
    if (msg === undefined || msg === null) {
        return; // Don't log undefined/null values
    }

    // Convert to string and check for "undefined" string
    const message = String(msg);
    if (message === 'undefined' || message.trim() === 'undefined') {
        return; // Don't log the string "undefined"
    }

    const timestamp = formatTimestamp();
    console.log(`${colors[color]}[${timestamp}] ${message}${colors.reset}`);
}

function shouldProcessAsset(asset) {
    if (!asset) return false;
    if (!STATE.SELECTED_ASSETS || STATE.SELECTED_ASSETS.size === 0) return true;
    return STATE.SELECTED_ASSETS.has(asset);
}

async function setupAssetSelectionCapture(page) {
    // Expose a function to receive asset selection events from the page
    await page.exposeFunction('botAssetSelected', (asset) => {
        if (!asset) return;
        STATE.SELECTED_ASSETS.add(asset);
        log(`[ASSET SELECTED] ${asset}`, 'yellow');
    });

    // Inject a click listener to capture asset selections
    await page.evaluate(() => {
        const handler = (ev) => {
            const el = ev.target.closest('[data-asset],[data-symbol],[data-asset-id],.asset-item,.symbol-item');
            if (!el) return;
            let asset =
                el.getAttribute('data-asset') ||
                el.getAttribute('data-symbol') ||
                el.getAttribute('data-asset-id') ||
                (el.textContent || '').trim();
            if (asset) {
                window.botAssetSelected(asset);
            }
        };
        document.addEventListener('click', handler, { capture: true });
    });
}

async function waitForAssetConfirmation() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question('✅ Asset selection: click assets in the UI, then press Enter here to confirm...\n', () => {
            rl.close();
            resolve();
        });
    });
}

// Global state 
const STATE = {
    ASSETS: {},
    CANDLES: {},
    CURRENT_CANDLE: {},          // In-memory building candle per asset
    CURRENT_CANDLE_START: {},    // Period start timestamp per asset
    CURRENT_CANDLE_TICKS: {},    // Number of price ticks received for current candle
    LAST_PRICE_UPDATE: {},       // Last price update time per asset (ms) - for 5s throttle
    SELECTED_ASSETS: new Set(),  // Assets explicitly selected via UI
    ACTIONS: {},
    CURRENT_ASSET: null,
    PERIOD: CONFIG.candle.period,
    PRICES: {},
    AUTHENTICATED: false,
    INDICATORS: {},
    lastIndicatorUpdate: {},        // per-asset intra-bar refresh timestamps
    // ============================================================================
    // BOT SETTINGS —  STRATEGY ONLY (Katie Tutorials / YouTube videos)
    // ============================================================================
    // Pipeline uses only  strategy tier (see docs/youtube_strategies.md).
    // No other strategies (e.g. vote-based MA/RSI/MACD) are used.
    // ============================================================================
    SETTINGS: {
        // ----------  Strategy () ----------
        Strategy: ' ',                 
       
        enqueueAllSignalsForTesting: false,
        executeInlineWithBot: true,
        tradeAmount: CONFIG.execution.tradeAmount,

        // Validation loop: runs every N seconds to fill signal_outcomes for analysis
        enableValidationLoop: true,
        validationLoopIntervalMs: 60000,
        lookAheadSeconds: CONFIG.candle.lookAheadSeconds,

        // Execution Settings (Live trades only)
        execution: {
            enabled:                  true,
            maxDailyTrades:           CONFIG.execution.maxDailyTrades,
            minPayout:                CONFIG.execution.minPayout,
            tradeDelayMs:             CONFIG.execution.tradeDelayMs,
            buttonWaitTimeoutMs:      CONFIG.execution.buttonWaitTimeoutMs,
            postAssetSelectWaitMs:    CONFIG.execution.postAssetSelectWaitMs,
            useEvaluateClick:         CONFIG.execution.useEvaluateClick,
            resultSyncIntervalMs:     CONFIG.execution.resultSyncIntervalMs,
            resultSyncFirstDelayMs:   CONFIG.execution.resultSyncFirstDelayMs,
            resultSyncStaleHours:     CONFIG.execution.resultSyncStaleHours,
            expirationSec:            CONFIG.execution.expirationSec,
            placeOrderTimeoutMs:      CONFIG.execution.placeOrderTimeoutMs,
        }
    }
};

// Initialize indicators calculator
const indicators = new Indicators();

// Initialize database — uses ../data/ so both bot and MCP server share the same directory
const database = new TradingDatabase(path.join(__dirname, '../data/trading_data.db'));

// Pocket Option URL
const POCKET_OPTION_URL = 'https://pocketoption.com';

async function setupBrowser() {
    log('Launching browser...', 'cyan');

    const browser = await puppeteer.launch({
        headless: false, // Show browser
        // protocolTimeout: 600000, // 10 min - avoid "Runtime.callFunctionOn timed out" on heavy trading pages
        args: [
            '--remote-debugging-port=9222',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox'
        ],
        defaultViewport: null,
        // defaultViewport: {
        //     width: 960,
        //     height: 540
        // }
    });

    log('✅ Browser launched', 'green');
    return browser;
}

async function interceptWebSocket(page) {
    log('Setting up WebSocket interception...', 'cyan');

    let client = null;

    try {
        if (page.isClosed()) {
            log('⚠️  Page is closed, cannot setup WebSocket interception', 'yellow');
            return null;
        }

        client = await page.target().createCDPSession();

        // Silently handle CDP session errors (Target closed is normal on navigation)
        client.on('error', (error) => {
            if (error.message && (error.message.includes('Target closed') ||
                error.message.includes('Session closed'))) {
                // Normal on page reload/navigation - ignore
            } else if (error.message) {
                log(`⚠️  CDP session error: ${error.message.substring(0, 80)}`, 'yellow');
            }
        });

        // Enable necessary domains
        await client.send('Network.enable');
        await client.send('Runtime.enable');
        await client.send('Performance.enable');

        log('✅ Chrome DevTools Protocol enabled', 'green');

        // Intercept WebSocket messages
        client.on('Network.webSocketFrameReceived', async ({ requestId, response }) => {
            try {
                // Decode base64 payload (like Python bot)
                if (response.payloadData) {
                    const payload = Buffer.from(response.payloadData, 'base64').toString('utf-8');
                    messageTaskQueue.push({ payload, page });
                    runMessageWorker(page); // Start worker if not running
                }
            } catch (error) {
                // Not all messages are JSON/base64 - this is normal
            }
        });

        // Also intercept sent messages to detect auth
        client.on('Network.webSocketFrameSent', async ({ requestId, response }) => {
            try {
                if (response.payloadData) {
                    const payload = Buffer.from(response.payloadData, 'base64').toString('utf-8');
                    if (payload.includes('auth') || payload.includes('"auth"')) {
                        log('📤 Authentication message sent', 'cyan');
                    }
                }
            } catch (error) {
                // Ignore errors
            }
        });

        // Monitor WebSocket creation
        client.on('Network.webSocketCreated', ({ requestId, url }) => {
            if (url.includes('socket.io') || url.includes('po.market')) {
                log(`🔌 WebSocket created: ${url}`, 'cyan');
            }
        });

        // Console log passthrough (for debugging WebSocket-related page logs)
        page.on('console', msg => {
            try {
                const text = msg.text();
                if (text.includes('websocket') || text.includes('socket')) {
                    // Log WebSocket related console messages
                }
            } catch (error) {
                // ignore
            }
        });

        return client;

    } catch (error) {
        if (error.message && (error.message.includes('Target closed') ||
            error.message.includes('Session closed') ||
            error.message.includes('Protocol error'))) {
            log(`⚠️  WebSocket interception setup failed (page closed?): ${error.message.substring(0, 80)}`, 'yellow');
        } else {
            log(`❌ WebSocket interception setup error: ${error.message}`, 'red');
        }
        return null;
    }
}

async function processWebSocketMessage(payload, page) {
    try {
        const data = JSON.parse(payload);

        // Handle history data (like Python bot)
        if (data.history !== undefined && data.asset) {
            if (!shouldProcessAsset(data.asset)) {
                return;
            }
            log(`📊 History data received for ${data.asset}`, 'green');

            if (!STATE.CURRENT_ASSET) {
                STATE.CURRENT_ASSET = data.asset;
                log(`   Current asset set to: ${STATE.CURRENT_ASSET}`, 'cyan');
            }

            // Ignore server period changes - keep our fixed period
            // Log when server tries to change period but don't accept it
            if (data.period && STATE.PERIOD !== data.period) {
                log(`   ⚠️  Server requested period change: ${STATE.PERIOD} → ${data.period} (IGNORED - using fixed ${STATE.PERIOD}s)`, 'yellow');
                // Don't change STATE.PERIOD - keep our configured period
                // Don't clear STATE.CANDLES - preserve in-memory data
            }

            // Process candles (reversed like Python bot)
            // Filter to only candles whose timestamp aligns with our fixed period (e.g. 300s)
            // Guards against server sending 1m bars before user has manually set chart to 5m
            const candles = [...(data.candles || [])]
                .reverse()
                .filter(c => c[0] % STATE.PERIOD === 0);

            // Process history data
            if (data.history && Array.isArray(data.history)) {
                for (const [tstamp, value] of data.history) {
                    const rawTimestamp = parseInt(parseFloat(tstamp));
                    const timestamp = rawTimestamp;  // DB layer handles timezone conversion
                    const candle = [timestamp, value, value, value, value];

                    // Update candle based on value
                    candle[2] = value; // close
                    if (value > candle[3]) candle[3] = value; // high
                    if (value < candle[4]) candle[4] = value; // low

                    // Add candle if timestamp matches period
                    if (timestamp % STATE.PERIOD === 0) {
                        const exists = candles.some(c => c[0] === timestamp);
                        if (!exists) {
                            candles.push(candle);
                        }
                    }
                }
            }

            STATE.CANDLES[data.asset] = candles;
            log(`   Processed ${candles.length} candles for ${data.asset}`, 'cyan');

            // Store candles in database (convert timestamps to UTC-6)
            // Skip flat candles (O=H=L=C) from history as they're incomplete
            let storedCandles = 0;
            for (const candle of candles) {
                const open = candle[1];
                const high = candle[3];
                const low = candle[4];
                const close = candle[2];

                // Skip flat candles (incomplete candles with no price movement)
                if (open === high && high === low && low === close) {
                    continue; // Skip this flat candle
                }

                try {
                    await database.insertCandle(
                        data.asset,
                        candle[0], // timestamp converted to UTC-6
                        open,
                        high,
                        low,
                        close,
                        0 // volume (not available yet)
                    );
                    storedCandles++;
                } catch (error) {
                    // Ignore duplicate key errors (candle already exists)
                }
            }
            log(`   Stored ${storedCandles} candles in database for ${data.asset}`, 'cyan');

            // Calculate indicators when we have enough candles
            const minCandles = Indicators.getMinCandles();
            log(`   Checking indicator calculation for ${data.asset}: ${candles.length} candles >= ${minCandles}?`, 'cyan');
            if (candles.length >= minCandles) {
                const indicatorData = indicators.calculateAll(data.asset, candles);
                if (indicatorData) {
                    STATE.INDICATORS[data.asset] = indicatorData;
                    log(`   Indicators calculated for ${data.asset}`, 'magenta');

                    // Store indicators in database (convert timestamp to UTC-6)
                    const lastCandle = candles[candles.length - 1];
                    try {
                        await database.insertIndicators(data.asset, lastCandle[0], indicatorData);
                        log(`   ✅ Indicators stored for ${data.asset}`, 'green');
                    } catch (error) {
                        // Log error but don't spam console - only log if it's not a duplicate
                        if (!error.message || !error.message.includes('UNIQUE constraint')) {
                            console.error(`   ❌ Error inserting indicators for ${data.asset}:`, error.message);
                        }
                    }

                    // Backfill indicator rows for every prior candle that has enough lookback.
                    // Keeps the candles ↔ indicators table 1:1 across restarts (warmup floor unavoidable).
                    // Clear STC history before backfill so pre-reconnect values don't leak into
                    // stc_delta on the first post-reconnect bar.
                    indicators._lastSchaffValues[data.asset] = null;
                    let backfilled = 0;
                    for (let i = minCandles - 1; i < candles.length - 1; i++) {
                        const window = candles.slice(0, i + 1);
                        const ind = indicators.calculateAll(data.asset, window);
                        if (!ind) continue;
                        try {
                            await database.insertIndicators(data.asset, candles[i][0], ind);
                            backfilled++;
                        } catch (err) {
                            if (!err.message || !err.message.includes('UNIQUE constraint')) {
                                console.error(`   ❌ Backfill ${data.asset} @ ${candles[i][0]}: ${err.message}`);
                            }
                        }
                    }
                    // Restore _lastSchaffValues to current bar's STC after backfill loop overwrites it
                    indicators._lastSchaffValues[data.asset] = indicatorData.stc_value ?? null;
                    if (backfilled > 0) log(`   ↩️  Backfilled ${backfilled} historical indicator rows for ${data.asset}`, 'cyan');

                    // Store signal in database if strategy fires
                    const _signal0 = strategy.evaluate(indicatorData);
                    if (_signal0) {
                        try {
                            await database.insertSignal(data.asset, lastCandle[0], _signal0);
                            log(`   ✅ Signal stored for ${data.asset}: ${_signal0.direction}`, 'green');
                        } catch (error) {
                            if (!error.message || !error.message.includes('UNIQUE constraint')) {
                                console.error(`   ❌ Error inserting signal for ${data.asset}:`, error.message);
                            }
                        }
                    } else {
                        log(`   ℹ️  No signal for ${data.asset}`, 'yellow');
                    }
                } else {
                    log(`   ⚠️  calculateAll returned null/undefined for ${data.asset}`, 'yellow');
                }
            } else {
                log(`   ⚠️  Not enough candles for ${data.asset}: ${candles.length} < ${minCandles}`, 'yellow');
            }
        }

        // Handle real-time price updates (like Python bot)
        if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) && data[0].length >= 3) {
            const asset = data[0][0];
            if (!shouldProcessAsset(asset)) {
                return;
            }
            const timestamp = parseFloat(data[0][1]);
            const currentValue = parseFloat(data[0][2]);
            const nowMs = Date.now();

            // Store price in prices table (every second/tick)
            // Round timestamp to nearest second for storage
            const priceTimestamp = Math.floor(timestamp);
            if (priceTimestamp && !isNaN(priceTimestamp) && priceTimestamp > 0) {
                // DB layer handles timezone conversion
                priceBatchBuffer.push({ asset, timestamp: priceTimestamp, price: currentValue });
                if (priceBatchBuffer.length >= BATCH_SIZE_LIMIT || (Date.now() - lastBatchFlush) > BATCH_TIME_LIMIT_MS) {
                    flushPriceBatch(database);
                }
            }

            // Update STATE.PRICES for display/logging (throttled to every 5 seconds)
            const PRICE_UPDATE_THROTTLE_MS = 5000;
            const lastPriceUpdate = STATE.LAST_PRICE_UPDATE[asset] || 0;
            const shouldUpdatePrice = (nowMs - lastPriceUpdate) >= PRICE_UPDATE_THROTTLE_MS;

            if (shouldUpdatePrice) {
                // Validate timestamp before converting
                let timeISO = null;
                if (timestamp && !isNaN(timestamp) && timestamp > 0) {
                    try {
                        timeISO = new Date(timestamp * 1000).toISOString();
                    } catch (e) {
                        // Invalid timestamp - use current time as fallback
                        timeISO = new Date().toISOString();
                    }
                } else {
                    // Invalid timestamp - use current time as fallback
                    timeISO = new Date().toISOString();
                }

                STATE.PRICES[asset] = {
                    price: currentValue,
                    timestamp: timestamp,
                    time: timeISO
                };
                STATE.LAST_PRICE_UPDATE[asset] = nowMs;
            }

            // Build true OHLC in-memory for current period and persist on rollover (with optional 5s throttle)
            // NOTE: OHLC aggregation happens on EVERY tick for accuracy, regardless of price update throttle
            const periodStart = Math.floor(timestamp / STATE.PERIOD) * STATE.PERIOD;
            const currentCandle = STATE.CURRENT_CANDLE[asset];
            const isNewPeriod = !currentCandle || periodStart > STATE.CURRENT_CANDLE_START[asset];

            if (DEBUG_OHLC) {
                log(`🟢 Tick ${asset} ts=${timestamp} p=${currentValue} periodStart=${periodStart}`, 'cyan');
            }

            // Finalize previous candle on period rollover
            if (isNewPeriod && currentCandle) {
                // Only store candles that have received at least 2 ticks OR have price variation
                // This prevents storing incomplete/flat candles (O=H=L=C from single tick)
                const tickCount = STATE.CURRENT_CANDLE_TICKS[asset] || 0;
                const hasVariation = (currentCandle.high !== currentCandle.low);
                const shouldStore = tickCount >= 2 || hasVariation;

                // Reset tick counter regardless of whether the candle is persisted
                STATE.CURRENT_CANDLE_TICKS[asset] = 0;

                if (!shouldStore) {
                    // Low-quality candle (1 tick AND flat). Drop from DB AND from STATE.CANDLES so
                    // indicator history stays bidirectionally aligned with the candles table.
                    if (DEBUG_OHLC) {
                        log(`⏭️  Drop low-quality candle ${asset} @ ${STATE.CURRENT_CANDLE_START[asset]} (ticks<2 && flat)`, 'gray');
                    }
                } else {
                    try {
                        await database.insertCandle(
                            asset,
                            STATE.CURRENT_CANDLE_START[asset],
                            currentCandle.open,
                            currentCandle.high,
                            currentCandle.low,
                            currentCandle.close,
                            0
                        );
                    } catch (err) {
                        // ignore duplicates
                    }

                    if (DEBUG_OHLC) {
                        log(`✅ Finalize ${asset} @ ${STATE.CURRENT_CANDLE_START[asset]} O=${currentCandle.open} H=${currentCandle.high} L=${currentCandle.low} C=${currentCandle.close}`, 'green');
                    }

                    // Push finalized candle to STATE.CANDLES for indicators [timestamp, open, close, high, low]
                    // If history pre-populated this candle, update it in-place with live-aggregated OHLC
                    // (live ticks are more accurate than the server-provided history bar).
                    if (!STATE.CANDLES[asset]) STATE.CANDLES[asset] = [];
                    const _lastEntry = STATE.CANDLES[asset][STATE.CANDLES[asset].length - 1];
                    const _isDupCandle = _lastEntry && _lastEntry[0] === STATE.CURRENT_CANDLE_START[asset];
                    if (_isDupCandle) {
                        // Overwrite history OHLC with live-aggregated values
                        _lastEntry[1] = currentCandle.open;
                        _lastEntry[2] = currentCandle.close;
                        _lastEntry[3] = currentCandle.high;
                        _lastEntry[4] = currentCandle.low;
                    } else {
                        STATE.CANDLES[asset].push([
                            STATE.CURRENT_CANDLE_START[asset],
                            currentCandle.open,
                            currentCandle.close,
                            currentCandle.high,
                            currentCandle.low
                        ]);
                    }

                    {
                        // Recalculate indicators on finalized candle
                        const candlesArr = STATE.CANDLES[asset];
                        const minCandles = Indicators.getMinCandles();
                        if (candlesArr.length >= minCandles) {
                            const indicatorData = indicators.calculateAll(asset, candlesArr);
                            if (indicatorData) {
                                STATE.INDICATORS[asset] = indicatorData;

                                try {
                                    await database.insertIndicators(asset, STATE.CURRENT_CANDLE_START[asset], indicatorData);
                                    if (DEBUG_OHLC) {
                                        log(`✅ Indicators stored for ${asset} on candle finalize`, 'green');
                                    }
                                } catch (error) {
                                    // Log error but don't spam console - only log if it's not a duplicate
                                    if (!error.message || !error.message.includes('UNIQUE constraint')) {
                                        console.error(`❌ Error inserting indicators for ${asset} on finalize:`, error.message);
                                    }
                                }

                                // Only insert signals if strategy fires
                                const _signal = strategy.evaluate(indicatorData);
                                if (_signal) {
                                    try {
                                        const finalSignals = _signal;
                                        const signalTimestamp = STATE.CURRENT_CANDLE_START[asset];

                                        // Guard 1: reject signal if the candle array hasn't advanced.
                                        // Compare the signal timestamp against the second-to-last candle in the
                                        // array. If they match, the finalizer just re-fired on the same bar it
                                        // fired on last time — the feed is frozen.
                                        // Uses only DB-relative timestamps so no wall-clock alignment needed.
                                        const _candleArr = STATE.CANDLES[asset] || [];
                                        const _prevCandle = _candleArr.length >= 2 ? _candleArr[_candleArr.length - 2] : null;
                                        const _isStale = _prevCandle && _prevCandle[0] === signalTimestamp;
                                        if (_isStale) {
                                            log(`[STALE] Signal blocked for ${asset}: same candle timestamp ${signalTimestamp} fired again — feed frozen`, 'red');
                                        } else {

                                            const insertResult = await database.insertSignal(asset, signalTimestamp, finalSignals);

                                            // Enqueue ALL signals directly — no qualification gate.
                                            // The validation loop still runs separately for analysis (signal_outcomes).
                                            if (insertResult?.id || finalSignals) {
                                                const sigId = insertResult?.id || (await database.get('SELECT id FROM signals WHERE asset = ? AND timestamp = ?', [asset, signalTimestamp])).id;
                                                const inFlight = await database.hasAssetInFlightLiveOrder(asset);
                                                if (!inFlight && sigId) {
                                                    const enqResultId = await database.enqueueOrder(sigId, asset, finalSignals.direction, signalTimestamp);
                                                    const exec = STATE.SETTINGS.execution;
                                                    const isLiveExecution = exec?.enabled === true;
                                                    if (STATE.SETTINGS.executeInlineWithBot && isLiveExecution && enqResultId) {
                                                        const shouldExecute = !(await database.hasOrderedTradeForOrder(enqResultId));
                                                        if (shouldExecute) {
                                                            const blockEntry = await isAssetBlocked(asset);
                                                            if (blockEntry) {
                                                                log(`[BLOCK] Skipping ${asset}: ${blockEntry.reason}`, 'yellow');
                                                                await database.updateOrderStatus(enqResultId, 'SKIPPED', `asset-blocked: ${blockEntry.reason}`);
                                                            } else {
                                                                const order = { id: enqResultId, signal_id: sigId, asset, direction: finalSignals.direction, signal_timestamp: signalTimestamp };
                                                                executionQueue.push({
                                                                    database,
                                                                    order,
                                                                    config: {
                                                                        tradeAmount: STATE.SETTINGS.tradeAmount || 1,
                                                                        skipQualifiedGate: true,
                                                                        riskMax: null,
                                                                        execution: STATE.SETTINGS.execution,
                                                                        requireLiveExecution: true
                                                                    }
                                                                });
                                                                runExecutionWorker(page);
                                                            } // end !blockEntry
                                                        }
                                                    }
                                                }
                                            }

                                            if (DEBUG_OHLC) {
                                                log(`✅ Signal stored for ${asset}: ${finalSignals.direction}`, 'green');
                                            }

                                        } // end Guard 1 stale-signal check
                                    } catch (error) {
                                        // Log error but don't spam console - only log if it's not a duplicate
                                        if (!error.message || !error.message.includes('UNIQUE constraint')) {
                                            console.error(`❌ Error inserting signal for ${asset} on finalize:`, error.message);
                                        }
                                    }
                                }
                            } else {
                                if (DEBUG_OHLC) {
                                    log(`⚠️  calculateAll returned null/undefined for ${asset} on finalize`, 'yellow');
                                }
                            }
                        } else {
                            if (DEBUG_OHLC) {
                                log(`⚠️  Not enough candles for ${asset} on finalize: ${candlesArr.length} < ${minCandles}`, 'yellow');
                            }
                        }

                    } // end indicator + signal pipeline
                } // end shouldStore (candle persisted → push + recompute indicators)
            }

            // Start or update current in-memory candle
            // NOTE: Candles are only stored in database when period completes (fully closed)
            if (isNewPeriod || !currentCandle) {
                STATE.CURRENT_CANDLE_START[asset] = periodStart;  // DB layer handles timezone conversion
                STATE.CURRENT_CANDLE[asset] = {
                    open: currentValue,
                    high: currentValue,
                    low: currentValue,
                    close: currentValue
                };
                STATE.CURRENT_CANDLE_TICKS[asset] = 1; // First tick for new candle

                if (DEBUG_OHLC) {
                    log(`🆕 Start ${asset} @ ${periodStart} O=H=L=C=${currentValue}`, 'yellow');
                }
            } else {
                STATE.CURRENT_CANDLE[asset].high = Math.max(STATE.CURRENT_CANDLE[asset].high, currentValue);
                STATE.CURRENT_CANDLE[asset].low = Math.min(STATE.CURRENT_CANDLE[asset].low, currentValue);
                STATE.CURRENT_CANDLE[asset].close = currentValue;
                STATE.CURRENT_CANDLE_TICKS[asset] = (STATE.CURRENT_CANDLE_TICKS[asset] || 0) + 1; // Increment tick count

                if (DEBUG_OHLC) {
                    const cc = STATE.CURRENT_CANDLE[asset];
                    log(`↔️ Update ${asset} @ ${periodStart} O=${cc.open} H=${cc.high} L=${cc.low} C=${cc.close}`, 'yellow');
                }
            }

            // Update indicators periodically (every 30 seconds, tracked per asset)
            // pushHistory=false: intra-bar refresh must not advance _lastSchaffValues
            if (STATE.CANDLES[asset] && STATE.CANDLES[asset].length >= Indicators.getMinCandles()) {
                if (!STATE.lastIndicatorUpdate[asset] || Date.now() - STATE.lastIndicatorUpdate[asset] > 30000) {
                    const indicatorData = indicators.calculateAll(asset, STATE.CANDLES[asset], false);
                    if (indicatorData) {
                        STATE.INDICATORS[asset] = indicatorData;
                        STATE.lastIndicatorUpdate[asset] = Date.now();
                    }
                }
            }

            // Log price update (throttled - every 5 seconds, same as price update)
            if (shouldUpdatePrice) {
                // log(`💰 ${asset}: ${currentValue.toFixed(5)}`, 'green');
            }
        }

        // Check for authentication (multiple formats)
        if (data.auth || data.authenticated ||
            (Array.isArray(data) && data[0] === 'auth') ||
            (typeof data === 'object' && data.uid) ||
            (data.history && data.asset)) { // If we're getting data, we're authenticated
            STATE.AUTHENTICATED = true;
        }

    } catch (error) {
        // Not all messages are JSON or in expected format
        // This is normal - many WebSocket messages are binary or different format
        // But log errors in history processing to help debug
        if (error.message && !error.message.includes('Unexpected token') && !error.message.includes('JSON')) {
            console.error(`⚠️ Error in processWebSocketMessage: ${error.message}`);
            console.error(error.stack);
        }
    }
}

async function navigateToPocketOption(page) {
    log(`Navigating to ${POCKET_OPTION_URL}...`, 'magenta');

    try {
        // Use 'load' instead of 'networkidle2' - Pocket Option has constant WebSocket activity
        // 'networkidle2' waits for network to be idle for 2 seconds, which never happens on dynamic sites
        await page.goto(POCKET_OPTION_URL, {
            waitUntil: 'load',  // Changed from 'networkidle2' - more lenient, waits for page load
            timeout: 120000     // Increased timeout to 120 seconds (2 minutes)
        });

        log('✅ Page loaded', 'green');
        log('Please log in to your Pocket Option account in the browser', 'yellow');
        log('WebSocket messages will be intercepted automatically...', 'cyan');

        // Give page a moment to fully initialize WebSocket connections
        await new Promise(resolve => setTimeout(resolve, 3000));

    } catch (error) {
        if (error.message.includes('timeout')) {
            log('⚠️  Navigation timeout - page may still be loading', 'yellow');
            log('   The bot will continue - WebSocket interception is already active', 'yellow');
            log('   Please check if the page loaded in the browser', 'yellow');
        } else {
            throw error; // Re-throw other errors
        }
    }
}

function displayStatus() {
    setInterval(() => {
        console.clear();
        log(`${'='.repeat(70)}`, 'bright');
        log('Pocket Option Bot Status', 'bright');
        log(`${'='.repeat(70)}`, 'bright');

        log(`\nAuthentication: ${STATE.AUTHENTICATED ? '✅ Authenticated' : '❌ Not authenticated'}`,
            STATE.AUTHENTICATED ? 'green' : 'red');
        log(`Current Asset: ${STATE.CURRENT_ASSET || 'None'}`, 'cyan');
        log(`Period: ${STATE.PERIOD} seconds`, 'cyan');

        log(`\n📊 Assets Tracked: ${Object.keys(STATE.CANDLES).length}`, 'bright');
        Object.keys(STATE.CANDLES).forEach(asset => {
            const candleCount = STATE.CANDLES[asset].length;
            const price = STATE.PRICES[asset]?.price;
            log(`   ${asset}: ${candleCount} candles${price ? ` | Price: ${price.toFixed(5)}` : ''}`, 'cyan');
        });

        log(`\n💰 Latest Prices:`, 'bright');
        Object.keys(STATE.PRICES).slice(-5).forEach(asset => {
            const price = STATE.PRICES[asset];
            log(`   ${asset}: ${price.price.toFixed(5)} (${price.time})`, 'green');
        });

        log(`\n📊 Indicators:`, 'bright');
        const indicatorAssets = Object.keys(STATE.INDICATORS);
        if (indicatorAssets.length > 0) {
            indicatorAssets.forEach(asset => {
                const ind = STATE.INDICATORS[asset];
                if (!ind) return; // Skip if no indicator data
                log(`   ${asset}:`, 'cyan');
                try {
                    const indicatorStr = indicators.formatIndicators(ind);
                    // Ensure indicatorStr is a valid string before logging
                    if (indicatorStr &&
                        typeof indicatorStr === 'string' &&
                        indicatorStr !== 'No data' &&
                        indicatorStr !== 'Calculating...' &&
                        indicatorStr.trim() !== '' &&
                        !indicatorStr.includes('undefined')) {
                        console.log(`${colors.reset}[${formatTimestamp()}]       ${indicatorStr}`);
                    }
                } catch (error) {
                    // Silently skip if formatting fails
                }

                // Display signal if strategy fires on current indicator snapshot
                const _dispSignal = strategy.evaluate(ind);
                if (_dispSignal) {
                    const signalColor = _dispSignal.direction === 'CALL' ? 'green' : 'red';
                    log(`      Signal: ${_dispSignal.direction}`, signalColor);
                    if (_dispSignal.reasons && Array.isArray(_dispSignal.reasons)) {
                        _dispSignal.reasons.forEach(reason => {
                            if (reason && typeof reason === 'string' && reason.trim() !== '') {
                                log(`         - ${reason}`, 'yellow');
                            }
                        });
                    }
                }
            });
        } else {
            log(`   Waiting for enough candles to calculate indicators...`, 'yellow');
        }

        log(`\n${'='.repeat(70)}`, 'bright');
        log('Press Ctrl+C to stop', 'yellow');
    }, 30000); // Changed from 2000(2 seconds) to 30000(30 seconds) to reduce console spam
}

async function main() {
    log(`${'='.repeat(70)}`, 'bright');
    log('Pocket Option Trading Bot', 'bright');
    log('Based on Python bot approach (browser automation)', 'bright');
    log(`${'='.repeat(70)}`, 'bright');

    let browser;
    let page;

    try {
        // Initialize database
        log('Initializing database...', 'cyan');
        await database.initialize();

        // Ensure mcp.db schema exists (safe no-op if tables already present)
        await initMcpSchema(MCP_DB_PATH).catch(e => console.warn(`[MCP-SCHEMA] ${e.message}`));

        // Recover any orders that were claimed (status='SKIPPED', reason='claimed-for-execution')
        // but never completed due to a prior crash. Reset them back to PENDING so they can retry.
        await mcpDbRun(
            `UPDATE mcp_orders SET status = 'PENDING', status_reason = 'recovered-after-crash', updated_at = strftime('%s','now')
             WHERE status = 'SKIPPED' AND status_reason = 'claimed-for-execution'`
        ).catch(e => console.warn(`[MCP-WORKER] Crash recovery sweep failed: ${e.message}`));

        let _resultSyncFailureCount = 0;
        // Result sync: poll PO DOM for WIN/LOSS on pending live trades (only when LIVE execution)
        const resultSyncMs = STATE.SETTINGS.execution?.resultSyncIntervalMs ?? 35000;
        const runResultSync = async () => {
            const exec = STATE.SETTINGS.execution;
            const isLiveExecution = exec?.enabled === true;

            // PRIORITY: If there are trades waiting in the queue, skip sync to avoid blocking execution
            if (executionQueue.length > 0) {
                // log(`   [RESULT-SYNC] Skipping cycle: ${executionQueue.length} trade(s) in queue have priority`, 'yellow');
                return;
            }

            if (isLiveExecution && page && !page.isClosed()) {
                try {
                    const { synced, ordersAwaited = 0 } = await syncLiveTradeResultsFromDOM(page, database, {
                        limit: 10,
                        tradeAmount: STATE.SETTINGS.tradeAmount || 1,
                        expirySeconds: STATE.SETTINGS.execution?.expirationSec ?? 65,
                        minConsecutiveWinsForTrading: 1,
                        checkPreempt: () => executionQueue.length > 0
                    });
                    if (synced > 0) {
                        _resultSyncFailureCount = 0;
                        log(`   📊 Result sync: ${synced} trade(s) closed and written to trades_ordered`, 'cyan');
                        const balance = await getBalanceFromDOM(page);
                        if (balance != null) log(`   💰 Account balance: ${balance}`, 'cyan');
                    } else {
                        if (ordersAwaited > 0) _resultSyncFailureCount++;
                    }
                } catch (e) {
                    log(`   ⚠️  Result sync error: ${e.message}`, 'yellow');
                }
            }
        };
        setTimeout(() => {
            runResultSync();
            setInterval(runResultSync, resultSyncMs);
        }, STATE.SETTINGS.execution?.resultSyncFirstDelayMs ?? 25000);

        // Validation loop: periodically validate signals past expiry → signal_outcomes
        if (STATE.SETTINGS.enableValidationLoop) {
            const intervalMs = STATE.SETTINGS.validationLoopIntervalMs || 60000;
            const lookAhead = STATE.SETTINGS.lookAheadSeconds || 60;
            const amount = STATE.SETTINGS.tradeAmount || 1;
            const staleH = STATE.SETTINGS.execution?.resultSyncStaleHours ?? 0;
            log(`   📋 Validation loop: every ${intervalMs / 1000}s, expiry=${lookAhead}s`, 'cyan');

            const runValidation = async () => {
                try {
                    const options = {
                        writeQualification: true,
                        minConsecutiveWinsForTrading: 2,
                        logNoPending: false,
                        staleHours: staleH
                    };
                    // When system clock is behind signal timestamps, use data time
                    if (typeof database.getMaxSignalTimestamp === 'function') {
                        const maxTs = await database.getMaxSignalTimestamp();
                        const nowSeconds = Math.floor(Date.now() / 1000);
                        if (maxTs != null && maxTs > nowSeconds) {
                            options.referenceNowSeconds = maxTs;
                        }
                    }
                    const { validated, skipped, pendingCount } = await validatePendingSignals(database, lookAhead, amount, options);
                    if (validated > 0 || skipped > 0) {
                        log(`   📊 Validation: ${validated} validated, ${skipped} skipped (pending=${pendingCount})`, 'cyan');
                    }
                } catch (e) {
                    log(`   ⚠️  Validation loop error: ${e.message}`, 'yellow');
                }
            };
            runValidation(); // run once at startup
            setInterval(runValidation, intervalMs);
        }

        // Setup browser
        browser = await setupBrowser();
        page = await browser.newPage();
        resetSessionCalibration(); // Calibrate order amount and expiry on first order

        // MCP orders worker: polls ../data/mcp.db every 5s for manual orders placed via `po trade`
        setInterval(async () => {
            try {
                if (page && !page.isClosed()) await runMcpOrdersWorker(page);
            } catch (e) { /* swallow — must not crash the bot */ }
        }, 5000);


        // Setup WebSocket interception
        await interceptWebSocket(page);

        // Navigate to Pocket Option
        await navigateToPocketOption(page);

        // Setup asset selection capture
        await setupAssetSelectionCapture(page);
        log('Select assets in the Pocket Option UI, then press Enter here to confirm...', 'yellow');
        await waitForAssetConfirmation();
        if (STATE.SELECTED_ASSETS.size > 0) {
            log(`Assets locked: ${Array.from(STATE.SELECTED_ASSETS).join(', ')}`, 'cyan');
        } else {
            log('No assets selected; processing all incoming assets.', 'yellow');
        }

        // Display status updates
        displayStatus();

        // Keep running
        await new Promise(() => { }); // Run indefinitely

    } catch (error) {
        log(`❌ Error: ${error.message}`, 'red');
        console.error(error);
    } finally {
        if (browser) {
            log('\nClosing browser...', 'yellow');
            await browser.close();
        }
        // Close database connection
        await database.close();
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    log('\n\nShutting down...', 'yellow');
    await database.close();
    process.exit(0);
});

// Prevent unhandled promise rejections (e.g. Puppeteer "Target closed" during async setInterval callbacks)
// from crashing the entire bot process. Log and continue.
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    // Puppeteer/CDP connection errors are normal when the user closes/reloads the browser tab
    const isPuppeteerNoise = msg.includes('Target closed') || msg.includes('Protocol error') ||
        msg.includes('Session closed') || msg.includes('Page crashed') ||
        msg.includes('Navigation timeout') || msg.includes('net::ERR');
    if (isPuppeteerNoise) {
        log(`⚠️  Browser error (ignored): ${msg.substring(0, 100)}`, 'yellow');
    } else {
        log(`⚠️  Unhandled rejection: ${msg}`, 'yellow');
        console.error(reason);
    }
});

process.on('uncaughtException', (err) => {
    const msg = err.message || String(err);
    log(`⚠️  Uncaught exception: ${msg}`, 'yellow');
    console.error(err);
    // Don't exit — let the bot continue unless it's truly unrecoverable
});

// Run
main().catch(error => {
    log(`Fatal error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
});
