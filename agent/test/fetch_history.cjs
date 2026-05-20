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
    const cdp = await page.target().createCDPSession();
    const cdpWs = createCdpWsTransport(cdp);

    await cdp.send('Network.enable');

    // Capture the WS URL and SSID from the browser's own outbound auth frame.
    // PO's socket.io is unreachable via JS injection — we piggyback on the
    // browser's existing auth to open our own direct Node.js WS connection.
    let capturedWsUrl = null;
    let capturedSsid = null;

    cdp.on('Network.webSocketCreated', (ev) => {
        cdpWs.onCreated(ev);
        if (ev.url && /po\.market|socket\.io/i.test(ev.url)) {
            capturedWsUrl = ev.url;
        }
    });

    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
        cdpWs.onFrame({ requestId });
        try {
            const parsed = parseWsPayload(response?.payloadData);
            const result = extractHistoryPeriodResult(parsed);
            if (result) dispatchHistoryResult(pending, result);
        } catch (_) {}
    });

    // Capture the auth SSID from the browser's outbound WS frames.
    // Per CDP spec: text frames (opcode=1) have payloadData as plain UTF-8, NOT base64.
    // The browser sends 42["auth",{session,isDemo,uid,platform}] right after connecting.
    cdp.on('Network.webSocketFrameSent', ({ response }) => {
        try {
            // Always log sent frames until SSID is captured (for debugging)
            const payloadRaw = response?.payloadData ?? '';
            if (!capturedSsid) {
                log(`WS→ ${payloadRaw.slice(0, 120)}`);
            }
            if (capturedSsid) return;
            // Text frames are plain UTF-8; try that first, fall back to base64
            let raw = payloadRaw;
            if (!raw.startsWith('4')) {
                raw = Buffer.from(payloadRaw, 'base64').toString('utf8');
            }
            if (!raw.startsWith('42')) return;
            const parsed = JSON.parse(raw.slice(2));
            if (Array.isArray(parsed) && parsed[0] === 'auth' && parsed[1]?.session) {
                capturedSsid = parsed[1];
                log(`SSID captured: uid=${capturedSsid.uid} isDemo=${capturedSsid.isDemo}`);
            }
        } catch (_) {}
    });

    await page.goto(CFG.pocket_option_url, { waitUntil: 'load', timeout: 120000 });
    log(`log in → open QT chart (Real or Demo — we will NOT switch) → press Enter`);
    log(`fetch: ${assets.join(', ')} (${HIST.targetBars} bars)`);
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
        // Fallback: try to pull SSID from common browser storage locations
        log('SSID not in WS frames — probing page storage...');
        try {
            const found = await page.evaluate(() => {
                const candidates = [
                    window.__ssid, window.ssid, window.SSID,
                    localStorage.getItem('ssid'), localStorage.getItem('SSID'),
                    localStorage.getItem('user'), localStorage.getItem('auth'),
                ];
                for (const c of candidates) {
                    if (c && typeof c === 'string' && c.includes('session')) return c;
                    if (c && typeof c === 'object' && c?.session) return JSON.stringify(c);
                }
                return null;
            }).catch(() => null);
            if (found) {
                try {
                    const obj = JSON.parse(found.startsWith('{') ? found : found);
                    if (obj?.session) { capturedSsid = obj; log(`SSID from storage: uid=${obj.uid}`); }
                } catch (_) {}
            }
        } catch (_) {}
    }

    if (!capturedSsid) {
        log('SSID not captured. Check the WS→ lines above — if none printed, the WS frames');
        log('are not flowing through CDP. Try: refresh the PO chart page, then re-run.');
        await browser.close();
        db.close();
        process.exit(1);
    }

    const directWs = createDirectWs({ log });
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
