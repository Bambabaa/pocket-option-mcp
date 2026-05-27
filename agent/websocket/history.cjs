'use strict';
// loadHistoryPeriod WebSocket protocol (ChipaDev BinaryOptionsTools-v2 get_candles.rs).

/**
 * ChipaDev-style request correlation id: unix seconds + random 10-99.
 * @returns {number}
 */
function makeRequestIndex() {
    const rand = 10 + Math.floor(Math.random() * 89);
    return Number(`${Math.floor(Date.now() / 1000)}${rand}`);
}

/**
 * @param {string|Buffer} payloadData base64 or utf-8 from CDP
 * @returns {unknown|null}
 */
function parseWsPayload(payloadData) {
    if (!payloadData) return null;
    let raw;
    try {
        raw = Buffer.from(payloadData, 'base64').toString('utf-8');
    } catch {
        raw = String(payloadData);
    }
    const jsonStr = raw.replace(/^\d+/, '');
    if (!jsonStr.startsWith('[') && !jsonStr.startsWith('{')) return null;
    try {
        return JSON.parse(jsonStr);
    } catch {
        return null;
    }
}

/**
 * Extract loadHistoryPeriod result from parsed WS payload.
 * @param {unknown} data
 * @returns {object|null}
 */
function extractHistoryPeriodResult(data) {
    if (!data) return null;

    if (
        typeof data === 'object' &&
        !Array.isArray(data) &&
        data.asset != null &&
        data.index != null &&
        Array.isArray(data.data)
    ) {
        return data;
    }

    if (Array.isArray(data) && data.length >= 2) {
        const evt = data[0];
        if (evt === 'loadHistoryPeriod' || evt === 'loadHistoryPeriodFast') {
            const body = data[1];
            if (body && typeof body === 'object' && Array.isArray(body.data)) {
                return body;
            }
        }
    }

    return null;
}

function isHistoryPeriodResult(data) {
    return extractHistoryPeriodResult(data) != null;
}

/**
 * PO CandleData → agent bar [ts, open, close, high, low]
 * @param {{ time: number, open: number, close: number, high: number, low: number }} c
 * @returns {[number, number, number, number, number]|null}
 */
function candleDataToBar(c) {
    const ts = parseInt(c.time, 10);
    const open = parseFloat(c.open);
    const close = parseFloat(c.close);
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    if (!ts || ts <= 0 || [open, close, high, low].some((v) => isNaN(v))) return null;
    return [ts, open, close, high, low];
}

function createCandleStore() {
    return new Map();
}

/**
 * @param {Map<string, Map<number, number[]>>} store
 * @param {string} asset
 * @param {number[][]} bars
 * @returns {number} newly added count
 */
function mergeBars(store, asset, bars) {
    if (!store.has(asset)) store.set(asset, new Map());
    const byTs = store.get(asset);
    let added = 0;
    for (const bar of bars) {
        if (!bar || bar.length < 5) continue;
        const ts = bar[0];
        if (!byTs.has(ts)) added++;
        byTs.set(ts, bar);
    }
    return added;
}

/**
 * @param {Map<string, Map<number, number[]>>} store
 * @param {string} asset
 * @returns {number[][]}
 */
function getSortedBars(store, asset) {
    const byTs = store.get(asset);
    if (!byTs) return [];
    return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Install socket.io spy before page scripts run (same pattern as test_chart.cjs).
 * Sets window.__poSocket when a socket is discovered.
 * @param {import('puppeteer').Page} page
 */
async function installSocketSpy(page) {
    await page.evaluateOnNewDocument(() => {
        const skip = ['ping', 'pong', 'heartbeat', '42', ''];

        function captureSocket(sock) {
            if (!sock || typeof sock.emit !== 'function') return sock;
            if (!sock.__spy) {
                sock.__spy = true;
                const orig = sock.emit.bind(sock);
                sock.emit = function (event, ...a) {
                    if (!skip.includes(String(event))) {
                        console.log(`[SOCK] emit "${event}" ${JSON.stringify(a).slice(0, 300)}`);
                    }
                    return orig(event, ...a);
                };
                console.log('[SOCK] socket spy installed');
            }
            window.__poSocket = sock;
            return sock;
        }

        let _io;
        Object.defineProperty(window, 'io', {
            configurable: true,
            enumerable: true,
            get() {
                return _io;
            },
            set(val) {
                if (typeof val !== 'function') {
                    _io = val;
                    return;
                }
                const orig = val;
                _io = function (...args) {
                    return captureSocket(orig.apply(this, args));
                };
                try {
                    Object.assign(_io, orig);
                } catch (_) {}
                console.log('[SOCK] io() factory patched');
            },
        });

        const poll = setInterval(() => {
            if (window.socket) captureSocket(window.socket);
            if (window.Socket && typeof window.Socket.emit === 'function') {
                captureSocket(window.Socket);
            }
            try {
                const mgr = window.io?.socket || window.io?.sockets;
                if (mgr?.sockets) {
                    for (const s of mgr.sockets.values()) captureSocket(s);
                }
            } catch (_) {}
        }, 500);
        setTimeout(() => clearInterval(poll), 180000);
    });
}

/** Frame where socket was found (main page or iframe). */
let _socketFrame = null;

/**
 * Runs in browser context — finds socket.io on current frame.
 */
function pickSocketInFrame() {
    function pick() {
        if (window.__poSocket?.emit) return window.__poSocket;
        if (window.socket?.emit) return window.socket;
        if (window.Socket?.emit) return window.Socket;
        try {
            const io = window.io;
            if (typeof io === 'function') {
                const s = io();
                if (s?.emit) return s;
            }
            const mgr = io?.socket || io?.sockets;
            if (mgr?.sockets) {
                for (const s of mgr.sockets.values()) {
                    if (s?.emit) return s;
                }
            }
        } catch (_) {}
        return null;
    }
    const sock = pick();
    if (sock) {
        window.__poSocket = sock;
        return true;
    }
    return false;
}

/**
 * Search main page and all iframes for socket.io.
 * @returns {Promise<boolean>}
 */
async function probeAllFrames(page) {
    for (const frame of page.frames()) {
        try {
            const ok = await frame.evaluate(pickSocketInFrame);
            if (ok) {
                _socketFrame = frame;
                return true;
            }
        } catch (_) {}
    }
    _socketFrame = null;
    return false;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {number} timeoutMs
 * @param {(msg: string) => void} [log]
 */
async function waitForPageSocket(page, timeoutMs = 90000, log = () => {}) {
    const deadline = Date.now() + timeoutMs;
    let lastLog = 0;
    while (Date.now() < deadline) {
        if (await probeAllFrames(page)) return true;
        if (Date.now() - lastLog > 10000) {
            log('waiting for socket (log in + open Quick Trading chart)...');
            lastLog = Date.now();
        }
        await sleep(500);
    }
    return false;
}

function getSocketFrame(page) {
    return _socketFrame || page.mainFrame();
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} asset
 * @param {number} period
 */
async function emitChangeSymbol(page, asset, period) {
    const frame = getSocketFrame(page);
    await frame.evaluate(
        (sym, p) => {
            const sock = window.__poSocket || window.socket;
            if (!sock?.emit) throw new Error('socket not available');
            sock.emit('changeSymbol', sym, p);
        },
        asset,
        period
    );
}

/**
 * CDP transport — send on the same WebSocket the chart already uses (no window.socket needed).
 * @param {import('puppeteer').CDPSession} cdp
 */
function createCdpWsTransport(cdp) {
    /** @type {Map<string, string>} */
    const sockets = new Map();

    return {
        onCreated({ requestId, url }) {
            if (!requestId || !url) return;
            if (/po\.market|socket\.io|pocketoption/i.test(url)) {
                sockets.set(requestId, url);
            }
        },
        onFrame({ requestId }) {
            if (requestId) sockets.set(requestId, sockets.get(requestId) || 'active');
        },
        pickId() {
            for (const [id, url] of sockets) {
                if (String(url).includes('po.market')) return id;
            }
            return sockets.keys().next().value || null;
        },
        async waitReady(timeoutMs, log = () => {}) {
            const deadline = Date.now() + timeoutMs;
            let lastLog = 0;
            while (Date.now() < deadline) {
                const id = this.pickId();
                if (id) return id;
                if (Date.now() - lastLog > 8000) {
                    log('waiting for chart WebSocket (prices ticking on chart)...');
                    lastLog = Date.now();
                }
                await sleep(400);
            }
            return null;
        },
        async send(requestId, event, payload) {
            const msg = `42${JSON.stringify([event, payload])}`;
            await cdp.send('Network.sendWebSocketFrame', {
                requestId,
                response: {
                    opcode: 1,
                    mask: true,
                    payloadData: Buffer.from(msg, 'utf8').toString('base64'),
                },
            });
        },
    };
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{ asset: string, period: number, time: number, index: number, offset: number }} req
 * @param {ReturnType<createCdpWsTransport>|null} cdpWs
 */
async function emitLoadHistoryPeriod(page, req, cdpWs) {
    if (!(await probeAllFrames(page))) throw new Error('socket not available');
    const frame = getSocketFrame(page);
    const ok = await frame.evaluate((payload) => {
        const sock = window.__poSocket;
        if (!sock?.emit) return false;
        sock.emit('loadHistoryPeriod', payload);
        return true;
    }, req);
    if (!ok) throw new Error('socket not available');
}

/**
 * Register a pending history response waiter.
 * @param {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} pending
 */
function waitForHistoryResponse(pending, index, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const entry = pending.get(index);
            if (!entry) return;
            pending.delete(index);
            reject(new Error(`loadHistoryPeriod timeout (${timeoutMs}ms) index=${index}`));
        }, timeoutMs);
        pending.set(index, { resolve, reject, timer });
    });
}

/** Cancel a pending waiter and clear its timer (e.g. emit failed). */
function cancelPending(pending, index) {
    const entry = pending.get(index);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(index);
    entry.reject(new Error('request cancelled'));
}

/** Clear all pending waiters (call before browser close). */
function clearAllPending(pending) {
    for (const [index, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('shutdown'));
        pending.delete(index);
    }
}

/**
 * Resolve pending entry from CDP frame (call from fetch_history handler).
 * @param {Map<number, object>} pending
 * @param {object} result LoadHistoryPeriodResult
 * @param {(msg: string) => void} [log]
 */
function dispatchHistoryResult(pending, result) {
    const idx = Number(result.index);
    const entry = pending.get(idx);
    if (!entry) {
        // PO often pushes chart history when you click an asset — not our request
        return;
    }
    clearTimeout(entry.timer);
    pending.delete(idx);
    entry.resolve(result);
}

/**
 * @typedef {object} FetchHistoryOpts
 * @property {number} period candle period seconds
 * @property {number} targetBars
 * @property {number} batchSize offset per request
 * @property {number} requestTimeoutMs
 * @property {number} stallLimit
 * @property {number} interRequestDelayMs
 * @property {Map<number, object>} pending shared pending map
 * @property {ReturnType<createCdpWsTransport>} cdpWs CDP WebSocket transport
 * @property {(msg: string) => void} log
 * @property {((event: string, payload: unknown) => Promise<boolean>)|undefined} emitter optional CDP-context emitter
 */

/**
 * Paginated loadHistoryPeriod fetch for one asset.
 * @param {import('puppeteer').Page} page
 * @param {string} asset
 * @param {Map<string, Map<number, number[]>>} store
 * @param {FetchHistoryOpts} opts
 */
async function fetchAssetHistory(page, asset, store, opts) {
    const {
        period,
        targetBars,
        batchSize,
        requestTimeoutMs,
        stallLimit,
        interRequestDelayMs,
        pending,
        cdpWs,
        log,
        emitter,
    } = opts;

    if (!cdpWs?.pickId()) {
        throw new Error('chart WebSocket not found — stay on QT chart until prices update');
    }

    try {
        if (emitter) {
            const ok = await emitter('changeSymbol', { asset, period });
            if (!ok) throw new Error('socket not available');
        } else {
            await emitChangeSymbol(page, asset, period);
        }
        log(`${asset}: changeSymbol(${period}s)`);
        await sleep(2000);
    } catch (e) {
        log(`${asset}: changeSymbol skipped: ${e.message}`);
    }

    let anchorTime = Math.floor(Date.now() / 1000);
    let stall = 0;

    while ((store.get(asset)?.size ?? 0) < targetBars && stall < stallLimit) {
        const index = makeRequestIndex();
        const before = store.get(asset)?.size ?? 0;

        const offsetSeconds = batchSize * period;
        log(
            `${asset}: request index=${index} time=${anchorTime} offset=${offsetSeconds}s (~${batchSize} bars) ` +
                `(${before}/${targetBars} bars)`
        );

        const responsePromise = waitForHistoryResponse(pending, index, requestTimeoutMs);

        try {
            if (emitter) {
                const ok = await emitter('loadHistoryPeriod', { asset, period, time: anchorTime, index, offset: offsetSeconds });
                if (!ok) throw new Error('socket not available');
            } else {
                await emitLoadHistoryPeriod(page, { asset, period, time: anchorTime, index, offset: offsetSeconds }, cdpWs);
            }
        } catch (e) {
            cancelPending(pending, index);
            log(`${asset}: emit failed: ${e.message}`);
            stall++;
            await sleep(interRequestDelayMs);
            continue;
        }

        let result;
        try {
            result = await responsePromise;
        } catch (e) {
            if (!String(e.message).includes('cancelled') && !String(e.message).includes('shutdown')) {
                log(`${asset}: ${e.message}`);
            }
            stall++;
            await sleep(interRequestDelayMs);
            continue;
        }

        if (result.period != null && Number(result.period) !== period) {
            log(`${asset}: period mismatch response=${result.period} expected=${period}`);
        }

        const bars = (result.data || [])
            .map(candleDataToBar)
            .filter(Boolean);
        const added = mergeBars(store, asset, bars);
        const total = store.get(asset)?.size ?? 0;

        log(`${asset}: +${added} bars (total ${total}/${targetBars})`);

        if (added > 0) {
            stall = 0;
            const sorted = getSortedBars(store, asset);
            const oldest = sorted[0][0];
            anchorTime = oldest - period;
        } else {
            stall++;
            anchorTime -= period * Math.min(batchSize, 100);
        }

        if (interRequestDelayMs > 0) await sleep(interRequestDelayMs);
    }

    return getSortedBars(store, asset);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} cfg full config.json
 * @returns {{ targetBars: number, batchSize: number, requestTimeoutMs: number, stallLimit: number, interRequestDelayMs: number, period: number }}
 */
function resolveHistoryOptions(cfg) {
    const period = cfg.candle_period_seconds ?? 300;
    const h = cfg.history || {};
    const targetHours = h.target_hours ?? 24;
    const targetBars = Math.ceil((targetHours * 3600) / period);
    const batchSize = Math.min(h.batch_size ?? targetBars, targetBars);
    return {
        period,
        targetBars,
        batchSize,
        requestTimeoutMs: h.request_timeout_ms ?? 12000,
        stallLimit: h.stall_limit ?? 6,
        interRequestDelayMs: h.inter_request_delay_ms ?? 800,
    };
}

module.exports = {
    makeRequestIndex,
    parseWsPayload,
    extractHistoryPeriodResult,
    isHistoryPeriodResult,
    candleDataToBar,
    createCandleStore,
    mergeBars,
    getSortedBars,
    installSocketSpy,
    waitForPageSocket,
    createCdpWsTransport,
    emitChangeSymbol,
    emitLoadHistoryPeriod,
    waitForHistoryResponse,
    cancelPending,
    clearAllPending,
    dispatchHistoryResult,
    fetchAssetHistory,
    resolveHistoryOptions,
};
