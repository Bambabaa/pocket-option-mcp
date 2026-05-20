'use strict';
// Fetch 24h OHLC via loadHistoryPeriod → agent.db
//
//   node agent/test/fetch_history.cjs EURUSD_otc
//   node agent/test/fetch_history.cjs EURUSD_otc GBPUSD_otc

const puppeteer = require('puppeteer');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const {
    parseWsPayload,
    extractHistoryPeriodResult,
    createCandleStore,
    fetchAssetHistory,
    dispatchHistoryResult,
    resolveHistoryOptions,
    installSocketSpy,
    waitForPageSocket,
    ensureTradingPage,
    clearAllPending,
} = require('../websocket/history.cjs');
const { openAgentDb, storeBarsAndIndicators } = require('../websocket/store.cjs');

const CFG = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../websocket/config.json'), 'utf8')
);
const DB_PATH = path.join(__dirname, '../data/agent.db');
const HIST = resolveHistoryOptions(CFG);

const assets = process.argv
    .slice(2)
    .flatMap((a) => a.split(','))
    .map((s) => s.trim())
    .filter(Boolean);

if (assets.length === 0) {
    console.error('Usage: node agent/test/fetch_history.cjs EURUSD_otc [more assets...]');
    process.exit(1);
}

const log = (m) => console.log(`[fetch_history] ${m}`);

function pressEnter(msg) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(msg, () => {
            rl.close();
            resolve();
        });
    });
}

async function main() {
    const db = openAgentDb(DB_PATH);
    const pending = new Map();
    const store = createCandleStore();

    const browser = await puppeteer.launch({
        headless: false,
        args: ['--remote-debugging-port=9225', '--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: null,
    });

    const page = await browser.newPage();
    await installSocketSpy(page);

    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
        try {
            const parsed = parseWsPayload(response?.payloadData);
            const result = extractHistoryPeriodResult(parsed);
            if (result) dispatchHistoryResult(pending, result);
        } catch (_) {}
    });

    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });
    log(`log in → open Quick Trading → press Enter (fetch ${assets.join(', ')})`);
    await pressEnter('');

    let socketOk = await waitForPageSocket(page, 20000, log);
    if (!socketOk) socketOk = await ensureTradingPage(page, CFG, log);
    if (!socketOk) {
        log('no socket — log in, click Demo/Quick Trading so the chart loads, run again');
        await browser.close();
        db.close();
        process.exit(1);
    }
    log('socket ready');

    for (const asset of assets) {
        log(`${asset}...`);
        try {
            const bars = await fetchAssetHistory(page, asset, store, {
                ...HIST,
                pending,
                log,
            });
            if (bars.length === 0) {
                log(`${asset}: no data`);
                continue;
            }
            const s = storeBarsAndIndicators(db, asset, bars, CFG.indicators, log);
            log(`${asset}: ${s.finalCandleCount} bars in DB`);
        } catch (e) {
            log(`${asset}: ${e.message}`);
        }
    }

    clearAllPending(pending);
    await browser.close();
    db.close();
    log(`done → ${DB_PATH}`);
}

process.on('unhandledRejection', () => {});
main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
