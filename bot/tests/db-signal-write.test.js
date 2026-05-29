'use strict';

// ── DB signal-write integration test ─────────────────────────────────────────
// Tests the full pipeline: candles → indicators → strategy → DB writes
// Uses an in-memory SQLite database — no real trading_data.db is touched.

const assert    = require('assert');
const path      = require('path');
const Indicators   = require('../indicators');
const strategy     = require('../strategy');
const { TradingDatabase } = require('../database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Bot candle format: [timestamp, open, close, high, low]
function candle(ts, open, close, high, low) {
    return [ts, open, close,
        high ?? (Math.max(open, close) + 0.0005),
        low  ?? (Math.min(open, close) - 0.0005)];
}

function stableCandles(n, base, startTs = 1_700_000_000) {
    return Array.from({ length: n }, (_, i) => {
        const o = base + Math.sin(i * 0.3) * 0.0001;
        const c = base + Math.sin(i * 0.5) * 0.0002;
        return candle(startTs + i * 300, o, c,
            Math.max(o, c) + 0.0005, Math.min(o, c) - 0.0005);
    });
}

// Simulates the exact pipeline block in pocket-option-bot.js (candle finalize path):
//   calculateAll → insertIndicators → strategy.evaluate → insertSignal → enqueueOrder
async function runPipeline(db, indInst, asset, candles) {
    const MIN = Indicators.getMinCandles();
    if (candles.length < MIN) return null;

    const ind = indInst.calculateAll(asset, candles);
    if (!ind) return null;

    const lastTs = candles[candles.length - 1][0];

    // 1. Write indicators
    await db.insertIndicators(asset, lastTs, ind);

    // 2. Evaluate strategy
    const signal = strategy.evaluate(ind);
    if (!signal) return null;

    // 3. Write signal
    const sigResult = await db.insertSignal(asset, lastTs, signal);
    const sigId = sigResult?.id;

    // 4. Enqueue order (mirrors bot: skip if in-flight — none in this test)
    const inFlight = await db.hasAssetInFlightLiveOrder(asset);
    let orderId = null;
    if (!inFlight && sigId) {
        orderId = await db.enqueueOrder(sigId, asset, signal.direction, lastTs);
    }

    return { ind, signal, sigId, orderId, lastTs };
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log(`  ✅  ${name}`); passed++; })
        .catch(e => { console.log(`  ❌  ${name}\n      ${e.message}`); failed++; });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n── db signal-write integration tests ──────────────────────────────');

    // Open an in-memory DB for each test to ensure isolation
    async function freshDb() {
        const db = new TradingDatabase(':memory:');
        await db.initialize();
        return db;
    }

    const MIN = Indicators.getMinCandles();
    const ASSET = 'EURUSD_sig_test';
    const BASE_TS = 1_700_000_000;

    // ── 1. Candle writes ───────────────────────────────────────────────────────
    await test('insertCandle — row stored with correct OHLC', async () => {
        const db = await freshDb();
        const ts = BASE_TS;
        await db.insertCandle(ASSET, ts, 1.08500, 1.08600, 1.08400, 1.08550, 0);
        const row = await db.get('SELECT * FROM candles WHERE asset = ? AND timestamp = ?', [ASSET, ts]);
        assert.ok(row, 'candle row must exist');
        assert.strictEqual(row.asset, ASSET);
        assert.ok(Math.abs(row.open  - 1.08500) < 1e-9, `open=${row.open}`);
        assert.ok(Math.abs(row.high  - 1.08600) < 1e-9, `high=${row.high}`);
        assert.ok(Math.abs(row.low   - 1.08400) < 1e-9, `low=${row.low}`);
        assert.ok(Math.abs(row.close - 1.08550) < 1e-9, `close=${row.close}`);
        await db.close();
    });

    // ── 2. Duplicate candle silently ignored ───────────────────────────────────
    await test('insertCandle — duplicate timestamp silently ignored', async () => {
        const db = await freshDb();
        const ts = BASE_TS;
        await db.insertCandle(ASSET, ts, 1.085, 1.086, 1.084, 1.0855, 0);
        await db.insertCandle(ASSET, ts, 1.085, 1.087, 1.084, 1.0860, 0); // duplicate
        const rows = await db.all('SELECT * FROM candles WHERE asset = ? AND timestamp = ?', [ASSET, ts]);
        assert.strictEqual(rows.length, 1, 'must have exactly one candle row');
        await db.close();
    });

    // ── 3. Indicators write — all required fields present ─────────────────────
    await test('insertIndicators — key fields stored in DB', async () => {
        const db = await freshDb();
        const inst = new Indicators();
        const candles = stableCandles(MIN + 10, 1.08500);
        const lastTs  = candles[candles.length - 1][0];
        await db.insertCandle(ASSET, lastTs, 1.085, 1.086, 1.084, 1.0855, 0);

        const ind = inst.calculateAll(ASSET, candles);
        await db.insertIndicators(ASSET, lastTs, ind);

        const row = await db.get('SELECT * FROM indicators WHERE asset = ? AND timestamp = ?', [ASSET, lastTs]);
        assert.ok(row, 'indicators row must exist');
        assert.ok(row.rsi_14    != null, 'rsi_14 missing');
        assert.ok(row.atr_14    != null, 'atr_14 missing');
        assert.ok(row.macd_hist != null, 'macd_hist missing');
        assert.ok(row.bb_width_bps != null, 'bb_width_bps missing');
        assert.ok(row.stc_value != null, 'stc_value missing');
        await db.close();
    });

    // ── 4. Below min-candle threshold — pipeline exits early, no DB writes ─────
    await test('below min-candle threshold — no signal, no DB rows', async () => {
        const db   = await freshDb();
        const inst = new Indicators();
        const asset = ASSET + '_short';

        // Feed fewer candles than getMinCandles() requires
        const candles = stableCandles(MIN - 10, 1.08500);
        const result = await runPipeline(db, inst, asset, candles);
        assert.strictEqual(result, null, 'runPipeline must return null below min-candle threshold');

        const rows = await db.all('SELECT * FROM signals WHERE asset = ?', [asset]);
        assert.strictEqual(rows.length, 0, `expected 0 signal rows, got ${rows.length}`);
        await db.close();
    });

    // ── 5. Signal written on extreme crash bar ─────────────────────────────────
    await test('signal written to DB on extreme crash bar', async () => {
        const db   = await freshDb();
        const inst = new Indicators();
        const asset = ASSET + '_crash';

        const stable   = stableCandles(100, 1.08500);
        // Insert candles into DB so insertSignal's candle_id FK subquery can resolve
        for (const c of stable) {
            try { await db.insertCandle(asset, c[0], c[1], c[3], c[4], c[2], 0); } catch (_) {}
        }

        // Warm up strategy rolling state
        for (let i = MIN; i < stable.length - 1; i++) {
            const ind = inst.calculateAll(asset, stable.slice(0, i + 1));
            if (ind) strategy.evaluate(ind);
        }

        // Add crash bar: -500 pips → guarantees T1_ZSCORE_EXTREME_LOW
        const crashTs = BASE_TS + 100 * 300;
        const crashBar = candle(crashTs, 1.08500, 1.03500, 1.08500, 1.03495);
        await db.insertCandle(asset, crashTs, crashBar[1], crashBar[3], crashBar[4], crashBar[2], 0);

        const allCandles = [...stable, crashBar];
        const result = await runPipeline(db, inst, asset, allCandles);

        assert.ok(result !== null, 'runPipeline must return a result on crash bar');
        assert.ok(result.sigId != null && result.sigId > 0, `sigId=${result.sigId}`);
        assert.strictEqual(result.signal.direction, 'CALL');
        assert.strictEqual(result.signal.strategyUsed, 'T1_ZSCORE_EXTREME_LOW');

        // Verify DB row
        const row = await db.get('SELECT * FROM signals WHERE asset = ? AND timestamp = ?', [asset, crashTs]);
        assert.ok(row, 'signal row must exist in DB');
        assert.strictEqual(row.direction, 'CALL');
        assert.strictEqual(row.strategy_used, 'T1_ZSCORE_EXTREME_LOW');
        assert.ok(row.reasons, 'reasons must be present');
        const reasons = JSON.parse(row.reasons);
        assert.ok(Array.isArray(reasons) && reasons.length > 0, 'reasons must be non-empty array');
        assert.ok(reasons[0].includes('T1-CALL'), `reason string must contain T1-CALL, got: ${reasons[0]}`);

        await db.close();
    });

    // ── 6. Order enqueued in orders_queue after signal ─────────────────────────
    await test('order enqueued in orders_queue after signal', async () => {
        const db   = await freshDb();
        const inst = new Indicators();
        const asset = ASSET + '_queue';

        const stable = stableCandles(100, 1.08500);
        for (const c of stable) {
            try { await db.insertCandle(asset, c[0], c[1], c[3], c[4], c[2], 0); } catch (_) {}
        }
        for (let i = MIN; i < stable.length - 1; i++) {
            const ind = inst.calculateAll(asset, stable.slice(0, i + 1));
            if (ind) strategy.evaluate(ind);
        }

        const crashTs  = BASE_TS + 100 * 300;
        const crashBar = candle(crashTs, 1.08500, 1.03500, 1.08500, 1.03495);
        await db.insertCandle(asset, crashTs, crashBar[1], crashBar[3], crashBar[4], crashBar[2], 0);

        const result = await runPipeline(db, inst, asset, [...stable, crashBar]);
        assert.ok(result !== null, 'signal must fire');
        assert.ok(result.orderId != null && result.orderId > 0, `orderId=${result.orderId}`);

        // Verify orders_queue row
        const row = await db.get('SELECT * FROM orders_queue WHERE id = ?', [result.orderId]);
        assert.ok(row, 'orders_queue row must exist');
        assert.strictEqual(row.asset, asset);
        assert.strictEqual(row.direction, 'CALL');
        assert.strictEqual(row.status, 'PENDING');
        assert.strictEqual(row.signal_id, result.sigId);
        assert.strictEqual(row.signal_timestamp, crashTs);

        await db.close();
    });

    // ── 7. Duplicate signal silently ignored (INSERT OR IGNORE) ───────────────
    await test('duplicate signal on same timestamp silently ignored', async () => {
        const db = await freshDb();
        const ts = BASE_TS + 500;
        const fakeSignal = { direction: 'CALL', strategyUsed: 'T1_ZSCORE_EXTREME_LOW', reasons: ['test'] };

        const r1 = await db.insertSignal(ASSET, ts, fakeSignal);
        const r2 = await db.insertSignal(ASSET, ts, fakeSignal);

        assert.ok(r1.id > 0, 'first insert must return id');
        assert.ok(r2.id > 0, 'second insert must return same id');
        assert.strictEqual(r1.id, r2.id, 'both must return the same row id');

        const rows = await db.all('SELECT * FROM signals WHERE asset = ? AND timestamp = ?', [ASSET, ts]);
        assert.strictEqual(rows.length, 1, `expected 1 row, got ${rows.length}`);
        await db.close();
    });

    // ── 8. hasAssetInFlightLiveOrder — false before any orders ────────────────
    await test('hasAssetInFlightLiveOrder — false when no orders exist', async () => {
        const db = await freshDb();
        const inFlight = await db.hasAssetInFlightLiveOrder(ASSET);
        assert.strictEqual(inFlight, false);
        await db.close();
    });

    // ── 9. Reasons column stores valid JSON array ──────────────────────────────
    await test('signal reasons stored as valid JSON array in DB', async () => {
        const db = await freshDb();
        const ts = BASE_TS + 600;
        const reasons = ['[T1-CALL] z_close_ema20=-3.42σ dist_ema20_atr=-3.10 session=European'];
        await db.insertSignal(ASSET, ts, { direction: 'CALL', strategyUsed: 'T1_ZSCORE_EXTREME_LOW', reasons });

        const row = await db.get('SELECT reasons FROM signals WHERE asset = ? AND timestamp = ?', [ASSET, ts]);
        assert.ok(row, 'row must exist');
        const parsed = JSON.parse(row.reasons);
        assert.ok(Array.isArray(parsed), 'reasons must parse to array');
        assert.strictEqual(parsed[0], reasons[0]);
        await db.close();
    });

    // ── 10. Full DB round-trip: candle → indicators → signal → order ───────────
    await test('full round-trip: all 4 tables written for one signal bar', async () => {
        const db   = await freshDb();
        const inst = new Indicators();
        const asset = ASSET + '_roundtrip';

        const stable = stableCandles(100, 1.08500);
        for (const c of stable) {
            await db.insertCandle(asset, c[0], c[1], c[3], c[4], c[2], 0);
        }
        for (let i = MIN; i < stable.length - 1; i++) {
            const ind = inst.calculateAll(asset, stable.slice(0, i + 1));
            if (ind) strategy.evaluate(ind);
        }

        const crashTs  = BASE_TS + 100 * 300;
        const crashBar = candle(crashTs, 1.08500, 1.03500, 1.08500, 1.03495);
        await db.insertCandle(asset, crashTs, crashBar[1], crashBar[3], crashBar[4], crashBar[2], 0);

        const result = await runPipeline(db, inst, asset, [...stable, crashBar]);
        assert.ok(result !== null, 'signal must fire');

        // candles
        const cRow = await db.get('SELECT id FROM candles WHERE asset = ? AND timestamp = ?', [asset, crashTs]);
        assert.ok(cRow, 'candles row missing');

        // indicators
        const iRow = await db.get('SELECT id FROM indicators WHERE asset = ? AND timestamp = ?', [asset, crashTs]);
        assert.ok(iRow, 'indicators row missing');

        // signals
        const sRow = await db.get('SELECT id FROM signals WHERE asset = ? AND timestamp = ?', [asset, crashTs]);
        assert.ok(sRow, 'signals row missing');

        // orders_queue
        const oRow = await db.get('SELECT * FROM orders_queue WHERE signal_id = ?', [sRow.id]);
        assert.ok(oRow, 'orders_queue row missing');
        assert.strictEqual(oRow.status, 'PENDING');

        await db.close();
    });

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log(`\n  ${passed} passed  ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
