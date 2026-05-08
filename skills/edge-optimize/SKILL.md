---
name: edge-optimize
description: Full 4-step systematic optimization of 8GSR gate thresholds per docs/8GSR_TASK.md. Runs univariate scan → multivariate grid search → time-based cross-validation → ranked top-10 parameter sets. Use when the user says "optimize the strategy", "find the best parameters", "run the full optimization", or "8GSR task".
---

# Edge Optimize — Full 8GSR Parameter Optimization

You are running the full systematic optimization described in `docs/8GSR_TASK.md`. Your goal: find the parameter combination that produces the highest statistically significant, profitable edge at 120s expiry.

## Step 1: Health Check

Call `po_health`. If bot DB not accessible → STOP.

## Step 2: Univariate Scan

Call `po_find_edge`.

This returns all 13+ dimensions bucketed with full statistics including z-score, p-value, and Wilson 95% CI (now that bStats is upgraded).

**For each dimension, extract:**
- The best bucket per parameter per direction (from `best_thresholds`)
- Any bucket with p_value < 0.10 — note as statistically significant
- Any bucket with p_value < 0.05 — note as strong edge

**Document top 2-3 ranges per parameter:**

| Param | Direction | Best range | WR | n | z_score | p_value |
|---|---|---|---|---|---|---|

Focus on 120s expiry (`exp_120s`). Flag any dimension where best bucket WR < 50% — those parameters add no edge.

## Step 3: Multivariate Grid Search

Call `po_grid_search` (direction='both').

This tests ALL combinations of:
- `stc_prev` (6 thresholds per direction)
- `stc_delta` (5 thresholds per direction)
- `g3_depth` (5 thresholds per direction)
- `g1_bars_ago` (1, 2, 3, any)

= up to 600 CALL + 720 PUT combinations, filtered to n≥20.

**From the results:**
1. List top 10 combinations per direction (by win rate)
2. Note the p_value and Wilson CI for each — only trust combinations with p_value < 0.10
3. Check if the current live gate params appear in the top results — confirm they are optimal or find a better set

## Step 4: Cross-Validation

From `po_find_edge`, the `cross_validation` section splits the 120s signal pool at the median timestamp into in-sample (first half) and out-of-sample (second half).

**Check:**
- Does the overall WR hold within 5% between halves?
- Does the best parameter set from Step 3 perform consistently across both halves?
- If out-of-sample WR drops >10% vs in-sample → mark as OVERFIT RISK

To validate a specific parameter set across time:
Call `po_simulate` with those params to see overall performance, then manually compare `po_find_edge cross_validation` in_sample vs out_of_sample WR for that direction.

## Step 5: Rank and Report

Build a top-10 table from the grid search results. For each entry:

| Rank | Direction | stc_prev | delta | g3_depth | g1 | n | WR | PnL | PF | z | p | Wilson CI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

**Select the single best set** using this criteria (in order):
1. p_value < 0.05 (statistically significant)
2. n ≥ 30 (enough trades)
3. Profit factor > 1.2
4. Wilson CI lower bound > 50% (confidently above breakeven)
5. If tied: prefer the set with higher n

## Step 6: Compare vs Current Live Gates

Current live gates in `bot/indicators.js`:
- CALL: stcPrev ≤ 25, delta 0–0.5, g3_depth < -150
- PUT:  stcPrev ≥ 85, delta -0.9–0, g3_depth > 175

For each direction, state:
- Are the live gates already at the optimal grid point?
- If not, what change would improve WR and by how much?
- Quantify the improvement using the grid search results

## Step 7: Simulate Recommended Changes

For any gate change identified, call `po_simulate` with those params to confirm the improvement vs baseline before recommending a bot update.

## Step 8: Write Report

Write `docs/edge_report_[YYYY-MM-DD].md` with:

```markdown
# 8GSR Optimization Report — [date]

## Dataset
- Total loose-pool signals: N
- Validated at 120s: N
- Date range: [first signal ts] to [last signal ts]

## Univariate Findings
[Table of best bucket per parameter — WR, n, z_score, p_value]

## Top 10 Parameter Sets — CALL
[Table from grid search]

## Top 10 Parameter Sets — PUT
[Table from grid search]

## Cross-Validation
- In-sample WR:     N% (n=N)
- Out-of-sample WR: N% (n=N)
- Verdict: ROBUST / MARGINAL / OVERFIT RISK

## Recommended Best Set
**CALL:** stc_prev ≤ N, delta < N, g3_depth < N, g1_bars_ago = N
  WR = N%, n = N, z = N, p = N, Wilson CI = [N, N]

**PUT:** stc_prev ≥ N, delta ≥ N, g3_depth > N, g1_bars_ago = N
  WR = N%, n = N, z = N, p = N, Wilson CI = [N, N]

## Gate Changes Required
| Param | Current | Recommended | Delta WR | Delta PnL |
|---|---|---|---|---|

## Next Steps
1. Apply recommended gate changes via po_simulate first
2. If confirmed: update bot/indicators.js
3. Accumulate N live trades then re-run /edge-optimize to validate
```

## Rules

- Never recommend a gate change without po_simulate confirmation
- Flag any finding with n < 20 as "insufficient sample"
- p_value < 0.10 = MARGINAL, < 0.05 = SIGNIFICANT, < 0.01 = STRONG
- Wilson CI lower bound > 0.50 = confidently above breakeven
- Always separate CALL and PUT — different optimal thresholds are expected
- If no combination passes p < 0.10 with n ≥ 20, report "no statistically significant edge found" and recommend accumulating more data
