# Pocket Option MCP — User Guide

A complete reference for the 43 MCP tools that connect Claude to your Pocket Option trading bot.

---

## Quick Start

Always begin a session with:

```
po_health
```

This confirms both databases are reachable and the bot is live. If the bot is offline, the session has ended — pivot to analysis mode rather than waiting.

---

## Tool Reference by Category

### 1. Health & Market State

| Tool | What it does |
|---|---|
| `po_health` | Check both DBs + bot liveness. Call first, always. |
| `po_market_state` | Active asset count, signal rate last hour, today P/L, top assets |
| `po_tracked_assets` | Which assets the bot has candle data for |
| `po_prices` | Current price for one or all assets |

---

### 2. Intelligence — Agentic One-Call Tools

| Tool | What it does |
|---|---|
| `po_scan_all` | Score all assets by indicator alignment — price, signal, streak, win rate, ranked |
| `po_recommend` | "What should I trade right now?" — filters by precision score + WR + bias. Ranked with confidence. |
| `po_risk_check asset direction` | Pre-trade audit — checks precision, direction alignment, recent form, consecutive losses. Returns 0-100 score + GOOD/CAUTION/RISKY/AVOID. |
| `po_asset_bias` | Per-asset CALL vs PUT win rate history. Flags flat assets (BLOCK_RECOMMENDED) and preferred direction. |
| `po_asset_volatility` | Ranks all assets by BB width bps. Use to identify flat/pegged assets to block. |

**Typical workflow before trading:**

```
po_recommend
→ pick top asset
→ po_risk_check EURUSD_otc PUT
→ po_trade EURUSD_otc PUT 500
```

---

### 3. Market Data

| Tool | What it does |
|---|---|
| `po_candles asset` | OHLC bars. Use `summary=true` unless you need individual bars. |
| `po_price_history asset` | Tick-level prices over a time window |
| `po_indicators asset` | Latest MA6/14, RSI-5, BB, Stochastic K/D v2, Keltner, Schaff values |
| `po_signals` | CALL/PUT signals from the 8GSR pipeline (STC_CALL_8GSR / STC_PUT_8GSR). Filter by asset or direction. |
| `po_pending_signals` | Signals past expiry not yet validated |

---

### 4. Placing & Managing Trades

| Tool | What it does |
|---|---|
| `po_trade asset direction amount` | Enqueue a manual CALL or PUT. Writes to mcp.db — bot picks it up and clicks Pocket Option. Blocked assets are auto-skipped. |
| `po_cancel_order id` | Cancel a PENDING manual order (mcp.db only) |
| `po_mcp_orders` | View manual orders you placed via po_trade |
| `po_bot_orders` | View bot-generated execution queue (readonly) |

**Requirements:** Bot must be running with execution enabled.

---

### 5. Results & Performance

| Tool | What it does |
|---|---|
| `po_trades_ordered` | Executed live trades with WIN/LOSS results |
| `po_pnl_summary` | P/L breakdown by asset |
| `po_rolling_summary days=N` | Rolling win rate + P/L. Use `days=0` for all-time. |
| `po_performance` | Daily performance table |
| `po_hourly_breakdown` | Trade count and P/L by hour (descriptive only — OTC has no session boundaries) |

---

### 6. Asset Analytics

| Tool | What it does |
|---|---|
| `po_asset_analytics` | What drives wins/losses per asset: STC zone, RSI zone, direction, BB width breakdown |
| `po_asset_streaks` | Current win/loss streak per asset (computed from trades_ordered) |
| `po_streak_leaderboard` | Rank assets by consecutive wins |
| `po_signal_outcomes` | Signal validation history — entry/exit price, WIN/LOSS |
| `po_asset_trades` | Trade outcomes per asset |
| `po_validation_stats` | Aggregate win rate from validation history |

---

### 7. Asset Controls — Blocking

Blocks are temporary and reversible. Only block on current conditions — never on historical win rate alone (OTC conditions change constantly).

| Tool | What it does |
|---|---|
| `po_block_asset asset reason` | Block an asset. Bot skips all orders for it. |
| `po_unblock_asset asset` | Remove an active block |
| `po_auto_block_sweep` | Block all assets with current BB < 5 bps — run once at session start |
| `po_auto_block_check asset` | Check one asset for auto-block conditions (consecutive losses or low BB) |

**Block source reference:**

| source | Written by | Cleared by |
|---|---|---|
| `session` | session-monitor (3 consec losses) | session-monitor restart only |
| `auto` | po_auto_block_sweep | 10-min unblock sweep or expiry |
| `claude` | po_block_asset (you or Claude) | po_unblock_asset or expiry |

**OTC block rule:** Block only on current BB < 5 bps (dead market right now). Never block because of historical win rate — OTC asset conditions change fast. An asset that lost yesterday may have the best setup today.

---

### 7a. Session Monitor — Autonomous Block/Unblock Loop

Run this alongside the bot and MCP server:

```
node src/scripts/session-monitor.js
```

| Timer | Behaviour |
|---|---|
| On startup | Clears all `source='session'` blocks from prior run |
| Every 2 min | Checks for 3 consecutive losses → session block |
| Every 10 min | Re-evaluates non-session blocks — unblocks if conditions recovered |

**Unblock conditions (all must pass):** BB ≥ 10 bps AND indicator < 5 min old AND < 3 consecutive losses today.

---

### 8. Analysis & Backtesting

The core research pipeline. Always validate on historical data before changing any live gates.

#### po_replay_candles — Full Replay

Replays every candle bar-by-bar across all assets using the 8GSR check8GSR() logic. Fires simulated CALL and PUT signals and validates against actual prices at 60s and 120s. Returns win rates, P/L, gate rejection counts.

**Primary expiry: 120s (2m). Use 60s as context only.** A signal that works at 60s but not 120s is a fade — the 2m trade is wrong.

#### po_find_edge — 17-Dimension Analysis

Analyses all replayed 8GSR signals. Returns results at both 60s and 120s expiry with full statistics per bucket (z_score, p_value, wilson_95ci).

| Dimension | What it reveals |
|---|---|
| `by_direction` | CALL vs PUT overall WR and PnL |
| `by_stc_prev` | STC zone at signal bar (CALL: 0-5, 5-10, 10-25; PUT: 75-85, 85-95, 95-100) |
| `by_stc_delta` | Hook size — CALL: 0.0-0.1, 0.1-0.2, 0.2-0.3, 0.3-0.5; PUT mirror |
| `by_g1_barsAgo` | BB touch recency: 1, 2, or 3 bars before signal |
| `by_g2_cross_depth` | K at C-2 (pre-cross bar) — how deep was stoch before crossing |
| `by_g2_cross_kd` | K at C-1 (cross bar) — momentum at the crossing point |
| `by_stoch_levels` | Current K at signal bar vs direction gate |
| `by_g3_depth` | CCI depth: CALL -250 to -150 buckets; PUT 150 to 250 buckets |
| `by_g3_cross_bars_ago` | Recency of CCI cross: 1-3, 4-6, 7-10, 11-24 bars ago |
| `by_cci_current` | CCI value at the signal bar itself |
| `by_coincidence_score` | Gates at max intensity (0-5): does higher score predict better WR? |
| `by_bb_width` | BB bps at signal: flat <2, weak 2-5, marginal 5-10, ok 10-20, good 20+ |
| `by_bars_since_last` | Bars since last same-direction signal on same asset — detects if clustered signals underperform |
| `by_regime` | Market regime at signal time: TRENDING/RANGING/STABLE × EXPANDING/COMPRESSING |
| `by_asset` | Per-asset win rates with CALL/PUT breakdown |
| `best_thresholds` | Auto-selected best bucket per parameter (n≥5) |
| `cross_validation` | 120s signals split at median timestamp → in-sample vs out-of-sample WR |

**Reading statistical fields:**
- `z_score` — How many standard deviations above 50% WR (H0 = coin flip)
- `p_value` — Right-tail probability. p < 0.10 = indicative; p < 0.05 = significant; p < 0.01 = strong
- `wilson_95ci` — [lower, upper] — true WR 95% confidence interval
- Leading cause of wins = highest-WR bucket with p_value < 0.10 and n ≥ 5
- Leading cause of losses = lowest-WR bucket with the most trades (highest loss impact)

#### po_simulate — A/B Test Gate Changes

Compare baseline (current live gates) vs modified thresholds side-by-side before touching the bot.

**Available parameters (8GSR):**

```
# PUT gate tuning
po_simulate put_stc_floor=N              # PUT ceiling threshold (stcPrev ≥ N)
po_simulate put_delta_min=N              # PUT delta gate (how much STC dropped)
po_simulate put_g3_depth_max=N           # PUT CCI depth gate

# CALL gate tuning
po_simulate call_stc_ceiling=N           # CALL floor threshold (stcPrev ≤ N)
po_simulate call_delta_max=N             # CALL delta gate (how much STC rose)
po_simulate call_g3_depth_min=N          # CALL CCI depth gate

# BB gate
po_simulate min_bb_bps=N                 # minimum BB width at signal bar

# Parameters can be combined
po_simulate put_stc_floor=N put_delta_min=N put_g3_depth_max=N
```

#### po_grid_search — Multivariate Threshold Search

Tests all combinations of 8GSR gate thresholds simultaneously. Filters to minimum sample size. Ranked by 120s WR with full statistics.

```
po_grid_search direction=put
po_grid_search direction=call
po_grid_search direction=both
```

Use this after `po_find_edge` identifies promising univariate improvements. The grid search confirms which combination actually maximises 120s WR.

#### po_walk_forward — Rolling Time-Fold Validation

Splits 120s validated signals into N equal time-ordered folds (default 5) and computes WR per fold. Returns `STABLE / MODERATE / UNSTABLE` verdict based on WR spread across folds.

```
po_walk_forward                    # 5 folds, both directions
po_walk_forward direction=put folds=7
```

Use after accumulating 50+ signals. Spread ≤ 15% = STABLE. Any fold below breakeven = UNSTABLE — the edge may not be consistent across time.

#### po_score_calibration — Coincidence Score → Sizing Multiplier

Maps coincidence score (0-5) to actual 120s WR and a Kelly-derived sizing multiplier. Returns `calibration_verdict`: `SCORE IS PREDICTIVE` or `SCORE NOT YET DIFFERENTIATED`.

```
po_score_calibration
```

If predictive, use `recommended_multiplier` to scale trade amount in `/auto-trade`: amount = base × multiplier.

#### po_loss_attribution — Gate Leak Finder

For every 120s LOSS, computes each gate's margin-from-threshold at signal time. Ranks gates by how often they were the weakest link and compares average margin on losses vs wins.

```
po_loss_attribution
```

`margin_gap > 0` on a gate means wins had more breathing room than losses — tightening that gate would filter more losses than wins. Output includes a direct `po_simulate` recommendation for the leakiest gate.

#### po_gate_interaction — 2D WR Heatmap

Cross any two `po_find_edge` dimensions to find combinations that univariate analysis cannot reveal. Returns an N×M grid with trades + WR + z_score per cell, plus `best_combination` and `worst_combination`.

```
po_gate_interaction dim_a=stc_prev dim_b=g3_depth direction=put
po_gate_interaction dim_a=regime dim_b=coincidence_score
po_gate_interaction dim_a=bars_since_last_signal dim_b=bb_width
```

Available dimensions: `stc_prev`, `stc_delta`, `g1_bars_ago`, `g3_depth`, `g3_cross_bars_ago`, `bb_width`, `coincidence_score`, `regime`, `bars_since_last_signal`.

Focus on cells with trades ≥ 5. Use `best_combination` to identify which pairing to test with `po_simulate`.

#### po_optimize_gates — Legacy Grid Search

Older grid search over single-parameter thresholds. Use `po_grid_search` for multivariate optimization.

#### po_replay_signal signal_id=N

Reconstructs all 8GSR gate values at the exact moment a historical signal fired. Shows which gates passed/failed and the actual trade outcome.

#### po_significance

Binomial significance test per slice (direction, asset, STC zone). Returns p-values, z-scores, Wilson CI, Kelly fraction.

---

### 9. Multi-Agent Autonomous Trading

The `/auto-trade` skill spawns 3 agents in sequence: Scanner → Analyst → Executor. Use these tools to support the pipeline.

| Tool | Used by | What it does |
|---|---|---|
| `po_signal_context asset` | Analyst | Full 4-bar snapshot (indicators + candles + recent signals) in one call |
| `po_drawdown_check` | Executor | GO/PAUSE/STOP verdict: today P/L, consecutive losses, bot liveness |
| `po_session_log_write` | All agents | Write a decision to the audit trail |
| `po_session_log_read` | Human review | Full history of scanner scans, analyst verdicts, executor actions |

**Bot offline = session ended.** If `po_health` shows bot not live, do not wait — switch immediately to `/session-review` ANALYSIS MODE.

---

## Strategy Reference — 8GSR (8-Gate STC Reversal)

The only active strategy. 4 gates must all pass (AND logic). Any gate failure kills the signal immediately.

### Indicator Mapping

| Column | Indicator | Role |
|---|---|---|
| `schaff_value` | STC (12,25,5,3,3) | Primary signal — 0-100 scale |
| `stochastic_k_v2` | Stoch K (5,3,3) | Gate G2 — cross detection |
| `stochastic_d_v2` | Stoch D (5,3,3) | Gate G2 — cross confirmation |
| `ma1` | MA6 | Fast trend (used in BB expansion / ma_gap_trend) |
| `ma3` | MA14 | Slow trend |
| `ma2` | MA50 | **NOT used in gate logic** |
| `rsi_5` | RSI period 5 | Gate context |
| `bb_upper/lower` | BB (20,2) | Gate G1 — touch detection |
| `bb_width_bps` | BB width | Gate G5 — volatility filter |

### STC Zone Reference

| Value | Zone | Meaning |
|---|---|---|
| ≤ 25 | Floor | CALL reversal zone — cycle exhausted to downside |
| ≥ 85 | Ceiling (live gate) | PUT reversal zone |
| ≥ 90 | Deep ceiling | Strongest PUT zone (higher confidence) |
| Rising (bar0 > barM1) | Turning bullish | STC curling upward |
| Falling (bar0 < barM1) | Turning bearish | STC rolling downward |

### CALL — STC Floor Bounce

| Gate | Check | Meaning |
|---|---|---|
| G4 | `barM1.schaff_value ≤ 25` AND `delta ≥ 0` AND `delta < 0.5` | STC at floor, small upward hook |
| G1 | `low ≤ bb_lower` within last 3 bars | BB lower touch recently |
| G2 | K crossed above D at barM1 (C-1), from deep zone (K < 30 at barM2) | Stoch bullish cross from oversold |
| G3 | CCI(8) crossed above −100 recently AND current CCI < −150 | CCI deep oversold bounce |
| G5 | `bb_width_bps ≥ 10` | Not a flat/dead market |
| G6 | `bb_expanding ≠ false` | Volatility releasing (null passes — insufficient history) |
| G7 | `ma_gap_trend ≠ narrowing` | Trend momentum intact |

### PUT — STC Ceiling Rollover

| Gate | Check | Meaning |
|---|---|---|
| G4 | `barM1.schaff_value ≥ 85` AND `delta ≥ −0.9` AND `delta ≤ 0` | STC at ceiling, rolling down |
| G1 | `high ≥ bb_upper` within last 3 bars | BB upper touch recently |
| G2 | K crossed below D at barM1 (C-1), from overbought zone (K > 70 at barM2) | Stoch bearish cross from overbought |
| G3 | CCI(8) crossed below +100 recently AND current CCI > +175 | CCI deep overbought rollover |
| G5 | `bb_width_bps ≥ 10` | Not a flat/dead market |
| G6 | `ma_gap_trend ≠ narrowing` | Trend momentum intact |

---

## OTC Market Rules

These rules apply to all analysis and recommendations in this system:

**Rule 1 — No static or WR-based asset blocks.**  
Only block assets where current BB < 5 bps (dead right now). Never block because of historical win rate. OTC conditions change constantly. A "loser" yesterday may have the best setup today.

**Rule 2 — No time-based trading filters.**  
OTC markets run 24/7 with no session boundaries. Never recommend avoiding certain hours of the day. `po_hourly_breakdown` data is descriptive context only — never an actionable gate.

---

## Research Workflow

```
1. po_health                          → confirm bot is live (if offline → session-review ANALYSIS MODE)
2. po_asset_volatility                → identify flat assets (BB < 5 bps)
3. po_auto_block_sweep                → block all BB < 5 bps assets
4. po_asset_bias                      → check directional edge per asset
5. po_replay_candles                  → full historical replay (60s + 120s)
6. po_find_edge                       → analyse all 17 8GSR dimensions
7. po_loss_attribution                → identify the leaky gate on losses
8. po_gate_interaction dim_a=X dim_b=Y → find the best 2D combination
9. po_simulate [gate changes]         → A/B test before touching bot/indicators.js
10. po_grid_search direction=put      → multivariate search for best combination
10a. po_walk_forward                  → confirm edge is stable across time folds
10b. po_score_calibration             → check if coincidence score predicts WR
9. po_recommend                       → live trade suggestions
10. po_risk_check asset direction     → confirm before placing
11. po_trade asset direction amount   → place trade
```

---

## Session Skills

Use these in Claude Code with `/skill-name`:

| Skill | When to use |
|---|---|
| `/auto-trade` | "watch the market", "scan and trade", "run the system" |
| `/session-review` | "how did we do", "review today", "what happened" |
| `/edge-report` | "find the edge", "research session", "analyse the strategy" |
| `/edge-optimize` | "optimize gates", "improve thresholds", "tune parameters" |
| `/block-flat-assets` | "clean up assets", "block flat markets", "housekeeping" |

**Session review modes:**
- **Bot offline** → ANALYSIS MODE: po_find_edge replay → leading cause of wins/losses → expiry divergence check → cross-validation
- **Bot live** → STANDARD MODE: today's trades → signals → streaks → bias

---

## Sample Questions to Ask Claude

### Health & Orientation

- "Is the bot running?"
- "What's the overall market looking like right now?"
- "What's today's P/L so far?"

### Trade Decisions

- "What should I trade right now?"
- "Is EURUSD a good trade right now?"
- "Should I go PUT on GBPUSD?"
- "Give me your top 3 trade recommendations"

### Performance Review

- "How has the bot performed this week?"
- "Show me all-time win rate and P/L"
- "Which assets are making money and which are losing?"
- "Show me the last 20 trades"
- "What's the win rate for CALL vs PUT overall?"

### Asset Investigation

- "Which assets should I stop trading?"
- "Show me the most volatile assets right now"
- "Which assets are too flat to trade?"
- "What's driving losses on SARCNY?"

### Blocking & Control

- "Block all flat assets"
- "Stop trading EURTRY"
- "Unblock USDJPY"
- "Which assets are currently blocked?"

### Deep Analysis

- "Run the full historical replay and show me the win rates"
- "What conditions produce the best win rate for PUT trades?"
- "What STC delta range produces the best 120s PUT win rate?"
- "How deep does CCI need to be for a reliable PUT signal?"
- "How does win rate change based on how recently the BB was touched?"
- "Run a grid search to find the best PUT gate combination"
- "Is there a cross-validation gap between early and recent trades?"
- "Is the edge consistent across time or concentrated in one period?"
- "Which gate is letting the most losing trades through?"
- "Does the coincidence score actually predict win rate?"
- "Show me the WR heatmap for STC zone vs CCI depth"
- "Which market regime does the strategy perform best in?"
- "Do signals that follow quickly after another signal underperform?"

### Gate Testing

- "What happens if we raise the PUT CCI depth to 200?"
- "Test what happens if we tighten the PUT STC floor to 90"
- "What if we allow a larger STC delta for PUT (up to -1.0)?"
- "Compare current gates vs requiring BB touch within 2 bars"
- "What gate change would improve PUT 120s win rate the most?"

### Placing Trades

- "Place a PUT on EURUSD for 500"
- "Cancel my last order"
- "Show me all orders I've placed manually"

### Agent Audit Trail

- "What did the scanner find in the last session?"
- "Show me all agent decisions from today"
- "Why did the executor skip that trade?"

---

## Important Rules

- **Always call `po_health` first** — if bot is offline, the session has ended; pivot to analysis
- **`po_simulate` before changing gates** — never modify `bot/indicators.js` without validating on historical data
- **Primary expiry is 2m (120s)** — 1m (60s) is context only; a 60s win that fades at 120s is not an edge
- **Block only on current BB < 5 bps** — never on historical win rate alone
- **No hour-of-day filters** — OTC is 24/7 synthetic; session times don't apply
- **`po_trade` writes to mcp.db only** — bot DB is never modified by MCP
- **Use `po_grid_search`** for multivariate optimization; use `po_simulate` for A/B testing single parameters
- **Statistical threshold for acting on findings**: p_value < 0.10 and n ≥ 5; always cite both when recommending changes
