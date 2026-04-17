# Pocket Option MCP — User Guide

A complete reference for using the 40 MCP tools to monitor, analyse, and trade via your Pocket Option bot.

---

## Quick Start

Always begin a session with:

```
po_health
```

This confirms both databases are reachable and the bot is live. If the bot is not running, live data tools will return stale or empty results.

---

## Tool Reference by Category

### 1. Health & Market State

| Tool | What it does |
|---|---|
| `po_health` | Check both DBs + bot liveness. Call first, always. |
| `po_market_state` | Active asset count, signal frequency last hour, today P/L, top assets |
| `po_tracked_assets` | Which assets the bot is currently monitoring |
| `po_prices` | Current price for one or all assets |

---

### 2. Intelligence — Agentic One-Call Tools

These replace calling 5 separate tools manually.

| Tool | What it does |
|---|---|
| `po_scan_all` | Scan ALL assets at once — scores each by 7 indicator layers (MA cross, gap expansion, RSI strength, stochastic trigger, BB position). Returns ranked list. |
| `po_recommend` | "What should I trade right now?" — filters scan by precision score + win rate + historical bias. Returns ranked list with confidence. |
| `po_risk_check asset direction` | "Is this trade safe?" — checks indicator precision, direction alignment, recent form, consecutive losses. Returns score 0-100 + GOOD/CAUTION/RISKY/AVOID verdict. |
| `po_asset_bias` | Per-asset CALL vs PUT win rate history. Flags flat assets (BLOCK_RECOMMENDED), consistent losers (AVOID), and preferred direction per asset. |
| `po_asset_volatility` | Ranks all assets by BB width bps. Use this to identify pegged/flat assets to block. |

**Typical workflow before trading:**

```
po_recommend
→ pick top asset
→ po_risk_check EURUSD_otc CALL
→ po_trade EURUSD_otc CALL 500 1
```

---

### 3. Market Data

| Tool | What it does |
|---|---|
| `po_candles asset` | OHLC bars. Use `summary=true` unless you need individual bars. |
| `po_price_history asset` | Tick-level prices over a time window |
| `po_indicators asset` | Latest MA6/14, RSI-5, BB, Stochastic K/D v2, Keltner, Schaff values |
| `po_signals` | CALL/PUT signals from the KT video2 pipeline. Filter by asset or direction. |
| `po_pending_signals` | Signals past expiry not yet validated |

---

### 4. Placing & Managing Trades

| Tool | What it does |
|---|---|
| `po_trade asset direction amount expiry` | Enqueue a manual CALL or PUT. Writes to mcp.db — bot picks it up and clicks Pocket Option. Blocked assets will be SKIPPED automatically. |
| `po_cancel_order id` | Cancel a PENDING manual order (mcp.db only) |
| `po_mcp_orders` | View manual orders you placed via po_trade |
| `po_bot_orders` | View bot-generated execution queue (readonly) |

**Requirements:** Bot must be running with `execution.enabled = true`.

---

### 5. Results & Performance

| Tool | What it does |
|---|---|
| `po_trades_ordered` | Executed live trades with WIN/LOSS results |
| `po_pnl_summary` | P/L breakdown by asset |
| `po_rolling_summary days=N` | Rolling win rate + P/L. Use `days=0` for all-time. |
| `po_performance` | Daily performance table |
| `po_hourly_breakdown` | Which hours of day are most profitable |

---

### 6. Asset Controls — Blocking

Use these to stop the bot trading specific assets. All blocks must have a `duration_minutes` — no permanent blocks.

| Tool | What it does |
|---|---|
| `po_block_asset asset reason duration_minutes` | Block an asset for N minutes. Bot skips it before every order. |
| `po_unblock_asset asset` | Remove an active block (non-session blocks only — see session monitor below) |
| `po_asset_volatility` | See which assets are flat/pegged (candidates for blocking) |
| `po_auto_block_sweep` | Block all assets with BB < 5 bps at session start — use once before first trade |
| `po_auto_block_check asset` | Check if asset should be blocked after a trade result (3 consec losses or WR < 35%) |

**Block source reference:**

| source | Written by | Cleared by |
|---|---|---|
| `session` | session-monitor (3 consec losses) | session-monitor restart only |
| `auto` | po_auto_block_sweep / autoBlockCheck | 10-min unblock sweep or expiry |
| `claude` | po_block_asset (you or Claude) | 10-min unblock sweep or po_unblock_asset |

---

### 6a. Session Monitor — Autonomous Block/Unblock Loop

Run this alongside the bot and MCP server:

```
node src/scripts/session-monitor.js
```

**What it does:**

| Timer | Behaviour |
|---|---|
| On startup | Clears all `source='session'` blocks from the prior run — fresh slate |
| Every 2 min | Checks every asset that has traded today for consecutive losses |
| Every 10 min | Re-evaluates all non-session blocks — unblocks if conditions have recovered |

**Loss monitor logic (every 2 min):**
- 2 consecutive losses → `WARNING` log (no block yet)
- 3 consecutive losses → `session` block with no expiry — asset blocked for rest of session

**Unblock sweep logic (every 10 min):**
Unblocks a `claude` or `auto` block only if ALL pass:
1. BB width >= 10 bps (current indicator)
2. Indicator data < 5 minutes old
3. Fewer than 3 consecutive losses today

Session blocks (`source='session'`) are **never** touched by the sweep. Only a restart clears them.

**Session boundary = restarting the session monitor.** On restart it clears all session blocks and starts fresh. Restart it each trading day.

**Console output examples:**
```
[LOSS-MONITOR] WARNING CADCHF_otc — 2 consecutive losses (1 more = session block)
[LOSS-MONITOR] BLOCKED CADCHF_otc — loss-monitor: 3 consecutive losses — session block
[UNBLOCK-SWEEP] CADCHF_otc stays blocked: BB 4.2 bps < 10 threshold
[UNBLOCK-SWEEP] UNBLOCKED EURUSD_otc — all conditions passed
```

---

### 7. Analysis & Backtesting

The core research pipeline. Run these to understand what the strategy actually produces on historical data before changing any live settings.

#### Step 1 — Full replay

```
po_replay_candles
```

Replays every candle bar-by-bar across all assets. Fires simulated CALL and PUT signals, validates against the next candle close. Returns win rates, P/L, gate rejection counts.

Each replayed signal now carries **retracement context**:

- `rsi_peak_10` — how overbought RSI was in the 10 bars before signal (PUT depth)
- `rsi_trough_10` — how oversold RSI was in the 10 bars before signal (CALL depth)
- `k_bars_above_65` — how many consecutive bars K was above 65 before the crash (PUT exhaustion)
- `k_bars_below_35` — how many consecutive bars K was below 35 before the bounce (CALL exhaustion)
- `ma_gap_trend` — was MA6/MA14 gap narrowing (exhaustion) or widening (momentum) at entry?
- `bb_expanding` — was BB width growing (breakout) or shrinking (squeeze) at entry?

#### Step 2 — Find the edge

```
po_find_edge
```

Analyses all replayed signals across 11 dimensions:

| Dimension | What it reveals |
|---|---|
| by_rsi | Win rate per RSI range at entry |
| by_stochastic_k | Win rate per K range at entry |
| by_ma_gap | Win rate per MA6/MA14 gap bps range |
| by_hour | Win rate per hour of day (UTC) |
| by_bb_width | Win rate when market is flat/weak/marginal/good volatility |
| by_pattern | All 4 patterns: CALL_REVERSAL, PUT_REVERSAL, CALL_CONTINUATION, PUT_CONTINUATION |
| **by_retracement_depth** | PUT: did RSI peak above 80/90 before reversal? CALL: did RSI trough below 20/10? |
| **by_k_extension** | Did K stay extended for 1 bar or 4+ bars before the crash? |
| **by_ma_gap_trend** | Was the trend exhausting (narrowing) or accelerating (widening) at entry? |
| **by_bb_expansion** | Was volatility rising or falling when the signal fired? |
| by_asset | Per-asset win rate with per-direction breakdown |

#### Step 3 — Test gate changes before touching the bot

```
po_simulate min_bb_bps=5
```

Compare baseline (current live gates) vs modified thresholds side-by-side. Returns signal count, win rate, P/L delta for both CALL and PUT.

**Example experiments:**

```
# Skip flat assets at asset level (avg BB)
po_simulate min_bb_bps=5

# Require real volatility at each individual bar — more precise (VALIDATED ✓)
po_simulate bar_bb_bps_min=10
po_simulate bar_bb_bps_min=15
po_simulate bar_bb_bps_min=20

# Bigger K crash requirement for CALL
po_simulate call_k_crash_min=35

# Tighten PUT D requirement
po_simulate put_d_min=85

# Combine bar-level BB + bigger K crash
po_simulate bar_bb_bps_min=10 call_k_crash_min=35
```

#### Step 4 — Grid search

```
po_optimize_gates direction=both
```

Automatically tests a range of threshold values for each gate and shows which produce the highest win rate.

#### Inspect a specific signal

```
po_replay_signal signal_id=1234
```

Reconstructs all gate values at the exact moment a historical signal fired. Shows which gates passed/failed, RSI/K/MA values, and actual trade outcome.

---

### 8. Qualification Layer

| Tool | What it does |
|---|---|
| `po_qualified_assets` | Assets on the bot's trading allow-list |
| `po_asset_streaks` | Current win streak per asset |
| `po_streak_leaderboard` | Rank assets by consecutive wins |
| `po_signal_outcomes` | Signal validation history — entry/exit price, WIN/LOSS |
| `po_asset_trades` | Trade outcomes for qualified assets |
| `po_validation_stats` | Aggregate win rate from validation history |

> Note: Qualification layer is currently **disabled** (`useQualifiedAssetsLayer: false`). Every signal trades regardless.

---

### 9. Multi-Agent Autonomous Trading

The `/auto-trade` skill spawns 3 agents in sequence: Scanner → Analyst → Executor.

| Tool | Used by |
|---|---|
| `po_signal_context asset` | Analyst — full 4-bar indicator + candle + signal snapshot in one call |
| `po_drawdown_check` | Executor — GO/PAUSE/STOP verdict based on today P/L, consecutive losses, bot liveness |
| `po_session_log_write` | All agents — write decisions to audit trail |
| `po_session_log_read` | Human review — full history of scanner scans, analyst verdicts, executor actions |

---

## Strategy Reference — MODE D Video2

The only active strategy. Modes A, B, C are disabled.

### Indicator mapping

| Column | Indicator | Role |
|---|---|---|
| `ma1` | MA6 | Fast — early trend catch |
| `ma3` | MA14 | Slow — trend confirmation |
| `ma2` | MA50 | **Not used in MODE D** |
| `stochastic_k_v2` | Stoch K (5,3,3) | Video2 stochastic |
| `stochastic_d_v2` | Stoch D (5,3,3) | Video2 stochastic signal line |
| `rsi_5` | RSI period 5 | Momentum |

**MA trend = (ma1 - ma3) / ma3 × 10000 bps**
Positive = MA6 above MA14 = uptrend. Negative = downtrend.

### CALL — K Flash Crash Bounce (reversal from oversold)

| Gate | Condition | Meaning |
|---|---|---|
| g1 | ma1 < ma3 | MA6 below MA14 — counter-trend |
| g2 | K_prev - K_curr > 25 | K crashed 25+ pts in one bar |
| g3 | K_curr < 25 | Currently oversold |
| g4 | K_prev >= 50 | Crashed from mid/high, not already oversold |
| g5 | RSI < 20 | RSI deeply oversold (tightened from 40) |
| g6 | maTrendBps > -20 | Not deeply bearish (MA6 not more than 20 bps below MA14) |
| g7 | BB width >= 20 bps | Real volatility at entry bar (tightened from 10 bps) |

### PUT — Late Overbought Reversal

| Gate | Condition | Meaning |
|---|---|---|
| g0 | RSI[-2] > 80 | Bar-2 RSI genuinely overbought — confirms prior peak (new gate) |
| g1 | RSI[-2] > 70, RSI[-1] > 70, exclude [75,80) | Two bars of sustained overbought |
| g2 | RSI falling, in [38,70), exclude [55,65), velocity > -12, close >= BB mid | Controlled RSI descent |
| g3 | K_prev > 65, K falling, K_curr in [55,80) | K exiting overbought zone |
| g4 | D_curr >= 80 | D lagging high — confirms extended state |
| g5 | ma1 > ma3 | MA6 above MA14 — trend was up, now reversing |
| g6 | K-D spread < -3 | Confirmed K/D cross, not whipsaw |
| g7 | maTrendBps < 20 | Not a strong uptrend (MA6 not more than 20 bps above MA14) |
| g8 | BB width >= 20 bps | Real volatility at entry bar (tightened from 10 bps) |

---

## Research Workflow

```
1. po_health                          → confirm bot is live
2. po_asset_bias                      → check which assets/directions have edge
3. po_asset_volatility                → identify flat assets to block
4. po_block_asset [flat assets]       → remove noise from trading
5. po_replay_candles                  → full historical replay with context
6. po_find_edge                       → analyse all 11 dimensions
7. po_simulate [gate changes]         → test improvements before touching bot
8. po_optimize_gates                  → grid search for best thresholds
9. po_recommend                       → get live trade suggestions
10. po_risk_check asset direction     → confirm before placing
11. po_trade asset direction amount   → place trade
```

---

## Sample Questions to Ask Claude

These are plain English prompts you can type directly. Claude will pick the right tools automatically.

### Health & Orientation

- "Is the bot running?"
- "What's the overall market looking like right now?"
- "How many assets are being tracked?"
- "What's today's P/L so far?"

### Trade Decisions

- "What should I trade right now?"
- "Is EURUSD a good trade right now?"
- "Should I go CALL or PUT on GBPUSD?"
- "Is it safe to trade AUDUSD right now?"
- "Give me your top 3 trade recommendations"
- "Which assets have the best win rate today?"

### Performance Review

- "How has the bot performed this week?"
- "Show me all-time win rate and P/L"
- "Which hours of the day are most profitable?"
- "Which assets are making money and which are losing?"
- "Show me the last 20 trades"
- "What's the win rate for CALL vs PUT overall?"

### Asset Investigation

- "Why is SARCNY losing so much?"
- "Which assets should I stop trading?"
- "Which assets have a strong directional bias?"
- "Show me the most volatile assets right now"
- "Which assets are too flat to trade?"

### Blocking & Control

- "Block all flat assets"
- "Stop trading EURTRY"
- "Unblock USDJPY"
- "Which assets are currently blocked?"

### Deep Analysis

- "Run the full historical replay and show me the win rates"
- "What conditions produce the best win rate for PUT trades?"
- "Does a bigger K crash before entry improve win rate?"
- "Does the strategy perform better when RSI peaked above 85 before a PUT?"
- "Which hour of the day has the highest win rate?"
- "What happens to win rate when BB is expanding vs contracting at entry?"
- "How many bars should K stay above 65 before a PUT for the best results?"
- "Show me the win rate breakdown by pattern — reversal vs continuation"

### Gate Testing

- "What happens if we skip flat assets with BB under 5 bps?"
- "Test what happens if we raise the K crash minimum from 25 to 35"
- "What if we tighten the PUT D requirement to 85?"
- "Compare current gates vs requiring RSI below 35 for CALL entries"
- "What gate change would improve PUT win rate the most?"

### Placing Trades

- "Place a PUT on EURUSD for 500"
- "Enter a CALL on GBPJPY with amount 200"
- "Cancel my last order"
- "Show me all orders I've placed manually"

### Agent Audit Trail

- "What did the scanner find in the last session?"
- "Show me all agent decisions from today"
- "Why did the executor skip that trade?"

---

## Important Rules

- **Always call `po_health` first** — confirms bot + DB connectivity
- **`po_simulate` before changing gates** — never modify live bot without testing on historical data first
- **Block flat assets** — BB < 5 bps assets lose consistently; use `po_block_asset`
- **`po_trade` writes to mcp.db only** — bot DB is never modified by MCP
- **Blocked assets are skipped automatically** — both MCP manual orders and bot-generated signals check asset_controls before executing
- **`po_rolling_summary days=0`** — gives all-time stats
- **`summary=true` on `po_candles`** — saves context window
- **BB width gate is live at 20 bps** — bot skips CALL and PUT signals where BB < 20 bps at entry bar (tightened from 10 bps per 2026-04-16 session report). Gate logs `BB XX.Xbps` in signal reasons for verification.
- **Use `po_simulate bar_bb_bps_min=N` to test threshold changes** before touching bot/indicators.js — always validate on data first
