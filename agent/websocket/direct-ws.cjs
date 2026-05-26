'use strict';
// Direct Node.js WebSocket to PO's server — bypasses the browser's socket entirely.
// Uses the auth SSID captured from CDP Network.webSocketFrameSent.
//
// Protocol: EIO v4 + Socket.IO
//   Server → '0{...}'        EIO open (ignore, informational)
//   Client → '40'             Socket.IO namespace connect
//   Server → '40' / '40{...}' Socket.IO namespace ACK
//   Client → '42["auth",{...}]' PO auth with captured SSID
//   Server → '2'              EIO ping → reply '3'

const WebSocket = require('ws');

const STATE = { IDLE: 0, CONNECTING: 1, HANDSHAKE: 2, READY: 3, CLOSED: 4 };

/**
 * @param {{ log: (m: string) => void, pingTimeoutMs?: number, psIntervalMs?: number, onFrame?: (raw: string) => void }} opts
 * @returns {{ connect: Function, emit: Function, close: Function }}
 */
function createDirectWs({ log, pingTimeoutMs = 35_000, psIntervalMs = 15_000, onFrame }) {
    let ws = null;
    let state = STATE.IDLE;
    let pingTimer = null;
    let psTimer = null;
    let connectResolve = null;
    let connectReject = null;

    function clearPingTimer() {
        if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    }

    function clearPsTimer() {
        if (psTimer) { clearInterval(psTimer); psTimer = null; }
    }

    function resetPingTimer() {
        clearPingTimer();
        pingTimer = setTimeout(() => {
            log('directWs: ping timeout — closing');
            ws?.terminate();
        }, pingTimeoutMs);
    }

    function startPsKeepalive() {
        clearPsTimer();
        psTimer = setInterval(() => {
            if (state === STATE.READY && ws) {
                ws.send('42["ps"]');
            }
        }, psIntervalMs);
    }

    function onMessage(raw) {
        const msg = typeof raw === 'string' ? raw : raw.toString('utf8');

        // EIO ping keepalive
        if (msg === '2') {
            ws.send('3');
            resetPingTimer();
            return;
        }

        // Socket.IO auth rejection
        if (msg === '41') {
            log('directWs: auth rejected (41) — closing');
            clearPingTimer();
            clearPsTimer();
            state = STATE.CLOSED;
            ws?.close();
            return;
        }

        // Socket.IO namespace ACK → send auth → READY
        if (state === STATE.HANDSHAKE && msg.startsWith('40')) {
            state = STATE.READY;
            resetPingTimer();
            startPsKeepalive();
            log('directWs: connected and authenticated');
            connectResolve?.();
            connectResolve = null;
            connectReject = null;
            return;
        }

        // EIO open packet — informational only
        if (msg.startsWith('0')) return;

        // Forward Socket.IO app-level events (42[...]) AND binary attachment payloads
        // PO uses binary events (451-[...]) for loadHistoryPeriodFast: the event
        // announcement has a placeholder, and the actual JSON arrives as the next
        // binary frame (decoded to a plain {asset,index,data} string).
        if (onFrame && (msg.startsWith('42') || msg.startsWith('{') || msg.startsWith('['))) {
            onFrame(msg);
        }
    }

    return {
        /**
         * @param {string} wsUrl    URL from Network.webSocketCreated
         * @param {object} ssid     { session, isDemo, uid, platform }
         * @param {number} [timeoutMs]
         */
        connect(wsUrl, ssid, timeoutMs = 15_000) {
            return new Promise((resolve, reject) => {
                connectResolve = resolve;
                connectReject = reject;

                const timer = setTimeout(() => {
                    if (state !== STATE.READY) {
                        state = STATE.CLOSED;
                        reject(new Error(`directWs connect timeout (${timeoutMs}ms)`));
                        ws?.terminate();
                    }
                }, timeoutMs);

                ws = new WebSocket(wsUrl, [], {
                    headers: { Origin: 'https://pocketoption.com' },
                });
                state = STATE.CONNECTING;

                ws.on('open', () => {
                    state = STATE.HANDSHAKE;
                    // Send Socket.IO namespace connect, then auth immediately after ACK
                    ws.send('40');
                });

                ws.on('message', (raw) => {
                    const msg = typeof raw === 'string' ? raw : raw.toString('utf8');

                    if (state === STATE.HANDSHAKE && msg.startsWith('40')) {
                        clearTimeout(timer);
                        // Send PO auth with the captured SSID
                        ws.send(`42${JSON.stringify(['auth', ssid])}`);
                        state = STATE.READY;
                        resetPingTimer();
                        startPsKeepalive();
                        log('directWs: connected and authenticated');
                        connectResolve?.();
                        connectResolve = null;
                        connectReject = null;
                        return;
                    }

                    onMessage(raw);
                });

                ws.on('error', (err) => {
                    clearTimeout(timer);
                    clearPingTimer();
                    clearPsTimer();
                    state = STATE.CLOSED;
                    log(`directWs: error — ${err.message}`);
                    connectReject?.(err);
                    connectResolve = null;
                    connectReject = null;
                });

                ws.on('close', () => {
                    clearTimeout(timer);
                    clearPingTimer();
                    clearPsTimer();
                    const wasConnecting = state !== STATE.READY && state !== STATE.CLOSED;
                    state = STATE.CLOSED;
                    log('directWs: closed');
                    if (wasConnecting) {
                        connectReject?.(new Error('directWs closed before READY'));
                        connectResolve = null;
                        connectReject = null;
                    }
                });
            });
        },

        /**
         * Emit a Socket.IO event with a single payload object.
         * Compatible with the `emitter` option in fetchAssetHistory.
         * @param {string} event
         * @param {unknown} payload
         * @returns {Promise<boolean>}
         */
        emit(event, payload) {
            if (state !== STATE.READY || !ws) return Promise.resolve(false);
            const msg = `42${JSON.stringify([event, payload])}`;
            return new Promise((resolve) => {
                ws.send(msg, (err) => resolve(!err));
            });
        },

        /**
         * Emit a Socket.IO event with multiple args (e.g. changeSymbol needs two separate args).
         * @param {string} event
         * @param {...unknown} args
         * @returns {Promise<boolean>}
         */
        emitMulti(event, ...args) {
            if (state !== STATE.READY || !ws) return Promise.resolve(false);
            const msg = `42${JSON.stringify([event, ...args])}`;
            return new Promise((resolve) => {
                ws.send(msg, (err) => resolve(!err));
            });
        },

        close() {
            clearPingTimer();
            clearPsTimer();
            state = STATE.CLOSED;
            ws?.close();
        },
    };
}

module.exports = { createDirectWs };
