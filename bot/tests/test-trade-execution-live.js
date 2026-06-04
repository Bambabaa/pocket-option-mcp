#!/usr/bin/env node
'use strict';

/**
 * Live/manual execution harness for order-executor.js
 *
 * Supports:
 * - Direct placement via placeOrderLive (dry or real)
 * - Optional DB queue execution via executeOrderById
 * - Optional result sync via syncLiveTradeResultsFromDOM
 *
 * Usage:
 *   node bot/tests/test-trade-execution-live.js --help
 *   node bot/tests/test-trade-execution-live.js --dry --asset "EURUSD_otc,USDJPY_otc" --direction CALL
 *   node bot/tests/test-trade-execution-live.js --real-trade --asset "EURUSD_otc" --direction PUT --sync-results
 *   node bot/tests/test-trade-execution-live.js --with-db --from-queue --real-trade --sync-results
 */

const readline = require('readline');
const puppeteer = require('puppeteer');

const {
    placeOrderLive,
    resetSessionCalibration,
    getBalanceFromDOM,
} = require('../scripts/order-executor');

const DEMO_URL = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/';

function log(msg, color = '\x1b[0m') {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    console.log(`${color}[${ts}] ${msg}\x1b[0m`);
}

function toInt(v, fallback) {
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
    const args = {
        dryRun: true,
        realTrade: false,
        withDb: false,
        fromQueue: false,
        listAssets: false,
        debugDeals: false,
        syncResults: false,
        direction: 'CALL',
        assets: ['EURUSD_otc'],
        tradeAmount: 1,
        expirationSec: 60,
        minPayout: 70,
        tradeDelayMs: 0,
        headless: false,
        slowMo: 0,
        protocolTimeout: 180000,
        defaultTimeoutMs: 45000,
        navTimeoutMs: 120000,
        limitAssets: 250,
        buttonWaitTimeoutMs: 4000,
        postAssetSelectWaitMs: 400,
        uiSettleWaitMs: 0,
        placeOrderTimeoutMs: 12000,
        resultWaitSec: null,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') return { ...args, help: true };
        if (a === '--dry') { args.dryRun = true; args.realTrade = false; continue; }
        if (a === '--real-trade') { args.realTrade = true; args.dryRun = false; continue; }
        if (a === '--with-db') { args.withDb = true; continue; }
        if (a === '--from-queue') { args.fromQueue = true; args.withDb = true; continue; }
        if (a === '--list-assets') { args.listAssets = true; continue; }
        if (a === '--debug-deals') { args.debugDeals = true; continue; }
        if (a === '--sync-results') { args.syncResults = true; continue; }
        if (a === '--headless') { args.headless = true; continue; }
        if (a === '--no-headless') { args.headless = false; continue; }

        const next = () => (i + 1 < argv.length ? argv[++i] : undefined);

        if (a === '--asset' || a === '--assets') {
            const v = next();
            if (v) args.assets = v.split(',').map(s => s.trim()).filter(Boolean);
            continue;
        }
        if (a === '--direction') {
            const v = String(next() || '').toUpperCase();
            if (v === 'CALL' || v === 'PUT') args.direction = v;
            continue;
        }
        if (a === '--amount') { args.tradeAmount = toInt(next(), args.tradeAmount); continue; }
        if (a === '--expiry' || a === '--expiration') { args.expirationSec = toInt(next(), args.expirationSec); continue; }
        if (a === '--min-payout') { args.minPayout = parseFloat(next() || '0') || 0; continue; }
        if (a === '--delay') { args.tradeDelayMs = toInt(next(), args.tradeDelayMs); continue; }
        if (a === '--slowmo') { args.slowMo = toInt(next(), args.slowMo); continue; }
        if (a === '--protocol-timeout') { args.protocolTimeout = toInt(next(), args.protocolTimeout); continue; }
        if (a === '--timeout') { args.defaultTimeoutMs = toInt(next(), args.defaultTimeoutMs); continue; }
        if (a === '--nav-timeout') { args.navTimeoutMs = toInt(next(), args.navTimeoutMs); continue; }
        if (a === '--limit-assets') { args.limitAssets = toInt(next(), args.limitAssets); continue; }
        if (a === '--button-wait') { args.buttonWaitTimeoutMs = toInt(next(), args.buttonWaitTimeoutMs); continue; }
        if (a === '--post-select-wait') { args.postAssetSelectWaitMs = toInt(next(), args.postAssetSelectWaitMs); continue; }
        if (a === '--ui-settle-wait') { args.uiSettleWaitMs = toInt(next(), args.uiSettleWaitMs); continue; }
        if (a === '--place-order-timeout') { args.placeOrderTimeoutMs = toInt(next(), args.placeOrderTimeoutMs); continue; }
        if (a === '--result-wait') { args.resultWaitSec = toInt(next(), 0); continue; }
    }

    return args;
}

function printHelp() {
    console.log(`
Live Trade Execution Harness (bot/tests/test-trade-execution-live.js)

Options:
  --dry                    Dry-run mode (default)
  --real-trade             Place real demo clicks
    --with-db                Ignored in this harness (DB writes disabled)
    --from-queue             Ignored in this harness (DB writes disabled)
    --list-assets            Print visible asset rows from the UI
    --debug-deals            Include raw deal row text in result output
    --sync-results           Wait for expiry and print DOM closed-deal snapshot

  --asset "A,B"            Assets list (default: EURUSD_otc)
  --direction CALL|PUT     Direction (default: CALL)
  --amount N               Trade amount (default: 1)
    --expiry N               Expiration sec (default: 60, i.e. 1m)
  --min-payout N           Minimum payout gate (default: 70)

  --headless | --no-headless
  --slowmo MS
  --protocol-timeout MS
  --timeout MS
  --nav-timeout MS
    --limit-assets N         Max rows for --list-assets (default: 250)
  --button-wait MS
  --post-select-wait MS
    --ui-settle-wait MS      Extra wait after UI ready before actions
  --place-order-timeout MS
  --result-wait SEC        Override post-place wait before result sync

Examples:
    node bot/tests/test-trade-execution-live.js --list-assets
  node bot/tests/test-trade-execution-live.js --dry --asset "EURUSD_otc,USDJPY_otc"
  node bot/tests/test-trade-execution-live.js --real-trade --asset "EURUSD_otc" --direction PUT --sync-results
    node bot/tests/test-trade-execution-live.js --real-trade --sync-results --asset "EURUSD_otc" --debug-deals
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

async function openAssetsPanelBestEffort(page) {
    try {
        const symbol = await page.$('.current-symbol');
        if (symbol) {
            await symbol.click();
            await new Promise(r => setTimeout(r, 600));
        }
    } catch (_) {
        // best-effort only
    }
}

async function listVisibleAssets(page, limit = 250) {
    await openAssetsPanelBestEffort(page);
    return page.evaluate((maxRows) => {
        const out = [];
        const seen = new Set();
        const isAssetLike = (text) => {
            if (!text || text.length > 60) return false;
            return /[A-Z]{2,4}\s*\/\s*[A-Z]{2,4}/i.test(text) || /OTC/i.test(text) || /\d{2,3}\s*%/.test(text);
        };

        let nodes = Array.from(document.querySelectorAll('.assets-list__item[data-id], .assets-list__item, span.alist__label, [class*="assets-list"] li'));
        if (nodes.length === 0) {
            nodes = Array.from(document.querySelectorAll('li, [role="option"], [class*="item"]'))
                .filter(el => isAssetLike((el.textContent || '').trim()));
        }

        for (const el of nodes) {
            const id = (el.getAttribute('data-id') || '').trim();
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            if (!id && !isAssetLike(text)) continue;
            const key = (id || text).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ id, text });
            if (out.length >= maxRows) break;
        }

        return out;
    }, Math.max(1, limit));
}

function parseNumberLoose(v) {
    if (v == null) return null;
    const s = String(v).replace(/,/g, '').replace(/[^\d.+-]/g, '');
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function normalizeAssetLabel(label) {
    if (!label) return null;
    const txt = String(label).trim().toUpperCase();
    const isOtc = /\bOTC\b/.test(txt);
    const m = txt.match(/([A-Z]{3})\s*\/\s*([A-Z]{3})/);
    if (!m) return null;
    return (m[1] + m[2]).toLowerCase() + (isOtc ? '_otc' : '');
}

async function openClosedDealsTabBestEffort(page) {
    const selectors = [
        '#bar-chart .widget-slot__header .divider ul li:nth-child(2) a',
        '.widget-slot__header a[href*="history"]',
        '.deals-tab',
        '[data-tab="history"]',
        '.tabs a:nth-child(2)',
        '.divider ul li a'
    ];

    for (const sel of selectors) {
        try {
            const el = await page.$(sel);
            if (!el) continue;
            await el.click();
            await new Promise(r => setTimeout(r, 1200));
            const hasRows = await page.$('.deals-list__item');
            if (hasRows) return true;
        } catch (_) {
            // try next selector
        }
    }

    return false;
}

async function expandClosedDealRowsBestEffort(page, limit = 5) {
    try {
        const rows = await page.$$('.deals-list__item .deals-list__item-short, .deals-list__item .open-full-info');
        const n = Math.min(limit, rows.length);
        for (let i = 0; i < n; i++) {
            try {
                await rows[i].click();
                await new Promise(r => setTimeout(r, 120));
            } catch (_) {
                // ignore per-row click failures
            }
        }
    } catch (_) {
        // best-effort only
    }
}

async function getClosedDealsRich(page, limit = 20) {
    await openClosedDealsTabBestEffort(page);
    await expandClosedDealRowsBestEffort(page, Math.max(3, Math.min(8, limit)));
    await new Promise(r => setTimeout(r, 800));

    return page.evaluate((maxItems) => {
        const rows = Array.from(document.querySelectorAll('.deals-list__item'));
        const out = [];

        const parseMoney = (text) => {
            if (!text) return null;
            const cleaned = String(text).replace(/,/g, '').replace(/[^\d.+-]/g, '');
            if (!cleaned) return null;
            const n = parseFloat(cleaned);
            return Number.isFinite(n) ? n : null;
        };

        const parsePercent = (text) => {
            if (!text) return null;
            const m = String(text).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
            return m ? parseFloat(m[1]) : null;
        };

        const normalizeAsset = (label) => {
            if (!label) return null;
            const txt = String(label).trim().toUpperCase();
            const isOtc = /\bOTC\b/.test(txt);
            const m = txt.match(/([A-Z]{3})\s*\/\s*([A-Z]{3})/);
            if (!m) return null;
            return (m[1] + m[2]).toLowerCase() + (isOtc ? '_otc' : '');
        };

        for (const row of rows) {
            if (out.length >= maxItems) break;

            const full = row.querySelector('.deals-list__item-full') || row;

            const priceItems = Array.from(full.querySelectorAll('.price-info__prices-item, [class*="price-info__prices-item"]'))
                .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim());

            const openText = priceItems.find(t => /open\s*price\s*:/i.test(t));
            const closeText = priceItems.find(t => /clos(?:e|ing)\s*price\s*:/i.test(t));

            const entryPrice = openText ? parseMoney(openText.split(':').slice(1).join(':')) : null;
            const exitPrice = closeText ? parseMoney(closeText.split(':').slice(1).join(':')) : null;
            const hasRichPrices = entryPrice != null && exitPrice != null;

            const short = row.querySelector('.deals-list__item-short');
            const row1 = short ? short.querySelector('.item-row:nth-child(1)') : null;
            const row2 = short ? short.querySelector('.item-row:nth-child(2)') : null;

            const assetAnchor = row1
                ? Array.from(row1.querySelectorAll('a')).find(a => /\//.test((a.textContent || '').trim()))
                : null;
            const assetLabel = assetAnchor ? (assetAnchor.textContent || '').trim() : '';
            const asset = normalizeAsset(assetLabel);

            const payoutText = row1 ? (row1.querySelector('.price-up')?.textContent || '') : '';
            const payout = parsePercent(payoutText);

            const closeClockText = row1 ? (row1.lastElementChild?.textContent || '') : '';
            let closeTimeHHMM = null;
            const tm = closeClockText.match(/(\d{1,2}):(\d{2})/);
            if (tm) closeTimeHHMM = { h: parseInt(tm[1], 10), m: parseInt(tm[2], 10) };

            const forecastText = (full.querySelector('.forecast .act')?.textContent || '').trim().toUpperCase();
            let direction = null;
            if (forecastText === 'SELL' || forecastText === 'PUT') direction = 'PUT';
            if (forecastText === 'BUY' || forecastText === 'CALL') direction = 'CALL';
            if (!direction) {
                const iconText = row2 ? (row2.querySelector('i')?.className || '') : '';
                if (/arrow-down|put|sell/i.test(iconText)) direction = 'PUT';
                if (/arrow-up|call|buy/i.test(iconText)) direction = 'CALL';
            }

            const amountText = row2 ? (row2.querySelector('div:nth-child(1)')?.textContent || '') : '';
            const inferredAmount = parseMoney(amountText);

            const profitText = row2 ? (row2.querySelector('div:nth-child(3)')?.textContent || '') : '';
            let profitLoss = parseMoney(profitText);
            if (profitLoss != null && /^\s*-/.test(profitText)) profitLoss = -Math.abs(profitLoss);
            if (profitLoss != null && /^\s*\+/.test(profitText)) profitLoss = Math.abs(profitLoss);

            let result = 'UNKNOWN';
            if (profitLoss != null) result = profitLoss > 0 ? 'WIN' : (profitLoss < 0 ? 'LOSS' : 'DRAW');

            // If P/L is ambiguous (0 or missing), infer outcome from direction and price movement.
            if ((profitLoss == null || profitLoss === 0) && direction && entryPrice != null && exitPrice != null) {
                const delta = exitPrice - entryPrice;
                const eps = 1e-10;
                if (Math.abs(delta) <= eps) {
                    result = 'DRAW';
                    if (profitLoss == null) profitLoss = 0;
                } else if (direction === 'CALL') {
                    result = delta > 0 ? 'WIN' : 'LOSS';
                    if (profitLoss == null && inferredAmount != null) {
                        profitLoss = result === 'WIN'
                            ? inferredAmount * ((payout != null ? payout : 0) / 100)
                            : -inferredAmount;
                    }
                } else if (direction === 'PUT') {
                    result = delta < 0 ? 'WIN' : 'LOSS';
                    if (profitLoss == null && inferredAmount != null) {
                        profitLoss = result === 'WIN'
                            ? inferredAmount * ((payout != null ? payout : 0) / 100)
                            : -inferredAmount;
                    }
                }
            }

            const rawText = (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);

            // Keep actionable rows even if this specific row has no expanded price block yet.
            if (!asset && !direction && profitLoss == null && !hasRichPrices) continue;

            out.push({
                asset,
                direction,
                result,
                profitLoss,
                payout,
                inferredAmount,
                closeTimeHHMM,
                entryPrice,
                exitPrice,
                hasRichPrices,
                rawText
            });
        }

        return out;
    }, Math.max(1, limit));
}

async function showClosedDeals(page, expectedCount = 1, options = {}) {
    const fallbackDirection = options.fallbackDirection || null;
    const fallbackAmount = Number.isFinite(options.fallbackAmount) ? options.fallbackAmount : null;
    const debugDeals = options.debugDeals === true;

    const deals = await getClosedDealsRich(page, Math.max(10, expectedCount + 3));
    if (!deals || deals.length === 0) {
        log('No closed deals parsed from rich UI rows (.price-info__prices).', '\x1b[33m');
        return;
    }
    log('Closed deals snapshot:', '\x1b[35m');
    const richCount = deals.filter(d => d.hasRichPrices).length;
    log(`Rich price rows: ${richCount}/${deals.length}`, richCount > 0 ? '\x1b[36m' : '\x1b[33m');
    deals.slice(0, expectedCount).forEach((d, i) => {
        // Compact rows like "$1$0$0" often omit explicit loss amount; recover stake if possible.
        const rawStake = parseNumberLoose(d.inferredAmount);

        const inferredAmount = (d.inferredAmount != null && d.inferredAmount > 0)
            ? d.inferredAmount
            : (rawStake != null && rawStake > 0)
                ? rawStake
                : (fallbackAmount != null && fallbackAmount > 0)
                    ? fallbackAmount
                    : null;

        const normalizedProfitLoss = (d.result === 'LOSS' && (d.profitLoss == null || d.profitLoss === 0) && inferredAmount != null)
            ? -inferredAmount
            : d.profitLoss;

        const pl = normalizedProfitLoss != null
            ? ` $${normalizedProfitLoss >= 0 ? '+' : ''}${Number(normalizedProfitLoss).toFixed(2)}`
            : '';
        const payout = d.payout != null ? ` payout=${d.payout}%` : '';
        const inferred = inferredAmount != null ? ` inferredAmount=${inferredAmount}` : '';
        const hhmm = d.closeTimeHHMM && Number.isFinite(d.closeTimeHHMM.h) && Number.isFinite(d.closeTimeHHMM.m)
            ? ` close=${String(d.closeTimeHHMM.h).padStart(2, '0')}:${String(d.closeTimeHHMM.m).padStart(2, '0')}`
            : '';
        const entry = d.entryPrice != null ? ` entry=${d.entryPrice}` : ' entry=N/A';
        const exit = d.exitPrice != null ? ` exit=${d.exitPrice}` : ' exit=N/A';
        const richTag = d.hasRichPrices ? ' prices=RICH' : ' prices=PARTIAL';
        const raw = (debugDeals || d.result === 'UNKNOWN') && d.rawText ? ` raw="${d.rawText}"` : '';
        const direction = d.direction || fallbackDirection || '?';
        const color = d.result === 'WIN' ? '\x1b[32m' : d.result === 'LOSS' ? '\x1b[31m' : '\x1b[33m';
        log(`  ${i + 1}. ${d.asset || normalizeAssetLabel(options.fallbackAssetLabel) || '?'} ${direction} ${d.result}${pl}${payout}${inferred}${hhmm}${entry}${exit}${richTag}${raw}`, color);
    });
}

function makeExecutionConfig(args) {
    return {
        enabled: true,
        dryRun: args.dryRun,
        minPayout: args.minPayout,
        tradeDelayMs: args.tradeDelayMs,
        expirationSec: args.expirationSec,
        buttonWaitTimeoutMs: args.buttonWaitTimeoutMs,
        postAssetSelectWaitMs: args.postAssetSelectWaitMs,
        placeOrderTimeoutMs: args.placeOrderTimeoutMs,
        useEvaluateClick: true,
    };
}

async function executeDirect(page, args) {
    const config = makeExecutionConfig(args);
    const results = [];

    for (const asset of args.assets) {
        const order = { asset, direction: args.direction };
        const r = await placeOrderLive(page, order, {
            ...config,
            tradeAmount: args.tradeAmount,
        });
        results.push({ asset, ...r });
        const color = r.success ? '\x1b[32m' : '\x1b[31m';
        const entry = r.entryPrice != null ? ` entry=${r.entryPrice}` : '';
        log(`${asset} ${args.direction}: ${r.success ? 'OK' : 'FAIL'}${entry}${r.error ? ` - ${r.error}` : ''}`, color);
    }

    return results;
}

async function run() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        return;
    }

    if (args.realTrade) args.dryRun = false;

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

        await promptEnter('Log in and confirm demo page is ready, then press Enter to continue...\n');

        if (args.uiSettleWaitMs > 0) {
            log(`UI settle wait: ${args.uiSettleWaitMs}ms`, '\x1b[36m');
            await new Promise(r => setTimeout(r, args.uiSettleWaitMs));
        }

        if (args.listAssets) {
            const rows = await listVisibleAssets(page, args.limitAssets);
            log(`Visible assets found: ${rows.length}`, '\x1b[36m');
            if (rows.length === 0) {
                log('No assets discovered from current DOM selectors.', '\x1b[33m');
            } else {
                rows.forEach((r, i) => log(`  ${i + 1}. data-id="${r.id}" text="${r.text}"`, '\x1b[36m'));
            }
            log('Test run complete.', '\x1b[32m');
            return;
        }

        resetSessionCalibration();

        if (args.withDb || args.fromQueue) {
            log('DB mode flags detected, but this harness is configured to NOT write DB. Ignoring --with-db/--from-queue.', '\x1b[33m');
        }

        log(`Mode: ${args.dryRun ? 'DRY' : 'REAL TRADE'} | assets=${args.assets.join(', ')} direction=${args.direction} amount=$${args.tradeAmount} expiry=${args.expirationSec}s`, '\x1b[35m');

        const results = await executeDirect(page, args);

        const placed = results.filter(r => r.success || r.status === 'EXECUTED').length;

        if (args.syncResults && !args.dryRun) {
            const waitSec = args.resultWaitSec != null ? args.resultWaitSec : (args.expirationSec + 5);
            if (waitSec > 0) {
                log(`Waiting ${waitSec}s before result sync...`, '\x1b[36m');
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }

            log('DB sync disabled by design (no DB writes). Showing DOM closed deals only.', '\x1b[33m');
            log('Using rich closed-deal DOM parser (.price-info__prices) for entry/exit prices.', '\x1b[36m');

            const balance = await getBalanceFromDOM(page);
            if (balance) log(`Account balance: ${balance}`, '\x1b[36m');

            await showClosedDeals(page, Math.max(1, placed), {
                fallbackDirection: args.direction,
                fallbackAmount: args.tradeAmount,
                fallbackAssetLabel: args.assets[0] || null,
                debugDeals: args.debugDeals,
            });
        }

        log('Test run complete.', '\x1b[32m');
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    log(`Fatal error: ${err.message}`, '\x1b[31m');
    console.error(err);
    process.exit(1);
});
