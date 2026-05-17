# Bot Pipeline Code Review — 2026-05-09

Reviewed by: Claude Code (Sonnet 4.6) via code-reviewer agent
Scope: full bot pipeline — `bot/`, `src/core/`, `src/tools/`, `src/scripts/`

---

## CRITICAL

### 1. `streaks` / `qualified` always `undefined` — destructuring 6 from Promise.all of 4

**File:** `src/core/intelligence.js:50`

```js
const [prices, signals, indicators, recentTrades, streaks, qualified] = await Promise.all([...]);
```

The `Promise.all` array contains only 4 entries. `streaks` and `qualified` are silently `undefined` throughout all downstream logic. Either the 5th/6th queries were dropped without cleaning up the destructuring, or the functionality is silently missing. Any code that uses `streaks` or `qualified` returns `undefined` without error.

**Fix:** Remove the dead destructuring slots, or add the missing queries.

---

### 2. `mcp_orders` queried from the bot DB (readonly) in `drawdownCheck()`

**File:** `src/core/agent-tools.js:204`

```js
const pendingOrders = await all(
  "SELECT id, asset, direction FROM mcp_orders WHERE status = 'PENDING'"
).catch(() => []);
```

`all()` routes to the bot-db (readonly connection). `mcp_orders` lives in `mcp.db`, not `trading_data.db`. The query always fails silently — `.catch(() => [])` swallows the error. The `pending_orders` field returned by `drawdownCheck()` is permanently `0`.

**Fix:** Replace `all(...)` with `mcpAll(...)`.

---

### 3. `this.macdHistory` never initialized — throws on any MACD call

**File:** `bot/indicators.js:117`

```js
if (!this.macdHistory[asset]) {   // TypeError: Cannot read properties of undefined
```

The `Indicators` constructor initializes `_v2ConsecCount`, `_v2LastTs`, `_lastSchaffValues`, `_stochHistory`, `_cciHistory` — but not `macdHistory`. Any call to `calculateMACD()` throws `TypeError: Cannot read properties of undefined (reading 'default')`. MACD is not used in live 8GSR gates, but the dead code still throws if called from replay or analysis tools.

**Fix:** Add `this.macdHistory = {};` to the constructor.

---

## HIGH

### 4. Duplicate inner function declarations — second silently overwrites first

**File:** `src/core/intelligence.js:566` (first) and `691` (second)

`patternVerdict()` and `buildLookbackNarrative()` are declared twice as named function declarations inside `evaluateModeD()`. JavaScript hoisting means the second definition silently overwrites the first at parse time. The first version's `FIRES` verdict (which includes the STC value label) is permanently lost. All calls use the second (inferior) version.

**Fix:** Deduplicate — keep one version (the first) and remove the second, or convert to `const` arrow functions to avoid hoisting.

---

### 5. `PUT_TREND` pattern pushed to `patterns[]` despite being "removed"

**File:** `src/core/intelligence.js:652–688`

A comment at line 535 states trend patterns are removed, but a full live PUT_TREND gate evaluation block runs and calls `patterns.push(...)` at line 669. This means:

- `ranked_verdicts` can contain two `PUT_TREND` entries (placeholder at index 3 + pushed entry)
- `best_put` may be incorrectly overridden by a weak TREND entry if it passes more gates than `STC_PUT_REVERSAL`

**Fix:** Remove the PUT_TREND gate evaluation block entirely, or reinstate the pattern consistently (remove the comment and placeholder).

---

### 6. MCP order claim sets terminal `SKIPPED` status before execution

**File:** `bot/pocket-option-bot.js:101`

```js
`UPDATE mcp_orders SET status = 'SKIPPED', status_reason = 'claimed-for-execution' ...`
```

`SKIPPED` is a terminal status (`CHECK(status IN ('PENDING','EXECUTED','SKIPPED','FAILED','CANCELLED'))`). If the bot crashes after claiming but before writing `EXECUTED`/`FAILED`, the order is permanently stuck as `SKIPPED` with reason `claimed-for-execution` and can never be retried.

**Fix:** Introduce a `CLAIMED` or `IN_PROGRESS` transitional status (add to the CHECK constraint), or use a `claimed_at` timestamp + a recovery sweep that resets stale claimed orders back to `PENDING` after a timeout.

---

### 7. Unbounded prices table load into memory in `replayCandles()` / `simulateGates()`

**File:** `src/core/analysis.js:186` and `869`

```js
const priceRows = await all(
  `SELECT asset, timestamp, price FROM prices ${priceWhereClause} ORDER BY asset, timestamp`,
  asset ? [asset] : []
);
```

When called for all assets (`asset = null`), every price tick in the database is loaded into JS memory. For a mature bot with weeks of data (prices table is a tick log), this can be millions of rows — causing OOM errors or multi-second freezes.

**Fix:** Add a mandatory time-window parameter (e.g. `AND timestamp >= ?`) and a row LIMIT. Fail fast with a clear error if no time window is provided.

---

## MEDIUM

### 8. `closePrice` fallback uses mismatched field names → silently returns `null`

**File:** `src/core/intelligence.js:227`

```js
const closePrice = ind.close ?? (ind.lastCandle_close ? JSON.parse(ind.lastCandle || '{}').close : null);
```

Guards on `ind.lastCandle_close` (unused value) but parses `ind.lastCandle` (the JSON string). Looks like copy-paste drift. If `ind.lastCandle` is missing or malformed, silently returns `null` → exits with score `0` on line 229.

**Fix:** Clarify intent — either parse `ind.lastCandle` (drop the `_close` guard) or read `ind.lastCandle_close` directly.

---

### 9. `g6_bbExpanding !== false` passes gate when data is `null`

**File:** `src/core/intelligence.js:488`

```js
g6_bbExpanding: bb_expanding !== false,
```

`bb_expanding` is tri-state: `true` / `false` / `null` (not enough bar history). `null !== false` evaluates to `true`, so missing BB expansion data counts as passing the gate. This inflates CALL gate scores to STRONG or PERFECT incorrectly when bar history is absent.

**Fix:** `g6_bbExpanding: bb_expanding === true`

---

### 10. `autoBlockVolatilitySweep()` missing 100-bar window — full history scan

**File:** `src/core/agent-tools.js:421`

The sweep function runs `AVG((bb_upper - bb_lower) / bb_middle * 10000) GROUP BY asset` with no time constraint. `getAssetVolatility()` correctly limits to the last 100 bars, but the sweep does not. Old bars from different volatility regimes contaminate the average used for auto-block decisions.

**Fix:** Add `WHERE timestamp >= (SELECT MAX(timestamp) - 100*60 FROM indicators WHERE asset = i.asset)` or a LIMIT-based subquery matching `getAssetVolatility()`.

---

### 11. BB width division-by-zero not fully guarded in `runUnblockSweep()`

**File:** `src/scripts/session-monitor.js:170`

```js
const bbBps = (ind.bb_upper - ind.bb_lower) / ind.bb_middle * 10000;
```

SQL filters `WHERE bb_middle > 0` but floating-point rounding on near-zero price assets can still return very small values. If `bb_middle` rounds to `0.0`, `bbBps` becomes `Infinity` or `NaN`. The `bbBps < 10` check passes `NaN` (evaluates `false`), so the asset is incorrectly unblocked.

**Fix:** Add a JS guard: `if (!isFinite(bbBps)) { /* skip or keep blocked */ continue; }`

---

### 12. `riskCheck()` checks `g7_bbWide` / `g8_bbWide` — gate names do not exist

**File:** `src/core/intelligence.js:948`

```js
if (best.gates.g7_bbWide === false || best.gates.g8_bbWide === false) {
```

The CALL and PUT reversal patterns use `g5_bbWide`, not `g7_bbWide`/`g8_bbWide`. This condition is always `false`. The BB-width penalty warning in `riskCheck()` never fires, even on dead-flat markets.

**Fix:** Change to `best.gates.g5_bbWide === false`.

---

### 13. "Today" boundary is UTC midnight, not Chicago trading session start

**Files:** `src/core/agent-tools.js:173`, `src/core/intelligence.js:1099`, `src/scripts/session-monitor.js:27`

All daily boundary calculations use `nowSec - (nowSec % 86400)` (UTC midnight). The bot displays times in `America/Chicago`. UTC midnight is 6pm–7pm Chicago time depending on DST — mid-session. The consecutive-loss counter and daily P/L limit reset mid-session rather than at the natural day boundary.

**Fix:** Compute today's start in Chicago time: `new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })` and convert back to epoch, or use a library like `luxon`.

---

## LOW

### 14. Missing `await` on async core calls in tool handlers

**File:** `src/tools/intelligence.js:12` — also `po_recommend`, `po_risk_check`, `po_market_state`, `po_asset_bias`

```js
return jsonResult(core.scanAllAssets());   // missing await
```

`jsonResult` awaits its argument internally, so this works — but async rejections from DB queries inside `scanAllAssets()` bypass the `catch` block at the call site and become unhandled promise rejections instead of clean `{ success: false, error }` responses.

**Fix:** Add `await` to match every other tool handler in the file.

---

### 15. `calculateMACD()` is O(n²)

**File:** `bot/indicators.js:123`

`calculateEMA()` is called on a growing slice inside a loop — O(n²) overall. Not in the live gate path, but wasteful for large candle arrays.

---

### 16. Startup DB error in `session-monitor.js` swallowed — monitor continues with broken state

**File:** `src/scripts/session-monitor.js:37`

If `clearSessionBlocks()` throws (e.g. `mcp.db` not yet created), the error is logged but the monitor keeps running the loss check and unblock sweep against a potentially broken DB. Prior-session blocks may persist silently.

**Fix:** Re-throw or `process.exit(1)` on startup DB failure.

---

## Summary

| # | Severity | File | Line | Issue |
|---|---|---|---|---|
| 1 | CRITICAL | `src/core/intelligence.js` | 50 | `streaks`/`qualified` always `undefined` |
| 2 | CRITICAL | `src/core/agent-tools.js` | 204 | `mcp_orders` queried via wrong DB connection |
| 3 | CRITICAL | `bot/indicators.js` | 117 | `this.macdHistory` uninitialized — throws on call |
| 4 | HIGH | `src/core/intelligence.js` | 566/691 | Duplicate function declarations — first overwritten |
| 5 | HIGH | `src/core/intelligence.js` | 652–688 | Removed PUT_TREND still pushed to patterns array |
| 6 | HIGH | `bot/pocket-option-bot.js` | 101 | Order claim uses terminal SKIPPED — crash = lost order |
| 7 | HIGH | `src/core/analysis.js` | 186, 869 | Unbounded prices table load into memory |
| 8 | MEDIUM | `src/core/intelligence.js` | 227 | `closePrice` fallback field name mismatch |
| 9 | MEDIUM | `src/core/intelligence.js` | 488 | `g6_bbExpanding !== false` passes on `null` data |
| 10 | MEDIUM | `src/core/agent-tools.js` | 421 | `autoBlockVolatilitySweep` scans full history |
| 11 | MEDIUM | `src/scripts/session-monitor.js` | 170 | BB width division-by-zero not fully guarded |
| 12 | MEDIUM | `src/core/intelligence.js` | 948 | `g7_bbWide`/`g8_bbWide` don't exist — check never fires |
| 13 | MEDIUM | multiple | — | Daily boundary is UTC midnight, not Chicago session |
| 14 | LOW | `src/tools/intelligence.js` | 12 | Missing `await` — async errors bypass catch |
| 15 | LOW | `bot/indicators.js` | 123 | `calculateMACD()` O(n²) inner loop |
| 16 | LOW | `src/scripts/session-monitor.js` | 37 | Startup DB error swallowed, monitor continues |

**Recommended fix order:** 2 → 9 → 12 → 1 → 6 → 3 → 4/5 → 7 → 8 → 10 → 11 → 13

- Items 2, 9, 12 directly corrupt live signal quality (wrong DB, inflated gate scores, silent BB check)
- Items 1, 6 are silent data loss bugs
- Items 3–5 are dead-but-dangerous code
- Items 7–13 are reliability/correctness improvements
