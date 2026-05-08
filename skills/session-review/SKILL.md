---
name: session-review
description: End-of-day or mid-session debrief. Pulls today's trades, analyses what worked and what didn't, identifies leading causes of wins and losses, and breaks down by expiry (2m primary, 1m optional). When the bot is offline the session is over — automatically pivots to full trade analysis mode. Use when the user says "review today", "how did we do", "session debrief", "what happened today", or when the bot is detected as offline.
---

# Session Review — Trading Debrief

You are generating a debrief of the current or most recent trading session. Your goal is to answer: **what happened, why, and what to do differently.**

## Step 1: Health Check

Call `po_health`.

**If bot is OFFLINE → the session has ended. Skip to ANALYSIS MODE (Step 2A).**

If bot is LIVE → run the standard live debrief (Step 2B onward).

---

## ANALYSIS MODE — Bot Offline (Session Ended)

When the bot is not running, the session is over. Do not wait for live data — pivot immediately to post-session analysis.

### Step 2A: Performance Summary

Call `po_rolling_summary(days=1)` — today's win rate, P/L, trade count.
Call `po_pnl_summary` — P/L by asset.
Call `po_trades_ordered` (recent, limit=50) — last trades with WIN/LOSS and direction.

Note:
- Total trades, overall WR, total P/L
- CALL vs PUT breakdown (count, WR, P/L each)
- Best and worst asset by P/L

### Step 2B: Deep Replay Analysis (Leading Causes)

Call `po_find_edge`.

This runs a full candle-by-candle replay from `candles + indicators + prices` — independent of what the bot actually traded. It gives the ground truth on what conditions produce wins vs losses.

**Primary target: `exp_120s` (2m expiry). Secondary context: `exp_60s` (1m expiry — optional).**

#### Identify Leading Causes of Wins

For each dimension in `exp_120s`, find the bucket with the highest win rate (≥5 trades):
- What value / range was present when the trade won?
- Is the z_score positive and p_value < 0.10?

The **leading cause of wins** = the dimension where high-WR buckets have p_value < 0.10 and WR >60%.

#### Identify Leading Causes of Losses

For each dimension, find the bucket with the lowest win rate (≥5 trades):
- What value / range was present when the trade lost?
- This bucket represents a known bad condition the bot should filter out.

The **leading cause of losses** = the dimension where the lowest-WR bucket has the most trades and worst net PnL.

#### Expiry Divergence Check

Compare the same bucket across `exp_60s` vs `exp_120s`:
- If 60s WR is high but 120s WR is low → **signal reversal**: the move is real but fades. The 2m trade is wrong direction.
- If 60s and 120s WR are close → **clean follow-through**: signal is genuine.
- Flag any dimension where |WR_60s - WR_120s| > 15% — that's where the expiry choice matters.

#### Cross-Validation Check

If `cross_validation` is present in the find_edge output:
- Compare `in_sample.overall_wr` vs `out_of_sample.overall_wr`
- If the gap is >10%: note "edge may be weakening over time — out-of-sample performance degraded"
- If the gap is <5%: note "edge is stable across time periods"

### Step 2C: Compile the Analysis Report

```
POST-SESSION ANALYSIS — [date]
═══════════════════════════════════════

PERFORMANCE SUMMARY
  Trades:      N (CALL: N | PUT: N)
  Win Rate:    N% (WR target: >52.2% for breakeven)
  P&L:         $N

  By expiry (from replay):
    2m (120s):  N% WR, $N PnL  ← PRIMARY
    1m (60s):   N% WR, $N PnL  ← optional context

DIRECTION BREAKDOWN
  CALL:  NW/NL — N% WR, $N
  PUT:   NW/NL — N% WR, $N

LEADING CAUSES OF WINS
  1. [Dimension]: [bucket] — N% WR (n=N, z=N, p=N)
     → Condition that consistently predicts winning trades
  2. [Dimension]: [bucket] — N% WR (n=N)

LEADING CAUSES OF LOSSES
  1. [Dimension]: [bucket] — N% WR (n=N, PnL=$N)
     → Condition to filter out — add as a gate or tighten threshold
  2. [Dimension]: [bucket] — N% WR (n=N)

EXPIRY DIVERGENCE (60s vs 120s)
  [Dimension]: 60s=N% vs 120s=N% → [DIVERGES/CONSISTENT]
  [Note if signal reverses between expiries]

CROSS-VALIDATION
  In-sample WR:     N% (n=N)
  Out-of-sample WR: N% (n=N)
  Verdict: STABLE / WEAKENING / OVERFIT RISK

ACTIONS RECOMMENDED
  Gate tighten:    [parameter] — remove [losing bucket] (saves $N)
  Gate loosen:     [parameter] — include [winning bucket] (adds $N)
  Dynamic block:   [assets with current BB < 5 bps — current session only, not permanent]
  Next run:        /edge-optimize to confirm gate changes before applying
```

---

## STANDARD MODE — Bot Live

### Step 2: Today's Performance

Call `po_rolling_summary(days=1)`, `po_pnl_summary`, `po_trades_ordered`.

### Step 3: Signal Quality Check

Call `po_signals(limit=50)` — patterns that fired: STC_CALL_8GSR vs STC_PUT_8GSR?
Check `po_session_log_read` — agent decisions if `/auto-trade` was run.

### Step 4: Asset Performance Breakdown

Call `po_asset_streaks` — assets on win/loss streaks.
Call `po_asset_bias(min_trades=3)` — are we trading the wrong direction on any asset?

For any asset with 3+ consecutive losses: Call `po_risk_check(asset)`.

### Step 5: BB Width Context

Call `po_asset_volatility` — for any losing asset, was BB < 10 bps at the time?

### Step 6: Compile Standard Debrief

```
SESSION DEBRIEF — [date]
═══════════════════════════════════════

PERFORMANCE SUMMARY
  Trades:      N (CALL: N | PUT: N)
  Win Rate:    N% (historical baseline: N%)
  P&L:         $N (target: breakeven @ 52.2%)

  By expiry (from today's trades):
    2m (120s):  N% WR, $N PnL  ← PRIMARY
    1m (60s):   N% WR, $N PnL  ← if available

TOP PERFORMER:   [asset] — $N profit, N% WR
WORST PERFORMER: [asset] — $N loss, N% WR

PATTERN BREAKDOWN
  STC_CALL_8GSR (CALL Reversal):  NW/NL — N%
  STC_PUT_8GSR  (PUT Reversal):   NW/NL — N%

ISSUES FOUND
  [e.g. "SARCNY traded 3x PUT — historically CALL_PREFERRED"]
  [e.g. "EURUSD 4 consecutive losses — BB < 5 bps at time of trade, flat market"]

ACTIONS RECOMMENDED
  Dynamic block:  [assets with current BB < 5 bps — temporary, auto-unblocks when vol returns]
  Watch:          [assets on win streak — good current setup]
```

### Step 7: Forward Actions

1. Dynamic block any asset currently under 5 bps via `po_block_asset` (NOT based on historical WR alone — OTC conditions change)
2. If session WR < 45%: recommend running `/edge-optimize`
3. If many flat-market losses: recommend `/block-flat-assets` (volatility-based only)
4. What to watch next session

---

## Rules

- **Bot offline = session ended = go straight to analysis mode** — never stop at "bot not running"
- Primary expiry is always 2m (120s) — 1m (60s) is context only
- Cite actual values: WR%, P/L amounts, z_score, p_value — no vague descriptions
- Leading cause of wins = highest-WR bucket with p_value < 0.10 and n ≥ 5
- Leading cause of losses = lowest-WR bucket with the most trades (highest loss impact)
- If n < 5 trades in any bucket: label "insufficient sample — treat as hypothesis"
- Cross-validation gap > 10%: flag as edge degradation, suggest more data collection
