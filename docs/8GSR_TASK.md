You are an MCP (Model Context Protocol) agent with access to the backtest dataset  (or the underlying database `data/trading_data.db`). Your task is to **systematically loosen the thresholds** of the 8‑Gate STC Reversal (8GSR) strategy, perform a **large‑scale validation** across many parameter combinations, and **identify the most profitable edge** that can be used in live trading.

### Strategy Context (8GSR v1.0 – baseline)

The original gates (as simulated) are:

1. **BB touch** – within 1‑3 bars before entry (any).
2. **Stochastic cross** – from deep oversold/overbought (K/D <30 or >80 before cross), with current K <50 (BUY) or >50 (SELL).
3. **CCI cross** – crossed ±100 at some point before entry, with depth extreme <‑150 (BUY) or >+150 (SELL) in prior 10 bars.
4. **STC hook** – from ≤25 (BUY) or ≥75 (SELL) on the signal bar, with stc_delta not checked.

Goal: **Find parameter ranges that produce a statistically significant, profitable edge** on the 1 and 2‑minute expiry, even if they deviate from the original “tight” thresholds.

### Parameters to Loosen (Vary Systematically)

For each parameter below, define a **wide search range**. Use reasonable step sizes to keep the number of combinations manageable (e.g., grid search with 2‑5 values per parameter). You may also use random sampling or Bayesian optimization if preferred.

| Parameter | Original (tight) | Loose search range (example) |
|-----------|------------------|------------------------------|
| `stc_delta` (BUY) | not used | 0 to 5.0, step 0.5 (or bins: <0.5, 0.5-1, 1-2, 2-3, 3-5, >5) |
| `stc_delta` (SELL) | not used | -5.0 to 0, step 0.5 (bins: -0.5-0, -1 to -0.5, -2 to -1, -3 to -2, -5 to -3, <-5) |
| `stc_prev` (BUY hook zone) | ≤25 | ≤15, ≤20, ≤25, ≤30, ≤35 |
| `stc_prev` (SELL hook zone) | ≥75 | ≥65, ≥70, ≥75, ≥80, ≥85 |
| `g2_bars_ago` (stoch cross age) | any (0‑2) | only 0, only 1, only 2, any of 0‑2 |
| `g2_d_before` (BUY) | <30 | bins: 0‑10, 10‑20, 20‑30, 30‑40, any |
| `g2_d_before` (SELL) | >80 | bins: 70‑80, 80‑90, 90‑100, any |
| `stoch_k` (current, BUY) | <50 | bins: 0‑20, 20‑30, 30‑40, 40‑50, any |
| `stoch_k` (current, SELL) | >50 | bins: 50‑60, 60‑70, 70‑80, 80‑90, any |
| `g3_depth` (BUY) | < -150 | < -100, < -125, < -150, < -175, < -200, also ranges like -200 to -150 |
| `g3_depth` (SELL) | > +150 | >100, >125, >150, >175, >200, and ranges |
| `g3_bars_ago` (CCI cross age) | any | 1, 2, 3, 4, 5+, any |
| `g1_bars_ago` (BB touch recency) | any of 1‑3 | only 1, only 2, only 3, any 1‑3 |
| Coincidence window (`max_g1,g2,g3`) | not enforced | ≤3, ≤4, ≤5, ≤6, any |

### Evaluation Metrics (per parameter combination)

For each combination of parameter values (or for each segmented bin when varying one parameter at a time), compute **on the 2‑minute expiry (`win_2m`)**:

- Number of trades (n)
- Win rate (%)
- Net PnL (sum of `pnl_2m, pnl_1m`)
- Profit factor = sum(winning PnL) / abs(sum(losing PnL))
- Average win / average loss ratio
- Z‑score and p‑value (test vs 50% win rate, one‑proportion z‑test)

Only consider combinations with **n ≥ 20** (or ≥30 for higher confidence).

### Procedure – Large‑scale Validation & Narrowing

1. **Univariate scan** – For each parameter individually, segment the data according to the loose ranges and compute the metrics. Identify which ranges improve win rate / PnL compared to baseline (all signals). Document the top 2‑3 ranges per parameter.

2. **Bivariate combinations** – Take the promising ranges from step 1 and combine them pairwise. For each pair, filter the signals and evaluate. Keep combinations with win rate >55% and profit factor >1.1, n≥20.

3. **Multivariate narrowing** – From the best bivariate combinations, add a third parameter (e.g., add `g1_bars_ago` or `g3_depth`). Iteratively build a set of 3‑4 parameters that together yield the highest win rate and PnL. Use forward selection.

4. **Cross‑validation (time‑based)** – Split the data into two time periods (e.g., first half vs second half of the dataset). Validate the best edge on the out‑of‑sample period. If performance holds (win rate within 5% absolute), consider it robust.

5. **Output the top 10 parameter sets** – For each, provide:
   - Parameter values (e.g., `stc_delta: 0‑0.5`, `g2_bars_ago: 1`, `g3_depth: -200 to -150`, `g1_bars_ago: 2`)
   - Number of trades, win rate, net PnL, profit factor, confidence interval.
   - A recommendation of **the single best set** to implement live.

### Additional Instructions

- **Direction‑aware** – Treat BUY and SELL separately; you may find different optimal thresholds for each.
- **Avoid overfitting** – Prefer parameter sets that perform well on at least 30‑50 trades and have a profit factor >1.2.
- **Consider expiry** – Only use `win_2m, win_1m` as the target; do not optimize for 1m or 3m.
- **Output format** – Produce a clear markdown report with tables, key insights, and the final recommended edge.


Now run the analysis and return your findings.