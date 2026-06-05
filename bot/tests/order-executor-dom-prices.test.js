'use strict';

/**
 * Focused DOM price tests for bot/scripts/order-executor.js
 *
 * Covers:
 * 1) parseDealsListResult extracts entry/exit from deals-list text
 * 2) syncLiveTradeResultsFromDOM price precedence:
 *    status_reason entry_price > parsed DOM entryPrice
 * 3) syncLiveTradeResultsFromDOM candle fallback when DOM prices missing
 *
 * Run:
 *   node bot/tests/order-executor-dom-prices.test.js
 */

const assert = require('assert');
const puppeteer = require('puppeteer');

const {
    parseDealsListResult,
    syncLiveTradeResultsFromDOM,
} = require('../scripts/order-executor');

function testSection(name) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ${name}`);
    console.log(`${'='.repeat(70)}`);
}

function ok(name) {
    console.log(`  \x1b[32m✅ ${name}\x1b[0m`);
}

function fail(name, error) {
    console.log(`  \x1b[31m❌ ${name}\x1b[0m`);
    console.log(`     Error: ${error.message}`);
    process.exitCode = 1;
}

function buildClosedTabAndDealsHtml(dealRows) {
    return `
<!doctype html>
<html>
  <body>
    <div id="bar-chart">
      <div class="widget-slot__header">
        <div class="divider">
          <ul>
            <li><a href="#open">Open</a></li>
            <li><a href="#closed">Closed</a></li>
          </ul>
        </div>
      </div>
      <div class="deals-list">
        ${dealRows.join('\n')}
      </div>
    </div>
  </body>
</html>`;
}

async function withBrowserPage(fn) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    try {
        await fn(page);
    } finally {
        await browser.close();
    }
}

async function runTest(name, fn) {
    try {
        await fn();
        ok(name);
    } catch (e) {
        fail(name, e);
    }
}

function makeDbMock({ orders, candleEntryClose = null, candleExitClose = null }) {
    const inserts = [];
    const queries = [];

    return {
        inserts,
        queries,

        async getExecutedOrdersAwaitingResultSync() {
            return orders;
        },

        async get(sql, params) {
            queries.push({ sql, params });
            const q = String(sql || '');
            if (q.includes('FROM candles')) {
                if (candleEntryClose != null) {
                    const value = candleEntryClose;
                    candleEntryClose = null;
                    return { close: value };
                }
                if (candleExitClose != null) {
                    const value = candleExitClose;
                    candleExitClose = null;
                    return { close: value };
                }
                return null;
            }
            return null;
        },

        async insertOrderedTradeClosed(...args) {
            inserts.push(args);
        },
    };
}

async function testParseEntryExitFromDomText() {
    const row = '<div class="deals-list__item">EUR/USD OTC Call Profit $0.89 (89%) 1.07596 -> 1.07576</div>';

    await withBrowserPage(async (page) => {
        await page.setContent(buildClosedTabAndDealsHtml([row]));
        const deals = await parseDealsListResult(page, 5);

        assert.strictEqual(deals.length, 1, 'Expected one parsed deal');
        assert.strictEqual(deals[0].asset, 'eurusd_otc', 'Asset normalization mismatch');
        assert.strictEqual(deals[0].direction, 'CALL', 'Direction parse mismatch');
        assert.strictEqual(deals[0].result, 'WIN', 'Result parse mismatch');
        assert.strictEqual(deals[0].payout, 89, 'Payout parse mismatch');
        assert.strictEqual(deals[0].profitLoss, 0.89, 'Profit parse mismatch');
        assert.strictEqual(deals[0].entryPrice, 1.07596, 'Entry price parse mismatch');
        assert.strictEqual(deals[0].exitPrice, 1.07576, 'Exit price parse mismatch');
    });
}

async function testSyncEntryPricePrecedenceStatusReasonOverDom() {
    const row = '<div class="deals-list__item">USD/JPY OTC Call Profit $1.11 (90%) 150.11111 -> 150.22222</div>';

    await withBrowserPage(async (page) => {
        await page.setContent(buildClosedTabAndDealsHtml([row]));

        const orderTs = Math.floor(Date.now() / 1000) - 1200;
        const db = makeDbMock({
            orders: [
                {
                    id: 501,
                    signal_id: 701,
                    asset: 'usdjpy_otc',
                    signal_timestamp: orderTs,
                    direction: 'CALL',
                    status_reason: 'placed_via=live-execution; entry_price=149.99999',
                    created_at: new Date((orderTs - 60) * 1000).toISOString(),
                    last_update_at: new Date(orderTs * 1000).toISOString(),
                },
            ],
        });

        const result = await syncLiveTradeResultsFromDOM(page, db, {
            limit: 10,
            expirySeconds: 900,
            tradeAmount: 1,
        });

        assert.strictEqual(result.synced, 1, 'Expected one synced order');
        assert.strictEqual(db.inserts.length, 1, 'Expected one trade insert');

        const insertArgs = db.inserts[0];
        const insertedEntryPrice = insertArgs[6];
        const insertedExitPrice = insertArgs[8];

        assert.strictEqual(insertedEntryPrice, 149.99999, 'status_reason entry_price should win over DOM entryPrice');
        assert.strictEqual(insertedExitPrice, 150.22222, 'Exit price should come from parsed DOM when available');
    });
}

async function testSyncCandleFallbackWhenDomPricesMissing() {
    const row = '<div class="deals-list__item">GBP/USD OTC Put Profit $0.95 (95%)</div>';

    await withBrowserPage(async (page) => {
        await page.setContent(buildClosedTabAndDealsHtml([row]));

        const orderTs = Math.floor(Date.now() / 1000) - 1800;
        const db = makeDbMock({
            orders: [
                {
                    id: 601,
                    signal_id: 801,
                    asset: 'gbpusd_otc',
                    signal_timestamp: orderTs,
                    direction: 'PUT',
                    status_reason: 'placed_via=live-execution',
                    created_at: new Date((orderTs - 60) * 1000).toISOString(),
                    last_update_at: new Date(orderTs * 1000).toISOString(),
                },
            ],
            candleEntryClose: 1.25001,
            candleExitClose: 1.24911,
        });

        const result = await syncLiveTradeResultsFromDOM(page, db, {
            limit: 10,
            expirySeconds: 900,
            tradeAmount: 1,
        });

        assert.strictEqual(result.synced, 1, 'Expected one synced order');
        assert.strictEqual(db.inserts.length, 1, 'Expected one trade insert');

        const insertArgs = db.inserts[0];
        const insertedEntryPrice = insertArgs[6];
        const insertedExitPrice = insertArgs[8];

        assert.strictEqual(insertedEntryPrice, 1.25001, 'Entry should fall back to candles close when DOM entry missing');
        assert.strictEqual(insertedExitPrice, 1.24911, 'Exit should fall back to candles close when DOM exit missing');

        const candleQueries = db.queries.filter(q => String(q.sql).includes('FROM candles'));
        assert.ok(candleQueries.length >= 2, 'Expected candle fallback queries for both entry and exit');
    });
}

async function main() {
    testSection('Order Executor DOM Price Tests');
    await runTest('parseDealsListResult extracts entry/exit prices', testParseEntryExitFromDomText);
    await runTest('sync: status_reason entry_price overrides parsed DOM entry', testSyncEntryPricePrecedenceStatusReasonOverDom);
    await runTest('sync: missing DOM prices fall back to candles close', testSyncCandleFallbackWhenDomPricesMissing);

    if (process.exitCode) {
        console.log('\nOne or more tests failed.');
    } else {
        console.log('\nAll tests passed.');
    }
}

main().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exitCode = 1;
});
