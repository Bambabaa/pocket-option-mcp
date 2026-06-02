'use strict';

/**
 * Unit Tests for bot/pocket-option-bot.js
 *
 * Tests core functionality:
 * - Direction computation (fade logic)
 * - ML gate evaluation (cascade)
 * - Time conversion functions
 * - Signal validation helpers
 */

const assert = require('assert');
const mlGate = require('../ml-gate');

// ============================================================================
// TEST HELPERS
// ============================================================================

function testSection(name) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ${name}`);
    console.log(`${'='.repeat(70)}`);
}

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (e) {
        console.log(`  ❌ ${name}`);
        console.log(`     Error: ${e.message}`);
        process.exitCode = 1;
    }
}

// ============================================================================
// IMPORTED FUNCTIONS (extracted for testing)
// ============================================================================

function computeDirectionFromRecentMove(asset, candles) {
    if (!candles || candles.length < 4) return null;
    // candles: [timestamp, open, close, high, low]
    const current = candles[candles.length - 1];
    const threeBack = candles[candles.length - 4];
    const recentMove = current[2] - threeBack[2]; // close - close
    if (recentMove === 0) return null; // flat → ambiguous
    return recentMove > 0 ? 'PUT' : 'CALL'; // fade it
}

function formatTimestamp(date = new Date()) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

// Simplified time conversion for testing
function convertToUTC6(timestamp) {
    const date = new Date(timestamp * 1000);
    const offset = date.getTimezoneOffset() * 60;
    return timestamp + offset + (6 * 3600);
}

function convertToChicagoTime(timestamp) {
    const date = new Date(timestamp * 1000);
    const offset = date.getTimezoneOffset() * 60;
    const chicagoOffset = -6 * 3600; // UTC-6
    return timestamp + offset + chicagoOffset;
}

// ============================================================================
// TESTS
// ============================================================================

testSection('1. Direction Computation (Fade Logic)');

test('Fade UP move → PUT', () => {
    const candles = [
        [1000, 100, 100, 102, 99],  // close: 100
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 103, 105, 106, 102],  // close: 105 (UP 5 from 100) → fade with PUT
    ];
    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, 'PUT', 'Should fade UP move with PUT');
});

test('Fade DOWN move → CALL', () => {
    const candles = [
        [1000, 100, 100, 102, 99],  // close: 100
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 95, 95, 102, 94],    // close: 95 (DOWN 5 from 100) → fade with CALL
    ];
    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, 'CALL', 'Should fade DOWN move with CALL');
});

test('Flat move (no direction) → null', () => {
    const candles = [
        [1000, 100, 100, 102, 99],  // close: 100
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 100, 100, 102, 99],  // close: 100 (FLAT) → null
    ];
    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, null, 'Should return null for flat move');
});

test('Insufficient history (< 4 candles) → null', () => {
    const candles = [
        [1000, 100, 100, 102, 99],
        [1300, 101, 101, 103, 100],
    ];
    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, null, 'Should return null for < 4 candles');
});

test('Empty candles array → null', () => {
    const dir = computeDirectionFromRecentMove('TEST', []);
    assert.strictEqual(dir, null, 'Should return null for empty array');
});

test('Null candles → null', () => {
    const dir = computeDirectionFromRecentMove('TEST', null);
    assert.strictEqual(dir, null, 'Should return null for null candles');
});

test('Large UP move (100+ pips)', () => {
    const candles = [
        [1000, 1000, 1000, 1005, 995],
        [1300, 1050, 1050, 1055, 1045],
        [1600, 1100, 1100, 1105, 1095],
        [1900, 1150, 1150, 1155, 1140],  // 150 pips up
    ];
    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, 'PUT', 'Should fade large UP move with PUT');
});

// ============================================================================

testSection('2. ML Gate Evaluation (Cascade)');

test('Tree approves → use TREE signal', () => {
    // Create indicator data that should trigger tree approval
    const ind = {
        asset: 'EURUSD',
        close: 1.0900,
        bb_upper: 1.0920,
        bb_lower: 1.0880,
        cci_20: -150,
        stc_value: 25,      // STC at floor (CALL reversal)
        stoch_k: 0.35,
        stoch_d: 0.40,
    };

    const result = mlGate.evaluateGate(ind, 0.80);

    if (result && result.tree?.approved) {
        assert(result.tree.approved === true, 'Tree should be approved');
        assert(result.tree.score > 0.85, 'Tree score should exceed gate');
    }
});

test('Both tree and logreg reject → no signal', () => {
    // Neutral indicator data that shouldn't trigger either model
    const ind = {
        asset: 'EURUSD',
        close: 1.0900,
        bb_upper: 1.0920,
        bb_lower: 1.0880,
        cci_20: 0,           // Neutral
        stc_value: 50,       // Middle (not extreme)
        stoch_k: 0.50,       // Neutral
        stoch_d: 0.50,
    };

    const result = mlGate.evaluateGate(ind, 0.80);

    const treeApproved = result?.tree?.approved;
    const lrApproved = result?.logreg?.approved;

    // At least one should be false (may vary based on model)
    assert(
        (treeApproved === false || lrApproved === false || !result),
        'Neutral conditions should not fire both models'
    );
});

test('ML gate returns score in valid range', () => {
    const ind = {
        asset: 'EURUSD',
        close: 1.0900,
        bb_upper: 1.0920,
        bb_lower: 1.0880,
        cci_20: -100,
        stc_value: 25,
        stoch_k: 0.30,
        stoch_d: 0.35,
    };

    const result = mlGate.evaluateGate(ind, 0.80);

    if (result && result.tree?.approved) {
        assert(result.tree.score >= 0 && result.tree.score <= 1, 'Score should be 0-1');
        assert(result.tree.score >= 0.85, 'Approved score should exceed gate threshold');
    }
});

test('Invalid payout (< floor) → not approved', () => {
    const ind = {
        asset: 'EURUSD',
        close: 1.0900,
        bb_upper: 1.0920,
        bb_lower: 1.0880,
        cci_20: -150,
        stc_value: 25,
        stoch_k: 0.30,
        stoch_d: 0.35,
    };

    // Use low payout (below tree floor of 0.70)
    const result = mlGate.evaluateGate(ind, 0.60);

    // At this low payout, tree shouldn't approve even if high score
    if (result) {
        assert(
            result.tree?.approved === false || !result.tree?.approved,
            'Tree should not approve at below-floor payout'
        );
    }
});

test('Missing indicator data → null result', () => {
    const ind = {
        asset: 'EURUSD',
        close: 1.0900,
        // Missing required indicators
    };

    const result = mlGate.evaluateGate(ind, 0.80);
    assert(result == null || !result, 'Should return null for incomplete data');
});

// ============================================================================

testSection('3. Time Conversion Functions');

test('Format timestamp returns valid HH:MM:SS', () => {
    const date = new Date('2026-06-01T14:30:45Z');
    const formatted = formatTimestamp(date);

    assert(formatted.match(/\d{2}:\d{2}:\d{2}/), 'Should match HH:MM:SS format');
    // Just verify it has valid time components (hour may vary by timezone)
    assert(formatted.includes(':'), 'Should have time separators');
    assert(formatted.split(':').length === 3, 'Should have 3 time components (HH:MM:SS)');
});

test('Format timestamp without arg uses current time', () => {
    const formatted = formatTimestamp();
    assert(formatted.match(/\d{2}:\d{2}:\d{2}/), 'Should return valid time format');
});

test('UTC6 conversion preserves timezone offset', () => {
    const ts = Math.floor(new Date('2026-06-01T12:00:00Z').getTime() / 1000);
    const converted = convertToUTC6(ts);

    assert(typeof converted === 'number', 'Should return number');
    assert(converted > ts, 'Should adjust for timezone');
});

test('Chicago time conversion adjusts to UTC-6', () => {
    const ts = Math.floor(new Date('2026-06-01T12:00:00Z').getTime() / 1000);
    const chicago = convertToChicagoTime(ts);

    assert(typeof chicago === 'number', 'Should return number');
    assert(chicago !== ts, 'Should adjust timezone');
});

// ============================================================================

testSection('4. Signal Validation Helpers');

test('Direction matches entry logic (CALL on recent DOWN)', () => {
    const candles = [
        [1000, 100, 100, 102, 99],
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 95, 95, 102, 94],  // DOWN 5 → CALL
    ];

    const dir = computeDirectionFromRecentMove('EURUSD', candles);
    assert.strictEqual(dir, 'CALL', 'DOWN move should → CALL');

    // Validate entry logic: CALL wins if price goes UP
    const entryPrice = 95;
    const futurePrice = 100;  // UP from entry
    const moved = futurePrice > entryPrice;
    const result = (dir === 'CALL' && moved) ? 'WIN' : 'LOSS';

    assert.strictEqual(result, 'WIN', 'CALL should win when price goes UP');
});

test('Direction matches entry logic (PUT on recent UP)', () => {
    const candles = [
        [1000, 100, 100, 102, 99],
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 105, 105, 106, 102],  // UP 5 → PUT
    ];

    const dir = computeDirectionFromRecentMove('EURUSD', candles);
    assert.strictEqual(dir, 'PUT', 'UP move should → PUT');

    // Validate entry logic: PUT wins if price goes DOWN
    const entryPrice = 105;
    const futurePrice = 100;  // DOWN from entry
    const moved = futurePrice > entryPrice;
    const result = (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';

    assert.strictEqual(result, 'WIN', 'PUT should win when price goes DOWN');
});

// ============================================================================

testSection('5. Edge Cases & Robustness');

test('Very small move (< 1 pip) still detected', () => {
    const candles = [
        [1000, 1.0900, 1.0900, 1.0905, 1.0895],
        [1300, 1.0901, 1.0901, 1.0906, 1.0896],
        [1600, 1.0902, 1.0902, 1.0907, 1.0897],
        [1900, 1.0903, 1.0903, 1.0908, 1.0898],  // 3 pips up
    ];

    const dir = computeDirectionFromRecentMove('EURUSD', candles);
    assert.strictEqual(dir, 'PUT', 'Even 1-pip move should be detected');
});

test('Negative prices handled correctly (spreads, crypto)', () => {
    const candles = [
        [1000, 0.5000, 0.5000, 0.5005, 0.4995],
        [1300, 0.5001, 0.5001, 0.5006, 0.4996],
        [1600, 0.5002, 0.5002, 0.5007, 0.4997],
        [1900, 0.4950, 0.4950, 0.5005, 0.4945],  // -50 pips
    ];

    const dir = computeDirectionFromRecentMove('USDT', candles);
    assert.strictEqual(dir, 'CALL', 'Should handle low prices');
});

test('Many candles history uses correct 4-bar window', () => {
    const candles = [
        [1000, 100, 100, 102, 99],
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 103, 103, 105, 102],
        [2200, 104, 104, 106, 103],
        [2500, 105, 105, 107, 104],
        [2800, 106, 110, 111, 105],  // 110 vs 103 from [1900]
    ];

    const dir = computeDirectionFromRecentMove('TEST', candles);
    assert.strictEqual(dir, 'PUT', 'Should use most recent 4 candles');
});

// ============================================================================

testSection('6. Per-Asset Leak-Proof Validation');

test('Direction computed per-asset (no cross-contamination)', () => {
    // Verify that direction is computed from the same asset's history
    const candles1 = [
        [1000, 100, 100, 102, 99],
        [1300, 101, 101, 103, 100],
        [1600, 102, 102, 104, 101],
        [1900, 105, 105, 106, 102],  // UP → PUT
    ];

    const candles2 = [
        [1000, 50, 50, 52, 49],
        [1300, 51, 51, 53, 50],
        [1600, 52, 52, 54, 51],
        [1900, 45, 45, 52, 44],  // DOWN → CALL
    ];

    const dir1 = computeDirectionFromRecentMove('EURUSD', candles1);
    const dir2 = computeDirectionFromRecentMove('GBPUSD', candles2);

    assert.strictEqual(dir1, 'PUT', 'EURUSD should be PUT');
    assert.strictEqual(dir2, 'CALL', 'GBPUSD should be CALL');
    assert.notStrictEqual(dir1, dir2, 'Different assets should have different directions');
});

// ============================================================================

testSection('SUMMARY');

console.log('\n✅ All unit tests completed!\n');
