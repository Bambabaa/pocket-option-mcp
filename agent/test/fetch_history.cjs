'use strict';
// Fetch paginated OHLC history via loadHistoryPeriod → agent.db
//
// Protocol (ChipaDevTeam BinaryOptionsTools-v2 get_candles.rs):
//   Step 1: 42["changeSymbol",{"asset":"X","period":300}]     — subscribe asset on this WS connection
//   Step 2: 42["loadHistoryPeriod",{"asset":"X","period":300,"time":T,"index":N,"offset":O}]
//   Reply:  42["loadHistoryPeriod",{"asset":"X","index":N,"data":[{time,open,close,high,low}],"period":300}]
//        OR 42["loadHistoryPeriodFast", ...same...]
//   Paginate by walking anchorTime backwards until targetBars collected.
//
//   node agent/test/fetch_history.cjs                   ← auto-detect assets from UI clicks
//   node agent/test/fetch_history.cjs EURUSD_otc        ← explicit list
//   node agent/test/fetch_history.cjs EURUSD_otc GBPUSD_otc

const puppeteer = require('puppeteer');
const readline  = require('readline');
const path      = require('path');
const fs        = require('fs');

const {
    extractHistoryPeriodResult,
    createCandleStore,
    fetchAssetHistory,
    dispatchHistoryResult,
    resolveHistoryOptions,
    createCdpWsTransport,
    clearAllPending,
} = require('../websocket/history.cjs');
const { openAgentDb, storeBarsAndIndicators } = require('../websocket/store.cjs');
const { createDirectWs } = require('../websocket/direct-ws.cjs');

const CFG = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../websocket/config.json'), 'utf8')
);
const DB_PATH = path.join(__dirname, '../data/agent.db');
const HIST    = resolveHistoryOptions(CFG);

const cliAssets = process.argv
    .slice(2)
    .flatMap((a) => a.split(','))
    .map((s) => s.trim())
    .filter(Boolean);

const log = (m) => console.log(`[fetch_history] ${m}`);

function pressEnter(msg) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(msg, () => { rl.close(); resolve(); });
    });
}

async function main() {
    const db      = openAgentDb(DB_PATH);
    const pending = new Map();
    const store   = createCandleStore();

    const browser = await puppeteer.launch({
        headless: false,
        args: ['--remote-debugging-port=9225', '--no-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: null,
    });

    const page  = await browser.newPage();
    const cdp   = await page.target().createCDPSession();
    const cdpWs = createCdpWsTransport(cdp);
    await cdp.send('Network.enable');

    let capturedWsUrl = null;
    let capturedSsid  = null;
    const detectedAssets = new Set();

    cdp.on('Network.webSocketCreated', (ev) => {
        cdpWs.onCreated(ev);
        if (ev.url && /po\.market|socket\.io/i.test(ev.url)) capturedWsUrl = ev.url;
    });

    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
        cdpWs.onFrame({ requestId });
        // Also parse browser WS frames in case PO responds there too
        try {
            const raw     = Buffer.from(response?.payloadData ?? '', 'base64').toString('utf8');
            const jsonStr = raw.replace(/^\d+/, '');
            if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return;
            const parsed  = JSON.parse(jsonStr);
            const result  = extractHistoryPeriodResult(parsed);
            if (result) dispatchHistoryResult(pending, result);
        } catch (_) {}
    });

    cdp.on('Network.webSocketFrameSent', ({ response }) => {
        try {
            let raw = response?.payloadData ?? '';
            if (!raw.startsWith('4')) raw = Buffer.from(raw, 'base64').toString('utf8');
            if (!raw.startsWith('42')) return;
            const parsed = JSON.parse(raw.slice(2));
            if (!Array.isArray(parsed)) return;
            if (parsed[0] === 'auth' && parsed[1] && (parsed[1].session || parsed[1].token)) {
                if (!capturedSsid) {
                    capturedSsid = parsed[1];
                    log(`SSID captured: uid=${capturedSsid.uid ?? 'demo'}`);
                }
            }
            if (parsed[0] === 'changeSymbol' && parsed[1]?.asset) {
                detectedAssets.add(parsed[1].asset);
            }
        } catch (_) {}
    });

    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });

    if (cliAssets.length > 0) {
        log(`fetch: ${cliAssets.join(', ')} (${HIST.targetBars} bars each)`);
        log(`log in → open trading chart → press Enter`);
    } else {
        log(`No assets specified — click assets in the PO UI to detect them, then press Enter`);
    }
    await pressEnter('');

    const wsId = await cdpWs.waitReady(90000, log);
    if (!wsId) {
        log('no chart WebSocket — open Quick Trading so prices are ticking, then run again');
        await browser.close();
        db.close();
        process.exit(1);
    }
    log('chart WebSocket connected');

    const ssidDeadline = Date.now() + 15_000;
    while (!capturedSsid && Date.now() < ssidDeadline) {
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!capturedSsid) {
        log('SSID not captured — make sure you are logged in with the chart open');
        await browser.close();
        db.close();
        process.exit(1);
    }

    const assets = cliAssets.length > 0 ? cliAssets : Array.from(detectedAssets);
    if (assets.length === 0) {
        log('No assets to fetch. Pass CLI args or click assets in the PO UI before pressing Enter.');
        await browser.close();
        db.close();
        process.exit(1);
    }
    log(`assets: ${assets.join(', ')} (${HIST.targetBars} bars each)`);

    // directWs — routes loadHistoryPeriod/loadHistoryPeriodFast responses to pending resolver
    const directWs = createDirectWs({
        log,
        onFrame: (raw) => {
            try {
                const jsonStr = raw.replace(/^\d+/, '');
                const parsed  = JSON.parse(jsonStr);
                const result  = extractHistoryPeriodResult(parsed);
                if (result) dispatchHistoryResult(pending, result);
            } catch (_) {}
        },
    });

    try {
        await directWs.connect(capturedWsUrl, capturedSsid, 15_000);
    } catch (e) {
        log(`directWs connect failed: ${e.message}`);
        await browser.close();
        db.close();
        process.exit(1);
    }

    // Emitter with auto-reconnect: if directWs drops, reconnect before retrying
    async function emitter(event, payload) {
        let ok = await directWs.emit(event, payload);
        if (!ok) {
            log(`directWs dropped — reconnecting...`);
            try {
                await directWs.connect(capturedWsUrl, capturedSsid, 15_000);
                ok = await directWs.emit(event, payload);
            } catch (e) {
                log(`reconnect failed: ${e.message}`);
            }
        }
        return ok;
    }

    for (const asset of assets) {
        log(`${asset}...`);
        try {
            const bars = await fetchAssetHistory(page, asset, store, {
                ...HIST,
                pending,
                cdpWs,
                log,
                emitter,
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
    directWs.close();
    await browser.close();
    db.close();
    log(`done → ${DB_PATH}`);
}

process.on('unhandledRejection', () => {});
main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
