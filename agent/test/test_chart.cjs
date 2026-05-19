'use strict';
// Fetch historical data from Pocket Option, compute indicators, write to agent.db.
// Manual run — for testing and analysis.
// Usage: node agent/test/test_chart.cjs
//
// 1. Browser opens → log in to Pocket Option
// 2. Select your assets in the UI (PO sends history dumps automatically)
// 3. Press Enter in this terminal when done selecting
// 4. Script processes all captured history dumps → indicators → agent.db → exits

const puppeteer = require('puppeteer');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { computeAll } = require('../websocket/indicators.cjs');

const CFG         = JSON.parse(fs.readFileSync(path.join(__dirname, '../websocket/config.json'), 'utf8'));
const DB_PATH     = path.join(__dirname, '../data/agent.db');
const PERIOD      = CFG.candle_period_seconds;
const TARGET_BARS = 1000; // target candles per asset (excluding warmup)

// ── DB ────────────────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create schema if tables don't exist yet
db.exec(`
CREATE TABLE IF NOT EXISTS candles (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,
    open       REAL    NOT NULL,
    high       REAL    NOT NULL,
    low        REAL    NOT NULL,
    close      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS indicators (
    asset              TEXT    NOT NULL,
    timestamp          INTEGER NOT NULL,
    sma_10             REAL, sma_20 REAL, sma_50 REAL,
    ema_12             REAL, ema_26 REAL,
    rsi_14             REAL,
    macd_line          REAL, macd_signal REAL, macd_histogram REAL,
    bb_upper           REAL, bb_middle REAL, bb_lower REAL, bb_width_bps REAL,
    stoch_k            REAL, stoch_d REAL, stoch_prev_d REAL,
    keltner_upper      REAL, keltner_middle REAL, keltner_lower REAL,
    zigzag_direction   INTEGER, zigzag_reversal INTEGER, zigzag_pivot REAL,
    stc_value          REAL, stc_signal REAL, stc_prev REAL, stc_delta REAL,
    adx                REAL, plus_di REAL, minus_di REAL,
    cci_20             REAL, williams_r REAL, atr_14 REAL,
    psar_value         REAL, psar_trend INTEGER, psar_is_bullish INTEGER,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS prices (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,
    price      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

CREATE TABLE IF NOT EXISTS agent_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    asset          TEXT    NOT NULL,
    direction      TEXT    NOT NULL CHECK(direction IN ('CALL','PUT')),
    amount         REAL    NOT NULL,
    expiry_seconds INTEGER NOT NULL DEFAULT 300,
    signal_ts      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    executed_at    INTEGER,
    status         TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING','EXECUTED','CLOSED','FAILED','CANCELLED')),
    result         TEXT    CHECK(result IN ('WIN','LOSS','DRAW',NULL)),
    profit_loss    REAL
);

CREATE TABLE IF NOT EXISTS agent_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id   TEXT    NOT NULL,
    cycle_ts   INTEGER NOT NULL,
    asset      TEXT,
    decision   TEXT    NOT NULL CHECK(decision IN ('TRADE','SKIP','PAUSE','STOP')),
    direction  TEXT,
    expiry_min INTEGER,
    score      REAL,
    reason     TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_prices_asset_ts ON prices(asset, timestamp);
`);

const stmtInsertCandle = db.prepare(`
    INSERT OR IGNORE INTO candles (asset, timestamp, open, high, low, close)
    VALUES (@asset, @timestamp, @open, @high, @low, @close)
`);

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

const writeCandleBatch = db.transaction((rows) => { for (const r of rows) stmtInsertCandle.run(r); });
const writeIndicatorBatch = db.transaction((rows) => { for (const r of rows) stmtInsertIndicators.run(r); });

function log(msg) { console.log(`[test_chart] ${new Date().toISOString().slice(11, 19)} ${msg}`); }

// ── Process a captured history dump ───────────────────────────────────────────
function processAndStore(asset, serverCandles, historyTicks) {
    // Start with server-provided OHLC candles (reversed — PO sends newest-first)
    const merged = [...(serverCandles || [])].reverse();

    // Aggregate ALL ticks into PERIOD buckets → proper OHLC per bar.
    // Ticks arrive chronologically; we accumulate O/H/L/C per bucket then
    // add any bucket not already covered by a server candle.
    if (Array.isArray(historyTicks)) {
        const buckets = new Map(); // bucket_ts → { open, high, low, close }
        for (const [rawTs, rawPrice] of historyTicks) {
            const ts = parseInt(parseFloat(rawTs));
            const price = parseFloat(rawPrice);
            if (isNaN(ts) || ts <= 0 || isNaN(price)) continue;
            const bucket = Math.floor(ts / PERIOD) * PERIOD;
            if (!buckets.has(bucket)) {
                buckets.set(bucket, { open: price, high: price, low: price, close: price });
            } else {
                const b = buckets.get(bucket);
                b.high = Math.max(b.high, price);
                b.low = Math.min(b.low, price);
                b.close = price; // last tick in this bucket = close
            }
        }
        for (const [bucket, ohlc] of buckets) {
            if (!merged.some(c => c[0] === bucket)) {
                // format: [ts, open, close, high, low] — matches bot's STATE.CANDLES
                merged.push([bucket, ohlc.open, ohlc.close, ohlc.high, ohlc.low]);
            }
        }
    }

    merged.sort((a, b) => a[0] - b[0]);

    const bars = [];
    const candleRows = [];
    for (const c of merged) {
        const [ts, open, close, high, low] = c;
        candleRows.push({ asset, timestamp: ts, open, high, low, close });
        if (!bars.some(r => r[0] === ts)) bars.push([ts, open, close, high, low]);
    }
    bars.sort((a, b) => a[0] - b[0]);

    writeCandleBatch(candleRows);
    log(`${asset}: ${bars.length} bars (${candleRows.length} candles written)`);

    let prevStc = null;
    const indRows = [];
    for (let i = 1; i <= bars.length; i++) {
        const slice = bars.slice(0, i);
        const ind = computeAll(slice, CFG.indicators, prevStc);
        if (!ind) continue;
        prevStc = ind.stc_value;
        indRows.push({ asset, timestamp: slice[slice.length - 1][0], ...ind });
    }

    writeIndicatorBatch(indRows);
    log(`${asset}: indicators computed for ${indRows.length} bars`);

    // Drop warmup bars — STC is the last indicator to become valid (ema_slow=50).
    // Any bar where stc_value IS NULL is incomplete; remove it from both tables immediately.
    const dropWarmup = db.transaction(() => {
        const { changes } = db.prepare(
            `DELETE FROM indicators WHERE asset = ? AND stc_value IS NULL`
        ).run(asset);
        db.prepare(
            `DELETE FROM candles WHERE asset = ? AND timestamp NOT IN (SELECT timestamp FROM indicators WHERE asset = ?)`
        ).run(asset, asset);
        return changes;
    });
    const dropped = dropWarmup();
    if (dropped > 0) log(`${asset}: dropped ${dropped} warmup bars`);

    return bars.length - dropped;
}

// ── Wait for user to press Enter ──────────────────────────────────────────────
function waitForEnter() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\n✅ Steps:\n   1. Log in to Pocket Option\n   2. Click each asset you want (any period — script auto-switches to ${PERIOD}s via changeSymbol)\n   3. Scroll the chart LEFT to load more bars\n   4. Watch for [SOCK] emit lines — they reveal PO's history request event\n   5. Press Enter when done\n`, () => {
            rl.close();
            resolve();
        });
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    log(`PERIOD=${PERIOD}s`);

    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--remote-debugging-port=9224',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
        ],
        defaultViewport: null,
    });

    const page = await browser.newPage();

    // ── Socket spy — injected BEFORE the page loads ───────────────────────────
    // Intercepts window.io at the moment socket.io assigns it, wraps every
    // new socket instance so all socket.emit calls appear in the terminal.
    // Must run via evaluateOnNewDocument so it's in place before PO scripts run.
    await page.evaluateOnNewDocument(() => {
        let _io;
        const skip = ['ping','pong','heartbeat','42',''];

        function spySocket(sock) {
            if (!sock || sock.__spy) return sock;
            sock.__spy = true;
            const orig = sock.emit.bind(sock);
            sock.emit = function(event, ...a) {
                if (!skip.includes(String(event)))
                    console.log(`[SOCK] emit "${event}" ${JSON.stringify(a).slice(0,300)}`);
                return orig(event, ...a);
            };
            console.log('[SOCK] socket spy installed');
            return sock;
        }

        // Intercept window.io = <socket.io factory> assignment
        Object.defineProperty(window, 'io', {
            configurable: true, enumerable: true,
            get() { return _io; },
            set(val) {
                if (typeof val !== 'function') { _io = val; return; }
                const orig = val;
                _io = function(...args) {
                    return spySocket(orig.apply(this, args));
                };
                try { Object.assign(_io, orig); } catch(_) {}
                console.log('[SOCK] io() factory patched');
            }
        });

        // Fallback: poll window.socket directly (some builds don't use window.io)
        const t = setInterval(() => {
            if (window.socket && !window.socket.__spy) spySocket(window.socket);
        }, 1000);
        setTimeout(() => clearInterval(t), 120000);
    });

    // Mirror [SOCK] lines from the browser to the terminal
    page.on('console', (msg) => {
        const t = msg.text();
        if (t.startsWith('[SOCK]')) log(t);
    });

    log('navigating to Pocket Option...');
    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });
    log('page loaded — log in and select your assets in the UI');

    // CDP interception — capture all history dumps as they arrive
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('error', (err) => {
        if (!err.message?.includes('Target closed') && !err.message?.includes('Session closed'))
            log(`CDP error: ${err.message}`);
    });

    // Accumulate ALL dumps per asset — merges candles from every history response
    // (initial load + each chart scrollback loads another ~99 older candles)
    const candleStore = new Map(); // asset → Map<ts, candle[]>
    const tickStore = new Map(); // asset → [[ts, price], ...]

    // Helper: emit changeSymbol via the page's socket (same pattern as bot's order-executor)
    async function emitChangeSymbol(asset) {
        await page.evaluate((sym, p) => {
            const sock = window.socket
                || window.io?.sockets?.sockets?.values?.()?.next?.()?.value;
            if (sock?.emit) sock.emit('changeSymbol', sym, p);
        }, asset, PERIOD).catch(() => {});
    }

    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
        try {
            if (!response.payloadData) return;
            const raw = Buffer.from(response.payloadData, 'base64').toString('utf-8');
            const jsonStr = raw.replace(/^\d+/, '');
            if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return;
            const data = JSON.parse(jsonStr);
            if (data && !Array.isArray(data) && data.asset && data.history !== undefined) {
                const asset  = data.asset;
                const period = data.period;

                // Period mismatch — auto-correct via changeSymbol (same as bot pattern).
                // User doesn't need to manually switch to the correct chart period.
                if (period && period !== PERIOD) {
                    log(`${asset}: wrong period ${period}s — requesting ${PERIOD}s...`);
                    emitChangeSymbol(asset);
                    return; // discard this dump; wait for the corrected one
                }

                if (!candleStore.has(asset)) candleStore.set(asset, new Map());
                if (!tickStore.has(asset)) tickStore.set(asset, []);

                // Merge candles by timestamp (dedup)
                for (const c of (data.candles || [])) candleStore.get(asset).set(c[0], c);

                // Append ticks
                tickStore.get(asset).push(...(data.history || []));

                const totalBars  = candleStore.get(asset).size;
                const totalTicks = tickStore.get(asset).length;
                const pct = Math.min(100, Math.round(totalBars / TARGET_BARS * 100));
                log(`captured: ${asset} — ${totalBars}/${TARGET_BARS} candles (${pct}%) | ${totalTicks} ticks`);
            }
        } catch (_) { }
    });

    // Wait for user to select assets AND scroll the chart left to load more bars
    await waitForEnter();

    // Drain window — flush any in-flight frames
    log('collecting final frames — please wait 4s...');
    await new Promise(r => setTimeout(r, 4000));

    // ── Auto-fetch more history via CDP wheel events ──────────────────────────
    // Chart drag (Puppeteer mouse) doesn't trigger PO's server-side history
    // requests. CDP Input.dispatchMouseEvent goes through the browser's real
    // input path and fires the chart's wheel handler, which triggers fetches.
    const NEED = TARGET_BARS + 70; // extra buffer for warmup bars that will be dropped

    async function autoFetch(asset) {
        log(`${asset}: auto-fetching to ${TARGET_BARS} bars...`);

        // Switch to this asset at the correct period — same as bot's changeSymbol pattern
        await emitChangeSymbol(asset);
        await new Promise(r => setTimeout(r, 3000));

        let stallCount = 0;
        let lastCount  = candleStore.get(asset)?.size ?? 0;

        while ((candleStore.get(asset)?.size ?? 0) < NEED && stallCount < 6) {
            try {
                // Locate the chart canvas and get its centre coords
                const pos = await page.evaluate(() => {
                    const el = document.querySelector(
                        '.chart-candles canvas, [class*="chart"] canvas, canvas'
                    );
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return {
                        x: Math.round(r.left + r.width  * 0.3),
                        y: Math.round(r.top  + r.height * 0.5),
                    };
                });

                if (pos) {
                    // 15 rapid wheel-left events via CDP
                    for (let i = 0; i < 15; i++) {
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseWheel',
                            x: pos.x, y: pos.y,
                            deltaX: -400, deltaY: 0,
                            modifiers: 0,
                        });
                        await new Promise(r => setTimeout(r, 40));
                    }
                }

                // Brute-force common history-request event names — one may work.
                // The socket spy ([SOCK] lines) will reveal which one PO responds to.
                const store    = candleStore.get(asset);
                const oldestTs = store?.size
                    ? Math.min(...store.keys())
                    : Math.floor(Date.now() / 1000) - 100 * PERIOD;
                await page.evaluate((sym, p, from) => {
                    const sock = window.socket
                        || window.io?.sockets?.sockets?.values?.()?.next?.()?.value;
                    if (!sock?.emit) return;
                    [
                        ['history',         { asset: sym, period: p, from }],
                        ['loadHistory',     { asset: sym, period: p, from }],
                        ['getCandles',      { symbol: sym, period: p, from }],
                        ['subscribeSymbol', sym, p, from],
                        ['chartHistory',    { symbol: sym, period: p, from }],
                        ['loadCandles',     { asset: sym, period: p, from, count: 100 }],
                    ].forEach(([evt, ...args]) => { try { sock.emit(evt, ...args); } catch(_){} });
                }, asset, PERIOD, oldestTs - PERIOD).catch(() => {});
            } catch (_) {}

            await new Promise(r => setTimeout(r, 2500));

            const current = candleStore.get(asset)?.size ?? 0;
            const pct     = Math.min(100, Math.round(current / TARGET_BARS * 100));

            if (current > lastCount) {
                log(`  ${asset}: ${current}/${TARGET_BARS} candles (${pct}%)`);
                lastCount  = current;
                stallCount = 0;
            } else {
                stallCount++;
                if (stallCount < 6) log(`  ${asset}: no new candles (stall ${stallCount}/6)`);
            }
        }

        const final = candleStore.get(asset)?.size ?? 0;
        log(`${asset}: fetch done — ${final} candles`);
    }

    // Run auto-fetch for every captured asset that needs more data
    for (const [asset] of candleStore) {
        if ((candleStore.get(asset)?.size ?? 0) < NEED) {
            await autoFetch(asset);
        }
    }

    // Build usable list — assets with at least some data
    const usable = [...candleStore.entries()]
        .filter(([asset]) => {
            const c = candleStore.get(asset)?.size ?? 0;
            const t = tickStore.get(asset)?.length ?? 0;
            return c > 0 || t >= 10;
        })
        .map(([asset]) => ({
            asset,
            candles: [...candleStore.get(asset).values()],
            history: tickStore.get(asset) || [],
        }));

    if (usable.length === 0) {
        log('no usable history dumps — select assets in the UI first, then press Enter');
        db.close();
        await browser.close();
        process.exit(0);
    }

    log(`processing ${usable.length} asset(s): ${usable.map(a => a.asset).join(', ')}`);

    let success = 0;
    for (const { asset, candles, history } of usable) {
        log(`--- ${asset} ---`);
        try {
            const count = processAndStore(asset, candles, history);
            log(`${asset}: done — ${count} bars in agent.db`);
            success++;
        } catch (e) {
            log(`${asset}: FAILED — ${e.message}`);
        }
    }

    log(`complete — ${success}/${usable.length} assets`);
    db.close();
    await browser.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
