# ETL & Decision Pipeline Review — 2026-05-09

Reviewed by: Claude Code (Sonnet 4.6) via code-reviewer agent
Scope: `bot/database.js`, `bot/indicators.js`, `bot/pocket-option-bot.js`, `src/core/intelligence.js`
Focus: indicator miscalculations, data leaks between assets, lookahead bias, DB ETL correctness

---

## CRITICAL

### C1. RSI is Cutler (SMA) — not Wilder's smoothed
**File:** `bot/indicators.js:75–96`

Every call recomputes a plain arithmetic average of the last `period` gains/losses from scratch. Wilder's RSI carries exponential decay from all prior bars (alpha = 1/period). For RSI(5) on 60s bars the values diverge materially from what Pocket Option's chart displays. Gate g3 (`RSI < 30` for CALL, `RSI > 70` for PUT) is evaluated against the wrong number on every signal.

**Fix:** Seed the first value with SMA of gains/losses, then apply Wilder's smoothing:
```js
let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
}
```
Requires persisting `avgGain`/`avgLoss` state per asset (same pattern as `_lastSchaffValues`).

---

### C2. STC method defaults `(30, 55, 8, 4, 3)` vs config `(10, 20, 5, 3, 3)`
**File:** `bot/indicators.js:308`, `622–626`

`calculateSchaffTrendCycle()` declares default parameters `(emaFast = 30, emaSlow = 55, cyclePeriod = 8, smooth1 = 4, smooth2 = 3)`. `calculateAll()` always passes the correct explicit values from `INDICATOR_CONFIG.schaff`, so live signals are correct. But any direct call — from `replay-multi-db.mjs`, test scripts, or analysis tools — silently uses `(30, 55, 8, 4)` instead of `(10, 20, 5, 3)`. Backtests and replays compute a fundamentally different STC than the live bot.

**Fix:** Change method defaults to match config:
```js
calculateSchaffTrendCycle(candles, emaFast = 10, emaSlow = 20, cyclePeriod = 5, smooth1 = 3, smooth2 = 3)
```

---

### C3. STC cycle loop includes the open (incomplete) candle — 1-bar lookahead
**File:** `bot/indicators.js:315–320`

```js
for (let i = emaSlow; i <= n; i++) {
    const slice = candles.slice(0, i);
    ...
}
```

`n = closes.length`. At `i = n`, `candles.slice(0, n)` is the full array including `candles[n-1]` — the live in-flight bar. On the 30-second intra-bar refresh path (bot line 960), the STC value incorporates a bar that is still open. Gate g1 (STC ≥ 90 / ≤ 25) and g2 (STC direction) are evaluated against a lookahead value.

**Fix:** Change loop bound from `<= n` to `< n` to exclude the current bar:
```js
for (let i = emaSlow; i < n; i++) {
```

---

## HIGH

### H1. v1 stochastic columns always `null` in DB
**File:** `bot/database.js:558–560`

`insertIndicators` maps `indicators.stochastic_k` → `stochastic_k_v2` column (correct). But the v1 columns (`stochastic_k`, `stochastic_d`) at positions 12–13 are populated from `indicators.stochasticKT` which is never assigned in `calculateAll()`. Any raw query or MCP tool reading the bare `stochastic_k` column receives `null`. `agent-tools.js:33` selects both columns — v1 is silently null.

**Fix:** Either populate v1 columns with the same v2 values, or drop the v1 columns from the schema and all SELECT statements. Preferred: drop v1 columns.

---

### H2. `getCandles()` returns DESC order — indicators need ASC
**File:** `bot/database.js:361–366`

```js
SELECT * FROM candles WHERE asset = ? ORDER BY timestamp DESC LIMIT ?
```

All indicator calculations assume oldest-first (chronological) array order. The live bot builds `STATE.CANDLES` chronologically via push, so this doesn't affect live signals. But any future caller that pipes `getCandles()` output directly into `calculateAll()` will silently compute indicators on reversed history — producing garbage values without any error.

**Fix:** Add `ORDER BY timestamp ASC` and document that the live bot uses `STATE.CANDLES` directly. Or add a `reverse()` call at the call site when the consumer needs ASC.

---

### H3. Backfill loop leaves `_lastSchaffValues[asset]` at wrong bar
**File:** `bot/indicators.js:629–630`

During the history backfill loop, each `calculateAll()` call overwrites `_lastSchaffValues[asset]` with that bar's STC. If the final `calculateAll()` after backfill fails or returns `null`, the state is left at the second-to-last bar's STC. The next real tick sees the wrong `prevSchaffValue`, incorrectly evaluating g2 (STC rising/falling direction).

**Fix:** Save the last good STC value separately after the backfill loop completes, rather than relying on incremental state updates through the loop.

---

### H4. `STATE.lastIndicatorUpdate` is global — starves multi-asset intra-bar updates
**File:** `bot/pocket-option-bot.js:957–966`

One shared timestamp across all assets. When EURUSD's tick triggers the 30s intra-bar recalc, all other assets' ticks within the next 30 seconds skip their update. In a session with 5+ tracked assets, some assets may never get an intra-bar refresh between candle closes.

**Fix:** Key the timer per asset:
```js
if (!STATE.lastIndicatorUpdate[asset] || Date.now() - STATE.lastIndicatorUpdate[asset] > 30000) {
    ...
    STATE.lastIndicatorUpdate[asset] = Date.now();
}
```
Initialise `STATE.lastIndicatorUpdate` as `{}` instead of `null`.

---

## MEDIUM

### M3. `bb_expanding` falls back to `bars[1]` when history < 6 — g6 inflated after restart
**File:** `src/core/intelligence.js:441–448`

```js
const barBbOld = bars[5] || bars[bars.length - 1];
```

With fewer than 6 bars (e.g. right after restart), `bars[5]` is `undefined` and the fallback is `bars[bars.length - 1]` (barM1). BB expansion is then compared against the immediate prior bar, not 5 bars back. Any width increase at all passes g6, inflating CALL gate scores to STRONG/PERFECT incorrectly.

**Fix:** Return `null` explicitly when fewer than 6 bars are available and treat `null` as gate fail:
```js
const barBbOld = bars.length >= 6 ? bars[5] : null;
const bb_expanding = barBbOld ? bbWidthNow > bbWidthOld : null;
```

---

### M4. `ma_gap_trend` falls back to 1-bar delta when history < 4
**File:** `src/core/intelligence.js:428–438`

Same shallow-history pattern. With 2 bars, `gapPrev` is barM1's MA gap and the narrowing check fires on a 1-bar micro-wiggle — incorrectly blocking a signal via g7 (`ma_gap_trend !== 'narrowing'`).

**Fix:** Return `'unknown'` when fewer than 4 bars are available and treat `'unknown'` as passing the gate (same behavior as `'stable'` or `'widening'`).

---

### M7. Stale stoch cross history after reconnect — phantom cross detection
**File:** `bot/indicators.js:617–636`

`_stochHistory[asset]` is a rolling buffer capped at 4 entries. After reconnect and history flood, pre-reconnect entries remain in the buffer mixed with new bars. Cross detection reads `[length-2]` and `[length-3]` as prior-bar K/D — those can be pre-reconnect bars, producing a false stoch cross signal on the first post-reconnect tick.

**Fix:** Clear `_stochHistory[asset]` (and `_cciHistory[asset]`) when a history flood is detected for an asset (i.e. when more than N candles arrive at once).

---

## LOW

### L2. `getSignalsByStrength()` ignores its `minStrength` parameter
**File:** `bot/database.js:682–694`

`minStrength` is accepted but never used in the SQL query. All signals returned regardless of strength.

**Fix:** Add `WHERE strength >= ?` clause, or remove the parameter.

---

### L3. `backtestSignals()` references removed columns `strength` and `adx_value`
**File:** `bot/database.js:1000–1007`

Both columns were dropped by `migrateSignalsDropStrengthColumns()`. Result objects have `strength: undefined` and `adx: undefined`. Not in the live signal path but breaks any analysis tool using this function.

---

### L4. `calculateAll()` mutates shared `STATE.CANDLES[asset]` array with `.asset` property
**File:** `bot/indicators.js:598`

```js
candles.asset = asset;
```

Adds a non-standard property to the live candle array on every `calculateAll()` call. Only used by the dead `calculateMACD()` path. Remove the mutation and pass `asset` as a parameter to `calculateMACD()` directly.

---

## Summary Table

| ID | Sev | File | Lines | Issue |
|----|-----|------|-------|-------|
| C1 | CRIT | `bot/indicators.js` | 75–96 | RSI is SMA not Wilder's — gate g3 values diverge from platform |
| C2 | CRIT | `bot/indicators.js` | 308, 622 | STC defaults mismatch config — backtests use different STC than live |
| C3 | CRIT | `bot/indicators.js` | 315–320 | STC loop includes open candle — 1-bar lookahead on intra-bar refresh |
| H1 | HIGH | `bot/database.js` | 558–560 | v1 stoch columns always null |
| H2 | HIGH | `bot/database.js` | 361–366 | `getCandles()` DESC order — latent reversal trap |
| H3 | HIGH | `bot/indicators.js` | 629–630 | Backfill loop leaves `_lastSchaffValues` at wrong bar |
| H4 | HIGH | `bot/pocket-option-bot.js` | 957–966 | Global `lastIndicatorUpdate` starves multi-asset intra-bar updates |
| M3 | MED | `src/core/intelligence.js` | 441–448 | `bb_expanding` shallow-history fallback inflates g6 |
| M4 | MED | `src/core/intelligence.js` | 428–438 | `ma_gap_trend` 1-bar delta on shallow history blocks valid signals |
| M7 | MED | `bot/indicators.js` | 617–636 | Stale stoch cross history after reconnect — phantom cross |
| L2 | LOW | `bot/database.js` | 682–694 | `getSignalsByStrength()` ignores `minStrength` param |
| L3 | LOW | `bot/database.js` | 1000–1007 | `backtestSignals()` references removed columns |
| L4 | LOW | `bot/indicators.js` | 598 | Mutates shared candle array with `.asset` property |
