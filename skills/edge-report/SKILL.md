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

**Primary target: `exp_120s` (2m expiry). Secondary context: `exp_60s` (1m expiry — optional).**

Where 60s and 120s WR diverge by >15% on the same bucket: flag as expiry-sensitive — the signal is real at 1m but fades (or reverses) by 2m. This is critical for gate tuning since 2m is the trading target.

This returns 11+ analysis dimensions. Extract findings from each:

**Capture these specifically:**
- `by_direction` — CALL vs PUT overall WR and PnL at 60s and 120s expiry
- `by_stc_prev` — STC zone depth at signal bar (CALL: 0-5, 5-10, 10-25; PUT: 75-85, 85-95, 95-100)
- `by_stc_delta` — hook size: CALL 0.0-0.1, 0.1-0.2, 0.2-0.3, 0.3-0.5; PUT mirror
- `by_g1_barsAgo` — BB touch recency: 1, 2, or 3 bars before signal
- `by_g2_cross_depth` — K at C-2 (pre-cross bar): how deep was stoch before crossing
- `by_g2_cross_kd` — K at C-1 (the cross bar itself): momentum at the crossing point
- `by_stoch_levels` — current K at signal bar vs direction gate
- `by_g3_depth` — CCI depth: CALL -250 to -150 buckets; PUT 150 to 250 buckets
- `by_g3_cross_bars_ago` — recency of CCI cross: 1-3, 4-6, 7-10, 11-24 bars ago
- `by_cci_current` — CCI value at the signal bar itself
- `by_coincidence_score` — gates at max intensity (0-5): does higher score predict better WR?
- `by_bb_width` — BB bps at signal (flat <2, weak 2-5, marginal 5-10, ok 10-20, good 20+)
- `by_asset` — per-asset win rates with CALL/PUT breakdown and preferred direction
- `best_thresholds` — auto-selected best bucket per parameter with ≥5 trades

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

## 6. Asset Analysis
[Top 5 assets by win rate — with preferred direction]
[Bottom 5 assets — with reason (low vol / wrong direction)]
[Assets currently below 5 bps BB — flag for dynamic block only, not permanent]

## 7. Recommendations
[Specific gate change proposals with po_simulate commands to test them]
[Dynamic blocks: assets with current BB < 5 bps only — OTC conditions change, never block by historical WR alone]
[Pattern focus: which direction (CALL/PUT) has the strongest current edge]
```

## Step 7: Simulate Top Recommendations

For any gate change identified in the report, run `po_simulate` to validate before recommending it as a live bot change.

Example simulations to run based on findings:
- If `by_stc_delta` shows CALL delta 0.2-0.3 outperforms: test `po_simulate call_delta_max=0.3`
- If `by_g3_depth` shows CALL -175 to -150 outperforms deeper zones: test `po_simulate call_g3_depth_min=-175`
- If `by_stc_prev` shows PUT 95-100 outperforms: test `po_simulate put_stc_ceiling=95`
- If `by_g3_depth` shows PUT >175 outperforms >150: test `po_simulate put_g3_depth_max=175`
- If `by_stc_prev` shows CALL 0-5 outperforms: test `po_simulate call_stc_floor=5`
- Combine the best univariate results into one joint simulation to see the full cumulative effect

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
