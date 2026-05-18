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
const readline  = require('readline');
const path      = require('path');
const fs        = require('fs');
const Database  = require('better-sqlite3');
const { computeAll } = require('../websocket/indicators.cjs');

const CFG     = JSON.parse(fs.readFileSync(path.join(__dirname, '../websocket/config.json'), 'utf8'));
const DB_PATH = path.join(__dirname, '../data/agent.db');
const PERIOD  = CFG.candle_period_seconds;

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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

const writeCandleBatch    = db.transaction((rows) => { for (const r of rows) stmtInsertCandle.run(r); });
const writeIndicatorBatch = db.transaction((rows) => { for (const r of rows) stmtInsertIndicators.run(r); });

function log(msg) { console.log(`[test_chart] ${new Date().toISOString().slice(11, 19)} ${msg}`); }

// ── Process a captured history dump ───────────────────────────────────────────
function processAndStore(asset, serverCandles, historyTicks) {
    const merged = [...(serverCandles || [])].reverse();

    if (Array.isArray(historyTicks)) {
        for (const [rawTs, price] of historyTicks) {
            const ts = parseInt(parseFloat(rawTs));
            if (isNaN(ts) || ts <= 0) continue;
            if (ts % PERIOD !== 0) continue;
            if (merged.some(c => c[0] === ts)) continue;
            merged.push([ts, price, price, price, price]);
        }
    }

    merged.sort((a, b) => a[0] - b[0]);

    const bars = [];
    const candleRows = [];
    for (const c of merged) {
        const [ts, open, close, high, low] = c;
        if (open === high && high === low && low === close) continue;
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
        const ind   = computeAll(slice, CFG.indicators, prevStc);
        if (!ind) continue;
        prevStc = ind.stc_value;
        indRows.push({ asset, timestamp: slice[slice.length - 1][0], ...ind });
    }

    writeIndicatorBatch(indRows);
    log(`${asset}: indicators computed for ${indRows.length} bars`);
    return bars.length;
}

// ── Wait for user to press Enter ──────────────────────────────────────────────
function waitForEnter() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('\n✅ Select your assets in the Pocket Option UI, then press Enter here to process...\n', () => {
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

    // Collect dumps keyed by asset (last dump wins if asset re-selected)
    const captured = new Map();

    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
        try {
            if (!response.payloadData) return;
            const raw     = Buffer.from(response.payloadData, 'base64').toString('utf-8');
            const jsonStr = raw.replace(/^\d+/, '');
            if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return;
            const data = JSON.parse(jsonStr);
            if (data && !Array.isArray(data) && data.asset && data.history !== undefined) {
                captured.set(data.asset, data);
                log(`captured history dump: ${data.asset} (${Array.isArray(data.candles) ? data.candles.length : 0} candles, ${Array.isArray(data.history) ? data.history.length : 0} ticks)`);
            }
        } catch (_) {}
    });

    // Wait for user to select assets in the UI
    await waitForEnter();

    if (captured.size === 0) {
        log('no history dumps captured — did you select any assets in the UI?');
        db.close();
        await browser.close();
        process.exit(0);
    }

    log(`processing ${captured.size} asset(s): ${[...captured.keys()].join(', ')}`);

    let success = 0;
    for (const [asset, data] of captured) {
        log(`--- ${asset} ---`);
        try {
            const count = processAndStore(asset, data.candles, data.history);
            log(`${asset}: done — ${count} bars in agent.db`);
            success++;
        } catch (e) {
            log(`${asset}: FAILED — ${e.message}`);
        }
    }

    log(`complete — ${success}/${captured.size} assets`);
    db.close();
    await browser.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
