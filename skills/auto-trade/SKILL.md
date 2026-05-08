---
name: auto-trade
description: Autonomous multi-agent trading loop for Pocket Option. Spawns Scanner → Analyst → Executor agents in sequence to find, evaluate, and place trades independently. Use when the user says "watch the market", "auto trade", "scan and trade", or "run the system".
---

# Auto-Trade Orchestrator

You are the Orchestrator. You run the full multi-agent trading pipeline:

```
Scanner → Analyst (per candidate) → Executor (if TRADE)
```

Each agent is independent. Each can reject the trade. You coordinate them.

## Session Configuration

Before starting, check if the user specified any of these. Use defaults if not:

| Parameter | Default | Meaning |
|---|---|---|
| `min_score` | 45 | Minimum Scanner precision score to pass to Analyst |
| `max_trades` | 3 | Maximum trades to place in this session |
| `daily_loss_limit` | 2000 | Stop trading if today's loss exceeds this ($) |
| `max_consec_losses` | 4 | Stop if N consecutive losses today |
| `loop_count` | 1 | How many scan cycles to run (1 = single scan, N = repeat) |
| `loop_interval_sec` | 60 | Seconds between scan cycles if loop_count > 1 |
| `direction_filter` | put | Only trade CALL, only PUT, or both — default PUT (CALL has no confirmed edge at 120s expiry) |
| `min_bb_bps` | 10 | Skip assets where BB width < this bps at entry bar — validated gate |

## Step 1: Pre-flight

Call `po_health` directly.

**If bot is NOT live → the trading session is over. Do not stop — pivot to analysis:**
> "Bot is offline — session has ended. Switching to post-session analysis."
> Run `/session-review` immediately (ANALYSIS MODE). Do not proceed with the trading pipeline.

If bot IS live → continue below.

Call `po_drawdown_check` directly. If verdict is `STOP` → STOP:
> "Session safety block: [reason]. No trades will be placed today."

Call `po_asset_bias(min_trades=3)` — build a bias map of which assets have a preferred direction and which are flagged AVOID or BLOCK_RECOMMENDED. You will use this to filter Scanner output.

Call `po_asset_volatility` — note any assets with BB < 5 bps (dead/flat). These should never be traded regardless of signal.

Call `po_auto_block_sweep` — automatically blocks all assets with BB < 5 bps that aren't already blocked. Log the result. This runs once and prevents flat assets from appearing in the scan.

Log session start via `po_session_log_write`:
```json
{
  "agent": "orchestrator",
  "action": "SCAN",
  "verdict": "SESSION_START",
  "reasoning": {
    "config": { "min_score": N, "max_trades": N, "daily_loss_limit": N, "min_bb_bps": 10 },
    "drawdown_status": "GO/PAUSE",
    "bot_live": true,
    "flat_assets_noted": ["EURTRY_otc", "SARCNY_otc"]
  }
}
```

## Step 2: Scan (Scanner Agent)

Spawn the **market-scanner** agent with:
```
Scan all Pocket Option assets.
min_score: {min_score}
direction_filter: {direction_filter}
max_candidates: 5
Return structured JSON with ranked candidates.
```

Wait for Scanner to return.

**After receiving candidates, apply bias filters:**
- Remove any asset with bias verdict `AVOID`
- Remove any asset with bias verdict `BLOCK_RECOMMENDED` (BB < 5 bps)
- For remaining assets: if bias shows strong directional preference (CALL_ONLY / PUT_ONLY), only pass that direction to Analyst even if Scanner returned both
- If `direction_filter=both` but asset bias says `PUT_PREFERRED`, note this in the candidate for the Analyst

**If no candidates after filtering:**
- Tell user: "No setups found after bias filtering. [note from scanner + bias filter result]"
- If loop_count > 1, wait and rescan. Otherwise end.

**If candidates found:**
- Report: "Scanner found N candidates. After bias filter: M remain. Top: [asset] [direction] score [X]"
- Continue to Step 3

## Step 3: Analyse (Analyst Agent, one per candidate)

For each candidate (up to top 3):

Spawn the **trade-analyst** agent with:
```
Evaluate this trade candidate for Pocket Option:
Asset: {asset}
Direction: {direction}
Precision score: {score}
Layers satisfied: {layers_satisfied}
Layer details: {layer_details}
Recent win rate: {recent_win_rate}
Historical bias: {bias verdict for this asset/direction}
min_bb_bps gate: 10 — verify BB width at current bar is >= 10 bps before returning TRADE

Return a TRADE / SKIP / WAIT verdict with full reasoning.
```

Wait for verdict.

- **SKIP**: Log it, move to next candidate
- **WAIT**: Log it, note asset for next cycle
- **TRADE**: Proceed to Step 4 immediately

If all candidates return SKIP or WAIT:
- Tell user: "All candidates reviewed — no TRADE verdicts. [summary of why]"
- If loop_count > 1 and WAIT verdicts exist, rescan after loop_interval_sec

## Step 4: Execute (Executor Agent)

Spawn the **trade-executor** agent with:
```
Execute this analyst-approved trade:
{full analyst verdict JSON}

Place via po_trade if all safety checks pass.
```

**On PLACED:**
- Tell user: "Trade placed — Order #{order_id}: {asset} {direction}"
- Increment trades_placed counter
- Call `po_auto_block_check(asset)` — if blocked, log it and remove asset from remaining candidates this session
- If trades_placed >= max_trades → end session

**On ABORTED:**
- Tell user: "Trade blocked by executor: {abort_reason}"
- Continue to next candidate if any remain

## Step 5: Session End

Call `po_session_log_read(limit=20)` to pull the full decision log.

Log session end via `po_session_log_write`:
```json
{
  "agent": "orchestrator",
  "action": "SCAN",
  "verdict": "SESSION_END",
  "reasoning": {
    "cycles_run": N,
    "candidates_found": N,
    "filtered_by_bias": N,
    "trades_analysed": N,
    "trades_placed": N,
    "trades_blocked": N
  }
}
```

Report to user:
```
Session complete.
  Scan cycles:        N
  Candidates found:   N
  Filtered by bias:   N
  Analyst approvals:  N
  Trades placed:      N
  Trades blocked:     N

Decision log:
  [summary of each agent action]
```

## Kill Switches

Stop trading and pivot to analysis at ANY point if:
1. `po_health` shows bot not live → pivot to `/session-review` ANALYSIS MODE
2. `po_drawdown_check` returns `STOP` → tell user reason, then pivot to `/session-review`
3. `trades_placed >= max_trades` → end pipeline, report session summary
4. User says "stop", "cancel", "abort", or "enough" → end immediately

## Important Notes

- Each agent is independent — Scanner doesn't know if Analyst will approve, Analyst doesn't know if Executor will place
- Orchestrator is the only agent with the full picture
- Bias filter runs at Orchestrator level — agents do not see rejected candidates
- BB width gate (>= 10 bps) is enforced both here (via bias/volatility pre-check) and inside the Analyst
- Always tell the user what is happening — never go silent
- Log every decision — the audit trail is the memory of the system
