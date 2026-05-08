# Pocket Option MCP — Session Memory

**Last Updated**: 2026-05-08  
**Strategy**: 8-Gate STC Reversal (8GSR) — 4-gate live deployment  
**Market**: OTC binary options (24/7 synthetic quotes)

---

## Project Overview

MCP server connecting Claude to a running `pocket-option-bot.js` via SQLite. Claude reads the bot DB (readonly), writes orders/blocks/logs to a separate MCP DB, and the bot reads that before execution.

```
Claude (MCP client)
    ↓
pocket-option-mcp (MCP stdio server — src/server.js)
    ↓
    ├── SQLite READONLY  → data/trading_data.db  ← Bot writes candles/signals/trades
    └── SQLite WRITABLE  → data/mcp.db           ← MCP writes orders/blocks/agent logs
                                                         ↑ Bot reads before executing
```

---

## Critical Rules

- **NEVER write to `socket_option/determ/`** — read-only source. All bot modifications go in `pocket-option-mcp/bot/`
- **No Python** — corrupts SQLite when conflicting with the JS process. Use sqlite3 CLI only
- **Always validate with `po_simulate` before changing live gates**
- **MA50 is NOT used** — only MA6 (`ma1`) and MA14 (`ma3`) in gate logic
- **Use stochastic_k_v2 / stochastic_d_v2** — NOT stochastic_k / stochastic_d (deprecated)

---

## File Layout

```
pocket-option-mcp/
├── bot/
│   ├── pocket-option-bot.js     ← Main bot + MCP order worker + isAssetBlocked() guard
│   ├── indicators.js            ← 8GSR live gate logic (check8GSR)
│   └── database.js
├── data/
│   ├── trading_data.db          ← Bot writes (READONLY to MCP)
│   └── mcp.db                   ← MCP writes (orders, blocks, agent logs)
├── src/
│   ├── server.js                ← 43 tools registered
│   ├── core/
│   │   ├── analysis.js          ← Replay engine, find_edge, simulate, grid_search
│   │   ├── intelligence.js      ← scan_all, recommend, risk_check, asset_bias
│   │   └── agent-tools.js       ← signal_context, drawdown_check, session_log, blocks
├── agents/
│   ├── market-scanner.md        ← Scanner agent spec (8GSR indicator alignment proxy)
│   ├── trade-analyst.md         ← Analyst agent spec (full 4-gate 8GSR verification)
│   └── trade-executor.md        ← Executor agent spec (po_trade + safety checks)
├── skills/
│   ├── auto-trade/SKILL.md      ← Orchestrator: Scanner→Analyst→Executor loop
│   ├── session-review/SKILL.md  ← Bot offline=session ended→analysis mode
│   ├── edge-report/SKILL.md     ← Full research session (15 8GSR dimensions)
│   ├── edge-optimize/SKILL.md   ← Univariate→grid search→cross-validation
│   └── block-flat-assets/SKILL.md ← Volatility-based cleanup (BB < 5 bps only)
└── docs/
    ├── 8GSR_TASK.md             ← Strategy spec and statistical requirements
    └── edge_report_*.md         ← Generated research reports
```

---

## Strategy: 8GSR (8-Gate STC Reversal)

The live strategy is named 8GSR. Despite the name, exactly **4 gates** are active and checked in sequence. Any gate failure immediately kills the signal.

### CALL — STC Floor Bounce (validated p=0.0005, n=25, WR=84.0% at 120s)

| Gate | Check | Meaning |
|---|---|---|
| G4 | `barM1.schaff_value ≤ 25` AND `(bar0.schaff - barM1.schaff) ≥ 0` AND `< 0.5` | STC at floor, curling up (small hook, not blowout) |
| G1 | `low ≤ bb_lower` within last 3 bars | BB lower touch recently |
| G2 | K crossed above D exactly 1 bar ago (`barM2` pre-cross, `barM1` cross bar) from deep zone (K < 30 at barM2) | Stoch bullish cross from oversold |
| G3 | CCI(8) crossed above −100 within 3 bars AND current CCI depth < −150 | CCI deep oversold bounce |

Additional live conditions: BB width ≥ 10 bps (g5), bb_expanding ≠ false (g6), ma_gap_trend ≠ narrowing (g7).

### PUT — STC Ceiling Rollover (validated p=0.029, n=14, WR=78.6% at 120s)

| Gate | Check | Meaning |
|---|---|---|
| G4 | `barM1.schaff_value ≥ 85` AND delta `≥ −0.9` AND `≤ 0` | STC at ceiling (deep), rolling down (not already crashed) |
| G1 | `high ≥ bb_upper` within last 3 bars | BB upper touch recently |
| G2 | K crossed below D exactly 1 bar ago from overbought zone (K > 70 at barM2) | Stoch bearish cross from overbought |
| G3 | CCI(8) crossed below +100 within 3 bars AND current CCI depth > +175 | CCI deep overbought rollover |

Additional live condition: BB width ≥ 10 bps (g5), ma_gap_trend ≠ narrowing (g6).

### STC Zone Interpretation

- `schaff_value ≤ 25` = floor (CALL reversal zone)
- `schaff_value ≥ 90` = deep ceiling (strongest PUT zone)
- `schaff_value ≥ 85` = ceiling (live PUT gate — slightly looser)
- Rising STC (bar0 > barM1) = cycle turning bullish
- Falling STC (bar0 < barM1) = cycle turning bearish

---

## Performance Results

### Simulation Results (po_simulate)

| Configuration | Direction | WR | n | PnL | Notes |
|---|---|---|---|---|---|
| Baseline (stc≥90, delta≥-0.5, depth>150) | PUT | 43.0% | 14 | negative | Too tight — gentle rollovers that fade by 120s |
| **ceiling=85, delta≥-0.9, depth>175** | **PUT** | **64.0%** | **25** | positive | **Current live gates — confirmed both 60s and 120s** |
| Any CALL configuration tested | CALL | ~38.9% | varies | negative | No confirmed edge at 120s expiry |

### Live Trade Baseline (Contaminated)

- **Total live trades**: ~40
- **Win rate**: 37.5%
- **Status**: CONTAMINATED — mixed with old strategy trades + 30s refresh bug (corrupts G2/G3 ~50% of bar closes)
- **Verdict**: Do not use as performance baseline. Wait for 30+ clean trades post-restart.

### 30s Refresh Bug (Critical)

The bot's 30s periodic `calculateAll()` call resets `_stochHistory` and `_cciHistory` mid-bar, breaking G2/G3 on roughly 50% of closes. This caused most live losses. The bug must be fixed before restarting.

---

## Analysis Engine (src/core/analysis.js)

### Three-Table Replay Engine

The replay engine is fully independent of the signals/trades_ordered tables. It reads:
- `candles` — OHLC bar data
- `indicators` — Pre-calculated gate values (schaff, BB, stoch, CCI, etc.)
- `prices` — Tick-level quotes used to validate 60s and 120s outcomes

`check8GSR()` is the batch replay equivalent of the live `check8GSR()` in `bot/indicators.js`. It fires all 4 gates bar-by-bar and records WIN/LOSS at both expiry targets.

### Statistical Functions Added

**normCDF()** — Abramowitz & Stegun approximation for z→p conversion (added at module level)

**bStats()** — Now returns full statistics for every bucket in po_find_edge:
- `trades`, `wins`, `losses`, `win_rate`
- `net_pnl`, `profit_factor`, `avg_win`, `avg_loss`, `avg_wl_ratio`
- `z_score` — One-proportion z-test vs H0: WR=50%
- `p_value` — Right-tail p-value from normCDF(z)
- `wilson_95ci` — Wilson confidence interval [lower, upper]

**Cross-validation** — Added to findEdge() return: splits 120s signals at median timestamp → in-sample vs out-of-sample WR comparison. Gap > 10% = edge degradation flag.

### Grid Search (po_grid_search)

New tool added. Tests up to 600 CALL + 720 PUT parameter combinations:
- CALL: stc_prev ceiling (5 values) × stc_delta max (6 values) × g3_depth min (5 values) × g1_bars_ago (4 values)
- PUT: stc_prev floor (6 values) × stc_delta min (6 values) × g3_depth max (5 values) × g1_bars_ago (4 values)

Filters to n≥20 only. Ranked by 120s WR with full bStats. Use `/edge-optimize` to run this as part of a structured optimization workflow.

### po_find_edge Dimensions (8GSR)

15 dimensions analyzed at both 60s and 120s expiry:
- `by_direction` — CALL vs PUT overall
- `by_stc_prev` — STC zone depth at signal bar
- `by_stc_delta` — Hook size (how much STC moved)
- `by_g1_barsAgo` — BB touch recency (1, 2, or 3 bars)
- `by_g2_cross_depth` — K at barM2 (pre-cross depth)
- `by_g2_cross_kd` — K at barM1 (cross bar momentum)
- `by_stoch_levels` — Current K at signal bar
- `by_g3_depth` — CCI depth at signal
- `by_g3_cross_bars_ago` — Recency of CCI cross
- `by_cci_current` — CCI value at signal bar
- `by_coincidence_score` — Gates at max intensity (0-5)
- `by_bb_width` — BB bps tier at signal
- `by_asset` — Per-asset CALL/PUT breakdown
- `best_thresholds` — Auto-selected best bucket per parameter (n≥5)
- `cross_validation` — In-sample vs out-of-sample 120s WR

---

## Agent System

### Orchestrator (auto-trade skill)

`Scanner → Analyst (per candidate) → Executor (if TRADE)`

- Pre-flight: po_health + po_drawdown_check + po_asset_bias + po_asset_volatility + po_auto_block_sweep
- **If bot offline**: pivot immediately to /session-review ANALYSIS MODE (not hard stop)
- direction_filter default: `put` (CALL has no confirmed edge at 120s)
- min_bb_bps gate: 10 bps

### Scanner Agent (agents/market-scanner.md)

Scores all assets by indicator alignment. Returns ranked candidates. **Note**: Scanner uses indicator alignment as proxy — it does NOT verify actual 8GSR gates. Analyst does the real gate check.

### Analyst Agent (agents/trade-analyst.md)

Full 4-gate 8GSR verification using po_signal_context (4-bar snapshot):
- G4: STC hook check (zone + delta)
- G1: BB touch recency
- G2: Stoch cross from deep zone
- G3: CCI depth bounce

Returns TRADE / SKIP / WAIT with gate_details JSON. Decision matrix: 4/4 = TRADE; 3/4 = WAIT; G4 fail = immediate SKIP. BB width ≥ 10 bps required (enforced here and at Orchestrator).

### Executor Agent (agents/trade-executor.md)

Places trade via po_trade if all safety checks pass. Logs result to session audit trail.

---

## Skills System

| Skill | When to use | Key rule |
|---|---|---|
| `/auto-trade` | "watch the market", "scan and trade" | Offline → pivot to analysis |
| `/session-review` | "how did we do", "review today" | Offline → ANALYSIS MODE (po_find_edge, leading causes) |
| `/edge-report` | "find the edge", "research session" | Full 15-dimension report + simulate |
| `/edge-optimize` | "optimize gates", "improve thresholds" | Univariate → grid search → cross-validation |
| `/block-flat-assets` | "clean up assets", "housekeeping" | Block BB < 5 bps ONLY — no WR-based blocks |

### Session Review — Two Modes

**ANALYSIS MODE (bot offline = session ended)**:
1. `po_rolling_summary(days=1)` + `po_pnl_summary` + `po_trades_ordered`
2. `po_find_edge` — full candle replay
3. Extract leading cause of wins (highest-WR bucket, p_value < 0.10, n≥5)
4. Extract leading cause of losses (lowest-WR bucket, most trades, worst PnL)
5. Expiry divergence check: |WR_60s - WR_120s| > 15% = flag
6. Cross-validation gap > 10% = edge degradation flag

**STANDARD MODE (bot live)**: po_rolling_summary → po_signals → po_asset_streaks → po_asset_bias → po_asset_volatility

---

## OTC Market Rules (Hard Rules)

**Rule 1 — No static or WR-based asset blocks.**  
Only block assets where current BB < 5 bps (dead right now). Never block because of historical win rate. OTC conditions change constantly. "Loser yesterday, best setup today."

**Rule 2 — No time-based trading filters.**  
OTC markets run 24/7 with no session boundaries. No "avoid hours X–Y". `by_hour` data = descriptive only, never actionable. Remove all hour-of-day recommendations from all skills.

---

## Data Schema (Lean Current Schema)

The following tables exist in `trading_data.db`:

| Table | Purpose |
|---|---|
| `candles` | OHLC bars per asset |
| `indicators` | Calculated gate values (schaff, BB, stoch, CCI, MA, RSI) |
| `prices` | Tick-level quotes for 60s/120s outcome validation |
| `signals` | Signals fired by live bot (pattern = STC_CALL_8GSR / STC_PUT_8GSR) |
| `trades_ordered` | Executed trade results (WIN/LOSS + P/L) |

**Removed tables** (no longer exist): `qualified_assets`, `asset_streaks`, `performance`.  
For asset analytics: use `po_asset_analytics` or JOIN `trades_ordered + indicators`.

**Key indicator columns**:
- `schaff_value` — STC(12,25,5,3,3), stored per bar
- `stochastic_k_v2`, `stochastic_d_v2` — Stochastic (5,3,3) v2 (use these, not v1)
- `ma1` = MA6 (fast), `ma3` = MA14 (slow) — MA50 (`ma2`) NOT used in gates
- `bb_upper`, `bb_middle`, `bb_lower`, `bb_width_bps` — Bollinger Bands (20,2)

---

## BB Width Evidence

| BB Range | WR | PnL | Verdict |
|---|---|---|---|
| < 5 bps | ~38% | Heavy negative | Block immediately |
| 5–10 bps | 45.8% | −$3,580 (135 signals) | Below breakeven |
| 10–20 bps | Profitable | Positive | Keep |
| 20+ bps | Best | Best | Preferred |

**Breakeven threshold**: 52.2% WR (Pocket Option payout structure).

---

## MCP Tools Quick Reference

### Health & Market
- `po_health` — Check both DBs + bot liveness (call first always)
- `po_market_state` — Active assets, signal rate, today P/L
- `po_prices` — Current price for one or all assets

### Intelligence
- `po_scan_all` — Score all assets (indicator alignment proxy)
- `po_recommend` — Ranked picks (precision + WR + bias)
- `po_risk_check` — Pre-trade audit (0–100 score + verdict)
- `po_asset_bias` — Per-asset CALL vs PUT history
- `po_asset_volatility` — Rank by BB width (find flat assets)

### Analysis & Backtesting
- `po_replay_candles` — Full historical replay (60s AND 120s validation)
- `po_find_edge` — 15-dimension WR breakdown with z_score/p_value/wilson_95ci
- `po_simulate` — A/B test baseline vs modified thresholds
- `po_grid_search` — Multivariate search (600 CALL + 720 PUT combinations)
- `po_optimize_gates` — Legacy grid search (superseded by po_grid_search)
- `po_significance` — Binomial test + Wilson CI per slice

### Asset Controls
- `po_block_asset` — Block asset (bot skips all orders)
- `po_unblock_asset` — Remove block
- `po_auto_block_sweep` — Auto-block all BB < 5 bps assets at session start
- `po_auto_block_check` — Check one asset for auto-block conditions

### Trading
- `po_trade` — Enqueue manual CALL/PUT → mcp.db → bot executes
- `po_cancel_order` — Cancel PENDING order
- `po_drawdown_check` — GO/PAUSE/STOP verdict (call before placing)

### Performance
- `po_trades_ordered` — Executed trades with WIN/LOSS
- `po_pnl_summary` — P/L by asset
- `po_rolling_summary` — Rolling WR + P/L (days=0 = all-time)

### Multi-Agent
- `po_signal_context` — 4-bar snapshot for Analyst agent
- `po_session_log_write/read` — Agent decision audit trail

---

## Current Status (as of 2026-05-08)

### Bot Status
- **Offline** — Has been down ~46 hours
- **Cause**: Unknown (may be 30s refresh bug cascading)
- **Action needed**: Fix 30s bug, then restart

### Live Performance Baseline
- 40 live trades, 37.5% WR — **DO NOT use as baseline** (contaminated)
- Contamination: mixed old strategy + 30s refresh bug breaking G2/G3
- Need: 30+ clean trades after restart to establish valid baseline

### Gate Configuration (Current Live)
- **CALL**: stcPrev ≤ 25 / delta < 0.5 / g3_depth < −150 / bb_width ≥ 10
- **PUT**: stcPrev ≥ 85 / delta ≥ −0.9 / g3_depth > +175 / bb_width ≥ 10
- Both directions active

### Validated by Simulation
- PUT gates (ceiling=85, delta≥-0.9, depth>175): **64% WR, n=25** — confirmed at both 60s and 120s
- CALL: all configurations tested below 50% at 120s — disabled

---

## Next Actions

### Immediate (before restarting bot)
1. Fix 30s refresh bug in `bot/indicators.js` (corrupts `_stochHistory`/`_cciHistory`)
2. Confirm fix: `calculateAll()` must NOT run on 30s tick — only on bar close
3. Restart bot

### After restart
1. Trade both CALL and PUT (`direction_filter: both`)
2. Accumulate 30+ clean trades for valid baseline
3. Run `/session-review` daily to track leading causes
4. Run `/edge-optimize` after 50+ trades to tune gate thresholds

### Research
- `po_grid_search` not yet executed — run to identify best multivariate combination
- Add K > 30 minimum current-K gate to CALL G2 (identified but not applied)
- If CALL WR improves with more data: re-enable and validate

---

## Key Learnings

- **PUT >> CALL in OTC**: Historically and in simulation, PUT produces reliable edge at 120s; CALL does not
- **STC ceiling ≥ 85 (not ≥ 90)**: Slightly lower threshold captures more valid rollovers without sacrificing WR
- **Delta ≥ -0.9 (not ≥ -0.5)**: Tight delta only captures gentle rollovers that fade between 60s and 120s. Allowing larger deltas improves 120s WR
- **CCI depth > 175 (not > 150)**: Tighter depth for PUT eliminates shallow bounces
- **Expiry hierarchy**: 2m (120s) = primary; 1m (60s) = context only. A signal that works at 60s but not 120s is a fade, not an edge
- **OTC has no sessions**: Hour-of-day data shows variation but is not reproducible — never filter by hour
- **Static blocks harm performance**: OTC assets shift regimes. Yesterday's loser may be today's best setup. Block only on current BB width

---

**Memory Version**: 2.0  
**Last Session**: 2026-05-08  
**Strategy State**: 8GSR live (CALL + PUT both active)  
**Next Milestone**: Fix 30s bug → restart bot → 30+ clean PUT trades → /edge-optimize
