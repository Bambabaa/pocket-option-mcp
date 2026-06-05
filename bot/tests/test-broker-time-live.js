#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

const DEMO_URL = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/';

function formatOffset(minutesEastOfUtc) {
    const sign = minutesEastOfUtc >= 0 ? '+' : '-';
    const abs = Math.abs(minutesEastOfUtc);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `UTC${sign}${hh}:${mm}`;
}

function formatLocalDateTime(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    const tz = formatOffset(-d.getTimezoneOffset());
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms} ${tz}`;
}

function log(msg, color = '\x1b[0m') {
    const ts = formatLocalDateTime(new Date());
    console.log(`${color}[${ts}] ${msg}\x1b[0m`);
}

function toInt(v, fallback) {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : fallback;
}

function toFloat(v, fallback) {
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : fallback;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalClock(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseHmsToSec(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const h = toInt(m[1], -1);
    const min = toInt(m[2], -1);
    const sec = toInt(m[3] || '0', -1);
    if (h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) return null;
    return (h * 3600) + (min * 60) + sec;
}

function normalizeDayDeltaSec(deltaSec) {
    let d = deltaSec;
    if (d > 43200) d -= 86400;
    if (d < -43200) d += 86400;
    return d;
}

function parseUtcZoneOffsetMinutes(zoneText) {
    if (!zoneText) return null;
    const t = String(zoneText).trim().toUpperCase();
    const m = t.match(/^UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const h = toInt(m[2], 0);
    const mins = toInt(m[3] || '0', 0);
    if (h > 14 || mins > 59) return null;
    return sign * ((h * 60) + mins);
}

function mean(values) {
    if (!values.length) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
}

function stddev(values) {
    if (!values.length) return null;
    const m = mean(values);
    const variance = values.reduce((a, b) => a + ((b - m) ** 2), 0) / values.length;
    return Math.sqrt(variance);
}

function csvEscape(value) {
    const s = value == null ? '' : String(value);
    if (!/[",\n]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
    const args = {
        samples: 60,
        intervalMs: 1000,
        durationSec: null,
        headless: false,
        slowMo: 0,
        protocolTimeout: 180000,
        defaultTimeoutMs: 45000,
        navTimeoutMs: 120000,
        outCsv: null,
        includeCandleTime: true,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') return { ...args, help: true };
        if (a === '--headless') { args.headless = true; continue; }
        if (a === '--no-headless') { args.headless = false; continue; }
        if (a === '--no-candle-time') { args.includeCandleTime = false; continue; }

        const next = () => (i + 1 < argv.length ? argv[++i] : undefined);

        if (a === '--samples') { args.samples = Math.max(1, toInt(next(), args.samples)); continue; }
        if (a === '--interval-ms') { args.intervalMs = Math.max(100, toInt(next(), args.intervalMs)); continue; }
        if (a === '--duration-sec') { args.durationSec = Math.max(1, toFloat(next(), 0)); continue; }
        if (a === '--slowmo') { args.slowMo = Math.max(0, toInt(next(), args.slowMo)); continue; }
        if (a === '--protocol-timeout') { args.protocolTimeout = Math.max(1000, toInt(next(), args.protocolTimeout)); continue; }
        if (a === '--timeout') { args.defaultTimeoutMs = Math.max(1000, toInt(next(), args.defaultTimeoutMs)); continue; }
        if (a === '--nav-timeout') { args.navTimeoutMs = Math.max(1000, toInt(next(), args.navTimeoutMs)); continue; }
        if (a === '--out') { args.outCsv = next() || null; continue; }
    }

    if (args.durationSec != null && args.durationSec > 0) {
        args.samples = Math.max(1, Math.ceil((args.durationSec * 1000) / args.intervalMs));
    }

    return args;
}

function printHelp() {
    console.log(`
Live Broker Time Probe (bot/tests/test-broker-time-live.js)

What it does:
  Samples broker clock (.current-time__time + .current-time__zone) against local clock,
  computes normalized drift in seconds, and optionally captures a visible candle time label.

Options:
  --samples N              Number of samples (default: 60)
  --interval-ms N          Interval between samples in ms (default: 1000)
  --duration-sec N         Alternative to samples (samples auto-calculated)
  --out PATH               Optional CSV output path

  --headless | --no-headless
  --no-candle-time         Disable best-effort candle time capture
  --slowmo MS
  --protocol-timeout MS
  --timeout MS
  --nav-timeout MS

Examples:
  node bot/tests/test-broker-time-live.js
  node bot/tests/test-broker-time-live.js --duration-sec 120 --interval-ms 1000
  node bot/tests/test-broker-time-live.js --samples 90 --out bot/tests/artifacts/broker-time.csv
`);
}

function promptEnter(message) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message, () => {
            rl.close();
            resolve();
        });
    });
}

async function waitForTradingUi(page) {
    await page.waitForSelector('.current-symbol, #put-call-buttons-chart-1, .btn-call, .btn-put', { timeout: 45000 }).catch(() => null);
}

async function readBrokerSnapshot(page, includeCandleTime) {
    return page.evaluate((wantCandle) => {
        const txt = (sel) => {
            const el = document.querySelector(sel);
            return el ? (el.textContent || '').trim() : null;
        };

        const brokerTime = txt('.current-time__time');
        const brokerZone = txt('.current-time__zone');

        let candleTime = null;
        if (wantCandle) {
            const selectors = [
                '#bar-chart .chart-container [class*="time"]',
                '#bar-chart .time-scale [class*="label"]',
                '#bar-chart [class*="x-axis"] text',
                '#bar-chart [class*="time-axis"]'
            ];

            for (const sel of selectors) {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const node of nodes) {
                    const t = (node.textContent || '').trim();
                    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
                        candleTime = t;
                        break;
                    }
                }
                if (candleTime) break;
            }
        }

        return { brokerTime, brokerZone, candleTime };
    }, includeCandleTime);
}

async function run() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        return;
    }

    const browser = await puppeteer.launch({
        headless: args.headless,
        slowMo: args.slowMo,
        protocolTimeout: args.protocolTimeout,
        defaultViewport: null,
        args: ['--start-maximized'],
    });

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(args.defaultTimeoutMs);
        page.setDefaultNavigationTimeout(args.navTimeoutMs);

        log('Navigating to Pocket Option demo page...', '\x1b[36m');
        await page.goto(DEMO_URL, { waitUntil: 'networkidle0', timeout: args.navTimeoutMs });
        await waitForTradingUi(page);

        await promptEnter('Log in and confirm demo page is ready, then press Enter to start time probe...\n');

        log(`Starting broker time probe: samples=${args.samples} intervalMs=${args.intervalMs}`, '\x1b[35m');

        const samples = [];
        const localUtcOffsetMin = -new Date().getTimezoneOffset();

        for (let i = 0; i < args.samples; i++) {
            const tickStart = Date.now();
            const localDate = new Date();
            const localClock = formatLocalClock(localDate);

            const snap = await readBrokerSnapshot(page, args.includeCandleTime).catch(() => ({
                brokerTime: null,
                brokerZone: null,
                candleTime: null,
            }));

            const localSec = parseHmsToSec(localClock);
            const brokerSec = parseHmsToSec(snap.brokerTime);
            const driftSec = (localSec != null && brokerSec != null)
                ? normalizeDayDeltaSec(brokerSec - localSec)
                : null;

            const brokerUtcOffsetMin = parseUtcZoneOffsetMinutes(snap.brokerZone);
            const zoneDeltaMin = (brokerUtcOffsetMin != null)
                ? (localUtcOffsetMin - brokerUtcOffsetMin)
                : null;

            const row = {
                sample: i + 1,
                localIso: localDate.toISOString(),
                localClock,
                localUtcOffsetMin,
                brokerTime: snap.brokerTime,
                brokerZone: snap.brokerZone,
                brokerUtcOffsetMin,
                zoneDeltaMin,
                candleTime: snap.candleTime,
                driftSec,
            };
            samples.push(row);

            const driftText = driftSec == null ? 'NA' : `${driftSec >= 0 ? '+' : ''}${driftSec.toFixed(0)}s`;
            const candleText = snap.candleTime ? ` candle=${snap.candleTime}` : '';
            const zoneText = snap.brokerZone ? ` zone=${snap.brokerZone}` : ' zone=NA';
            const color = driftSec == null ? '\x1b[33m' : (Math.abs(driftSec) <= 2 ? '\x1b[32m' : '\x1b[36m');
            log(`sample ${row.sample}/${args.samples} local=${localClock} broker=${snap.brokerTime || 'NA'}${zoneText} drift=${driftText}${candleText}`, color);

            const elapsed = Date.now() - tickStart;
            const sleepMs = Math.max(0, args.intervalMs - elapsed);
            if (i < args.samples - 1 && sleepMs > 0) {
                await new Promise(r => setTimeout(r, sleepMs));
            }
        }

        const driftValues = samples.map(s => s.driftSec).filter(v => Number.isFinite(v));
        const zones = Array.from(new Set(samples.map(s => s.brokerZone).filter(Boolean)));
        const m = mean(driftValues);
        const mn = driftValues.length ? Math.min(...driftValues) : null;
        const mx = driftValues.length ? Math.max(...driftValues) : null;
        const sd = stddev(driftValues);

        log('Time probe summary:', '\x1b[35m');
        log(`  samples=${samples.length} validDrift=${driftValues.length}`, '\x1b[36m');
        log(`  brokerZonesSeen=${zones.length > 0 ? zones.join(', ') : 'NA'}`, '\x1b[36m');
        log(`  meanDriftSec=${m != null ? m.toFixed(2) : 'NA'}`, '\x1b[36m');
        log(`  minDriftSec=${mn != null ? mn.toFixed(2) : 'NA'} maxDriftSec=${mx != null ? mx.toFixed(2) : 'NA'}`, '\x1b[36m');
        log(`  jitterStdDevSec=${sd != null ? sd.toFixed(2) : 'NA'}`, '\x1b[36m');

        if (args.outCsv) {
            const outPath = path.resolve(process.cwd(), args.outCsv);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });

            const header = [
                'sample', 'localIso', 'localClock', 'localUtcOffsetMin',
                'brokerTime', 'brokerZone', 'brokerUtcOffsetMin', 'zoneDeltaMin',
                'candleTime', 'driftSec'
            ];

            const lines = [header.join(',')];
            for (const s of samples) {
                lines.push([
                    s.sample,
                    csvEscape(s.localIso),
                    csvEscape(s.localClock),
                    s.localUtcOffsetMin,
                    csvEscape(s.brokerTime),
                    csvEscape(s.brokerZone),
                    s.brokerUtcOffsetMin == null ? '' : s.brokerUtcOffsetMin,
                    s.zoneDeltaMin == null ? '' : s.zoneDeltaMin,
                    csvEscape(s.candleTime),
                    s.driftSec == null ? '' : s.driftSec
                ].join(','));
            }

            fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
            log(`CSV written: ${outPath}`, '\x1b[32m');
        }

        log('Time probe complete.', '\x1b[32m');
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    log(`Fatal error: ${err.message}`, '\x1b[31m');
    console.error(err);
    process.exit(1);
});
