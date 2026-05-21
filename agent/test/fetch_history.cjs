'use strict';
// Fetch 24h OHLC via loadHistoryPeriod → agent.db
//
//   node agent/test/fetch_history.cjs                   ← auto-detect assets from UI clicks
//   node agent/test/fetch_history.cjs EURUSD_otc        ← explicit asset list
//   node agent/test/fetch_history.cjs EURUSD_otc GBPUSD_otc

const puppeteer = require('puppeteer');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

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
const HIST = resolveHistoryOptions(CFG);

// CLI assets are optional — if not provided, auto-detect from UI clicks
const cliAssets = process.argv
    .slice(2)
    .flatMap((a) => a.split(','))
    .map((s) => s.trim())
    .filter(Boolean);

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
    const cdp = await page.target().createCDPSession();
    const cdpWs = createCdpWsTransport(cdp);

    await cdp.send('Network.enable');

    // Capture the WS URL and SSID from the browser's own outbound auth frame.
    // PO's socket.io is unreachable via JS injection — we piggyback on the
    // browser's existing auth to open our own direct Node.js WS connection.
    let capturedWsUrl = null;
    let capturedSsid = null;
    const detectedAssets = new Set(); // Assets clicked in the UI (via changeSymbol frames)

    cdp.on('Network.webSocketCreated', (ev) => {
        cdpWs.onCreated(ev);
        if (ev.url && /po\.market|socket\.io/i.test(ev.url)) {
            capturedWsUrl = ev.url;
        }
    });

    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
        cdpWs.onFrame({ requestId });
        try {
            // Parse base64-encoded browser WS frames for history responses
            const raw = Buffer.from(response?.payloadData ?? '', 'base64').toString('utf8');
            const jsonStr = raw.replace(/^\d+/, '');
            if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return;
            const parsed = JSON.parse(jsonStr);
            const result = extractHistoryPeriodResult(parsed);
            if (result) dispatchHistoryResult(pending, result);
        } catch (_) {}
    });

    // Capture the auth SSID and UI-clicked assets from the browser's outbound WS frames.
    // Per CDP spec: text frames (opcode=1) have payloadData as plain UTF-8, NOT base64.
    cdp.on('Network.webSocketFrameSent', ({ response }) => {
        try {
            const payloadRaw = response?.payloadData ?? '';
            if (!capturedSsid) {
                log(`WS→ ${payloadRaw.slice(0, 120)}`);
            }
            // Text frames are plain UTF-8; try that first, fall back to base64
            let raw = payloadRaw;
            if (!raw.startsWith('4')) {
                raw = Buffer.from(payloadRaw, 'base64').toString('utf8');
            }
            if (!raw.startsWith('42')) return;
            const parsed = JSON.parse(raw.slice(2));
            if (!Array.isArray(parsed)) return;

            // Capture auth SSID (real account: session field; demo: token field)
            if (parsed[0] === 'auth' && parsed[1] && (parsed[1].session || parsed[1].token)) {
                if (!capturedSsid) {
                    capturedSsid = parsed[1];
                    log(`SSID captured: uid=${capturedSsid.uid ?? 'demo'} isDemo=${capturedSsid.isDemo ?? 1}`);
                }
            }

            // Capture assets the user clicks in the PO UI (changeSymbol events)
            if (parsed[0] === 'changeSymbol' && parsed[1]?.asset) {
                detectedAssets.add(parsed[1].asset);
            }
        } catch (_) {}
    });

    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });
    if (cliAssets.length > 0) {
        log(`fetch: ${cliAssets.join(', ')} (${HIST.targetBars} bars)`);
        log(`log in → open chart → press Enter`);
    } else {
        log(`No assets specified — click assets in the PO UI to detect them, then press Enter`);
    }
    await pressEnter('');

    const wsId = await cdpWs.waitReady(90000, log);
    if (!wsId) {
        log('no chart WebSocket — open QT trading so prices tick, then run again');
        await browser.close();
        db.close();
        process.exit(1);
    }
    log('chart WebSocket connected');

    // Wait for SSID (browser sends auth frame within ~2s of WS open)
    const ssidDeadline = Date.now() + 15_000;
    while (!capturedSsid && Date.now() < ssidDeadline) {
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!capturedSsid) {
        // Fallback: open the guest demo page (no login required)
        const DEMO_URL = 'https://pocketoption.com/en/cabinet/try-demo/';
        log(`SSID not captured — opening guest demo: ${DEMO_URL}`);
        try {
            await page.goto(DEMO_URL, { waitUntil: 'load', timeout: 30000 });
        } catch (_) {}
        const demoDeadline = Date.now() + 20_000;
        while (!capturedSsid && Date.now() < demoDeadline) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    if (!capturedSsid) {
        log('SSID not captured. Open PO trading chart (real or demo) and try again.');
        await browser.close();
        db.close();
        process.exit(1);
    }

    // Resolve final asset list: CLI args override, otherwise use UI-detected assets
    const assets = cliAssets.length > 0 ? cliAssets : Array.from(detectedAssets);
    if (assets.length === 0) {
        log('No assets to fetch. Pass asset names as CLI args or click assets in the PO UI before pressing Enter.');
        await browser.close();
        db.close();
        process.exit(1);
    }
    log(`assets: ${assets.join(', ')} (${HIST.targetBars} bars each)`);

    const directWs = createDirectWs({
        log,
        // Route directWs responses (loadHistoryPeriod replies) to the pending resolver.
        // PO sends history replies only on the connection that made the request.
        onFrame: (raw) => {
            try {
                const jsonStr = raw.replace(/^\d+/, '');
                const parsed = JSON.parse(jsonStr);
                const result = extractHistoryPeriodResult(parsed);
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
    log('directWs ready');

    for (const asset of assets) {
        log(`${asset}...`);
        try {
            const bars = await fetchAssetHistory(page, asset, store, {
                ...HIST,
                pending,
                cdpWs,
                log,
                emitter: (event, payload) => directWs.emit(event, payload),
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
