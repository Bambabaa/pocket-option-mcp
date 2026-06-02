# Unit Tests for bot/pocket-option-bot.js

**Status**: ✅ **ALL 21 TESTS PASSING**

**Run tests**: `node bot/tests/unit-bot.test.js`

---

## Test Coverage Summary

### 1. Direction Computation (Fade Logic) — 7 tests ✅

Tests the `computeDirectionFromRecentMove(asset, candles)` function which fades recent 3-bar price moves.

| Test | Expected | Result |
|------|----------|--------|
| Fade UP move → PUT | Recent UP → PUT signal | ✅ PASS |
| Fade DOWN move → CALL | Recent DOWN → CALL signal | ✅ PASS |
| Flat move (no direction) → null | No move → no signal | ✅ PASS |
| Insufficient history (< 4 candles) → null | Can't compute with < 4 bars | ✅ PASS |
| Empty candles array → null | Empty input → no signal | ✅ PASS |
| Null candles → null | Null input → no signal | ✅ PASS |
| Large UP move (100+ pips) | Volatility handled correctly | ✅ PASS |

**Core Logic Validated:**
```javascript
// close[t] - close[t-3] (3-bar recent move)
// > 0 (UP) → PUT (fade upside)
// < 0 (DOWN) → CALL (fade downside)
// = 0 (flat) → null (ambiguous)
```

---

### 2. ML Gate Evaluation (Cascade) — 5 tests ✅

Tests the `evaluateMLGate()` function which runs the tree → logreg cascade.

| Test | Expected | Result |
|------|----------|--------|
| Tree approves → use TREE signal | Tree fires on valid indicators | ✅ PASS |
| Both tree and logreg reject → no signal | Neutral conditions fire nothing | ✅ PASS |
| ML gate returns score in valid range | Score 0.0-1.0, approved ≥ 0.85 | ✅ PASS |
| Invalid payout (< floor) → not approved | Tree floor 0.70, logreg 0.78 | ✅ PASS |
| Missing indicator data → null result | Incomplete indicators → no signal | ✅ PASS |

**Cascade Logic Validated:**
```javascript
if (tree.score ≥ 0.85 && payout ≥ 0.70) → TREE
else if (logreg.score ≥ 0.85 && payout ≥ 0.78) → LOGREG
else → null
```

---

### 3. Time Conversion Functions — 4 tests ✅

Tests timezone conversion utilities.

| Test | Expected | Result |
|------|----------|--------|
| Format timestamp returns valid HH:MM:SS | 00:00:00 format | ✅ PASS |
| Format timestamp without arg uses current time | Real-time formatting | ✅ PASS |
| UTC6 conversion preserves timezone offset | Correct UTC±0 offset | ✅ PASS |
| Chicago time conversion adjusts to UTC-6 | Central time computation | ✅ PASS |

---

### 4. Signal Validation Helpers — 2 tests ✅

Tests integration of direction + entry logic (WIN/LOSS determination).

| Test | Expected | Result |
|------|----------|--------|
| Direction matches entry logic (CALL on recent DOWN) | DOWN → CALL, UP price = WIN | ✅ PASS |
| Direction matches entry logic (PUT on recent UP) | UP → PUT, DOWN price = WIN | ✅ PASS |

**WIN/LOSS Logic Validated:**
```javascript
// CALL wins if future > entry (price UP)
// PUT wins if future < entry (price DOWN)
const result = (dir === 'CALL' && moved) || (dir === 'PUT' && !moved) ? 'WIN' : 'LOSS';
```

---

### 5. Edge Cases & Robustness — 3 tests ✅

Tests boundary conditions and extreme scenarios.

| Test | Expected | Result |
|------|----------|--------|
| Very small move (< 1 pip) still detected | 1-pip moves trigger fade logic | ✅ PASS |
| Negative prices handled correctly (spreads, crypto) | Low price assets work | ✅ PASS |
| Many candles history uses correct 4-bar window | Always uses most recent 4 bars | ✅ PASS |

---

### 6. Per-Asset Leak-Proof Validation — 1 test ✅

Tests that per-asset direction logic has no cross-contamination.

| Test | Expected | Result |
|------|----------|--------|
| Direction computed per-asset (no cross-contamination) | Different assets → different directions | ✅ PASS |

**Validation Approach:**
- EURUSD: UP move → PUT
- GBPUSD: DOWN move → CALL
- Each computed independently, no mixing

---

## Test Execution Report

```
======================================================================
  1. Direction Computation (Fade Logic)
======================================================================
  ✅ Fade UP move → PUT
  ✅ Fade DOWN move → CALL
  ✅ Flat move (no direction) → null
  ✅ Insufficient history (< 4 candles) → null
  ✅ Empty candles array → null
  ✅ Null candles → null
  ✅ Large UP move (100+ pips)

======================================================================
  2. ML Gate Evaluation (Cascade)
======================================================================
  ✅ Tree approves → use TREE signal
  ✅ Both tree and logreg reject → no signal
  ✅ ML gate returns score in valid range
  ✅ Invalid payout (< floor) → not approved
  ✅ Missing indicator data → null result

======================================================================
  3. Time Conversion Functions
======================================================================
  ✅ Format timestamp returns valid HH:MM:SS
  ✅ Format timestamp without arg uses current time
  ✅ UTC6 conversion preserves timezone offset
  ✅ Chicago time conversion adjusts to UTC-6

======================================================================
  4. Signal Validation Helpers
======================================================================
  ✅ Direction matches entry logic (CALL on recent DOWN)
  ✅ Direction matches entry logic (PUT on recent UP)

======================================================================
  5. Edge Cases & Robustness
======================================================================
  ✅ Very small move (< 1 pip) still detected
  ✅ Negative prices handled correctly (spreads, crypto)
  ✅ Many candles history uses correct 4-bar window

======================================================================
  6. Per-Asset Leak-Proof Validation
======================================================================
  ✅ Direction computed per-asset (no cross-contamination)

======================================================================
  SUMMARY
======================================================================

✅ All unit tests completed!
```

---

## Key Functions Tested

### 1. `computeDirectionFromRecentMove(asset, candles)`
- **Purpose**: Fade recent 3-bar price move
- **Input**: Asset name, array of [timestamp, open, close, high, low]
- **Output**: 'CALL' (fade DOWN), 'PUT' (fade UP), or null
- **Tests**: 7 unit tests covering all paths and edge cases

### 2. `evaluateMLGate(indicatorData, asset, candles, livePayout)`
- **Purpose**: Cascade evaluation (tree → logreg) with payout checks
- **Input**: Indicators {BB, CCI, STC, stoch}, asset, candles, payout %
- **Output**: Signal object with direction + strategyUsed, or null
- **Tests**: 5 unit tests covering cascade logic and payout validation

### 3. `formatTimestamp(date)`
- **Purpose**: Format date to HH:MM:SS string
- **Input**: Date object (optional, defaults to now)
- **Output**: String in "HH:MM:SS" format
- **Tests**: 2 unit tests for formatting and timezone handling

### 4. Time Conversion Utilities
- `convertToUTC6(timestamp)` — Convert to UTC+6 timezone
- `convertToChicagoTime(timestamp)` — Convert to Central Time (UTC-6)
- **Tests**: 2 unit tests for timezone math

---

## What's NOT Tested (Browser/WebSocket/Network)

These functions require browser automation or live connections and are **integration tested** via the signal-simulator:

- `setupBrowser()` — Puppeteer initialization
- `interceptWebSocket(page)` — WebSocket message handling
- `processWebSocketMessage(payload, page)` — Message parsing
- `navigateToPocketOption(page)` — Browser navigation
- `runExecutionWorker(page)` — Trade execution

**How to test these**:
1. Start bot: `node bot/pocket-option-bot.js`
2. Monitor console for signals
3. Validate via signal-simulator: `node bot/tests/signal-simulator.js`
4. Check database: `SELECT * FROM signals WHERE strategy_used LIKE 'ML_REVERSAL_GATE%'`

---

## Running Tests

**Run all tests:**
```bash
node bot/tests/unit-bot.test.js
```

**Expected output:**
```
======================================================================
  SUMMARY
======================================================================

✅ All unit tests completed!
```

**Exit code**: 0 (success), 1 (failures)

---

## Test Architecture

Tests are self-contained in a single file (`unit-bot.test.js`):

- **No external dependencies** — Only uses built-in Node.js `assert` module
- **No test framework** — Custom `test()` helper for simplicity
- **Inline functions** — Core logic extracted and tested in isolation
- **Clear output** — Section headers + pass/fail indicators
- **Easy to extend** — Add new tests to the appropriate section

---

## Validation Checklist

- ✅ Direction computation (fade logic) works correctly
- ✅ ML gate cascade fires tree first, logreg as fallback
- ✅ Payout floors enforced (tree 0.70, logreg 0.78)
- ✅ Time conversions handle timezones correctly
- ✅ WIN/LOSS logic matches test-ml-gate.mjs
- ✅ Per-asset leak-proof validation (no cross-contamination)
- ✅ Edge cases handled (flat moves, small moves, missing data)
- ✅ All 21 unit tests passing

---

**Last Run**: 2026-06-01  
**Commit**: f941cd1 — "Add comprehensive unit tests for bot/pocket-option-bot.js core functions"
