---
name: edge-report
description: Run a full research session on historical data. Replays all candles, analyses win rates across all 11 dimensions (RSI, stoch, MA gap, BB width, hour, pattern, retracement depth, K extension, MA gap trend, BB expansion, asset), and writes a consolidated report to docs/. Use when the user says "analyse the strategy", "find the edge", "research session", or "what's working".
---

# Edge Report — Full Strategy Research Session

You are running a complete data-driven research session on the     strategy using all historical data in trading_data.db. Your goal is to identify what conditions genuinely produce wins vs losses and write a structured report.

## Step 1: Health Check

Call `po_health`. If bot DB not accessible → STOP:
> "Cannot access trading_data.db. Ensure the bot has been running and the DB path is set correctly."

## Step 2: Run Full Replay

Call `po_replay_candles`.

This fires all historical CALL and PUT signals bar-by-bar and validates against the next candle. Note:
- Total signals fired
- CALL win rate and P/L
- PUT win rate and P/L
- Gate rejection counts (which gates filter most — tells you which are doing the work)
- Any gap flags (signals with no next candle)

## Step 3: Deep Edge Analysis

Call `po_find_edge`.

This returns 11 analysis dimensions. Extract findings from each:

**Capture these specifically:**
- `by_bb_width` — which BB tiers are profitable vs losing (key gate validation)
- `by_pattern` — CALL_REVERSAL vs PUT_REVERSAL vs CALL_CONTINUATION vs PUT_CONTINUATION win rates
- `by_retracement_depth` — does deeper RSI peak/trough before signal improve win rate?
- `by_k_extension` — does more bars of K extension before crash improve win rate?
- `by_ma_gap_trend` — narrowing vs widening MA gap at signal time
- `by_bb_expansion` — expanding vs contracting BB at signal time
- `by_hour` — which UTC hours are most profitable
- `by_asset` — per-asset win rates with CALL/PUT breakdown

## Step 4: Asset Bias Check

Call `po_asset_bias`.

Note:
- Assets with AVOID verdict
- Assets with BLOCK_RECOMMENDED (BB < 5 bps)
- Assets with strong directional bias (CALL_ONLY, PUT_ONLY)
- Assets with BOTH verdict and high win rates (best candidates)

## Step 5: Volatility Scan

Call `po_asset_volatility`.

Note assets below 10 bps — these are the ones currently leaking P/L through the BB gate.
Note assets above 30 bps — best volatility for clean setups.

## Step 6: Compile the Report

Write a complete markdown report to `docs/edge_report_[YYYY-MM-DD].md`.

Structure:

```markdown
# Edge Report — [date]

**Dataset:** [N] validated signals | [N] assets | [date range]
**Overall:** [N] signals, [WR]% win rate, [P&L] P&L

---

## 1. Overall Performance
[CALL vs PUT breakdown — signals, WR, P&L each]

## 2. Gate Rejection Analysis
[Which gates are filtering most signals — top 3 rejection gates]
[What this means for signal volume vs quality tradeoff]

## 3. BB Width Analysis
[Tier breakdown: which bps ranges are profitable]
[Current 10 bps gate: how many signals it blocks, P&L impact]
[Recommendation: keep at 10, raise to 15, or leave unchanged]

## 4. Pattern Breakdown
[All 4 patterns: CALL_REVERSAL, PUT_REVERSAL, CALL_CONTINUATION, PUT_CONTINUATION]
[Win rate + P&L + trade count per pattern]
[Which pattern has the most edge, which is leaking]

## 5. Retracement Context
[PUT: RSI peak depth before reversal — does deeper peak improve WR?]
[CALL: RSI trough depth before bounce — does deeper trough improve WR?]
[K extension: does more bars above/below 65/35 improve WR?]

## 6. Market Timing
[Best and worst UTC hours]
[MA gap trend at signal: narrowing vs widening]
[BB expansion state at signal: expanding vs contracting]

## 7. Asset Analysis
[Top 5 assets by win rate — with preferred direction]
[Bottom 5 assets — with reason (low vol, wrong direction, etc.)]
[Assets to block: AVOID or BLOCK_RECOMMENDED]

## 8. Recommendations
[Specific gate change proposals with po_simulate commands to test them]
[Assets to block immediately]
[Pattern focus: which pattern to prioritise]
[Timing filter: which hours to avoid if any]
```

## Step 7: Simulate Top Recommendations

For any gate change identified in the report, run `po_simulate` to validate before recommending it as a live bot change.

Example simulations to run based on findings:
- If `by_bb_width` shows 15 bps improves WR: `po_simulate bar_bb_bps_min=15`
- If `by_k_extension` shows 3+ bars is best: `po_simulate call_k_crash_min=30`
- If `by_retracement_depth` shows RSI peak > 85 for PUT: note in report as hypothesis to test

Add simulation results to the Recommendations section.

## Step 8: Report to User

Tell the user:
- Report saved to `docs/edge_report_[date].md`
- Top 3 findings (most impactful)
- Immediate actions: assets to block, gate changes validated by simulation
- Next research questions to investigate

## Rules

- Always base recommendations on data — cite signal counts and win rates
- Never recommend a gate change without running `po_simulate` first
- If a finding has < 10 signals, note "small sample — treat as hypothesis"
- The report is the deliverable — make it detailed enough to act on without re-running the analysis
