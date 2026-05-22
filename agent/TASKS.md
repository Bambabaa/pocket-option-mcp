# Agent System — Task Checklist

**Status key:** `⬜ pending` `🔄 in progress` `✅ done`

---

## PHASE 0 — Research & Entry Strategy (Statistical)

Goal: Find gates with a provable, statistically significant edge at 5m expiry.
Nothing goes into the scan logic unless it survives significance testing AND walk-forward validation.
This is the same standard the 1m bot uses via `po_significance` and `po_walk_forward`.

**Output:** `agent/research/strategy.md` — the validated gate spec that Task 2.5 implements.

---

### Why statistical significance — not just raw WR

Raw win rate is a biased estimator. If you test 20 conditions and pick the one with the highest WR,
you will find a false positive by chance even if no real edge exists (multiple testing problem).
You also risk overfitting to a short sample — a 60% WR on 30 trades could easily be 50% on 300.

The framework below requires every gate to pass:
1. Binomial test vs H0: WR = 0.5 (is the edge real or random?)
2. Wilson 95% CI lower bound > 52% (even the pessimistic estimate must beat random)
3. Walk-forward: significant on training data AND holds on out-of-sample test data
4. Multiple testing correction: alpha adjusted for the number of conditions tested

A gate that fails any of these is noise. It does not go into the strategy.

---

### Task R.1 — Backtest engine (`agent/research/backtest.cjs`) ⬜

**What it is:**
Reads every completed 5m bar from `agent.db`, detects which signal conditions fire at each bar,
then measures the outcome at 5m / 10m / 15m expiry using forward bar closes.
Writes raw signal records to a `backtest` table for all downstream analysis.

**Steps:**
- [ ] Create `agent/research/` directory
- [ ] Create `agent/research/backtest.cjs`
- [ ] Open `agent.db` readonly
- [ ] Create (or recreate) `backtest` table in `agent.db`:
  ```sql
  CREATE TABLE IF NOT EXISTS backtest (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      asset        TEXT    NOT NULL,
      bar_ts       INTEGER NOT NULL,   -- signal bar open timestamp
      direction    TEXT    NOT NULL,   -- CALL or PUT
      gate         TEXT    NOT NULL,   -- which individual condition fired
      score        INTEGER NOT NULL,   -- total gates firing in this direction at this bar
      entry_close  REAL    NOT NULL,   -- close price of signal bar (entry proxy)
      exit_1bar    REAL,               -- close 1 bar forward  (5m expiry)
      exit_2bar    REAL,               -- close 2 bars forward (10m expiry)
      exit_3bar    REAL,               -- close 3 bars forward (15m expiry)
      win_5m       INTEGER,            -- 1=WIN 0=LOSS NULL=no data
      win_10m      INTEGER,
      win_15m      INTEGER,
      fold         INTEGER NOT NULL    -- 0=train 1=test (chronological 70/30 split per asset)
  );
  ```
- [ ] For each asset: load all bars joined to indicators, sorted ASC by timestamp
- [ ] **Chronological 70/30 split per asset:** first 70% of bars → fold=0 (train), last 30% → fold=1 (test)
- [ ] For each bar (skip last 3 — need 3 forward bars for outcomes):
  - Test every individual gate listed below
  - For each gate that fires: record one row with that gate name + direction
  - Also count total CALL gates firing and total PUT gates firing → score
  - Record a "score=N" row for confluence analysis
  - Look up `exit_1bar` / `exit_2bar` / `exit_3bar` from the candles array
  - Set `win_5m = 1` if price moved in signal direction, 0 if not, NULL if no forward bar

  **CALL gates to test:**
  ```
  stc_floor        stc_value <= 25
  stc_deep_floor   stc_value <= 10
  stc_rising       stc_delta > 0
  rsi_below50      rsi_14 < 50
  rsi_oversold     rsi_14 < 30
  stoch_cross_up   stoch_k > stoch_d AND stoch_k < 50
  stoch_os         stoch_k < 20
  macd_hist_pos    macd_histogram > 0
  macd_cross_up    macd_histogram > 0 AND stoch_prev_d is not null (prev hist < 0)
  cci_low          cci_20 < -100
  cci_extreme      cci_20 < -150
  williams_os      williams_r < -80
  psar_bull        psar_is_bullish = 1
  adx_strong       adx >= 20
  bb_expanding     bb_width_bps >= 15
  keltner_below    close < keltner_lower
  ```

  **PUT gates to test:**
  ```
  stc_ceiling      stc_value >= 75
  stc_deep_ceiling stc_value >= 90
  stc_falling      stc_delta < 0
  rsi_above50      rsi_14 > 50
  rsi_overbought   rsi_14 > 70
  stoch_cross_dn   stoch_k < stoch_d AND stoch_k > 50
  stoch_ob         stoch_k > 80
  macd_hist_neg    macd_histogram < 0
  macd_cross_dn    macd_histogram < 0 AND prev hist > 0
  cci_high         cci_20 > 100
  cci_extreme      cci_20 > 150
  williams_ob      williams_r > -20
  psar_bear        psar_is_bullish = 0
  adx_strong       adx >= 20
  bb_expanding     bb_width_bps >= 15
  keltner_above    close > keltner_upper
  ```

- [ ] Log per asset: bars tested, CALL signals, PUT signals, rows written
- [ ] Do NOT filter or score anything here — raw signal capture only

**Files to create:** `agent/research/backtest.cjs`

**Run:**
```
node agent/research/backtest.cjs
```

---

### Task R.2 — Significance testing (`agent/research/significance.cjs`) ⬜

**What it is:**
Reads the `backtest` table and runs a binomial significance test on every gate.
Computes p-value, z-score, Wilson CI, and Kelly fraction.
Applies Bonferroni correction for multiple testing.
This is the same methodology as the main bot's `po_significance` MCP tool.

**Statistical methods:**

**Binomial p-value (one-tailed, H0: WR = 0.50):**
```js
// P(X >= k wins | n trials, p=0.5)
// Use normal approximation when n >= 30:
z = (k - n * 0.5) / Math.sqrt(n * 0.5 * 0.5)
p_value = 1 - normalCDF(z)   // one-tailed
```

**Wilson 95% confidence interval:**
```js
// Corrects for small samples — never outputs impossible bounds
p_hat = k / n
z95 = 1.96
center = (p_hat + z95*z95/(2*n)) / (1 + z95*z95/n)
margin = z95 * Math.sqrt(p_hat*(1-p_hat)/n + z95*z95/(4*n*n)) / (1 + z95*z95/n)
ci_lower = center - margin
ci_upper = center + margin
```

**Kelly fraction (PO payout = 0.85):**
```js
// f* = (WR * (1 + payout) - 1) / payout
// Positive = bet. Zero or negative = no edge, do not trade.
payout = 0.85
kelly = (wr * (1 + payout) - 1) / payout
half_kelly = kelly / 2   // conservative sizing
```

**Bonferroni correction:**
```js
// If testing N conditions at alpha=0.05:
alpha_corrected = 0.05 / N
// A gate must have p_value < alpha_corrected to be significant
```

**Steps:**
- [ ] Create `agent/research/significance.cjs`
- [ ] Implement `normalCDF(z)` (standard normal CDF)
- [ ] Implement `wilsonCI(k, n, z=1.96)`
- [ ] Implement `binomialPValue(k, n, p0=0.5)`
- [ ] Implement `kellyFraction(wr, payout=0.85)`
- [ ] Query `backtest` table grouped by `gate, direction, fold`:
  ```sql
  SELECT gate, direction, fold,
         COUNT(*) as n,
         SUM(win_5m) as wins_5m,
         SUM(win_10m) as wins_10m,
         SUM(win_15m) as wins_15m
  FROM backtest
  WHERE win_5m IS NOT NULL
  GROUP BY gate, direction, fold
  ORDER BY gate, direction, fold
  ```
- [ ] For each row, compute all stats for 5m, 10m, and 15m
- [ ] Count total unique gates being tested → compute Bonferroni alpha
- [ ] Print results table (training fold only first):
  ```
  gate            dir   n     WR_5m   p_val   CI_low  CI_high  z      kelly   sig?
  stc_floor       CALL  243   57.2%   0.014   51.3%   63.0%    2.45   0.182   YES*
  stc_deep_floor  CALL   89   61.8%   0.008   51.2%   71.4%    2.67   0.267   YES*
  stc_rising      CALL  198   52.5%   0.243   45.6%   59.4%    0.71   0.029   NO
  rsi_oversold    CALL   31   51.6%   0.450   34.4%   68.8%    0.18   0.011   NO (n<50)
  stoch_cross_up  CALL  312   54.1%   0.073   48.7%   59.5%    1.45   0.096   NO
  ...
  * = significant after Bonferroni correction
  ```
- [ ] Flag gates with n < 30 as "insufficient data — exclude"
- [ ] Flag gates where `ci_lower < 0.50` as "no reliable floor — exclude"
- [ ] Save significant gates (post-correction) to a list for R.3

**Files to create:** `agent/research/significance.cjs`

**Run:**
```
node agent/research/significance.cjs
```

---

### Task R.3 — Walk-forward validation (`agent/research/walkforward.cjs`) ⬜

**What it is:**
Takes every gate that was significant on the training fold (R.2)
and tests whether the same gate holds significance on the out-of-sample test fold.
A gate that was significant on training but fails on test is overfit — it does not go in the strategy.

This is the same concept as the main bot's `po_walk_forward` tool.

**Decision rules:**
```
STABLE:   significant on train AND WR_test >= WR_train - 5%  → USE
DEGRADED: significant on train AND WR_test >= 50% but < WR_train - 5%  → CAUTION, smaller sizing
OVERFIT:  significant on train AND WR_test < 50%  → DISCARD
```

**Steps:**
- [ ] Create `agent/research/walkforward.cjs`
- [ ] Load significant gates from R.2 (train fold, p < alpha_corrected)
- [ ] For each significant gate, query the TEST fold:
  ```sql
  SELECT COUNT(*) as n, SUM(win_5m) as wins
  FROM backtest
  WHERE gate = ? AND direction = ? AND fold = 1 AND win_5m IS NOT NULL
  ```
- [ ] Compute WR, p-value, Wilson CI on test fold
- [ ] Apply decision rules above
- [ ] Print comparison table:
  ```
  gate            dir   TRAIN                    TEST                     verdict
                        n    WR     CI_low        n    WR     CI_low
  stc_floor       CALL  170  57.2%  51.3%         73   55.1%  44.2%        STABLE ✓
  stc_deep_floor  CALL   62  61.8%  50.1%         27   44.4%  26.4%        OVERFIT ✗
  cci_low         CALL   58  60.3%  47.8%         23   60.9%  40.3%        STABLE ✓ (low n)
  ...
  ```
- [ ] Output final list: gates that are STABLE or DEGRADED (discard OVERFIT)
- [ ] For STABLE gates: use test fold WR (more conservative) as the reported edge
- [ ] Save final gate list to `agent/research/validated_gates.json`

**Files to create:** `agent/research/walkforward.cjs`, `agent/research/validated_gates.json`

**Run:**
```
node agent/research/walkforward.cjs
```

---

### Task R.4 — 1m validation statistical test ⬜

**What it is:**
Tests whether adding a 1m momentum check after the 5m signal fires improves win rate
with statistical significance. Uses the `prices` table to derive 60-second price movement.

**The hypothesis:**
```
H0: 1m momentum check does NOT improve WR (WR_filtered = WR_unfiltered)
H1: 1m momentum check DOES improve WR significantly
```

**The 1m check:**
```
Signal bar opens at timestamp T (e.g., 03:00:00)
Wait 60 seconds → check price at T+60
CALL confirmation: price at T+60 > price at T (first tick)
PUT  confirmation: price at T+60 < price at T (first tick)
Skip trade if price moved AGAINST the signal direction in first 60s
```

**Statistical test for the improvement:**
```
Two independent proportions (filtered vs unfiltered):
  p1 = WR of filtered group (1m confirmed)
  p2 = WR of unfiltered group (all signals)
  H0: p1 = p2  (no improvement)

  Pooled proportion: p_pool = (k1 + k2) / (n1 + n2)
  z = (p1 - p2) / sqrt(p_pool*(1-p_pool)*(1/n1 + 1/n2))
  p_value = 1 - normalCDF(z)   one-tailed: does filter IMPROVE WR?
```

**Steps:**
- [ ] Add to `agent/research/walkforward.cjs` (or separate script)
- [ ] For each validated gate from R.3:
  - Query `backtest` for signal bars on that gate (training fold only)
  - For each bar, look up prices table:
    ```sql
    SELECT price FROM prices WHERE asset = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1
    ```
    → first tick = bar open price proxy
    ```sql
    SELECT price FROM prices WHERE asset = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1
    ```
    → target timestamp = bar_ts + 60
  - Skip bars where tick data is missing within 120s of bar_ts
  - Split into: confirmed (1m agrees) vs rejected (1m contradicts)
- [ ] Compute WR for both groups, run two-proportion z-test
- [ ] Report:
  ```
  Gate: stc_floor CALL (n=170 bars with tick data)
    No filter:     WR_5m = 57.2%  (n=170)
    1m confirmed:  WR_5m = 63.1%  (n=104, lost 66 signals)
    1m rejected:   WR_5m = 48.2%  (n=66)
    Improvement z = 1.82, p = 0.034 → SIGNIFICANT ✓
    Signal reduction: -38.8%
    Decision: ADD 1m filter (WR gain outweighs signal loss)

  Gate: cci_low CALL (n=58 bars)
    No filter:     WR_5m = 60.3%
    1m confirmed:  WR_5m = 61.4%  (n=37)
    Improvement z = 0.21, p = 0.416 → NOT SIGNIFICANT ✗
    Decision: SKIP 1m filter (noise, not signal)
  ```
- [ ] Include 1m filter only for gates where p < 0.05 AND signal n_confirmed >= 20
- [ ] Update `agent/research/validated_gates.json` with `use_1m_filter: true/false` per gate

---

### Task R.5 — Confluence scoring & gate interaction ⬜

**What it is:**
Tests whether combining gates (score >= 2, >= 3, etc.) produces significantly better WR
than any single gate alone. This defines the minimum score threshold for the GO verdict
in `po_agent_scan`.

**Steps:**
- [ ] Query backtest grouped by `score, direction, fold`:
  ```sql
  SELECT score, direction, fold,
         COUNT(DISTINCT bar_ts || asset) as signals,
         SUM(win_5m) * 1.0 / COUNT(*) as wr_5m
  FROM backtest
  WHERE win_5m IS NOT NULL
  GROUP BY score, direction, fold
  ```
- [ ] Run binomial significance test at each score level (training fold):
  ```
  Score  Direction  n_train  WR_5m   p_val   CI_low   Kelly   sig?
  1      CALL       520      52.3%   0.148   48.3%    0.031   NO
  2      CALL       234      56.8%   0.020   50.6%    0.142   YES
  3      CALL        98      62.2%   0.001   52.5%    0.278   YES
  4      CALL        31      67.7%   0.004   50.1%    0.415   YES (low n)
  ```
- [ ] Walk-forward: test same score levels on test fold
- [ ] Find minimum score where BOTH train and test are significant → that is the GO threshold
- [ ] Test gate pairs: which two-gate combinations beat single gates?
  ```sql
  -- Find bars where both gate_A and gate_B fire simultaneously
  SELECT a.asset, a.bar_ts, a.direction, a.win_5m
  FROM backtest a
  JOIN backtest b ON a.asset=b.asset AND a.bar_ts=b.bar_ts AND a.direction=b.direction
  WHERE a.gate='stc_floor' AND b.gate='stc_rising' AND a.fold=0
  ```
- [ ] Report top 5 gate pairs by WR (n >= 20) for CALL and PUT
- [ ] Identify **required gates** (must always fire) vs **supporting gates** (count toward score)
- [ ] Update `agent/research/validated_gates.json` with:
  - `required_gates`: list (must all pass)
  - `supporting_gates`: list (score toward threshold)
  - `go_threshold`: minimum supporting score for GO verdict

---

### Task R.6 — Asset shortlist & expiry profiling ⬜

**What it is:**
Identifies which specific assets have the most reliable edge and what expiry maximises WR per asset.
Mirrors the `po_find_edge` `by_asset` breakdown for the 1m bot.

**Steps:**
- [ ] Query backtest for validated gates only (from R.3), grouped by asset + expiry:
  ```sql
  SELECT asset, direction,
         SUM(win_5m) * 1.0 / COUNT(*) as wr_5m,   COUNT(*) as n_5m,
         SUM(win_10m) * 1.0 / COUNT(*) as wr_10m,
         SUM(win_15m) * 1.0 / COUNT(*) as wr_15m
  FROM backtest
  WHERE gate IN (...validated gates...) AND fold = 1   -- test fold only for final shortlist
  GROUP BY asset, direction
  HAVING n_5m >= 15
  ORDER BY wr_5m DESC
  ```
- [ ] For each asset: run binomial test at each expiry (5m/10m/15m), find which is significant
- [ ] Classify expiry profile:
  - **Delayed winner:** WR_5m < WR_10m by >= 5% → use 10m expiry
  - **Quick reversal:** WR_5m >= WR_10m → use 5m expiry
  - **Flat:** WR difference < 5% → use 5m (default, shorter risk window)
- [ ] Keep only assets where at least ONE expiry has: p < 0.05 AND CI_lower > 50% AND n >= 15
- [ ] Output asset shortlist:
  ```
  asset           dir    best_expiry  WR      CI_low  n    profile
  GBPJPY_otc      CALL   10m          63.4%   51.2%   22   delayed_winner
  EURUSD_otc      PUT    5m           61.0%   50.3%   29   quick_reversal
  CADJPY_otc      CALL   5m           58.7%   47.2%   23   flat (borderline)
  ```
- [ ] Write shortlist to `agent/research/validated_gates.json`

---

### Task R.7 — Strategy document (`agent/research/strategy.md`) ⬜

**What it is:**
Compiles R.2–R.6 into a single human-readable spec.
This is the **only** input Task 2.5 (`po_agent_scan`) is allowed to use.
No gate goes into production without appearing in this document with its evidence.

**Steps:**
- [ ] Write `agent/research/strategy.md` with sections:

  **1. Summary statistics**
  - Total bars analyzed, total assets, date range covered
  - Total conditions tested, Bonferroni-corrected alpha used
  - Gates significant on train: N. Gates surviving walk-forward: M.

  **2. CALL gates (validated)**
  Per gate: WR_train, WR_test, CI lower, p-value, Kelly, 1m filter included?

  **3. PUT gates (validated)**
  Same structure.

  **4. Confluence scoring**
  - Required gates (all must fire)
  - Supporting gates + GO threshold
  - WR at each score level (train + test)

  **5. 1m validation**
  - Which gates use it, WR gain, signal reduction

  **6. Asset shortlist**
  - Asset, direction, expiry, WR, CI lower, n
  - Assets explicitly excluded and why (insufficient n, no significant expiry)

  **7. What was NOT significant**
  - Full list of tested conditions that failed
  - Reason: low n / p > alpha / failed walk-forward

  **8. Config thresholds**
  - Exact values to set in `config.json` strategy section

- [ ] Add strategy section to `agent/websocket/config.json`:
  ```json
  "strategy": {
    "call_required_gates": ["stc_floor", "stc_rising"],
    "call_supporting_gates": ["rsi_below50", "stoch_cross_up", "cci_low"],
    "call_go_threshold": 2,
    "put_required_gates": ["stc_ceiling", "stc_falling"],
    "put_supporting_gates": ["rsi_above50", "stoch_cross_dn", "cci_high"],
    "put_go_threshold": 2,
    "use_1m_filter": true,
    "min_bb_bps": 10,
    "asset_shortlist": { "GBPJPY_otc": { "direction": "CALL", "expiry_seconds": 600 }, ... },
    "payout_rate": 0.85
  }
  ```

**Files to create:** `agent/research/strategy.md`
**Files to modify:** `agent/websocket/config.json`

**Do not start Task 2.5 until this document exists.**

---

### Research build order

```
R.1 (backtest engine)
  → R.2 (significance testing on train fold)
    → R.3 (walk-forward: validate on test fold)
      → R.4 (1m filter significance test)
      → R.5 (confluence + gate pairs)
      → R.6 (asset shortlist + expiry profiling)
        → R.7 (strategy.md + config thresholds)
          → THEN start Task 2.5 (po_agent_scan)
```

---



## PHASE 2 — MCP Tools (Claude reads agent.db)

Goal: Claude can call MCP tools and get live 5m data from `agent/data/agent.db`.
No writes, no trades. Read-only intelligence layer.

---

### Task 2.1 — `src/agent-connection.js` ⬜

**What it is:**
A new file that opens `agent/data/agent.db` as a readonly SQLite connection and exports it.
All agent MCP tools import from here — one place to manage the connection.

**Steps:**
- [ ] Create `src/agent-connection.js`
- [ ] Import `better-sqlite3`
- [ ] Resolve `agent/data/agent.db` path relative to project root
- [ ] Open DB with `{ readonly: true }` flag
- [ ] Set `journal_mode = WAL` pragma (safe for readonly opens alongside writer)
- [ ] Export `agentDb` instance
- [ ] Add error handling: throw clear message if `agent.db` does not exist yet

**File to create:** `src/agent-connection.js`
**Files touched:** none modified

**Test:**
```js
const { agentDb } = require('./agent-connection');
console.log(agentDb.prepare('SELECT COUNT(*) as n FROM candles').get());
// → { n: 13839 }
```

---

### Task 2.2 — `po_agent_health` tool ⬜

**What it is:**
First tool Claude calls. Confirms the agent system is alive and data is fresh.
Equivalent to `po_health` but for `agent.db`.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js` (new file)
- [ ] Query: row counts for `candles`, `indicators`, `prices`, `agent_orders`, `agent_log`
- [ ] Query: `COUNT(DISTINCT asset)` from candles
- [ ] Query: `MAX(timestamp)` from candles → latest closed bar (with human-readable datetime)
- [ ] Query: `MAX(timestamp)` from prices → latest tick (seconds ago from `strftime('%s','now')`)
- [ ] Query: count of PENDING agent_orders
- [ ] Build response object with all the above
- [ ] Register tool in `src/server.js` as `po_agent_health`
- [ ] Add to MCP tool list (no required params)

**Files to create:** `src/core/agent-tools.js`
**Files to modify:** `src/server.js`

**Response shape:**
```json
{
  "agent_db": "ok",
  "assets_tracked": 69,
  "candles": 13839,
  "indicators": 13770,
  "price_ticks": 1700673,
  "latest_bar": "2026-05-22 03:00:00 UTC",
  "latest_tick_seconds_ago": 12,
  "pending_orders": 0
}
```

**Test:** Call `po_agent_health` → all fields populated, `latest_tick_seconds_ago` < 60 when client.cjs is running.

---

### Task 2.3 — `po_agent_candles` tool ⬜

**What it is:**
Returns the last N 5m OHLC bars for a specific asset from `agent.db`.
Used by Claude to inspect recent price action before deciding.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js`
- [ ] Input params: `asset` (required, string), `limit` (optional, default 20, max 500)
- [ ] Query: `SELECT timestamp, open, high, low, close FROM candles WHERE asset = ? ORDER BY timestamp DESC LIMIT ?`
- [ ] Return bars sorted ascending (oldest first) so Claude can read left→right
- [ ] Include metadata: asset name, bar count returned, oldest/newest timestamp
- [ ] Register tool in `src/server.js` as `po_agent_candles`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`

**Response shape:**
```json
{
  "asset": "GBPJPY_otc",
  "count": 20,
  "oldest": "2026-05-22 00:40:00",
  "newest": "2026-05-22 03:00:00",
  "bars": [
    { "timestamp": 1747870800, "open": 192.45, "high": 192.61, "low": 192.38, "close": 192.54 },
    ...
  ]
}
```

**Test:** Call `po_agent_candles` with `asset=EURUSD_otc, limit=5` → 5 rows returned, timestamps 5 minutes apart.

---

### Task 2.4 — `po_agent_indicators` tool ⬜

**What it is:**
Returns the latest indicator row for one asset, or a multi-asset snapshot.
Raw values — no scoring, no verdict. Claude reads this to do its own analysis.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js`
- [ ] Input params: `asset` (optional — if omitted, return latest row for ALL assets)
- [ ] Single-asset query: `SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT 1`
- [ ] Multi-asset query: JOIN indicators to a subquery `MAX(timestamp) per asset`
- [ ] Return all 35 indicator columns
- [ ] Include: `bar_time` (human datetime of the timestamp)
- [ ] Register tool in `src/server.js` as `po_agent_indicators`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`

**Response shape (single asset):**
```json
{
  "asset": "GBPJPY_otc",
  "bar_time": "2026-05-22 03:00:00",
  "stc_value": 18.4,
  "stc_prev": 14.1,
  "stc_delta": 4.3,
  "rsi_14": 38.2,
  "stoch_k": 22.1,
  "stoch_d": 19.4,
  "bb_width_bps": 64.2,
  "adx": 28.1,
  ...
}
```

**Test:** Call with a known asset → values match what SQLite returns for that asset's latest indicator row.

---

### Task 2.5 — `po_agent_scan` tool ⬜

**What it is:**
The main intelligence tool. Scans every tracked asset, scores it against the signal gates,
and returns a ranked list with direction and verdict.
This is the tool Claude calls first every loop cycle.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js`
- [ ] Input params: `min_bb_bps` (optional, default 10), `limit` (optional, default 20)
- [ ] Query: latest indicator row per asset (same multi-asset query as 2.4)
- [ ] For each asset, evaluate signal gates:

  **CALL gates (floor bounce):**
  - g1: `stc_value <= 25`
  - g2: `stc_delta > 0` (STC curling up)
  - g3: `rsi_14 < 50`
  - g4: `stoch_k < 50` AND `stoch_k > stoch_d` (bullish cross, not overbought)
  - g5: `bb_width_bps >= min_bb_bps` (not flat)

  **PUT gates (ceiling rollover):**
  - g1: `stc_value >= 75`
  - g2: `stc_delta < 0` (STC rolling down)
  - g3: `rsi_14 > 50`
  - g4: `stoch_k > 50` AND `stoch_k < stoch_d` (bearish cross, not oversold)
  - g5: `bb_width_bps >= min_bb_bps` (not flat)

- [ ] Score = count of gates passed (0–5)
- [ ] Verdict: `GO` if score >= 3, `WATCH` if score == 2, `SKIP` if score < 2
- [ ] Sort by score DESC, then stc_value proximity to zone edge
- [ ] Apply `limit` to result
- [ ] Register tool in `src/server.js` as `po_agent_scan`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`

**Response shape:**
```json
{
  "scanned": 69,
  "returned": 10,
  "timestamp": "2026-05-22 03:05:00",
  "results": [
    {
      "asset": "GBPJPY_otc",
      "direction": "CALL",
      "score": 4,
      "verdict": "GO",
      "stc_value": 18.4,
      "stc_delta": 4.3,
      "rsi_14": 38.2,
      "stoch_k": 22.1,
      "bb_width_bps": 64.2,
      "bar_time": "2026-05-22 03:00:00",
      "gates_passed": ["g1_stc_floor","g2_stc_rising","g3_rsi_below50","g5_bb_active"]
    },
    ...
  ]
}
```

**Test:** Call `po_agent_scan` → results match what the raw indicator query returns; scoring logic verified manually for 2-3 assets.

---

### Task 2.6 — Register all Phase 2 tools in `src/server.js` ⬜

**What it is:**
Wire up all 5 tools so the MCP server exposes them to Claude.

**Steps:**
- [ ] Import `agent-tools.js` handler module in `src/server.js`
- [ ] Register `po_agent_health` — no required params
- [ ] Register `po_agent_candles` — required: `asset`; optional: `limit`
- [ ] Register `po_agent_indicators` — optional: `asset`
- [ ] Register `po_agent_scan` — optional: `min_bb_bps`, `limit`
- [ ] Restart MCP server, confirm tools appear in tool list
- [ ] Call each tool from Claude CLI and verify response

**Files to modify:** `src/server.js`

**Test:** Run `/compact` then call `po_agent_health` from Claude — should return live data.

---

## PHASE 3 — Execution (Claude places trades)

Goal: Claude writes an order via MCP → `client.cjs` picks it up → sends to Pocket Option via
`direct-ws.cjs` → WIN/LOSS recorded back to `agent.db`.

---

### Task 3.1 — `po_agent_trade` MCP tool ⬜

**What it is:**
Claude's trade placement tool. Validates the order, writes a PENDING row to `agent_orders`.
Does NOT send the WS message — that's client.cjs's job.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js`
- [ ] Input params (all required): `asset`, `direction` (CALL/PUT), `amount`, `expiry_seconds`
- [ ] Optional: `cycle_id` (links order to scan cycle), `signal_ts` (bar timestamp of the signal)
- [ ] Validate: direction must be CALL or PUT
- [ ] Validate: amount > 0
- [ ] Validate: expiry_seconds in [60, 900] (1m–15m range for agent system)
- [ ] Validate: asset exists in candles table (must be tracked)
- [ ] Check: no existing PENDING or EXECUTING order for this asset (one order per asset at a time)
- [ ] Check: total PENDING + EXECUTING orders < `max_concurrent_trades` from config.json (default 2)
- [ ] Open `agent.db` in **write** mode (separate from readonly connection in 2.1)
- [ ] INSERT into `agent_orders`: asset, direction, amount, expiry_seconds, signal_ts, cycle_id, status=PENDING
- [ ] Return: inserted order id, asset, direction, amount, expiry, status
- [ ] Register tool in `src/server.js` as `po_agent_trade`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`
**Note:** Needs a writable DB connection — create separate `src/agent-connection-write.js` or add write mode flag to `agent-connection.js`

**Test (demo account):** Call `po_agent_trade` with valid params → row appears in `agent_orders` with status=PENDING.

---

### Task 3.2 — `po_agent_orders` MCP tool ⬜

**What it is:**
View the `agent_orders` table. Claude uses this to check open trades, count concurrent positions,
and review recent results.

**Steps:**
- [ ] Add handler in `src/core/agent-tools.js`
- [ ] Input params (all optional):
  - `status` — filter by PENDING/EXECUTED/CLOSED/FAILED/CANCELLED
  - `asset` — filter by asset
  - `limit` — max rows (default 20)
  - `result` — filter by WIN/LOSS/DRAW
- [ ] Query `agent_orders` with filters, ORDER BY created_at DESC
- [ ] Include computed field: `age_seconds` (now - created_at)
- [ ] Include computed field: `expires_in_seconds` (for EXECUTED orders: signal_ts + expiry_seconds - now)
- [ ] Return summary stats: total open, today's WIN count, today's LOSS count, today's P&L
- [ ] Register tool in `src/server.js` as `po_agent_orders`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`

**Response shape:**
```json
{
  "summary": {
    "open": 1,
    "today_wins": 3,
    "today_losses": 2,
    "today_pnl": 12.50
  },
  "orders": [
    {
      "id": 5,
      "asset": "GBPJPY_otc",
      "direction": "CALL",
      "amount": 10,
      "expiry_seconds": 300,
      "status": "EXECUTED",
      "result": null,
      "entry_price": 192.54,
      "expires_in_seconds": 180,
      "created_at": "2026-05-22 03:02:00"
    }
  ]
}
```

---

### Task 3.3 — `po_agent_log` MCP tool ⬜

**What it is:**
Read and write the `agent_log` table. Claude logs every decision here — not just trades,
but also SKIP and PAUSE decisions. Full audit trail.

**Steps:**

**Write (log a decision):**
- [ ] Input params: `cycle_id`, `cycle_ts`, `decision` (TRADE/SKIP/PAUSE/STOP), `asset` (optional), `direction` (optional), `expiry_min` (optional), `score` (optional), `reason` (required)
- [ ] INSERT into `agent_log`
- [ ] Return inserted row id

**Read (review decisions):**
- [ ] Input params: `limit` (default 50), `cycle_id` (optional — filter to one cycle), `decision` (optional filter)
- [ ] Query `agent_log` ORDER BY created_at DESC
- [ ] Group by cycle_id to show full cycle summaries
- [ ] Register both write and read as one tool with `action` param: `write` or `read`
- [ ] Register tool in `src/server.js` as `po_agent_log`

**Files to modify:** `src/core/agent-tools.js`, `src/server.js`

---

### Task 3.4 — SSID capture in `client.cjs` ⬜

**What it is:**
`client.cjs` currently does passive CDP interception only — it reads incoming WS frames but
never sends any. To execute trades via `direct-ws.cjs`, it needs the auth SSID first.
The SSID is in the browser's own outbound auth frame — captured the same way `fetch_history.cjs` does it.

**Steps:**
- [ ] Add `Network.webSocketFrameSent` listener in `setupInterception()` in `client.cjs`
- [ ] In the listener: decode payload (text frames are plain UTF-8, not base64)
- [ ] Look for: frame starts with `42`, parse JSON, check `parsed[0] === 'auth'`
- [ ] Extract SSID: `parsed[1]` (has `session` field for real account, `token` for demo)
- [ ] Store as module-level `capturedSsid` variable
- [ ] Also capture WS URL from `Network.webSocketCreated` (need it for directWs.connect)
- [ ] Log: `SSID captured: uid=... isDemo=...` (same as fetch_history.cjs)
- [ ] Add timeout warning if SSID not captured within 30s after page load

**Files to modify:** `agent/websocket/client.cjs`

**Test:** Start client.cjs, log in, open chart → should see `SSID captured` log line within 5s of auth.

---

### Task 3.5 — directWs instance in `client.cjs` ⬜

**What it is:**
Once SSID is captured (Task 3.4), open a second WS connection using `direct-ws.cjs`.
This second connection is the **execution channel** — it sends trade orders.
The browser's existing WS socket stays as the read-only data feed.

**Steps:**
- [ ] Import `createDirectWs` from `./direct-ws.cjs` in `client.cjs`
- [ ] After SSID is captured, call `directWs.connect(capturedWsUrl, capturedSsid)`
- [ ] Handle connect failure: log error, set `directWsReady = false`, continue (data collection still works)
- [ ] Store result as module-level `directWs` and `directWsReady` flag
- [ ] Add reconnect logic: if directWs closes, attempt reconnect every 30s (SSID is already stored)
- [ ] Log: `directWs ready — execution channel open`

**Files to modify:** `agent/websocket/client.cjs`

**Test:** After `SSID captured` appears → should see `directWs ready` within 5s.

---

### Task 3.6 — Port `pollOrders` to directWs ⬜

**What it is:**
Replace the broken `page.evaluate → sock.emit('openOrder')` in `client.cjs`'s `pollOrders`
function with `directWs.emit('openOrder', {...})`.
The polling loop (every 2s) already exists — just change the execution path.

**Steps:**
- [ ] In `pollOrders`, replace `page.evaluate(...)` block with `directWs.emit('openOrder', payload)`
- [ ] Build the `openOrder` payload:
  ```js
  {
    asset:     order.asset,
    direction: order.direction.toLowerCase(),  // 'call' or 'put'
    amount:    order.amount,
    time:      order.expiry_seconds,
  }
  ```
- [ ] On `directWs.emit` success → update `agent_orders` status to EXECUTED, store `executed_at`, store `entry_price` (latest close from candles or latest tick from prices)
- [ ] On failure (`directWs.emit` returns false or throws) → update status to FAILED, log reason
- [ ] Guard: if `!directWsReady` → skip polling, log warning once per minute
- [ ] Remove the old `page.evaluate` code entirely
- [ ] Remove the `page` parameter dependency from `pollOrders` (no longer needed)

**Files to modify:** `agent/websocket/client.cjs`

**Test (demo account):**
1. Write a PENDING row to `agent_orders` manually via sqlite3 CLI
2. Start client.cjs
3. Within 2s → row should change to EXECUTED, `executed_at` populated
4. Check PO UI to confirm trade appeared

---

### Task 3.7 — WIN/LOSS resolution ⬜

**What it is:**
After a trade's `expiry_seconds` elapses, look up the price at expiry time,
compare to `entry_price` and direction, and write WIN/LOSS back to `agent_orders`.
This closes the feedback loop — Claude can review actual results.

**Steps:**
- [ ] Add a resolution check to the `pollOrders` loop (or a separate `resolveOrders` function called on the same 2s interval)
- [ ] Query: `SELECT * FROM agent_orders WHERE status = 'EXECUTED' AND executed_at + expiry_seconds <= strftime('%s','now')`
- [ ] For each expired EXECUTED order:
  - [ ] Look up exit price: `SELECT price FROM prices WHERE asset = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1` using `executed_at + expiry_seconds` as the target
  - [ ] If no price row found yet: skip this cycle, try next poll
  - [ ] Determine result:
    - CALL + exit > entry → WIN
    - CALL + exit < entry → LOSS
    - CALL + exit == entry → DRAW
    - PUT + exit < entry → WIN
    - PUT + exit > entry → LOSS
  - [ ] Calculate `profit_loss`: WIN → `+amount * 0.85` (PO typical payout); LOSS → `-amount`
  - [ ] Update `agent_orders`: `status=CLOSED`, `result=WIN/LOSS/DRAW`, `exit_price`, `closed_at=now`, `profit_loss`
- [ ] Log: `order #N CLOSED: GBPJPY_otc CALL → WIN +$8.50`

**Files to modify:** `agent/websocket/client.cjs`

**Note:** PO payout rate (0.85 = 85%) should come from `config.json` — add `payout_rate: 0.85` field.

**Test:**
1. Place a CALL trade on demo
2. Wait for expiry
3. `agent_orders` row should show CLOSED + WIN or LOSS + profit_loss value

---

## Build Order

```
Phase 2 (read-only, safe to build now):
  2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6

Phase 3 (needs demo account testing):
  3.4 → 3.5 (in parallel with 2.x)
  3.1 → 3.2 → 3.3 (MCP side, can build alongside 2.x)
  3.6 → 3.7 (after 3.4 + 3.5 verified working)
```

Phase 2 has zero risk — all readonly. Build and test before touching Phase 3.
Phase 3 execution tasks (3.4–3.7) should be tested on **demo account only** until WIN/LOSS
results are consistent and correct.

---

## Files Created/Modified

| File | Action | Phase |
|---|---|---|
| `src/agent-connection.js` | CREATE | 2.1 |
| `src/core/agent-tools.js` | CREATE | 2.2–2.5, 3.1–3.3 |
| `src/server.js` | MODIFY — register tools | 2.6 |
| `agent/websocket/client.cjs` | MODIFY — SSID, directWs, pollOrders, resolver | 3.4–3.7 |
| `agent/websocket/config.json` | MODIFY — add `payout_rate` | 3.7 |
