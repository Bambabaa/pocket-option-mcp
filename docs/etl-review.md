# Data ETL Review — End to End

Focused review of the **data path**: WebSocket ingestion → in-memory candle
aggregation → indicator/feature transform → SQLite load → outcome validation.
Companion to `pipeline-review.md` (which covers signal/execution logic).
Scope: bot pipeline only; MCP server out of scope.

_Reviewed: 2026-06-03 (branch `main`). Findings marked ✔ verified against the
live `data/trading_data.db` while the bot was running._

```
EXTRACT                         TRANSFORM                         LOAD                       VALIDATE
WS frame (base64→JSON)
  ├─ history (data.candles +    reverse + period filter           insertCandle (ON CONFLICT) → candles
  │   data.history flats)       calculateAll (per bar)            insertIndicators           → indicators
  │                             evaluateMLGate (per bar)          insertSignal               → signals
  └─ tick array                 floor→periodStart OHLC build      insertPriceBatch           → prices
      └─ priceBatchBuffer       finalize on rollover              enqueueOrder               → orders_queue
                                                                  (validation loop)          → signal_outcomes
                                                                  (DOM result sync)          → trades_ordered
```

What's correct and should be preserved:

- **Indicator index usage is consistent.** Every transform reads `c[2]=close`,
  `c[3]=high`, `c[4]=low`, `c[1]=open` (`indicators.js` SMA/EMA/RSI/MACD/ATR/ADX/
  Williams/PSAR/ZigZag/BB/Stoch/CCI/STC). No row/column transpose.
- **Candle id stability.** `insertCandle` uses `ON CONFLICT(asset,timestamp) DO
  UPDATE` so `candles.id` never changes → soft-FK `candle_id` columns don't dangle.
- **Idempotent load.** `signal_outcomes` (INSERT OR IGNORE → conditional UPDATE)
  and `trades_ordered` (UNIQUE `order_id`) are safe under retries.
- **WAL + `busy_timeout=60s`** allow concurrent reads without corrupting writes.
- Live finalize keeps `candles` table and `STATE.CANDLES` aligned by dropping
  low-quality candles from **both** (`:826-831`).

---

## Verified against the live DB (2026-06-03)

Queried the running `data/trading_data.db` directly:

- **Feed is seconds, not milliseconds.** ✔ Raw `prices.timestamp` is 10-digit
  Unix seconds (`1780499725`), candle spacing is exactly `300`. The earlier
  "if PO sends ms" worry does **not** apply — aggregation math is sound.
- **Feed runs +2h ahead of UTC (broker UTC+2), stable.** ✔ Comparing each row's
  `timestamp` (broker clock) to its `created_at` (SQLite real-UTC write time)
  gives a constant `timestamp − created ≈ 6900s = offset(7200) − bar(300)` on
  every candle and signal. So the offset is a fixed **+2h**, derivable from the
  data itself (no live clock needed).
- **`created_at` is trustworthy.** ✔ `datetime(created_at,'localtime')` matches
  the real wall clock; only `timestamp` carries the broker offset.
- **Prices are a clean 1 Hz series.** ✔ Every asset: `min_gap=1s`, `max_gap=2s`,
  `avg≈1.008s`, zero gaps > 2s. Sub-second ticks are floored to whole seconds and
  de-duped by `UNIQUE(asset,timestamp)` → at most 1 row/asset/sec, last-wins.
  Consequence: ~300 ticks per 5-min bar (robust OHLC; `shouldStore` never drops
  liquid pairs), and entry/exit price lookups within the 5s tolerance always hit.

---

## EXTRACT (WebSocket ingestion)

### X1 — Feed timestamps carry a +2h broker offset that's never normalized  *(medium)* ✔

**Files:** `bot/pocket-option-bot.js:762`, `:637`, `:630`, `:807`, `:768`

The feed timestamp enters at two raw points — tick `parseFloat(data[0][1])`
(`:762`) and history `parseInt(parseFloat(tstamp))` / `data.candles[c][0]`
(`:637`/`:630`) — and is used as-is for `periodStart`, the candle key, and the
price key. It is **seconds** (confirmed, not ms), but it's in **broker time
(UTC+2)**, ~2h ahead of true UTC, and nothing normalizes it.

Because every market timestamp inherits this offset, the chain is internally
consistent (5-min spacing, `signal_ts + expiry`, indicator lookbacks all hold).
The bug is **clock-mixing**: real-UTC values (`Date.now()`-based
`trades_ordered.entry/exit_timestamp`, `last_update_at`, the validation loop)
sit in the same system as feed-time market timestamps. Proof from `trades_ordered`:
within one row, `signal_timestamp` (feed) and `entry_timestamp` (real-UTC from
`inferEntryTimestamp`) differ by ~6900s ≈ the offset — not a real holding period.

This is the **trunk** behind D2 and pipeline-review M1; the executor-side `+21600`
patch (D2) is a leaf symptom.

**Fix (decision pending):** pick **one** clock for market-event timestamps.
Option A (minimal, no migration) — keep feed-time canonical and derive
trade entry/exit from `signal_timestamp` (offset-agnostic, DST-proof).
Option B (source normalize) — convert feed→UTC at ingestion
(`ts_utc = feed_ts − offset`, offset = 7200, derivable from `created_at`), then
real-UTC writers align for free; needs a one-time migration of existing +2h rows.

### X2 — History `value` is not numeric-parsed  *(low)*

**File:** `bot/pocket-option-bot.js:636-639`

Tick prices are `parseFloat(data[0][2])`, but history pairs use `value` as-is:
`const candle = [timestamp, value, value, value, value]`. If the feed delivers
strings, these flat candles enter `STATE.CANDLES` as strings and corrupt
indicator math (`closes.reduce((a,b)=>a+b)` becomes string concatenation → NaN).
Works today because PO sends numbers; it's an unguarded type assumption.

**Fix:** `const v = parseFloat(value);` and skip if `isNaN(v)`.

### X3 — `messageTaskQueue` is unbounded  *(low)*

**File:** `bot/pocket-option-bot.js:189`, `:548`

Frames are pushed without backpressure. A history flood that outpaces the worker
grows memory unbounded. Fine at normal PO volume; worth a cap/metric.

---

## TRANSFORM (aggregation + indicators)

### T1 — History flat candles diverge `candles` from `indicators`  *(medium)*

**Files:** `bot/pocket-option-bot.js:656`, `:662-687`, `:717-732`

`STATE.CANDLES[asset] = candles` keeps the synthetic flat candles built from
`data.history`, but the DB insert loop **skips flat candles** (`O=H=L=C`,
`:669`). So the in-memory series (used for indicators) contains bars the
`candles` table never received. The backfill loop then writes `indicators` rows
keyed by those timestamps; the `candle_id` subquery returns NULL and — since
`PRAGMA foreign_keys` is **not** enabled — the FK `(asset,timestamp)→candles`
does not stop it. Result: `indicators` rows with no matching `candles` row, and
indicator values computed over a series that doesn't match the stored candles.

The live finalize path does this correctly (drops from both); only the **history
path** diverges.

**Fix:** either persist the flat history candles too, or exclude them from
`STATE.CANDLES` so the in-memory series matches what was stored.

### T2 — CCI typical price has no high/low fallback  *(low)*

**File:** `bot/indicators.js:436`

`(c[3] + c[4] + c[2]) / 3` assumes 5-element candles. Every other OHLC reader
uses `c[3] ?? c[2]` / `c[4] ?? c[1]`. A 3-element candle yields `NaN` CCI →
`CCI_Velocity` null → gate blocked. Defensive only (the live series is always
5-element), but inconsistent.

### T3 — STC is O(n²) per bar; reconnect backfill is O(n³)  *(perf / medium)*

**Files:** `bot/indicators.js:384-394`, `bot/pocket-option-bot.js:717-732`

`calculateSchaffTrendCycle` recomputes `calculateEMA(slice(0,i))` for every
`i` from `emaSlow..n` → O(n²) per `calculateAll`. The reconnect backfill calls
`calculateAll` for every historical bar → O(n³) overall. For a few hundred bars
this is a multi-hundred-ms to multi-second stall on reconnect. It runs inside the
serialized message worker, so it won't block the order executor, but it delays
catch-up. Consider memoizing the EMA streams once and indexing into them.

### T4 — `close` field (C0) verified present  *(info)*

`calculateAll` now sets `indicators.close = lastCandle[2]` (`:530`). Confirmed by
`tests/verify-c0-close.js`. The transform output now satisfies the ML-gate
contract.

---

## LOAD (SQLite writes)

### L1 — Foreign keys are never enforced  *(medium)*

**File:** `bot/database.js:41-54`

`initialize()` sets `busy_timeout`, `journal_mode=WAL`, `synchronous=NORMAL` but
**never `PRAGMA foreign_keys = ON`**. All the `FOREIGN KEY` clauses
(`indicators→candles`, `signals→candles`, `trades_ordered→orders_queue`, …) are
declarative only. Combined with T1, orphan rows can accumulate silently. Either
enable enforcement (and handle the resulting insert ordering) or document that
FKs are intentionally advisory and rely on the `candle_id` backfill instead.

### L2 — `insertOrderedTradeClosed` stub call corrupts the row  *(critical — see pipeline-review C2)*

Cross-listed: `order-executor.js:264-268` passes args in the wrong order and one
short, which would write garbage / violate `notes NOT NULL` on the stub path.

### L3 — Price batch is fire-and-forget  *(see D1)*

`flushPriceBatch(database)` is invoked without `await` in the tick hot path
(`:773`). Safe under normal flow (copies-then-clears synchronously, `BEGIN
IMMEDIATE` serializes), but see D1 for the shutdown data-loss angle.

---

## VALIDATE (outcomes)

### V1 — Expiry gate is looser than the outcome horizon  *(low)*

**Files:** `bot/scripts/validate_ml_signals.js:84-88`, `:49-61`

A signal becomes "past expiry" at `now - lookAheadSeconds` (config `300` = 1 bar),
but `getOutcome15m` needs `p+3` (3 bars / 15m) of future candles. So signals are
selected ~10 minutes before their outcome exists, fail the `no_future_candle`
check, and are re-queried each loop until the 3rd bar lands. Correct result, but
wasted work every cycle. Gate selection on `now - 3*period` instead.

### V2 — Position-based `p+3` can stretch the real horizon  *(low)*

**File:** `bot/scripts/validate_ml_signals.js:49-61`, `:122-127`

The outcome uses `arr[p+3]` over the **persisted** candle series. If flat candles
were dropped (T1), `p+3` persisted bars can be more than 15 real minutes ahead,
so the paper outcome and the live 15m option measure slightly different windows.

---

## CROSS-CUTTING

### D1 — Shutdown / crash loses buffered prices and the open candle  *(medium)*

**Files:** `bot/pocket-option-bot.js:210-226`, `:1287-1291`

`priceBatchBuffer` flushes at 200 items or 10s. The `SIGINT` handler closes the DB
and exits **without flushing**, dropping up to 200 ticks (or 10s) of prices.
The in-progress `STATE.CURRENT_CANDLE` (and any complete period not yet rolled
over by a following tick) is also lost. For a price-driven backtest store this is
silent gap creation.

**Fix:** `await flushPriceBatch(database)` in the SIGINT handler before
`database.close()`; optionally finalize the current candle on shutdown.

### D2 — Result-sync `+21600` offset is the wrong magnitude  *(medium — leaf of X1)* ✔

**File:** `bot/scripts/order-executor.js:1162-1168`

The entry/exit price fallback tries to bridge clocks with `ABS(timestamp - (? +
21600))` — a **6h** offset. But the measured feed-vs-UTC offset is **+2h
(7200s)**, so this looks in the wrong window and won't match the candle → null
`entry_price`/`exit_price` on closed trades. Comments elsewhere also claim "DB
layer handles timezone conversion" though no conversion exists. Once X1 is
resolved (one canonical clock), this dual-match offset should be deleted, not
re-tuned — entry/exit and candles will already share a clock.

---

## Severity summary

| ID | Stage | Severity | One-liner |
|----|-------|----------|-----------|
| X1 | Extract | Medium ✔ | feed is seconds but +2h broker offset → clock-mixing (not ms) |
| X2 | Extract | Low | history `value` not numeric-parsed |
| X3 | Extract | Low | unbounded message queue |
| T1 | Transform | Medium | history flats: `candles` ≠ `indicators` |
| T2 | Transform | Low | CCI lacks high/low fallback |
| T3 | Transform | Medium (perf) | STC O(n²)/bar, backfill O(n³) |
| L1 | Load | Medium | `PRAGMA foreign_keys` never ON |
| L2 | Load | Critical | stub `insertOrderedTradeClosed` arg order (C2) |
| V1 | Validate | Low | expiry gate looser than 3-bar horizon |
| V2 | Validate | Low | dropped flats stretch `p+3` window (rare: 1 Hz feed ✔) |
| D1 | Cross | Medium | shutdown loses buffered prices + open candle |
| D2 | Cross | Medium ✔ | result-sync `+21600` is wrong offset (should be 7200 / removed) — leaf of X1 |

### Suggested order
1. **X1** (+ its leaf **D2**) — one canonical clock; underpins every key and fixes null entry/exit prices.
2. **T1** + **L1** — table divergence / orphan rows (enable FKs or align flats).
3. **D1** — stop silent price-gap creation on shutdown.
4. **T3** — reconnect latency.
5. **X2 / T2 / V1 / V2 / X3** — hardening.
