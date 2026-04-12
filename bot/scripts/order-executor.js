/**
 * Shared order execution logic. Used by:
 * - pocket-option-bot.js
 *
 * Writes actual trades to trades_ordered (source of truth for executed live orders).
 */

const SEL = {
    // Scoped to trading panel first (avoids wrong element when multiple .btn-call exist)
    btnCall: '#put-call-buttons-chart-1 .btn-call',
    btnPut: '#put-call-buttons-chart-1 .btn-put',
    btnCallFallbacks: [
        '.btn-call', '.btn-up', '.call-btn',
        '#put-call-buttons-chart-1 [data-action="call"]',
        'button.btn-call'
    ],
    btnPutFallbacks: [
        '.btn-put', '.btn-down', '.put-btn',
        '#put-call-buttons-chart-1 [data-action="put"]',
        'button.btn-put'
    ],
    currentSymbol: '.current-symbol',
    currentPrice: '.current-price, .strike-price, .price-value',
    assetListItem: '.assets-list__item[data-id]',
    assetByDataId: (asset) => `.assets-list__item[data-id="${asset}"]`,
    assetSearchInput: 'input[placeholder*="earch" i], input[placeholder*="ymbol" i], .assets-list input',
    amountInput: '.block--bet-amount input[type=text]',
    amountInputLong: '#put-call-buttons-chart-1 .block--bet-amount input[type=text]',
    amountInputFull: '#put-call-buttons-chart-1 .block.block--bet-amount .control__value input[type=text]',
    virtualKeyboard: '#modal-root div.virtual-keyboard',
    virtualKeyboardDigit: (n) => `#modal-root .virtual-keyboard > div > div:nth-child(${n}) > div`,
    virtualKeyboardBackspace: '.virtual-keyboard__col:last-of-type',
    payout: '.value__val.value__val-payout',
    balanceHeader: 'header span.js-balance, .balance-info-block__balance span',
    balanceDemoModal: 'div.balance-item--demo .js-balance-demo',
    balanceModalOpener: 'div.right-block__item.js-drop-down-modal-open',
    expirationBlock: '.block--expiration-inputs',
    expiration60: '[data-value="60"], [data-period="60"], .block--expiration-inputs [data-value="60"]',
    closedTab: '#bar-chart .widget-slot__header .divider ul li:nth-child(2) a',
    closedTabFallbacks: [
        '.widget-slot__header a[href*="history"]',
        '.deals-tab',
        '[data-tab="history"]',
        '.tabs a:nth-child(2)',
        '#bar-chart .right-widget-container .widget-slot__header .divider ul li:nth-child(2) a',
        '.divider ul li a'
    ],
    dealsListItem: '.deals-list__item',
    // Virtual keyboard digit mapping (nth-child index per digit)
    NUMBERS: { '0': '11', '1': '7', '2': '8', '3': '9', '4': '4', '5': '5', '6': '6', '7': '1', '8': '2', '9': '3' }
};

/**
 * Execution mutex: serializes live placement so only one order uses the Puppeteer page at a time.
 * Prevents concurrent selectAsset/click from overwriting each other when multiple signals fire.
 */
let _executionLock = Promise.resolve();

/**
 * Session calibration: amount and expiration are set ONCE, then reused for all subsequent orders.
 * Per-order we only: select asset → click CALL/PUT. Speeds up execution when trading multiple assets.
 */
let _sessionCalibrated = { amount: null, expirationSec: null };

/** Prevent double-syncing same DOM row across result-sync cycles (asset_direction_h:m_result). */
const _syncedDealSignatures = new Set();

async function calibrateTradingPanelIfNeeded(page, { tradeAmount = 1, expirationSec = 60, checkAbort = () => false }) {
    const amt = Math.round(tradeAmount);
    const exp = expirationSec;
    if (_sessionCalibrated.amount === amt && _sessionCalibrated.expirationSec === exp) {
        return; // Already calibrated
    }
    console.log(`   [EXECUTOR] Calibrating trading panel: amount=$${amt}, expiration=${exp}s (one-time)`);
    await setTradeAmount(page, amt, checkAbort);
    if (checkAbort()) return;
    await setExpiration(page, exp, checkAbort);
    if (checkAbort()) return;
    _sessionCalibrated = { amount: amt, expirationSec: exp };
}

function resetSessionCalibration() {
    _sessionCalibrated = { amount: null, expirationSec: null };
}

/**
 * Set trade expiration (seconds). Called once at session start.
 */
async function setExpiration(page, sec = 60, checkAbort = () => false) {
    try {
        const raw = SEL.expiration60 || '';
        const selectors = [
            ...(raw ? raw.split(',').map(s => s.trim()) : []),
            `[data-value="${sec}"]`,
            `[data-period="${sec}"]`,
            `.block--expiration-inputs [data-value="${sec}"]`
        ].filter(Boolean);
        for (const sel of selectors) {
            const el = await page.$(sel);
            if (el) {
                // Pre-check: if already active, skip
                const isActive = await el.evaluate(node => node.classList.contains('active') || node.classList.contains('selected') || node.getAttribute('aria-selected') === 'true');
                if (isActive) return;

                await el.click();
                if (checkAbort()) return;
                await new Promise(r => setTimeout(r, 200));
                return;
            }
        }
        const clicked = await page.evaluate((s) => {
            const block = document.querySelector('.block--expiration-inputs');
            if (!block) return false;
            const links = block.querySelectorAll('a, button, [role="button"], .control-buttons__wrapper *');
            for (const el of links) {
                const text = (el.textContent || '').trim();
                const val = el.getAttribute('data-value') || el.getAttribute('data-period');
                if (val === String(s) || text === String(s) || (s === 60 && (text === '1m' || text === '60'))) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, sec);
        if (clicked) {
            if (checkAbort()) return;
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (e) {
        console.log(`   [EXECUTOR] Expiration set skipped: ${e.message}`);
    }
}

async function withExecutionLock(fn) {
    const prev = _executionLock;
    let release;
    _executionLock = new Promise(resolve => { release = resolve; });
    try {
        await prev;
        return await fn();
    } finally {
        release();
    }
}

/**
 * Execute a single order: gates → insertTrade → updateOrderStatus.
 * @param {object} database - TradingDatabase instance
 * @param {object} order - Order row from orders_queue { id, signal_id, asset, direction, signal_timestamp }
 * @param {object} config - { tradeAmount, skipQualifiedGate, riskMax, page, execution }
 * @returns {Promise<'EXECUTED'|'SKIPPED'|'FAILED'>}
 */
async function executeOneOrder(database, order, config = {}) {
    const tradeAmount = config.tradeAmount != null ? config.tradeAmount : 1;
    const skipQualifiedGate = config.skipQualifiedGate === true;
    const riskMax = config.riskMax;

    // Gate: already have closed trade record
    const alreadyTraded = await database.hasOrderedTradeForOrder(order.id);
    if (alreadyTraded) {
        console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: already in trades_ordered`);
        await database.updateOrderStatus(order.id, 'SKIPPED', 'trade already closed (trades_ordered)');
        return 'SKIPPED';
    }
    // Gate: already placed (awaiting result sync) - don't place again (ALWAYS fetch fresh status - order object may be stale)
    const statusRow = await database.get('SELECT status FROM orders_queue WHERE id = ?', [order.id]);
    const status = statusRow?.status;
    if (status === 'EXECUTED') {
        console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: already EXECUTED (awaiting result sync)`);
        return 'EXECUTED'; // Already placed, result sync will write trades_ordered when closed
    }

    // Gate: requireLiveExecution - only trade when we can place real orders (no dry-run, no stub)
    if (config.requireLiveExecution === true) {
        if (!config.page || !config.execution?.enabled) {
            console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: requireLiveExecution but no page or execution disabled`);
            await database.updateOrderStatus(order.id, 'SKIPPED', 'requireLiveExecution: no page or execution disabled');
            return 'SKIPPED';
        }
        if (config.execution.dryRun === true) {
            console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: requireLiveExecution but dryRun=true`);
            await database.updateOrderStatus(order.id, 'SKIPPED', 'requireLiveExecution: dryRun mode');
            return 'SKIPPED';
        }
    }

    // Gate: qualified assets (unless skipped for testing)
    if (!skipQualifiedGate) {
        const qualified = await database.isAssetQualified(order.asset);
        if (!qualified) {
            console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: asset not in qualified_assets`);
            await database.updateOrderStatus(order.id, 'SKIPPED', 'asset not in qualified_assets');
            return 'SKIPPED';
        }
    }

    // Gate: risk_score (optional)
    if (riskMax != null) {
        const signal = await database.getSignalById(order.signal_id);
        const risk = signal && signal.risk_score != null ? signal.risk_score : 0;
        if (risk > riskMax) {
            console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: risk_score ${risk} > ${riskMax}`);
            await database.updateOrderStatus(order.id, 'SKIPPED', `risk_score ${risk} > ${riskMax}`);
            return 'SKIPPED';
        }
    }

    // Entry price
    let entryPrice = null;
    const prices = await database.getPrices(order.asset, 1);
    if (prices && prices.length > 0) entryPrice = prices[0].price;
    if (entryPrice == null) {
        const atSignal = await database.getPriceAtTimestamp(order.asset, order.signal_timestamp, 30);
        entryPrice = atSignal ? atSignal.price : 0;
    }
    if (entryPrice == null || entryPrice === 0) {
        console.log(`   [EXEC] FAIL order ${order.id} ${order.asset} ${order.direction}: no entry price`);
        await database.updateOrderStatus(order.id, 'FAILED', 'no entry price');
        return 'FAILED';
    }

    // Execute: place order, update status. trades_ordered written ONLY when trade closes (result sync).
    try {
        let placedVia = 'executor-stub';

        if (config.page && config.execution && config.execution.enabled) {
            const execResult = await withExecutionLock(async () => {
                // Re-check status inside lock: another execution may have placed while we waited
                const statusRow = await database.get('SELECT status FROM orders_queue WHERE id = ?', [order.id]);
                if (statusRow?.status === 'EXECUTED') {
                    return { success: true, skipped: true }; // Already placed - skip duplicate
                }
                const result = await placeOrderLive(config.page, order, { ...config.execution, tradeAmount });
                if (result.success) {
                    const notesValue = config.execution.dryRun ? 'dry-run' : 'live-execution';
                    const priceNote = result.entryPrice ? `; entry_price=${result.entryPrice}` : '';
                    await database.updateOrderStatus(order.id, 'EXECUTED', `placed_via=${notesValue}${priceNote}`);
                }
                return result;
            });
            if (execResult.skipped) {
                console.log(`   [EXEC] SKIP order ${order.id} ${order.asset} ${order.direction}: already EXECUTED (duplicate within lock)`);
                return 'EXECUTED';
            }
            if (!execResult.success) {
                console.log(`   [EXEC] FAIL order ${order.id} ${order.asset} ${order.direction}: ${execResult.error}`);
                await database.updateOrderStatus(order.id, 'FAILED', execResult.error);
                return 'FAILED';
            }
            placedVia = config.execution.dryRun ? 'dry-run' : 'live-execution';
            console.log(`   [EXEC] ✅ LIVE order ${order.id} ${order.asset} ${order.direction} placed (${placedVia})`);
        } else {
            console.log(`   [EXEC] ✅ STUB order ${order.id} ${order.asset} ${order.direction} (no page or execution disabled)`);
        }

        // Mark EXECUTED - for stub path only; live path already updated inside lock
        if (placedVia === 'executor-stub') {
            await database.updateOrderStatus(order.id, 'EXECUTED', `placed_via=${placedVia}`);
        }

        // For executor-stub: no real PO trade, so result sync never runs. Insert trades_ordered immediately.
        if (placedVia === 'executor-stub') {
            const now = Math.floor(Date.now() / 1000);
            const entryTs = now; // Stub "placed" now; no real 60s expiry to wait for
            await database.insertOrderedTradeClosed(
                order.id, order.asset, entryTs, order.direction,
                null, tradeAmount, 'executor-stub', order.signal_id,
                now, null, 'STUB', null
            );
        }
        return 'EXECUTED';
    } catch (err) {
        let finalStatus = 'FAILED';
        let statusReason = err.message;

        // If the error is a timeout, check if this order already timed out before
        if (err.message.includes('timeout') || err.message.includes('Timeout')) {
            try {
                const prevRow = await database.get('SELECT status_reason FROM orders_queue WHERE id = ?', [order.id]);
                if (prevRow && prevRow.status_reason && prevRow.status_reason.includes('timeout')) {
                    finalStatus = 'SKIPPED';
                    statusReason = `Repeated execution timeout (${err.message}) - skipping trade`;
                    console.log(`   [EXECUTOR] Asset ${order.asset} timed out repeatedly - skipping trade`);
                }
            } catch (ignore) { }
        }

        // Retry loop to bypass SQLITE_BUSY locks
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await database.updateOrderStatus(order.id, finalStatus, statusReason);
                success = true;
                break;
            } catch (dbErr) {
                if (attempt < 3) await new Promise(r => setTimeout(r, 200 * attempt));
            }
        }

        if (!success) {
            console.error(`   [CRITICAL] Order ${order.id} stuck in PENDING! Failed to write ${finalStatus}.`);
        }
        throw err;
    }
}

/**
 * Execute order on live Pocket Option page via Puppeteer.
 * Sequence: select asset (if needed) → set amount → click CALL/PUT.
 *
 * @param {object} page - Puppeteer page instance
 * @param {object} order - Order object { asset, direction, ... }
 * @param {object} execConfig - { enabled, dryRun, minPayout, tradeDelayMs, tradeAmount, expirationSec }
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function placeOrderLive(page, order, execConfig) {
    try {
        const DRY_RUN = execConfig.dryRun === true;
        const DELAY = execConfig.tradeDelayMs || 0;
        const MIN_PAYOUT = execConfig.minPayout || 0;
        const tradeAmount = execConfig.tradeAmount != null ? execConfig.tradeAmount : 1;
        const expirationSec = execConfig.expirationSec != null ? execConfig.expirationSec : 60;
        const btnTimeout = execConfig.buttonWaitTimeoutMs ?? 4000;
        const postWait = execConfig.postAssetSelectWaitMs ?? 1200;
        const placeOrderTimeoutMs = execConfig.placeOrderTimeoutMs ?? 10000;

        const primary = order.direction === 'CALL' ? (SEL.btnCall || '.btn-call') : (SEL.btnPut || '.btn-put');
        const fallbacks = order.direction === 'CALL' ? (SEL.btnCallFallbacks || []) : (SEL.btnPutFallbacks || []);
        const btnSelectors = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])];
        const payoutSel = SEL.payout || '.value__val.value__val-payout';

        console.log(`⚡ [EXECUTOR] Preparing ${DRY_RUN ? 'DRY RUN ' : ''}${order.direction} on ${order.asset} (amount: ${tradeAmount})...`);

        // 1. Wait for Delay (Anti-detect)
        if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY));

        // 2. Check Payout (Optional)
        if (MIN_PAYOUT > 0) {
            try {
                const payoutText = await page.$eval(payoutSel, el => el.textContent).catch(() => '0%');
                const payout = parseFloat(payoutText.replace('%', ''));
                if (payout > 0 && payout < MIN_PAYOUT) {
                    return { success: false, error: `Payout ${payout}% < ${MIN_PAYOUT}%` };
                }
            } catch (e) { /* ignore */ }
        }

        if (DRY_RUN) {
            const previewSelector = Array.isArray(btnSelectors) && btnSelectors.length > 0
                ? btnSelectors[0]
                : (order.direction === 'CALL' ? (SEL.btnCall || '.btn-call') : (SEL.btnPut || '.btn-put'));
            console.log(`   [DRY RUN] Would: select asset ${order.asset}, click ${previewSelector}`);
            return { success: true };
        }

        let isTimedOut = false;
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                isTimedOut = true;
                reject(new Error(`Place order timeout (${placeOrderTimeoutMs}ms)`));
            }, placeOrderTimeoutMs);
        });

        const placeOrder = async () => {
            const recordTiming = execConfig.recordTiming === true;
            const t0 = recordTiming ? Date.now() : 0;

            // 3. Select asset (if not already selected) - skip trade if selection fails after retries
            const assetSelected = await selectAssetIfNeeded(page, order.asset, {
                checkAbort: () => isTimedOut
            });
            if (isTimedOut) {
                console.log(`   [ABORT] ⚠️ placeOrder execution aborted after asset selection due to timeout.`);
                return { success: false, error: 'Aborted due to timeout race' };
            }
            const t1 = recordTiming ? Date.now() : 0;
            if (assetSelected === false) {
                return { success: false, error: `Asset ${order.asset} not found after retries - skipping trade` };
            }

            // 4. Calibrate amount + expiration once (skip if already done for this session)
            // Re-check timeout before potentially heavy calibration
            if (isTimedOut) return { success: false, error: 'Aborted before calibration' };
            await calibrateTradingPanelIfNeeded(page, { tradeAmount, expirationSec, checkAbort: () => isTimedOut });
            if (isTimedOut) {
                console.log(`   [ABORT] ⚠️ placeOrder execution aborted after calibration due to timeout.`);
                return { success: false, error: 'Aborted due to timeout race' };
            }
            const afterSelect = await page.$eval(SEL.currentSymbol || '.current-symbol', el => (el.textContent || '').trim()).catch(() => '');
            const wantNorm = normalizeAssetForMatch(order.asset);
            const gotNorm = normalizeAssetForMatch(afterSelect);
            // Accept pair-only match when UI omits OTC (e.g. "EUR/USD" for eurusd_otc)
            const pairOnlyMatch = (wantNorm.startsWith(gotNorm) && gotNorm.length >= 6) || (gotNorm.startsWith(wantNorm.slice(0, 6)) && wantNorm.length > 6);
            if (wantNorm && !pairOnlyMatch && wantNorm !== gotNorm && !gotNorm.includes(wantNorm) && !wantNorm.includes(gotNorm)) {
                console.log(`   ⚠️ [EXECUTOR] Wanted ${order.asset}, got "${afterSelect}" - verify trade asset`);
            }

            // Post-asset-selection wait: chart/trading panel needs time to settle before buttons are visible
            if (postWait > 0) await new Promise(r => setTimeout(r, postWait));

            // Close asset dropdown or other overlays so they don't block CALL/PUT
            await page.evaluate(() => {
                const modal = document.querySelector('div.drop-down-modal-wrap.active');
                if (modal) {
                    const backdrop = modal.querySelector('.drop-down-modal-wrap__backdrop') || modal;
                    backdrop?.click();
                }
            }).catch(() => { });
            await new Promise(r => setTimeout(r, 50));

            const t2 = recordTiming ? Date.now() : 0;
            // 5. Click CALL or PUT (try primary + fallbacks, optional retry for transient overlay)
            let btn = null;
            console.log(`   [EXECUTOR] Waiting for ${order.direction} button (timeout ${btnTimeout}ms per selector)...`);
            for (const attempt of [1, 2]) {
                for (const sel of btnSelectors) {
                    btn = await page.waitForSelector(sel, { visible: true, timeout: btnTimeout }).catch(() => null);
                    if (btn) break;
                }
                if (btn) break;
                if (attempt === 1) await new Promise(r => setTimeout(r, 150));
            }
            if (!btn) throw new Error(`CALL/PUT button not found (tried: ${btnSelectors.join(', ')})`);

            if (isTimedOut) {
                console.log(`   [ABORT] ⚠️ placeOrder execution aborted at the final click due to timeout.`);
                return { success: false, error: 'Aborted due to timeout race' };
            }

            const useEvaluateClick = execConfig.useEvaluateClick === true;
            if (useEvaluateClick) {
                // Synthetic click via evaluate - some sites accept this when CDP mouse does not register
                await btn.evaluate(el => el.click());
            } else {
                // Coordinate-based click (CDP mouse) - avoids hover-only behavior on some sites
                const box = await btn.boundingBox();
                if (box) {
                    const x = box.x + box.width / 2;
                    const y = box.y + box.height / 2;
                    await page.mouse.move(x, y);
                    await new Promise(r => setTimeout(r, 20));
                    await page.mouse.down();
                    await new Promise(r => setTimeout(r, 20));
                    await page.mouse.up();
                } else {
                    await btn.click({ delay: 20 });
                }
            }

            const t3 = recordTiming ? Date.now() : 0;

            // Capture entry price just before/during click if possible
            const entryPrice = await page.$eval(SEL.currentPrice || '.current-price', el => parseFloat((el.textContent || '').replace(/[^\d.]/g, ''))).catch(() => null);

            console.log(`   ✅ [EXECUTED] Clicked ${order.direction}${entryPrice ? ` @ ${entryPrice}` : ''}`);
            if (recordTiming) {
                return {
                    success: true,
                    entryPrice,
                    timing: {
                        dropdownSelect_ms: t1 - t0,
                        postSelectWaitPlusModal_ms: t2 - t1,
                        executeClick_ms: t3 - t2,
                        total_ms: t3 - t0,
                        timestamps: { start: t0, afterSelect: t1, beforeClick: t2, afterClick: t3 }
                    }
                };
            }
            return { success: true, entryPrice };
        };

        return await Promise.race([placeOrder(), timeoutPromise]);

    } catch (error) {
        console.error(`   ❌ [EXECUTION FAILED] ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Normalize asset name for matching (e.g. "USD/JPY OTC" or "USDJPY_otc" -> "USDJPYOTC").
 */
function normalizeAssetForMatch(asset) {
    if (!asset) return '';
    return (asset + '')
        .replace(/_/g, '')
        .replace(/\s*\/\s*/g, '')
        .replace(/\s/g, '')
        .replace(/\+\d+%?/g, '')
        .toUpperCase();
}

/**
 * True when UI display matches target asset.
 * OTC and non-OTC are distinct: audchf_otc must match "AUD/CHF OTC", not "AUD/CHF".
 * For OTC, accepts reversed pair (e.g. "AUD/USD OTC" matches USDAUD_otc).
 */
function assetDisplayMatchesTarget(uiNorm, targetNorm) {
    if (!uiNorm || !targetNorm) return false;
    if (uiNorm === targetNorm) return true;
    if (targetNorm.includes(uiNorm) && uiNorm.length >= 6 && !targetNorm.endsWith('OTC')) return true;
    // OTC: same pair in either order (e.g. AUDUSDOTC matches USDAUDOTC)
    if (uiNorm.endsWith('OTC') && targetNorm.endsWith('OTC') && uiNorm.length === 9 && targetNorm.length === 9) {
        const uiPair = uiNorm.slice(0, 6);
        const targetPair = targetNorm.slice(0, 6);
        if (uiPair === targetPair) return true;
        if (uiPair === targetPair.slice(3, 6) + targetPair.slice(0, 3)) return true;
    }
    return false;
}

/**
 * Get display pair from asset (e.g. "USDJPY_otc" -> "USD/JPY", "USD/JPY OTC" -> "USD/JPY").
 */
function getPairFromAsset(asset) {
    if (!asset) return '';
    const s = (asset + '').replace(/_/g, ' ').trim();
    const m = s.match(/^([A-Z]{3})\s*\/?\s*([A-Z]{3})/i) || s.match(/([A-Z]{3})\s*\/\s*([A-Z]{3})/i);
    if (m) return m[1].toUpperCase() + '/' + m[2].toUpperCase();
    if (s.length >= 6 && /^[A-Z]{6}/i.test(s.replace(/\s/g, ''))) {
        const t = s.replace(/\s/g, '').toUpperCase().slice(0, 6);
        return t.slice(0, 3) + '/' + t.slice(3, 6);
    }
    return '';
}

/** True when both are OTC norms and textNorm is the reversed pair of targetNorm (e.g. AUDUSDOTC vs USDAUDOTC). */
function isReversedOtcPair(textNorm, targetNorm) {
    if (!textNorm || !targetNorm || textNorm.length !== 9 || targetNorm.length !== 9) return false;
    if (!textNorm.endsWith('OTC') || !targetNorm.endsWith('OTC')) return false;
    const rev = targetNorm.slice(3, 6) + targetNorm.slice(0, 3);
    return textNorm.slice(0, 6) === rev;
}

/**
 * Select asset if not currently selected.
 * @param {object} page - Puppeteer page
 * @param {string} asset - Asset name e.g. "EURUSD_otc"
 * @param {object} options - { maxRetries: 2, checkAbort: () => boolean }
 */
async function selectAssetIfNeeded(page, asset, options = {}) {
    const maxRetries = options.maxRetries ?? 2;
    const checkAbort = typeof options.checkAbort === 'function' ? options.checkAbort : () => false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (checkAbort()) {
            console.log(`   [ABORT] ⚠️ Skipping asset selection retry for ${asset} due to timeout.`);
            return false;
        }

        try {
            const currentText = await page.$eval(SEL.currentSymbol, el => el.textContent || '').catch(() => '');
            const currentNorm = normalizeAssetForMatch(currentText);
            const targetNorm = normalizeAssetForMatch(asset);
            if (assetDisplayMatchesTarget(currentNorm, targetNorm)) {
                if (attempt > 0) console.log(`   [EXECUTOR] Asset ${asset} confirmed after retry`);
                else console.log(`   [EXECUTOR] Asset ${asset} already selected`);
                return true;
            }

            if (attempt > 0) {
                console.log(`   [EXECUTOR] Retry ${attempt}/${maxRetries} selecting ${asset}...`);
            } else {
                console.log(`   [EXECUTOR] Selecting asset ${asset}...`);
            }

            // Open the asset list
            await page.click(SEL.currentSymbol);
            await new Promise(r => setTimeout(r, 250));
            if (checkAbort()) return false;

            // 1. Use search input to filter list (reduces wrong matches)
            const pairAddress = getPairFromAsset(asset);
            const wantOtcFlag = asset.toLowerCase().endsWith('_otc');

            // Find and click within browser context to avoid "Detached Node" errors
            const foundInBrowser = await page.evaluate((searchStr, normTarget, otcOnly) => {
                const isMatchedInternal = (t, otc, target) => {
                    const text = (t || '').trim();
                    if (text.length > 35) return false;
                    const hasOtc = /OTC/i.test(text);
                    if (otc && !hasOtc) return false;
                    if (!otc && hasOtc) return false;
                    const textNorm = text.replace(/\s*\/\s*/g, '').replace(/\s/g, '').replace(/\+\d+%?/g, '').toUpperCase();
                    return textNorm === target || textNorm.startsWith(target);
                };

                // Filter search first
                if (searchStr) {
                    const inputs = document.querySelectorAll('input[type="text"], input[placeholder*="earch" i], input[placeholder*="ymbol" i], .assets-list input');
                    for (const inp of inputs) {
                        if (inp.closest('.assets-list, .modal, .dropdown')) {
                            inp.focus();
                            inp.value = '';
                            inp.value = searchStr;
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }

                // Scan list
                const items = document.querySelectorAll('span.alist__label, .assets-list__item, [class*="assets-list"] li');
                for (const el of items) {
                    if (isMatchedInternal(el.textContent, otcOnly, normTarget)) {
                        const clickable = el.closest('a') || el.querySelector('a') || el;
                        clickable.scrollIntoView({ block: 'center', behavior: 'instant' });
                        clickable.click();
                        return true;
                    }
                }
                return false;
            }, pairAddress ? pairAddress.replace('/', ' ') : '', targetNorm, wantOtcFlag);

            if (foundInBrowser) {
                await new Promise(r => setTimeout(r, 800));
                if (checkAbort()) return false;

                const verifyText = await page.$eval(SEL.currentSymbol, el => el.textContent || '').catch(() => '');
                if (assetDisplayMatchesTarget(normalizeAssetForMatch(verifyText), targetNorm)) {
                    console.log(`   [EXECUTOR] Asset selected: ${verifyText.trim()}`);
                    return true;
                }
            }

            // Cleanup: press Escape to close modal if it didn't select
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 400));
        } catch (e) {
            console.log(`   [EXECUTOR] Asset select attempt ${attempt + 1}: ${e.message}`);
        }
    }
    return false;
}

/**
 * Set trade amount. Tries: (1) direct JS value set, (2) $1 quick button, (3) virtual keyboard.
 */
async function setTradeAmount(page, amount, checkAbort = () => false) {
    const amt = Math.round(amount);
    const amountSelectors = [
        SEL.amountInputFull,
        SEL.amountInputLong,
        SEL.amountInput,
        '#put-call-buttons-chart-1 .block--bet-amount input[type=text]',
        '.block--bet-amount input[type=text]'
    ].filter(Boolean);

    try {
        let amountSel = null;
        for (const sel of amountSelectors) {
            if (await page.$(sel)) {
                amountSel = sel;
                break;
            }
        }
        if (!amountSel) {
            console.log(`   [EXECUTOR] Amount input not found`);
            return;
        }

        // 0. Pre-check: if already correct, skip expensive work
        const currentVal = await page.evaluate((sel) => {
            const input = document.querySelector(sel);
            return input ? input.value : null;
        }, amountSel);
        if (currentVal === String(amt)) return;

        if (checkAbort()) return;
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 150));

        if (checkAbort()) return;
        // 1. Try native keyboard type (focus input, select all, type - works if input accepts key events)
        await page.click(amountSel);
        await new Promise(r => setTimeout(r, 300));
        if (checkAbort()) return;
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type(String(amt), { delay: 50 });
        await new Promise(r => setTimeout(r, 200));
        const readBack = await page.evaluate((sel) => {
            const input = document.querySelector(sel);
            return input ? input.value : null;
        }, amountSel);
        if (readBack === String(amt)) {
            return;
        }

        // 2. Try direct JS set (React may ignore keyboard - try value + events)
        const directOk = await page.evaluate((sel, val) => {
            const input = document.querySelector(sel);
            if (!input) return false;
            const nativeInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (nativeInput && nativeInput.set) {
                nativeInput.set.call(input, String(val));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                input.value = String(val);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return input.value === String(val);
        }, amountSel, amt);
        if (directOk) {
            await new Promise(r => setTimeout(r, 200));
            return;
        }

        // 3. Try $1 quick button if amount is 1 (add amountQuick1 to PO_SELECTORS when known)
        if (amt === 1 && SEL.amountQuick1) {
            const q1 = await page.$(SEL.amountQuick1);
            if (q1) {
                await page.click(SEL.amountQuick1);
                await new Promise(r => setTimeout(r, 200));
                return;
            }
        }

        // 4. Virtual keyboard: click input, wait, clear, type digits
        if (checkAbort()) return;
        await page.click(amountSel);
        await new Promise(r => setTimeout(r, 700));
        if (checkAbort()) return;
        const keyboardSel = SEL.virtualKeyboard || '#modal-root div.virtual-keyboard';
        const kb = await page.waitForSelector(keyboardSel, { visible: true, timeout: 3000 }).catch(() => null);
        if (!kb) {
            console.log(`   [EXECUTOR] Virtual keyboard not found - amount may be wrong`);
            return;
        }

        const backspaceSelectors = [
            '#modal-root .virtual-keyboard .virtual-keyboard__col:last-of-type',
            '.virtual-keyboard .virtual-keyboard__col:last-of-type',
            SEL.virtualKeyboardBackspace
        ].filter(Boolean);
        const NUMBERS = SEL.NUMBERS || { '0': '11', '1': '7', '2': '8', '3': '9', '4': '4', '5': '5', '6': '6', '7': '1', '8': '2', '9': '3' };
        const digitSelFn = typeof SEL.virtualKeyboardDigit === 'function' ? SEL.virtualKeyboardDigit : (n) => `#modal-root .virtual-keyboard > div > div:nth-child(${n}) > div`;

        for (const sel of backspaceSelectors) {
            if (await page.$(sel)) {
                for (let i = 0; i < 10; i++) {
                    await page.click(sel).catch(() => { });
                    await new Promise(r => setTimeout(r, 100));
                }
                break;
            }
        }
        await new Promise(r => setTimeout(r, 150));

        // Enter digits - try nth-child first, fallback to click-by-text
        const str = String(amt);
        for (const char of str) {
            const n = NUMBERS[char];
            if (n) {
                const keySel = digitSelFn(parseInt(n, 10));
                let clicked = await page.click(keySel).then(() => true).catch(() => false);
                if (!clicked) {
                    await page.evaluate((digit) => {
                        const cols = document.querySelectorAll('#modal-root .virtual-keyboard .virtual-keyboard__col, .virtual-keyboard .virtual-keyboard__col');
                        for (const col of cols) {
                            const inner = col.querySelector('.virtual-keyboard__input, [class*="virtual-keyboard"]');
                            if (inner && (inner.textContent || '').trim() === digit) {
                                inner.click();
                                return;
                            }
                        }
                    }, char);
                }
                await new Promise(r => setTimeout(r, 120));
            }
        }
        await new Promise(r => setTimeout(r, 200));

        const finalVal = await page.evaluate((sel) => {
            const input = document.querySelector(sel);
            return input ? input.value : null;
        }, amountSel).catch(() => null);
        if (finalVal !== String(amt)) {
            console.log(`   [EXECUTOR] Amount may be wrong: wanted ${amt}, got "${finalVal}"`);
        }
    } catch (e) {
        console.log(`   [EXECUTOR] Amount set skipped: ${e.message}`);
    }
}

/**
 * Execute order by id (fetches order from DB).
 */
async function executeOrderById(database, orderId, config) {
    const order = await database.get('SELECT * FROM orders_queue WHERE id = ?', [orderId]);
    if (!order) return null;
    return executeOneOrder(database, order, config);
}

/**
 * Read account balance from DOM (header or demo modal). Used after trades close for collective report.
 * @param {object} page - Puppeteer page
 * @returns {Promise<string|null>} Balance text (e.g. "$123.45") or null
 */
async function getBalanceFromDOM(page) {
    const headerSel = SEL.balanceHeader;
    const demoSel = SEL.balanceDemoModal;
    try {
        return await page.evaluate((hSel, dSel) => {
            const el = document.querySelector(hSel) || document.querySelector(dSel);
            if (!el) return null;
            const t = (el.textContent || '').trim();
            return t && /[\d.]/.test(t) ? t : null;
        }, headerSel, demoSel);
    } catch (_) {
        return null;
    }
}

/**
 * Parse .deals-list__item for WIN/LOSS/DRAW, profit/loss, and payout %.
 * @param {object} page - Puppeteer page
 * @param {number} limit - Max items to return
 * @param {string} [selectorOverride] - Optional CSS selector (e.g. alternate list item class)
 * @returns {Promise<Array<{result: string, profitLoss: number|null, payout: number|null, rawText: string, asset: string|null}>>}
 */
async function parseDealsListResult(page, limit = 5, selectorOverride = null) {
    const sel = selectorOverride || SEL.dealsListItem || '.deals-list__item';
    try {
        return await page.evaluate((selector, maxItems) => {
            const els = document.querySelectorAll(selector);
            const out = [];
            for (let i = 0; i < els.length && out.length < maxItems; i++) {
                const el = els[i];
                const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
                // Skip empty-state or non-trade nodes (e.g. "No opened trades", "TradesOpenedClosed")
                if (/no opened trades|trades\s*opened\s*closed/i.test(text)) continue;
                if (text.length < 8) continue;
                if (!/\d{2,3}%|\$[\d.]+\s*\(|([A-Z]{3})\/([A-Z]{3})/i.test(text)) continue;
                const cls = (el.className || '').toLowerCase();
                let profitLoss = null;
                let payout = null;
                // 1. Primary: "Profit $X (Y%)" - allow flexible whitespace
                let m = text.match(/Profit\s*\$?\s*([\d.]+)\s*\(\s*([\d.]+)\s*%\)/i);
                if (m) {
                    profitLoss = parseFloat(m[1]);
                    payout = parseFloat(m[2]);
                } else {
                    // 2. Fallback: any $X (Y%) where X is NOT 1 (stake) - profit format
                    const all = text.matchAll(/\$\s*([\d.]+)\s*\(\s*([\d.]+)\s*%\)/g);
                    for (const match of all) {
                        const amt = parseFloat(match[1]);
                        if (amt !== 1 && (amt === 0 || amt > 1 || (amt > 0 && amt < 1))) {
                            profitLoss = amt;
                            payout = parseFloat(match[2]);
                            break;
                        }
                    }
                    if (profitLoss == null && payout == null) {
                        const profitOnly = text.match(/Profit\s*\$?\s*([\d.]+)/i);
                        if (profitOnly) profitLoss = parseFloat(profitOnly[1]);
                        const payoutOnly = text.match(/\(\s*([\d.]+)\s*%\)/);
                        if (payoutOnly) payout = parseFloat(payoutOnly[1]);
                    }
                    // 3. Compact format: "ASSET +92%18:28$1$0$0" (LOSS) or "$1$1.89+$0.89" (WIN)
                    if (profitLoss == null) {
                        const compactProfit = text.match(/\+\$([\d.]+)/);
                        if (compactProfit) {
                            profitLoss = parseFloat(compactProfit[1]);
                        } else if (/\$\d+(?:\.\d+)?\$0(\$0)?/.test(text)) {
                            profitLoss = 0;
                        }
                        if (payout == null) {
                            const compactPayout = text.match(/\+([\d.]+)%/);
                            if (compactPayout) payout = parseFloat(compactPayout[1]);
                        }
                    }
                }
                // Check DRAW first (DOM class/text) — $0 profit alone would wrongly become LOSS
                let result = null;
                const isDraw = /draw|equal|refund/i.test(cls) || /\bdraw\b|refund/i.test(text);

                if (isDraw) {
                    result = 'DRAW';
                    profitLoss = 0; // DRAW means mathematical $0 profit
                } else if (profitLoss != null) {
                    result = profitLoss > 0 ? 'WIN' : 'LOSS';
                } else {
                    if (/win|won|up|profit/i.test(cls) || /\bwin\b|won|\+\$/i.test(text)) result = 'WIN';
                    else result = 'LOSS';
                }
                let asset = null;
                const assetM = text.match(/^([A-Z]{3})\/?([A-Z]{3})(?:\s*OTC)?/i) || text.match(/([A-Z]{3})\/?([A-Z]{3})(?:\s*OTC)?/i);
                if (assetM) {
                    const isOtc = /OTC/i.test(assetM[0]);
                    asset = (assetM[1] + assetM[2]).toLowerCase() + (isOtc ? '_otc' : '');
                }
                // Direction: try data attributes, class names, or text (for same-asset disambiguation)
                let direction = null;
                const dataDir = el.getAttribute('data-direction') || el.getAttribute('data-action');
                if (dataDir && /call|put/i.test(dataDir)) direction = dataDir.toUpperCase().startsWith('C') ? 'CALL' : 'PUT';
                else if (/deal.*call|call.*deal|win-call|loss-call|btn-call/i.test(cls)) direction = 'CALL';
                else if (/deal.*put|put.*deal|win-put|loss-put|btn-put/i.test(cls)) direction = 'PUT';
                else if (/\bCall\b/i.test(text)) direction = 'CALL';
                else if (/\bPut\b/i.test(text)) direction = 'PUT';
                // Inferred stake for amount matching (profitLoss*100/payout for WIN; |profitLoss| for LOSS)
                let inferredAmount = null;
                if (profitLoss != null && payout != null && payout > 0 && profitLoss > 0) {
                    inferredAmount = profitLoss * 100 / payout;
                } else if (profitLoss != null && profitLoss <= 0) {
                    inferredAmount = -profitLoss;
                }
                // Close time for time-window matching (compact: +92%18:28 -> {hour:18, min:28})
                let closeTimeHHMM = null;
                const timeM = text.match(/(\d{1,2}):(\d{2})(?:\d{2})?(?=[\s$%]|$)/);
                if (timeM) {
                    closeTimeHHMM = { h: parseInt(timeM[1], 10), m: parseInt(timeM[2], 10) };
                }

                // Entry/Exit Prices: match patterns like "1.07596 -> 1.07576" or "1.07596...1.07576" or just "1.07596 1.07576"
                let entryPrice = null;
                let exitPrice = null;
                // Match two numbers (min 5 digits each) separated by anything non-digit
                const priceM = text.match(/([\d.]{5,})[^\d.]{1,10}([\d.]{5,})/) || text.match(/Price:\s*([\d.]{5,})/i) || text.match(/([\d.]{5,})\s*[→\->]\s*([\d.]{5,})/);
                if (priceM) {
                    entryPrice = parseFloat(priceM[1]);
                    if (priceM[2]) exitPrice = parseFloat(priceM[2]);
                }

                out.push({
                    result: result || 'UNKNOWN',
                    profitLoss,
                    payout,
                    rawText: text.slice(0, 120),
                    asset,
                    direction,
                    inferredAmount,
                    closeTimeHHMM,
                    entryPrice,
                    exitPrice
                });
            }
            return out;
        }, sel, limit);
    } catch (_) {
        return [];
    }
}

/**
 * Update trades_ordered with parsed result from .deals-list__item.
 * @param {object} database - TradingDatabase instance
 * @param {number} tradeId - trades_ordered id
 * @param {object} parsed - { result, profitLoss } from parseDealsListResult
 */
async function updateTradeExitFromParsed(database, tradeId, parsed) {
    const exitTimestamp = Math.floor(Date.now() / 1000);
    // Assuming updateTradeExit handles trades_ordered update or we adapt logic:
    await database.updateTradeExit(tradeId, exitTimestamp, null, parsed.result, parsed.profitLoss);
}

/**
 * Open the History/Closed tab and parse deals from DOM (no DB). Used by test script to show trade results.
 * @param {object} page - Puppeteer page
 * @param {number} limit - Max deal items to return
 * @returns {Promise<Array>} Parsed deals (same shape as parseDealsListResult)
 */
async function openClosedTabAndGetDeals(page, limit = 20) {
    const tryClickClosedTab = async (sel) => {
        try {
            const el = await page.$(sel);
            if (el) {
                await el.click();
                await new Promise(r => setTimeout(r, 3500));
                const itemSel = SEL.dealsListItem || '.deals-list__item';
                await page.waitForSelector(itemSel, { timeout: 5000 }).catch(() => null);
                return true;
            }
        } catch (_) { }
        return false;
    };
    const primarySel = SEL.closedTab || '#bar-chart .widget-slot__header .divider ul li:nth-child(2) a';
    await tryClickClosedTab(primarySel);
    // Scroll deals list so virtualized or overflow-hidden lists render more rows
    await page.evaluate((itemSel) => {
        const first = document.querySelector(itemSel);
        if (first) {
            const list = first.closest('[class*="deals-list"], [class*="history"], [class*="scroll"]') || first.parentElement;
            if (list && list.scrollHeight > list.clientHeight) {
                list.scrollTop = 0;
            }
            list?.scrollTo?.({ top: list.scrollHeight, behavior: 'auto' });
        }
    }, SEL.dealsListItem || '.deals-list__item').catch(() => { });
    await new Promise(r => setTimeout(r, 800));
    let deals = await parseDealsListResult(page, limit);
    if (deals.length === 0 && SEL.closedTabFallbacks && Array.isArray(SEL.closedTabFallbacks)) {
        for (const fallbackSel of SEL.closedTabFallbacks) {
            const clicked = await tryClickClosedTab(fallbackSel);
            if (clicked) {
                deals = await parseDealsListResult(page, limit);
                if (deals.length > 0) break;
            }
        }
    }
    // If still no items, try alternate list selectors (some PO layouts use different classes)
    if (deals.length === 0) {
        const altSelectors = ['.deals-list__item', '[class*="deals-list"] li', '[class*="history"] li', '[class*="deal"]', '.deals-list li'];
        for (const sel of altSelectors) {
            deals = await parseDealsListResult(page, limit, sel);
            if (deals.length > 0) break;
        }
    }
    return deals || [];
}

/**
 * Sync WIN/LOSS from PO DOM into trades_ordered. trades_ordered is written ONLY when trade is closed.
 * Queries executed orders awaiting result, parses deals, inserts trades_ordered with full result.
 * @param {object} page - Puppeteer page
 * @param {object} database - TradingDatabase instance
 * @param {object} options - { limit: 10, expirySeconds: 65, tradeAmount: 1, checkPreempt: () => boolean }
 * @returns {Promise<{synced: number}>}
 */
async function syncLiveTradeResultsFromDOM(page, database, options = {}) {
    const limit = options.limit ?? 10;
    const expirySeconds = options.expirySeconds ?? 65;
    const defaultAmount = options.tradeAmount ?? 1;
    const checkPreempt = typeof options.checkPreempt === 'function' ? options.checkPreempt : () => false;

    const orders = await database.getExecutedOrdersAwaitingResultSync(limit, expirySeconds);
    if (!orders || orders.length === 0) {
        return { synced: 0, ordersAwaited: 0 };
    }

    if (checkPreempt()) return { synced: 0, ordersAwaited: orders.length };

    console.log(`   [RESULT-SYNC] Starting: ${orders.length} order(s) awaiting result (${orders.map(o => `${o.asset} ${o.direction}`).join(', ')})`);
    const deals = await withExecutionLock(async () => {
        const tryClickClosedTab = async (sel) => {
            if (checkPreempt()) return false;
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.click();
                    // Check preemption after click
                    if (checkPreempt()) return false;
                    await new Promise(r => setTimeout(r, 600));
                    if (checkPreempt()) return false;

                    const itemSel = SEL.dealsListItem || '.deals-list__item';
                    await page.waitForSelector(itemSel, { visible: true, timeout: 2500 }).catch(() => null);
                    return true;
                }
            } catch (_) { }
            return false;
        };
        const primarySel = SEL.closedTab || '#bar-chart .widget-slot__header .divider ul li:nth-child(2) a';
        const clickedPrimary = await tryClickClosedTab(primarySel);

        if (checkPreempt()) return [];

        let dealsList = await parseDealsListResult(page, Math.max(limit, orders.length + 2));
        if (dealsList.length === 0 && orders.length > 0 && !clickedPrimary && SEL.closedTabFallbacks && Array.isArray(SEL.closedTabFallbacks)) {
            for (const fallbackSel of SEL.closedTabFallbacks) {
                if (checkPreempt()) break;
                const clicked = await tryClickClosedTab(fallbackSel);
                if (clicked) {
                    dealsList = await parseDealsListResult(page, Math.max(limit, orders.length + 2));
                    if (dealsList.length > 0) break;
                }
            }
        }
        return dealsList;
    });
    const dealsWithAsset = deals.filter(d => d.asset).length;
    console.log(`   [RESULT-SYNC] Parsed ${deals.length} deal(s) from DOM (${dealsWithAsset} with asset for matching)`);
    if (orders.length > 0 && deals.length === 0) {
        console.log(`   [RESULT-SYNC] ⚠️ No deals found - check closed tab selector or DOM`);
    }
    // Match orders to deals by asset (live order from DOM), not by row index - handles manual trades and out-of-order closes
    const usedDealIndices = new Set();
    let synced = 0;
    for (const order of orders) {
        const orderNorm = normalizeAssetForMatch(order.asset);
        if (!orderNorm) continue;
        let matchedDeal = null;
        let matchedIdx = -1;
        const expirySec = options.expirySeconds ?? 65;
        const expectedAmount = options.tradeAmount ?? defaultAmount;
        const orderSignalTs = order.signal_timestamp > 1e12 ? Math.floor(order.signal_timestamp / 1000) : order.signal_timestamp;
        const orderExpectedClose = orderSignalTs + expirySec;
        const candidates = [];
        for (let j = 0; j < deals.length; j++) {
            if (usedDealIndices.has(j)) continue;
            const d = deals[j];
            if (!d.asset) continue;
            const dealNorm = normalizeAssetForMatch(d.asset);
            if (dealNorm && orderNorm === dealNorm) {
                let score = 0;
                if (d.direction && order.direction && d.direction.toUpperCase() === order.direction.toUpperCase()) score += 100;
                if (d.inferredAmount != null && expectedAmount > 0) {
                    const diff = Math.abs(d.inferredAmount - expectedAmount);
                    score += Math.max(0, 50 - Math.min(diff, 50));
                }
                if (d.closeTimeHHMM) {
                    const expDate = new Date(orderExpectedClose * 1000);
                    const expMins = expDate.getUTCHours() * 60 + expDate.getUTCMinutes();
                    const dealMins = d.closeTimeHHMM.h * 60 + d.closeTimeHHMM.m;
                    const delta = Math.min(Math.abs(dealMins - expMins), Math.abs(dealMins - expMins + 1440), Math.abs(dealMins - expMins - 1440));
                    // Only allow matches within 1 minute. An old trade from 2 mins ago should NOT match.
                    if (delta <= 1) score += Math.max(0, 25 - Math.min(delta, 25));
                }
                candidates.push({ deal: d, idx: j, score });
            }
        }
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            matchedDeal = candidates[0].deal;
            matchedIdx = candidates[0].idx;
        }
        if (!matchedDeal) {
            console.log(`   [RESULT-SYNC] No matching live deal for order ${order.id} ${order.asset} ${order.direction} - skipping (may close later)`);
            continue;
        }
        if (matchedDeal.direction && order.direction && matchedDeal.direction.toUpperCase() !== order.direction.toUpperCase()) {
            console.warn(`   [RESULT-SYNC] ⚠️ Direction mismatch: order ${order.direction} vs deal ${matchedDeal.direction} (order ${order.id} ${order.asset})`);
        }
        const dir = (matchedDeal.direction || order.direction || '?').toUpperCase();
        const h = matchedDeal.closeTimeHHMM?.h ?? '?';
        const m = matchedDeal.closeTimeHHMM?.m ?? '?';
        const sig = `${matchedDeal.asset}_${dir}_${h}:${m}_${matchedDeal.result || 'UNKNOWN'}`;
        if (_syncedDealSignatures.has(sig)) {
            console.warn(`   [RESULT-SYNC] ⚠️ Deal already synced in a previous cycle. Waiting for new row to appear.`);
            continue;
        }
        _syncedDealSignatures.add(sig);
        try {
            usedDealIndices.add(matchedIdx);
            const parsed = matchedDeal;
            const inferred = inferAmountFromDeal(parsed, expectedAmount);
            const amount = (inferred != null && inferred > 0) ? inferred : (expectedAmount ?? defaultAmount);
            const exitTs = Math.floor(Date.now() / 1000);
            const notes = (order.status_reason || '').includes('dry') ? 'dry-run' : 'live-execution';
            const entryTs = inferEntryTimestamp(order);
            const minConsecutive = options.minConsecutiveWinsForTrading ?? 2;
            const result = parsed.result || 'UNKNOWN';
            const profitLoss = (result === 'LOSS' && (parsed.profitLoss == null || parsed.profitLoss === 0))
                ? -amount
                : parsed.profitLoss;
            const priceM = (order.status_reason || '').match(/entry_price=([\d.]+)/);
            const entryPrice = priceM ? parseFloat(priceM[1]) : (matchedDeal.entryPrice || null);

            // Database-backed Price Fallback (if DOM parsing failed)
            let finalEntryPrice = entryPrice;
            let finalExitPrice = parsed.exitPrice || null;

            if (!finalEntryPrice || !finalExitPrice) {
                // Try to find candles within ±30s of the timestamps
                // Support offset matching for UTC vs Local discrepancies
                const entryCandle = !finalEntryPrice ? await database.get(
                    'SELECT close FROM candles WHERE asset = ? AND (ABS(timestamp - ?) < 35 OR ABS(timestamp - (? + 21600)) < 35) ORDER BY ABS(timestamp - ?) LIMIT 1',
                    [order.asset, order.signal_timestamp, order.signal_timestamp, order.signal_timestamp]
                ) : null;
                if (entryCandle) finalEntryPrice = entryCandle.close;

                const exitCandle = !finalExitPrice ? await database.get(
                    'SELECT close FROM candles WHERE asset = ? AND (ABS(timestamp - ?) < 35 OR ABS(timestamp - (? + 21600)) < 35) ORDER BY ABS(timestamp - ?) LIMIT 1',
                    [order.asset, exitTs, exitTs, exitTs]
                ) : null;
                if (exitCandle) finalExitPrice = exitCandle.close;
            }

            await database.insertOrderedTradeClosedAndUpdateQualificationChain(order, {
                entryTs,
                entryPrice: finalEntryPrice,
                amount,
                notes,
                exitTimestamp: exitTs,
                exitPrice: finalExitPrice,
                result,
                profitLoss,
                payout: parsed.payout ?? null
            }, minConsecutive);
            const plStr = profitLoss != null ? `$${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(2)}` : '';
            console.log(`   [RESULT-SYNC] ✅ Matched order ${order.id} ${order.asset} ${order.direction} → ${parsed.result || 'UNKNOWN'} ${plStr} (written to trades_ordered)`);
            synced++;
        } catch (e) {
            console.error(`   [RESULT-SYNC] Failed to insert trades_ordered for order ${order.id}:`, e.message);
        }
    }
    if (synced > 0) {
        console.log(`   [RESULT-SYNC] Done: ${synced}/${orders.length} order(s) synced to trades_ordered`);
    }
    return { synced, ordersAwaited: orders.length };
}

function inferAmountFromDeal(parsed, expectedAmount = null) {
    let inferred = null;
    if (parsed.profitLoss == null) { /* leave null */ }
    else if (parsed.profitLoss > 0 && parsed.payout && parsed.payout > 0) {
        // WIN: Profit / Payout% = Amount (e.g. $230 / 92% = $250)
        inferred = Math.round(parsed.profitLoss * 100 / parsed.payout);
    }
    else if (parsed.profitLoss < 0) {
        // Some platforms show negative P/L for losses
        inferred = Math.abs(parsed.profitLoss);
    }
    else if (parsed.profitLoss === 0) {
        // LOSS: P/L is 0, so the loss is the full trade amount.
        // We use the expectedAmount from config as the best guess.
        inferred = expectedAmount;
    }

    if (expectedAmount != null && inferred != null) {
        const diff = Math.abs(inferred - expectedAmount);
        if (diff > 0.5) {
            console.warn(`   [AMOUNT] ⚠️ Inferred amount ${inferred} differs from config ${expectedAmount} by $${diff.toFixed(2)}`);
        }
    }
    return inferred ?? expectedAmount ?? null;
}

/**
 * Infer Unix-seconds entry timestamp (when trade was placed). Prefer last_update_at (EXECUTED time),
 * then created_at (enqueue time), fallback to signal_timestamp (signal generation - least accurate).
 */
function inferEntryTimestamp(order) {
    if (order.last_update_at) {
        const ts = Math.floor(new Date(order.last_update_at).getTime() / 1000);
        if (!isNaN(ts)) return ts;
    }
    if (order.created_at) {
        const ts = Math.floor(new Date(order.created_at).getTime() / 1000);
        if (!isNaN(ts)) return ts;
    }
    console.warn(`   [TIMESTAMP] ⚠️ entry_timestamp fallback to signal_timestamp for order ${order.id} — last_update_at and created_at are null`);
    return order.signal_timestamp;
}

/**
 * Update trades_ordered with parsed result (legacy - used if row existed before close).
 * @deprecated trades_ordered should only be written when trade closes via insertOrderedTradeClosed
 */
async function updateOrderedTradeExitFromParsed(database, tradeId, parsed) {
    const exitTimestamp = Math.floor(Date.now() / 1000);
    await database.updateOrderedTradeExit(tradeId, exitTimestamp, null, parsed.result, parsed.profitLoss);
}

module.exports = {
    executeOneOrder, executeOrderById, placeOrderLive, parseDealsListResult,
    getBalanceFromDOM,
    openClosedTabAndGetDeals,
    updateTradeExitFromParsed, syncLiveTradeResultsFromDOM,
    calibrateTradingPanel: calibrateTradingPanelIfNeeded,
    resetSessionCalibration,
    normalizeAssetForMatch
};
