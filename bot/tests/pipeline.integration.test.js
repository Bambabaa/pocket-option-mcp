'use strict';

// ── Pipeline integration test ─────────────────────────────────────────────────
// Exercises the full: candle array → indicators.calculateAll() → strategy.evaluate()
// No external DB, no WebSocket — pure synthetic candle data.

const assert    = require('assert');
const Indicators = require('../indicators');
const strategy  = require('../strategy');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Bot candle format: [timestamp, open, close, high, low]
function candle(ts, open, close, high, low) {
    return [
        ts,
        open,
        close,
        high ?? (Math.max(open, close) + 0.0005),
        low  ?? (Math.min(open, close) - 0.0005),
    ];
}

// N stable candles oscillating ±noise around base price
function stableCandles(n, base, startTs = 1_700_000_000) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const o = base + Math.sin(i * 0.3) * 0.0001;
        const c = base + Math.sin(i * 0.5) * 0.0002;
        out.push(candle(
            startTs + i * 300,
            o, c,
            Math.max(o, c) + 0.0005,
            Math.min(o, c) - 0.0005,
        ));
    }
    return out;
}

// Warm up strategy rolling state by piping each incremental window through evaluate
function warmUpStrategy(indInst, assetId, candles, minCandles) {
    for (let i = minCandles; i < candles.length; i++) {
        const ind = indInst.calculateAll(assetId, candles.slice(0, i + 1));
        if (ind) strategy.evaluate(ind);
    }
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌  ${name}\n      ${e.message}`);
        failed++;
    }
}

const MIN_CANDLES = Indicators.getMinCandles();
const BASE_ASSET  = 'EURUSD_test';

console.log('\n── pipeline integration tests ──────────────────────────────────────');
console.log(`   minCandles = ${MIN_CANDLES}\n`);

// ── 1. indicators.getMinCandles() is a positive integer ───────────────────────
test('Indicators.getMinCandles() returns a positive integer', () => {
    assert.ok(Number.isInteger(MIN_CANDLES) && MIN_CANDLES > 0,
        `expected positive integer, got ${MIN_CANDLES}`);
});

// ── 2. calculateAll → null on empty/null input (the actual hard guard) ────────
test('calculateAll — returns null for empty candle array', () => {
    const inst = new Indicators();
    assert.strictEqual(inst.calculateAll(BASE_ASSET, []),   null, 'empty array must return null');
    assert.strictEqual(inst.calculateAll(BASE_ASSET, null), null, 'null must return null');
});

// ── 2b. getMinCandles() is the bot's call guard — below it, stc_delta is null ─
test('calculateAll — stc_delta null before enough history (confirms getMinCandles is needed)', () => {
    const inst = new Indicators();
    // With only 10 bars, STC history is uninitialized → stc_delta must be null
    const ind = inst.calculateAll(BASE_ASSET, stableCandles(10, 1.08500));
    assert.ok(ind !== null, 'calculateAll still returns object (bot guards the call)');
    assert.strictEqual(ind.stc_delta, null, 'stc_delta must be null without prior history');
});

// ── 3. calculateAll → full ind object with enough candles ─────────────────────
test('calculateAll — returns complete ind object with minCandles + 10', () => {
    const inst = new Indicators();
    const ind  = inst.calculateAll(BASE_ASSET, stableCandles(MIN_CANDLES + 10, 1.08500));
    assert.ok(ind !== null, 'ind must not be null');

    const required = [
        'currentPrice', 'lastCandle', 'asset',
        'atr_14', 'atr_pct', 'bb_width_bps',
        'bb_upper', 'bb_lower', 'kc_upper', 'kc_lower',
        'rsi_14', 'macd_macd', 'macd_hist',
        'stc_value', 'psar_bull',
    ];
    for (const f of required) {
        assert.ok(ind[f] != null, `missing field: ${f}`);
    }
    assert.strictEqual(ind.asset, BASE_ASSET, 'asset label must be preserved');
});

// ── 4. evaluate() — returns null on null/bad input ────────────────────────────
test('evaluate — returns null on null input', () => {
    assert.strictEqual(strategy.evaluate(null), null);
});

test('evaluate — returns null when currentPrice missing', () => {
    assert.strictEqual(strategy.evaluate({ asset: BASE_ASSET, rsi_14: 50 }), null);
});

// ── 5. evaluate() — output shape is correct when a signal fires ───────────────
test('evaluate — output has correct shape when signal fires', () => {
    const inst    = new Indicators();
    const assetId = BASE_ASSET + '_shape';
    const stable  = stableCandles(100, 1.08500);
    warmUpStrategy(inst, assetId, stable, MIN_CANDLES);

    // Crash bar: -500 pips — guaranteed to trigger T1_ZSCORE_EXTREME_LOW
    const ts       = 1_700_000_000 + 100 * 300;
    const crashBar = candle(ts, 1.08500, 1.03500, 1.08500, 1.03495);
    const ind      = inst.calculateAll(assetId, [...stable, crashBar]);
    assert.ok(ind !== null, 'calculateAll must return non-null after 101 candles');

    const result = strategy.evaluate(ind);
    assert.ok(result !== null, 'a signal must fire on a -500 pip crash');
    assert.ok(['CALL', 'PUT'].includes(result.direction),
        `direction must be CALL or PUT, got: ${result.direction}`);
    assert.ok([1, 2, 3].includes(result.tier),
        `tier must be 1, 2, or 3; got: ${result.tier}`);
    assert.ok(typeof result.strategyUsed === 'string' && result.strategyUsed.length > 0,
        'strategyUsed must be a non-empty string');
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0,
        'reasons must be a non-empty array');
});

// ── 6. T1_ZSCORE_EXTREME_LOW fires on extreme crash bar ───────────────────────
test('T1_ZSCORE_EXTREME_LOW — fires CALL at tier 1 on extreme z-score crash', () => {
    const inst    = new Indicators();
    const assetId = BASE_ASSET + '_t1zscore';
    const stable  = stableCandles(100, 1.08500);
    warmUpStrategy(inst, assetId, stable, MIN_CANDLES);

    const ts       = 1_700_000_000 + 100 * 300;
    const crashBar = candle(ts, 1.08500, 1.03500, 1.08500, 1.03495);
    const ind      = inst.calculateAll(assetId, [...stable, crashBar]);
    assert.ok(ind !== null, 'calculateAll returned null');

    const result = strategy.evaluate(ind);
    assert.ok(result !== null, 'no signal fired — check feature warmup');
    assert.strictEqual(result.strategyUsed, 'T1_ZSCORE_EXTREME_LOW',
        `expected T1_ZSCORE_EXTREME_LOW, got ${result?.strategyUsed}`);
    assert.strictEqual(result.direction, 'CALL');
    assert.strictEqual(result.tier, 1);
});

// ── 7. Stable market → no signal ─────────────────────────────────────────────
test('evaluate — returns null on stable flat market', () => {
    const inst    = new Indicators();
    const assetId = BASE_ASSET + '_flat';
    const candles = stableCandles(100, 1.08500);
    warmUpStrategy(inst, assetId, candles, MIN_CANDLES);

    const ind = inst.calculateAll(assetId, candles);
    assert.ok(ind !== null, 'calculateAll returned null');
    const result = strategy.evaluate(ind);
    assert.strictEqual(result, null,
        `expected null on stable bar, got strategy=${result?.strategyUsed}`);
});

// ── 8. Asset state isolation ──────────────────────────────────────────────────
test('evaluate — two assets maintain independent rolling state', () => {
    const instA = new Indicators();
    const instB = new Indicators();
    const idA   = 'EURUSD_isolate';
    const idB   = 'GBPUSD_isolate';

    const cA = stableCandles(MIN_CANDLES + 5, 1.08500);
    const cB = stableCandles(MIN_CANDLES + 5, 1.26000);

    const indA = instA.calculateAll(idA, cA);
    const indB = instB.calculateAll(idB, cB);

    assert.ok(indA !== null && indB !== null, 'both calculateAll calls must succeed');
    assert.strictEqual(indA.asset, idA, 'asset A label preserved');
    assert.strictEqual(indB.asset, idB, 'asset B label preserved');
    assert.ok(Math.abs(indA.currentPrice - 1.08500) < 0.002, 'asset A price in range');
    assert.ok(Math.abs(indB.currentPrice - 1.26000) < 0.002, 'asset B price in range');

    // evaluate both — must not throw
    strategy.evaluate(indA);
    strategy.evaluate(indB);
});

// ── 9. ind fields required by T3_STC_COMPRESSION_BREAKDOWN exist ─────────────
test('T3_STC_COMPRESSION_BREAKDOWN — all required ind fields present in calculateAll output', () => {
    const inst = new Indicators();
    const ind  = inst.calculateAll(BASE_ASSET + '_stc', stableCandles(MIN_CANDLES + 10, 1.08500));
    assert.ok(ind !== null);
    // stc_high gate
    assert.ok('stc_value' in ind, 'stc_value missing');
    // psar_bearish gate
    assert.ok('psar_bull' in ind, 'psar_bull missing');
    // atr_low gate
    assert.ok('atr_pct' in ind, 'atr_pct missing');
    // bb_inside_kc gate
    assert.ok('bb_upper' in ind, 'bb_upper missing');
    assert.ok('kc_upper' in ind, 'kc_upper missing');
});

// ── 10. ML_EDGE_01 — ind fields exist ────────────────────────────────────────
test('ML_EDGE_01 — ind.macd_macd, ind.macd_hist, ind.rsi_14 present in calculateAll output', () => {
    const inst = new Indicators();
    const ind  = inst.calculateAll(BASE_ASSET + '_ml1', stableCandles(MIN_CANDLES + 10, 1.08500));
    assert.ok(ind !== null);
    assert.ok(ind.macd_macd != null, 'macd_macd missing');
    assert.ok(ind.macd_hist != null, 'macd_hist missing');
    assert.ok(ind.rsi_14    != null, 'rsi_14 missing');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed  ${failed} failed\n`);
if (failed > 0) process.exit(1);
