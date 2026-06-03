# Bot Pipeline Code Review

Review of `bot/pocket-option-bot.js` and its in-pipeline dependencies:
`indicators.js`, `ml-gate.js`, `database.js`, `config.js`,
`scripts/order-executor.js`, `scripts/validate_ml_signals.js`.

Scope: the **core trading pipeline only**. MCP server, manual `po_trade`
orders, and `asset_controls` blocking are intentionally out of scope here.

_Last reviewed: 2026-06-02 (branch `main`)._

---

## Pipeline at a glance

```
WS frame → messageTaskQueue → processWebSocketMessage
   ├─ history  → insertCandle → calculateAll → insertIndicators → evaluateMLGate → insertSignal
   └─ tick     → priceBatchBuffer → (period rollover) finalize candle
                    → calculateAll → insertIndicators → evaluateMLGate
                    → insertSignal → enqueueOrder → executionQueue → executeOneOrder → placeOrderLive
setInterval loops: runResultSync (DOM → trades_ordered) · runValidation (signal_outcomes)
```

What's solid and should be preserved:

- Serialized message worker prevents the history flood from starving the order executor.
- Separate execution / result-sync / validation loops.
- In-flight guard (`hasAssetInFlightLiveOrder`) enforces first-signal-only per asset.
- Stale-feed Guard 1 rejects a re-fired signal on a frozen candle array.
- STC history caching (`_lastSchaffValues`) with correct reset/restore around the reconnect backfill loop.

---

## Why signals may not be firing

### C0 — `indicatorData.close` is never set → 100% of signals blocked ✅ FIXED

**Files:** `bot/indicators.js:528-534`, `bot/pocket-option-bot.js:327`, `bot/ml-gate.js:61-62`

**Status:** Fixed 2026-06-02. `calculateAll` now sets `indicators.close` at
`bot/indicators.js:530` (right after `currentPrice`). Verified: 21 unit tests
pass, and a runtime check confirms `calculateAll(...).close === currentPrice ===
lastCandle[2]`.

`calculateAll` set `indicators.currentPrice = lastCandle[2]` but **never set
`indicators.close`**. The entire ML-gate path keys off `.close`:

1. `evaluateMLGate` bails on its first line — `if (!indicatorData || !indicatorData.close) return null;`
2. `computeKineticFeatures` does the same — `if (!ind || ind.close == null) return null;`,
   and `BB_Deviation = (close - bb_lower) / (bb_upper - bb_lower)` needs it.

So every bar-close / history / display evaluation returned `null`, `insertSignal`
was never reached, the `signals` table stayed empty, and nothing enqueued or
executed. **This blocked all signal generation.**

**Fix applied (one line) — added after `currentPrice` in `calculateAll`:**

```js
indicators.close = indicators.lastCandle[2];
```

`lastCandle[2]` is the close in the `[ts, open, close, high, low]` layout — the
same value `currentPrice` already uses, and what `BB_Deviation` expects.

#### Secondary blockers (still gate signals even after C0 is fixed)

| # | Cause | Where | Effect |
|---|---|---|---|
| S1 | Chart not on 5m → history filtered by `c[0] % 300 === 0` | `:632`, `:647` | <68 candles, `calculateAll` skipped, no signal. **Chart must be 5m.** |
| S2 | Selected-asset label ≠ WS feed symbol | `:399-405`, `:384-385` | Non-empty `SELECTED_ASSETS` matches nothing → all assets filtered. Empty set (no selection) is safer. |
| S3 | OTC hard-block (`isOtcAsset`) | `:330`, `:380` | Weekends are mostly OTC → zero signals. (See M3.) |
| S4 | 68-bar + gate feature warmup (3× CCI, 2× STC) | `indicators.js:572`, `ml-gate.js:82-103` | ~5.7h silent cold start. |
| S5 | `shouldStore` drops 1-tick flat candles | `:821-826` | Illiquid assets finalize bars/signals late or never. |
| S6 | 0.85 gate threshold (C1 corruption now fixed) | `ml-gate.js:33`, see C1 | Suppresses approvals — "few" rather than "none". |

---

## Critical

### C1 — ML-gate feature state is corrupted by the 30s display loop ✅ FIXED

**Files:** `bot/ml-gate.js:82-103`, `bot/pocket-option-bot.js:897`, `:736`, `:1124`

**Status:** Fixed 2026-06-02 via **Option 1** (cache at close — see below).
`ml-gate.js` left **untouched**: the corruption was removed at the source by
making the display stop calling the gate. Verified: `node --check` passes, 21 unit
tests pass, and `evaluateMLGate` now has exactly **two** callers (close `:897`,
history `:736`), both legitimately once-per-bar.

`ml-gate.js` keeps **stateful per-asset ring buffers** for the diff features —
`cci_history` (needs `cci[t-2]`) and `stc_history` (needs `stc[t-1]`) — and
advances them (`push`/`shift`) on *every* `evaluateGate` call. The function is
correct **only if called exactly once per closed bar**; the mutation is a side
effect with no guard.

`evaluateMLGate` *was* called from three unsynchronized places for the same asset:

| Caller | Cadence | Purpose | After fix |
|---|---|---|---|
| finalize / bar-close (`:897`) | once per closed bar | the real signal path that trades | still calls gate (correct) |
| history load (`:736`) | once per history frame | backfill | still calls gate (correct) |
| `displayStatus` loop (`:1124`) | every 30s | console display only | **now reads `STATE.LAST_SIGNAL` — never calls gate** |

`STATE.INDICATORS[asset]` is recomputed on `STATE.CANDLES` (finalized candles only,
`:1009` `pushHistory=false`), so it holds the **current bar's constant value**
between closes. The display loop therefore pushed that **same value ~9×/bar** into
the ring, saturating the 3-slot CCI buffer within ~90s of a close:

- `CCI_Velocity = (cci[t] − cci[t-2]) / 2` — **the real casualty.** It's a 2-bar
  lookback; the duplicate pushes evict the genuine `cci[t-2]`, collapsing it to a
  ~1-bar diff (e.g. true `17.5` reads as `10`). CCI_Velocity has the lowest tree
  importance (0.001), so live impact is real but small.
- `STC_Momentum = stc[t] − h[last]` — **survives** in steady state: it's a 1-bar
  lookback, and duplicate pushes leave the ring tail equal to the current bar's
  STC, which *is* the correct previous reference. (The original review had this
  backwards — STC was claimed corrupted, CCI claimed to survive.)
- `Stoch_Divergence` (0.988 tree importance) and `BB_Deviation` are
  contemporaneous (no history) and are unaffected.

This is the same bug class already recorded for `indicators.js` in memory
(`feedback_30s_refresh_bug`) — which `indicators.calculateAll` already guards with
its `pushHistory` flag (`:483`). The ml-gate path simply never received the
equivalent guard.

**Fix applied (Option 1 — cache at close, `ml-gate.js` untouched):**
- `STATE.LAST_SIGNAL` cache added (`:442`).
- Bar-close (`:898`) and history (`:737`) cache their gate result:
  `STATE.LAST_SIGNAL[asset] = _signal || null`.
- Display (`:1124`) reads the cache instead of re-evaluating:
  `const _dispSignal = STATE.LAST_SIGNAL[asset] || null`.
- Bonus cleanup: the intra-bar indicator refresh (`:1008`) interval is now dynamic
  `(STATE.PERIOD * 1000) / 2` instead of a hardcoded `30000` — scales with the
  candle period (150s at 5m; still 30s at the legacy 60s period). Churn reduction,
  not correctness — `:1009` recomputes on unchanged candles between closes.

Result: the ring advances **exactly once per bar**, restoring CCI_Velocity's
2-bar lookback. The displayed signal is now the exact value evaluated at close.

**Alternatives considered (not used):**
2. Make `computeKineticFeatures` stateless — derive `cci[t-2]` / `stc[t-1]` from the last 3 indicator rows in `STATE.INDICATORS` / DB rather than a mutable module ring.
3. Add a `pushHistory`-style flag to `evaluateGate` and pass `false` from the display caller. (Works, but touches `ml-gate.js` and leaves the display doing redundant read-only gate math.)

---

### C2 — `insertOrderedTradeClosed` stub call has the wrong argument order

**Files:** `bot/database.js:1500`, `bot/scripts/order-executor.js:264-268`

Signature (13 params):

```
insertOrderedTradeClosed(orderId, signalId, asset, entryTimestamp, direction,
                         amount, entryPrice, exitTimestamp, exitPrice,
                         result, profitLoss, payout, notes)
```

The result-sync call site (`order-executor.js:1174`) is correct. The **stub** call site is not:

```js
insertOrderedTradeClosed(order.id, order.asset, entryTs, order.direction,
    null, tradeAmount, 'executor-stub', order.signal_id, now, null, 'STUB', null)
```

This shifts every field: `signalId='eurusd'`, `asset=<timestamp>`,
`entryTimestamp='CALL'`, `entryPrice='executor-stub'`, `result=null`,
`profitLoss='STUB'`, and only 12 args are passed so `notes=undefined` —
violating the `notes TEXT NOT NULL` constraint.

Only reachable on the no-page / execution-disabled path, so live trading does not
hit it today, but it will throw if ever reached.

**Fix:** correct the argument order, or delete the stub branch entirely.

---

### C3 — ML-gate payout kill-switch never sees the real payout

**Files:** `bot/ml-gate.js:24-27`, `bot/pocket-option-bot.js:736`, `:897`

Both `evaluateMLGate` calls (close `:897`, history `:736`) pass a hardcoded `0.80`
as `livePayout`. (The display loop no longer calls the gate after the C1 fix.)
Since `0.80 ≥ tree floor 0.70` and `≥ logreg floor 0.78`, the payout-aware EV
gate documented in `ml-gate.js` is **always a pass** — effectively disabled.
The only real payout check is `minPayout = 70` at click time in `placeOrderLive`.
If live payout drops to e.g. 75%, a LogReg signal (floor 78%) still fires.

**Fix:** thread the actual payout (read from the DOM / `SEL.payout`) into the
gate, or remove the payout-floor logic so it is not mistaken for an active guard.

---

## Medium

### M1 — Timestamp convention is inconsistent and misdocumented

**Files:** `bot/pocket-option-bot.js:267`, `bot/scripts/order-executor.js:1162-1168`

Comments throughout claim "DB layer handles timezone conversion via
`toLocalTimestamp()`", but no such conversion exists in `database.js` —
candles/prices store raw epoch. Meanwhile result-sync carries a magic `+ 21600`
(6 hours) dual-match for entry/exit candle lookups, which only makes sense if
*some* rows are 6h-offset. Either the offset matching masks a real inconsistency
between `candles.timestamp` and `signal_timestamp`, or it is dead defensive code.
This directly affects exit-price accuracy.

**Fix:** pin down the single source of truth for stored timestamps, delete the
stale conversion comments, and remove or justify the `+21600` fallback.

---

### M2 — Result-sync uses "now" as the exit timestamp

**File:** `bot/scripts/order-executor.js:1143`, `:1167-1171`

`exitTs = Math.floor(Date.now()/1000)` is used both as
`trades_ordered.exit_timestamp` and as the candle-lookup key for `exit_price`.
For a 15m option the true settlement is `entry + 900`, but sync may run minutes
later, so the fallback `exit_price` can grab a candle far from the real close.

**Fix:** use `entryTs + expirySeconds` for the exit-price candle lookup.

---

### M3 — Static OTC block conflicts with the documented strategy

**File:** `bot/pocket-option-bot.js:330`, `:380` (`isOtcAsset`)

`isOtcAsset` hard-rejects every `_otc` pair in `shouldProcessAsset` and
`evaluateMLGate`. Memory `feedback_otc_market_rules` / `feedback_no_static_blocks`
states *no static blocks; OTC is the 24/7 synthetic market.* Pocket Option is
largely OTC-only on weekends, so this can mean the bot processes **nothing**
off-hours. Strategy decision, not a bug — but it contradicts the stated
principle.

**Fix:** confirm intent. If OTC really should be excluded, document why here and
update the conflicting memory; otherwise gate it dynamically.

---

## Minor / nits

- **Dead `'CLAIMED'` status** — referenced in `hasAssetInFlightLiveOrder`
  (`database.js:1348`) but `orders_queue` only ever uses
  PENDING/EXECUTED/SKIPPED/FAILED.
- **No `mlGate.resetState()` on reconnect** — the history path resets
  `indicators._lastSchaffValues` (`pocket-option-bot.js:715`) but leaves the
  ml-gate ring buffers holding pre-reconnect STC/CCI. Pair the resets.
- **Result-sync dedup signature is minute-resolution** —
  `asset_dir_h:m_result` (`order-executor.js:1131`) collides for two
  same-asset/same-direction/same-result trades closing in the same minute. Rare
  under first-signal-only + 15m expiry.
- **`flushPriceBatch` is fire-and-forget** (`pocket-option-bot.js:773`) — safe
  today (copies-then-clears synchronously, `insertPriceBatch` uses
  `BEGIN IMMEDIATE`), but the awaited-vs-not asymmetry is easy to trip over later.

---

## Suggested fix order

0. **C0** — ✅ done (2026-06-02). Unblocks signal generation; nothing else matters until this is in.
1. **C1** — ✅ done (2026-06-02). Ring now advances exactly once per bar; CCI_Velocity restored.
2. **C2** and **C3** — small, contained, clearly wrong.
3. **M1 / M2** — data-quality of `trades_ordered` (exit price, timestamps).
4. **M3** — confirm strategy intent.
5. Minor items as cleanup.
