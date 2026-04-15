---
name: session-review
description: End-of-day or mid-session debrief. Pulls today's trades, analyses what worked and what didn't, flags problem assets, compares performance against historical baseline, and writes a session summary. Use when the user says "review today", "how did we do", "session debrief", or "what happened today".
---

# Session Review — Trading Debrief

You are generating a debrief of the current or most recent trading session. Your goal is to answer: **what happened, why, and what to do differently.**

## Step 1: Health Check

Call `po_health` to confirm DB access. Bot does not need to be live for a review.

## Step 2: Today's Performance

Call `po_rolling_summary(days=1)` — today's win rate, P/L, trade count.

Call `po_pnl_summary` — P/L broken down by asset.

Call `po_trades_ordered` (recent) — last 20 executed trades with WIN/LOSS results.

Note:
- Total trades today
- Overall win rate today
- Total P/L today
- Best asset (highest P/L)
- Worst asset (lowest P/L)
- Any consecutive loss streaks

## Step 3: Signal Quality Check

Call `po_signals(limit=50)` — most recent signals fired by the bot.

Cross-reference with trades:
- Were signals being generated but not executed? (check bot liveness)
- Were trades placed on assets that had no signal? (manual overrides)
- What patterns fired today — OVERSOLD|Reversal vs OVERBOUGHT|Reversal vs UP TREND vs DOWN TREND?

Check `po_session_log_read` — pull today's agent decisions if `/auto-trade` was run.

## Step 4: Asset Performance Breakdown

Call `po_asset_streaks` — which assets are on win/loss streaks right now.

For any asset with 3+ consecutive losses today:
- Call `po_risk_check(asset)` — current indicator state
- Note whether it should be temporarily blocked

Call `po_asset_bias(min_trades=3)` — compare today's direction breakdown against historical bias.
- Did we trade CALL on an asset that historically only wins PUT? Flag this.

## Step 5: BB Width Context

Call `po_asset_volatility` — check current BB width across all traded assets.

For any asset that lost today:
- Was BB width below 10 bps at the time? (the validated losing zone)
- If yes — the BB gate should have caught this. Check if the bot is running the latest indicators.js.

## Step 6: Hourly Breakdown

Call `po_hourly_breakdown` — which hours were profitable vs unprofitable today.

Compare against historical `po_find_edge` hour data if available in docs/edge_report*.

## Step 7: Compile the Debrief

Report to the user in this format:

```
SESSION DEBRIEF — [date]
═══════════════════════════════════════

PERFORMANCE SUMMARY
  Trades:      N (CALL: N | PUT: N)
  Win Rate:    N% (historical baseline: N%)
  P&L:         $N (target: breakeven @ 52.2%)

TOP PERFORMER:   [asset] — $N profit, N% WR
WORST PERFORMER: [asset] — $N loss, N% WR

PATTERN BREAKDOWN
  CALL Reversal (OVERSOLD):    NW/NL — N%
  PUT Reversal (OVERBOUGHT):   NW/NL — N%
  CALL Continuation (UP TREND): NW/NL — N%
  PUT Continuation (DOWN TREND): NW/NL — N%

ISSUES FOUND
  [bullet list — e.g. "SARCNY traded 3x PUT — historically CALL_PREFERRED"]
  [e.g. "EURUSD 4 consecutive losses — consider temp block"]
  [e.g. "3 trades fired in 8-10 UTC dead zone"]

ACTIONS RECOMMENDED
  Block:   [assets with 3+ losses or AVOID verdict]
  Avoid:   [hours that underperformed]
  Watch:   [assets on win streak — good candidates for next session]
```

If `/auto-trade` was run, also include:
```
AGENT DECISIONS
  Scanner cycles:    N
  Analyst approvals: N / N reviewed
  Executor aborts:   N
  Trades placed:     N
  [Key decisions from po_session_log_read]
```

## Step 8: Forward Actions

Based on the debrief, suggest:
1. Any assets to block right now via `po_block_asset`
2. Whether to run `/edge-report` for deeper analysis if the session was bad
3. Whether to run `/block-flat-assets` if volatility was low across the board
4. What to watch for in the next session

## Rules

- Be specific — cite actual win rates, P&L values, and asset names
- Separate "what happened" (facts) from "why" (analysis) from "what to do" (actions)
- If today's WR is significantly below historical baseline, flag it prominently
- Small sample sizes (< 5 trades) should be noted as insufficient for conclusions
