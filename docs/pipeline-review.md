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

### C0 — `indicatorData.close` is never set → 100% of signals blocked

**Files:** `bot/indicators.js:528-533`, `bot/pocket-option-bot.js:327`, `bot/ml-gate.js:61-62`

`calculateAll` sets `indicators.currentPrice = lastCandle[2]` but **never sets
`indicators.close`**. The entire ML-gate path keys off `.close`:

1. `evaluateMLGate` bails on its first line — `if (!indicatorData || !indicatorData.close) return null;`
2. `computeKineticFeatures` does the same — `if (!ind || ind.close == null) return null;`,
   and `BB_Deviation = (close - bb_lower) / (bb_upper - bb_lower)` needs it.

So every bar-close / history / display evaluation returns `null`, `insertSignal`
is never reached, the `signals` table stays empty, and nothing enqueues or
executes. **This blocks all signal generation.**

**Fix (one line) — add after `currentPrice` in `calculateAll`:**

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
| S6 | 0.85 gate threshold + C1 corruption | `ml-gate.js:33`, see C1 | Suppresses approvals — "few" rather than "none". |

---

## Critical

### C1 — ML-gate feature state is corrupted by the 30s display loop

**Files:** `bot/ml-gate.js:82-103`, `bot/pocket-option-bot.js:895`, `:735`, `:1119`

`ml-gate.js` keeps **stateful per-asset ring buffers** for the diff features —
`cci_history` (needs `cci[t-2]`) and `stc_history` (needs `stc[t-1]`) — and
advances them on *every* `evaluateGate` call.

But `evaluateMLGate` is called from three unsynchronized places for the same asset:

| Caller | Cadence | Purpose |
|---|---|---|
| finalize / bar-close (`:895`) | once per closed bar | the real signal path that trades |
| history load (`:735`) | once per history frame | backfill |
| `displayStatus` loop (`:1119`) | **every 30s** | console display only |

With 300s candles, the display loop pushes ~10 *intra-bar* STC/CCI values into the
ring between two real closes. So when the next bar closes and fires a trade:

- `STC_Momentum = stc[t] − h[last]` reads an intra-bar value from ~30s ago, **not** the previous bar's STC.
- `CCI_Velocity = (cci[t] − cci[t-2]) / 2` — `cci[t-2]` is "2 pushes ago" = seconds ago, not 2 bars ago, so velocity collapses toward ~0.

The traded signal is therefore evaluated on **contaminated momentum/velocity**.
This is the same bug class already recorded for `indicators.js` in memory
(`feedback_30s_refresh_bug`), reappearing in `ml-gate.js`.
`Stoch_Divergence` (0.988 tree importance) is contemporaneous and survives, but
the tree branches on `STC_Momentum` and `CCI_Velocity` at multiple nodes.

**Fix options:**
1. Compute the gate once at bar-close, cache the result object, and have `displayStatus` reuse it instead of re-evaluating.
2. Make `computeKineticFeatures` stateless — derive `cci[t-2]` / `stc[t-1]` from the last 3 indicator rows in `STATE.INDICATORS` / DB rather than a mutable module ring.
3. Add a `pushHistory`-style flag (mirroring `indicators.calculateAll`) and pass `false` from the display and history callers so only bar-close advances the ring.

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

**Files:** `bot/ml-gate.js:24-27`, `bot/pocket-option-bot.js:735`, `:895`, `:1119`

All three `evaluateMLGate` calls pass a hardcoded `0.80` as `livePayout`.
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

1. **C1** — silently degrading every live signal; highest impact.
2. **C2** and **C3** — small, contained, clearly wrong.
3. **M1 / M2** — data-quality of `trades_ordered` (exit price, timestamps).
4. **M3** — confirm strategy intent.
5. Minor items as cleanup.
