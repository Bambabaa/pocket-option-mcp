# Changelog

All notable changes to pocket-option-mcp are recorded here.

---

## [Unreleased] — 2026-04-16

### Changed — MODE D Gate Tightening (session report 2026-04-16)

Three gate changes validated against 1,689 replayed signals and 144 live trades from the 2026-04-16 session report. Applied to both the live bot (`bot/indicators.js`) and the backtester (`src/core/analysis.js`).

**Change 2 — BB width gate: 10 bps → 20 bps**
- Applies to CALL `g7_bbWide` and PUT `g8_bbWide`
- Prior gate (10 bps) was validated on 135 signals: below 10 bps = 45.8% WR. New threshold of 20 bps further filters marginal-volatility bars.
- `bbWidthSufficient = bbWidthBps >= 20` in `bot/indicators.js`

**Change 3 — PUT: new gate g0 — RSI[-2] > 80**
- Requires bar-2-ago RSI to have been genuinely overbought (> 80) before the reversal fires.
- Filters out PUT signals where RSI touched 70–80 but never reached a true overbought peak — these produced low-edge trades.
- Added as `g0_rsiPriorOB` in `analysis.js`; wraps the existing PUT condition block in `bot/indicators.js`.

**Change 4 — CALL: RSI gate < 45 → < 20**
- Requires the entry bar RSI to be deeply oversold, not just mildly so.
- Reduces CALL signals but eliminates the bulk of false reversals where price was only moderately sold off.
- `rsiDown = rsi < 20` in `bot/indicators.js`; `g5_rsiDown = i0.rsi_5 < 20` in `analysis.js`.

Note: CALL Continuation pattern (UP TREND) remains manually commented out — not touched.

Files modified:
- `bot/indicators.js` — live signal generator
- `src/core/analysis.js` — backtester (CALL_GATES, PUT_GATES, simulateGates baseline)
- `CLAUDE.md` — gate reference updated
- `docs/user-guide.md` — strategy reference updated

---

### Added — Stale feed guards in bot/pocket-option-bot.js

Two guards to prevent duplicate/stale signals when the Pocket Option WebSocket feed freezes:

**Guard 2 — duplicate candle push prevention**
- Before pushing a finalized candle to `STATE.CANDLES`, checks if the last entry already has the same timestamp.
- If so, logs `[STALE] Skipping duplicate candle push` and skips the push.
- Prevents indicators from re-running on a bar that was already processed.

**Guard 1 — stale signal rejection**
- Before enqueuing a signal for execution, compares the signal's candle timestamp against the second-to-last entry in `STATE.CANDLES`.
- If they match, the finalizer fired twice on the same bar — feed is frozen. Signal is blocked with `[STALE] Signal blocked`.
- Uses only DB-relative timestamps; no wall-clock offset arithmetic needed.

File modified: `bot/pocket-option-bot.js`

---

### Added — Session Monitor (`src/scripts/session-monitor.js`)

New standalone ESM script that runs autonomously alongside the bot and MCP server.

```
node src/scripts/session-monitor.js
```

**Startup:** Clears all `source='session'` blocks from the prior run. Restart = new session boundary.

**Every 2 min — loss monitor:**
- 2 consecutive losses → `WARNING` log
- 3+ consecutive losses → `session` block (no expiry, cleared only on restart)

**Every 10 min — unblock sweep:**
Unblocks `auto` and `claude` blocks when ALL conditions pass:
1. BB width >= 10 bps (fresh indicator, < 5 min old)
2. Fewer than 3 consecutive losses today

Session blocks (`source='session'`) are never touched by the sweep.

Block source ownership:
| source | Written by | Cleared by |
|---|---|---|
| `session` | loss-monitor (3 consec losses) | session-monitor restart only |
| `auto` | po_auto_block_sweep / autoBlockCheck | 10-min sweep or expiry |
| `claude` | po_block_asset | 10-min sweep or po_unblock_asset |

Files added: `src/scripts/session-monitor.js`
Files modified: `CLAUDE.md`, `docs/user-guide.md` (Section 6a added)

---

## [9db56f4] — BB Width Gate + MCP Schema Init

- BB width gate enforced in `bot/indicators.js` at 10 bps
- Validated on 135 signals: below 10 bps = 45.8% WR (-$3,580), above 10 bps = 61.8% WR (+$7,120)
- MCP schema and initial docs added

## [6ac2031] — Asset Bias + Backtester Improvements

- `po_asset_bias` tool added — per-asset CALL vs PUT win rate, flags flat/AVOID assets
- Backtester improvements: retracement context fields added to replayed signals
- `po_find_edge` extended with `by_retracement_depth`, `by_k_extension`, `by_ma_gap_trend`, `by_bb_expansion`

## [8c89e8e] — Manual indicator and repo sync

## [f222abd] — Momentum Sniper: contextual dual-gap, MA50 trend, 1-bar Stochastic tolerance, exhaustion filters

## [0b832b1] — Intelligence tools + core analysis features
