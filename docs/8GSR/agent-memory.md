# Agent Memory — pocket-option-mcp

Consolidated context snapshot for any agent working in this repo. Covers persistent facts that are not derivable from reading code alone.

---

## DB Timestamps

PO's WebSocket server runs UTC. The bot stores all timestamps raw (UTC epoch seconds). The local machine is UTC-5, but `Date.now() / 1000` is also UTC epoch seconds — so DB timestamps and wall-clock comparisons need **no offset correction**.

When checking if a DB value is recent: `Math.floor(Date.now()/1000) - dbTimestamp` is correct as-is.

The staleness guards in `bot/pocket-option-bot.js` avoid wall-clock comparisons entirely by comparing DB timestamps against each other (last candle vs second-to-last) — the safest approach regardless of timezone.

---

## Session Monitor (`src/scripts/session-monitor.js`)

Standalone ESM script. Run with `node src/scripts/session-monitor.js` in a third terminal alongside the bot and MCP server.

Reads: `src/bot-db.js` (readonly — indicators, trades_ordered)
Writes: `src/mcp-db.js` (writable — asset_controls)

**Two timers:**
- Every 2 min: loss monitor — warn at 2 consecutive losses, write `source='session'` block at 3
- Every 10 min: unblock sweep — re-evaluates non-session blocks, unblocks if BB >= 10 bps + fresh indicator + < 3 consecutive losses

**Session boundary = restarting this script.** On startup it clears all `source='session'` blocks from the prior run.

**Block source ownership:**
| source | Written by | Cleared by |
|---|---|---|
| `session` | loss-monitor (3 consec losses) | session-monitor restart only |
| `auto` | po_auto_block_sweep / autoBlockCheck | unblock sweep or expiry |
| `claude` | po_block_asset | unblock sweep or po_unblock_asset |

When discussing blocks, always distinguish session blocks (restart required to clear) from auto/claude blocks (subject to 10-min sweep conditions).

---

## Static Asset Lists — Forbidden

Asset volatility fluctuates over time. No hardcoded allowlists or blocklists exist anywhere in the pipeline. All asset filtering is data-driven:
- Use `po_asset_volatility` to identify flat assets at session start
- Use `po_auto_block_sweep` to block them dynamically (BB < 5 bps)
- Use `po_auto_block_check` to react to live losing streaks

Never add a specific asset ticker to source code as a constant or array.

---

## Stale Feed Guards (`bot/pocket-option-bot.js`)

Two guards protect against duplicate signals when the Pocket Option WebSocket feed freezes:

**Guard 2** (line ~781): Wraps the entire indicator + signal pipeline. If `STATE.CURRENT_CANDLE_START[asset]` matches the last timestamp already in `STATE.CANDLES[asset]`, the whole block is skipped — no push, no indicator recalculation, no signal. Fires ~477x per session on today's data.

**Guard 1** (line ~828): Secondary guard inside the signal block. Compares `signalTimestamp` against the second-to-last candle in `STATE.CANDLES`. If they match, the signal is blocked. Acts as fallback if Guard 2 is ever bypassed.

Guard 1 fired 0x in the 2026-04-16 session (Guard 2 caught everything upstream).

---

## MODE D Gate Values (current live)

Gates are in `bot/indicators.js` (live bot) and `src/core/analysis.js` (backtester). Both must stay in sync.

**CALL K-Flash Crash Bounce:**
- g5: RSI < 20 (tightened from 40 on 2026-04-16)
- g7: BB width >= 20 bps (tightened from 10 bps on 2026-04-16)

**PUT Late Overbought Reversal:**
- g0: RSI[-2] > 80 (new gate added 2026-04-16)
- g8: BB width >= 20 bps (tightened from 10 bps on 2026-04-16)

CALL Continuation (UP TREND) pattern is manually commented out in `bot/indicators.js` — do not re-enable without explicit instruction.

---

## Session Performance History

| Date | Trades | WR | P/L | Notes |
|---|---|---|---|---|
| 2026-04-16 | 668 | 49.7% | -$36,435 | Gate changes not yet live; high volume was the main problem |

Break-even at 92% payout on $500 stakes requires ~54.3% WR. At ~50% WR, every session at high volume produces a structural loss.

Top 10 winning assets contributed +$17,115; 15 losing assets contributed -$43,770. Asset selection drag is the dominant factor.

---

## Known Validated Facts

- BB < 10 bps = losing zone: 45.8% WR on 135 signals (validated)
- BB < 5 bps = flat/dead market (auto-block threshold)
- Gate tightening (RSI < 20, BB >= 20, g0 RSI[-2] > 80) was not live during 2026-04-16 session — first live run will be the next session
- 16:00–17:00 UTC open hour is consistently the worst (35% WR, three sessions running)
- `trading_data.db` only holds data from the current session — insufficient for po_simulate until 2-3 more sessions accumulate
- `po_simulate call_rsi_max=25` or `call_rsi_max=30` is the recalibration candidate if CALL signals are too sparse
