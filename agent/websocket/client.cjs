'use strict';
// Agent WebSocket Client — live mode
// Usage: node agent/websocket/client.cjs
//
// NOTE (Phase 3): pollOrders currently uses page.evaluate → sock.emit('openOrder')
// which fails due to PO's cross-origin iframe. Order execution needs to be ported
// to direct-ws.cjs (same pattern as fetch_history.cjs) before live trading works.
//
// Mirrors the bot's two-message pattern exactly:
//
//  MSG TYPE 1 — history dump  { asset, candles:[...], history:[[ts,price],...] }
//    Fires once per asset on subscribe. Seeds in-memory candle array by merging
//    server OHLC candles with period-aligned ticks from data.history.
//    Immediately backfills indicators for every seeded bar.
//
//  MSG TYPE 2 — live tick stream  [[asset, timestamp, price]]
//    Fires on every price update. Stored to prices table (batched).
//    Builds current OHLC bar in-memory. On period rollover: finalises bar,
//    stores candle, computes + stores all 14 indicators.
//
// Messages are processed through a sequential queue (never inline) so heavy
// history dumps cannot starve the event loop.

const puppeteer = require('puppeteer');
const readline  = require('readline');
const path      = require('path');
const fs        = require('fs');
const { openAgentDb } = require('./store.cjs');
const { computeAll }  = require('./indicators.cjs');

const CFG     = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DB_PATH = path.join(__dirname, '../data/agent.db');
const PERIOD  = CFG.candle_period_seconds; // e.g. 300 for 5m

// ── DB ────────────────────────────────────────────────────────────────────────
const db = openAgentDb(DB_PATH); // auto-creates schema if tables don't exist

const stmtInsertCandle = db.prepare(`
    INSERT OR IGNORE INTO candles (asset, timestamp, open, high, low, close)
    VALUES (@asset, @timestamp, @open, @high, @low, @close)
`);

const stmtInsertPrice = db.prepare(`
    INSERT OR IGNORE INTO prices (asset, timestamp, price)
    VALUES (@asset, @timestamp, @price)
`);

const insertPriceBatch = db.transaction((rows) => {
    for (const r of rows) stmtInsertPrice.run(r);
});

const stmtInsertIndicators = db.prepare(`
    INSERT OR REPLACE INTO indicators (
        asset, timestamp,
        sma_10, sma_20, sma_50, ema_12, ema_26, rsi_14,
        macd_line, macd_signal, macd_histogram,
        bb_upper, bb_middle, bb_lower, bb_width_bps,
        stoch_k, stoch_d, stoch_prev_d,
        keltner_upper, keltner_middle, keltner_lower,
        zigzag_direction, zigzag_reversal, zigzag_pivot,
        stc_value, stc_signal, stc_prev, stc_delta,
        adx, plus_di, minus_di,
        cci_20, williams_r, atr_14,
        psar_value, psar_trend, psar_is_bullish
    ) VALUES (
        @asset, @timestamp,
        @sma_10, @sma_20, @sma_50, @ema_12, @ema_26, @rsi_14,
        @macd_line, @macd_signal, @macd_histogram,
        @bb_upper, @bb_middle, @bb_lower, @bb_width_bps,
        @stoch_k, @stoch_d, @stoch_prev_d,
        @keltner_upper, @keltner_middle, @keltner_lower,
        @zigzag_direction, @zigzag_reversal, @zigzag_pivot,
        @stc_value, @stc_signal, @stc_prev, @stc_delta,
        @adx, @plus_di, @minus_di,
        @cci_20, @williams_r, @atr_14,
        @psar_value, @psar_trend, @psar_is_bullish
    )
`);

// ── In-memory state ───────────────────────────────────────────────────────────
const assetCandles   = {}; // asset → [[ts, open, close, high, low], ...]  (completed bars)
const currentBar     = {}; // asset → { start, open, high, low, close }    (bar being built)
const currentTicks   = {}; // asset → tick count in current bar
const prevStc        = {}; // asset → last stc_value (for stc_delta)
const lastIndUpdate  = {}; // asset → Date.now() of last intra-bar indicator refresh

// Price batch buffer — flush every 200 ticks or 10s (mirrors bot pattern)
let priceBuf = [];
let lastFlush = Date.now();
const BATCH_LIMIT  = 200;
const FLUSH_MS     = 10000;

function flushPrices() {
    if (!priceBuf.length) return;
    const batch = priceBuf.splice(0);
    try { insertPriceBatch(batch); } catch (_) {}
    lastFlush = Date.now();
}

function log(msg) { console.log(`[agent] ${new Date().toISOString().slice(11, 19)} ${msg}`); }

// ── Indicator compute + store ─────────────────────────────────────────────────
function computeAndStore(asset, timestamp) {
    const bars = assetCandles[asset];
    if (!bars || bars.length < 2) return;
    const ind = computeAll(bars, CFG.indicators, prevStc[asset] ?? null);
    if (!ind) return;
    prevStc[asset] = ind.stc_value;
    try { stmtInsertIndicators.run({ asset, timestamp, ...ind }); }
    catch (e) { if (!e.message?.includes('UNIQUE')) log(`ind error ${asset}: ${e.message}`); }
}

// ── Bar finalise on period rollover ───────────────────────────────────────────
function finaliseBar(asset, bar) {
    // Drop flat single-tick candles (O=H=L=C with 1 tick) — same guard as bot
    if (currentTicks[asset] < 2 && bar.high === bar.low) return;

    if (!assetCandles[asset]) assetCandles[asset] = [];

    // Duplicate guard — don't push same bar twice if feed stalls
    const last = assetCandles[asset][assetCandles[asset].length - 1];
    if (last && last[0] === bar.start) return;

    assetCandles[asset].push([bar.start, bar.open, bar.close, bar.high, bar.low]);

    try { stmtInsertCandle.run({ asset, timestamp: bar.start, open: bar.open, high: bar.high, low: bar.low, close: bar.close }); }
    catch (_) {}

    computeAndStore(asset, bar.start);
    log(`bar closed: ${asset} @ ${bar.start} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close}`);
}

// ── Live tick ─────────────────────────────────────────────────────────────────
function onTick(asset, timestamp, price) {
    // 1. Store to prices table (batched)
    priceBuf.push({ asset, timestamp, price });
    if (priceBuf.length >= BATCH_LIMIT || Date.now() - lastFlush > FLUSH_MS) flushPrices();

    // 2. Build current OHLC bar
    const barStart = Math.floor(timestamp / PERIOD) * PERIOD;
    const bar = currentBar[asset];

    if (!bar || barStart > bar.start) {
        // Period rollover — finalise previous bar then open new one
        if (bar) finaliseBar(asset, bar);
        currentBar[asset]   = { start: barStart, open: price, high: price, low: price, close: price };
        currentTicks[asset] = 1;
    } else {
        bar.close = price;
        if (price > bar.high) bar.high = price;
        if (price < bar.low)  bar.low  = price;
        currentTicks[asset]++;

        // Intra-bar indicator refresh every 30s (doesn't advance prevStc)
        if (!lastIndUpdate[asset] || Date.now() - lastIndUpdate[asset] > 30000) {
            if (assetCandles[asset]?.length >= 2) {
                computeAll(assetCandles[asset], CFG.indicators, prevStc[asset] ?? null);
                lastIndUpdate[asset] = Date.now();
            }
        }
    }
}

// ── History dump processing ───────────────────────────────────────────────────
// Merges server OHLC candles with period-aligned ticks from data.history,
// then backfills indicators across the full seeded history.
function processHistoryDump(asset, serverCandles, historyTicks) {
    // Start from server's reversed candle array (bot does [...data.candles].reverse())
    const merged = [...(serverCandles || [])].reverse();

    // Walk tick pairs — add period-boundary ticks that aren't already in merged
    if (Array.isArray(historyTicks)) {
        for (const [rawTs, price] of historyTicks) {
            const ts = parseInt(parseFloat(rawTs));
            if (isNaN(ts) || ts <= 0) continue;
            if (ts % PERIOD !== 0) continue;                            // only period-aligned
            if (merged.some(c => c[0] === ts)) continue;               // already have it
            merged.push([ts, price, price, price, price]);              // flat candle from tick
        }
    }

    // Sort chronologically
    merged.sort((a, b) => a[0] - b[0]);

    // Store to DB and build in-memory array, skipping flat candles
    if (!assetCandles[asset]) assetCandles[asset] = [];
    let stored = 0;
    for (const c of merged) {
        const [ts, open, close, high, low] = c;
        if (open === high && high === low && low === close) continue;   // flat — skip
        try { stmtInsertCandle.run({ asset, timestamp: ts, open, high, low, close }); stored++; }
        catch (_) {}
        // Avoid duplicates in memory
        if (!assetCandles[asset].some(r => r[0] === ts)) {
            assetCandles[asset].push([ts, open, close, high, low]);
        }
    }
    assetCandles[asset].sort((a, b) => a[0] - b[0]);

    log(`${asset}: seeded ${assetCandles[asset].length} bars from history (${stored} new stored)`);

    // Backfill indicators across full history
    prevStc[asset] = null;
    let computed = 0;
    for (let i = 1; i <= assetCandles[asset].length; i++) {
        const slice = assetCandles[asset].slice(0, i);
        const ind   = computeAll(slice, CFG.indicators, prevStc[asset] ?? null);
        if (!ind) continue;
        prevStc[asset] = ind.stc_value;
        const ts = slice[slice.length - 1][0];
        try { stmtInsertIndicators.run({ asset, timestamp: ts, ...ind }); computed++; }
        catch (_) {}
    }
    log(`${asset}: indicators backfilled for ${computed} bars`);
}

// ── Sequential message queue (never process inline) ───────────────────────────
const msgQueue  = [];
let   queueBusy = false;

function enqueue(fn) {
    msgQueue.push(fn);
    drainQueue();
}

function drainQueue() {
    if (queueBusy || !msgQueue.length) return;
    queueBusy = true;
    const fn = msgQueue.shift();
    try { fn(); } catch (e) { log(`queue error: ${e.message}`); }
    queueBusy = false;
    if (msgQueue.length) setImmediate(drainQueue);
}

// ── CDP WS interception ───────────────────────────────────────────────────────
async function setupInterception(page) {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('error', (err) => {
        if (!err.message?.includes('Target closed') && !err.message?.includes('Session closed')) {
            log(`CDP error: ${err.message}`);
        }
    });

    client.on('Network.webSocketCreated', ({ url }) => {
        if (url.includes('po.market') || url.includes('socket.io')) log(`WS: ${url}`);
    });

    client.on('Network.webSocketFrameReceived', ({ response }) => {
        try {
            if (!response.payloadData) return;
            const raw = Buffer.from(response.payloadData, 'base64').toString('utf-8');
            const jsonStr = raw.replace(/^\d+/, '');
            if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return;
            const data = JSON.parse(jsonStr);

            // ── MSG TYPE 1: history dump ──────────────────────────────────────
            // { asset, history: [[ts,price],...], candles: [...ohlc], period }
            if (data && !Array.isArray(data) && data.asset && data.history !== undefined) {
                const asset = data.asset;
                enqueue(() => processHistoryDump(asset, data.candles, data.history));
                return;
            }

            // ── MSG TYPE 2: live tick stream ──────────────────────────────────
            // [[asset, timestamp, price], ...]
            if (Array.isArray(data) && Array.isArray(data[0]) && data[0].length >= 3) {
                const asset = data[0][0];
                if (typeof asset !== 'string') return;
                const ts    = Math.floor(parseFloat(data[0][1]));
                const price = parseFloat(data[0][2]);
                if (isNaN(ts) || isNaN(price) || ts <= 0) return;
                // Ticks are high-frequency — process directly, not through heavy queue
                onTick(asset, ts, price);
            }
        } catch (_) {}
    });

    return client;
}

// ── Order execution polling ───────────────────────────────────────────────────
const stmtPending  = db.prepare(`SELECT * FROM agent_orders WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 5`);
const stmtClaim    = db.prepare(`UPDATE agent_orders SET status = 'EXECUTING', executed_at = strftime('%s','now') WHERE id = ? AND status = 'PENDING'`);
const stmtExecuted = db.prepare(`UPDATE agent_orders SET status = 'EXECUTED', executed_at = strftime('%s','now') WHERE id = ?`);
const stmtFailed   = db.prepare(`UPDATE agent_orders SET status = 'FAILED' WHERE id = ?`);

async function pollOrders(page) {
    for (const order of stmtPending.all()) {
        if (!stmtClaim.run(order.id).changes) continue;
        log(`order ${order.id}: ${order.asset} ${order.direction} $${order.amount} ${order.expiry_seconds}s`);
        try {
            await page.evaluate((o) => {
                const sock = window.socket || window.io?.sockets?.sockets?.values?.()?.next?.()?.value;
                if (!sock?.emit) throw new Error('socket not available');
                sock.emit('openOrder', {
                    asset:     o.asset,
                    direction: o.direction.toLowerCase(),
                    amount:    o.amount,
                    time:      o.expiry_seconds,
                });
            }, { asset: order.asset, direction: order.direction, amount: order.amount, expiry_seconds: order.expiry_seconds });
            stmtExecuted.run(order.id);
        } catch (e) {
            log(`order ${order.id} failed: ${e.message}`);
            stmtFailed.run(order.id);
        }
    }
}

function pressEnter(msg) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(msg, () => { rl.close(); resolve(); });
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    log(`starting — PERIOD=${PERIOD}s`);

    const browser = await puppeteer.launch({
        headless: false,
        args: ['--remote-debugging-port=9223', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: null,
    });

    const page = await browser.newPage();

    // Interception must be set up BEFORE navigation so we catch the first WS
    // connection and initial history dump (fires within ~2s of auth).
    await setupInterception(page);

    log('navigating to Pocket Option...');
    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });
    log('log in → open trading chart → click assets → press Enter to start');
    await pressEnter('');
    log('live data collection started — Ctrl+C to stop');

    // Periodic price flush safety net
    setInterval(flushPrices, FLUSH_MS);

    // Order polling
    setInterval(() => pollOrders(page).catch(e => log(`poll error: ${e.message}`)), 2000);

    process.on('SIGINT', async () => {
        log('shutting down...');
        flushPrices();
        await browser.close();
        db.close();
        process.exit(0);
    });

    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        const noise = ['Target closed','Protocol error','Session closed','Page crashed','net::ERR'];
        if (noise.some(n => msg.includes(n))) return;
        log(`unhandled rejection: ${msg}`);
    });

    await new Promise(() => {}); // run forever
}

main().catch(e => { console.error(e); process.exit(1); });
