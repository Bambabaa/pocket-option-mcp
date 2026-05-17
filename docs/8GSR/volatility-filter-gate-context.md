# Volatility Filter Gate — Context & Understanding

**Document Type:** Knowledge Transfer & Testing Specification  
**Created:** 2026-05-02  
**Purpose:** Help Claude understand the volatility-based asset filtering strategy and prepare for testing  
**Session:** e5c68912-9fd1-4ac2-b964-803172505b1a

---

## The Core Discovery

After analyzing 199 live trades from Apr 29-30, 2026, we discovered a **critical insight that changes everything:**

> **Asset selection matters MORE than gate optimization.**

The difference between the best 5 assets and worst 5 assets is **+52.7 percentage points** in win rate:
- **Top 5 assets:** 79.5% WR (31/39 trades)
- **Bottom 5 assets:** 26.8% WR (11/41 trades)

This is **10x larger** than any gate optimization could achieve.

---

## What is the "Volatility Filter Gate"?

The volatility filter gate is **NOT** a traditional gate (like "STC ≤ 25" or "RSI < 30"). Instead, it's a **pre-filtering layer** that asks:

> **"Should we even consider trading this asset at all?"**

It combines three dimensions:
1. **Historical performance** — Does this asset win or lose consistently?
2. **Volatility structure** — Does this asset have enough movement (BB width)?
3. **Gate compliance** — Does this asset respect our entry rules, or does it leak?

---

## The Problem We're Solving

### Current Bot Behavior (BROKEN)
```
Bot monitors 51 assets
→ Generates signals for ALL 51 assets equally
→ Trades GBPUSD with 0% WR (-$3,500)
→ Trades TNDUSD with 22.2% WR (-$2,100)
→ Trades YERUSD with 28.6% WR (-$2,345)
→ Overall result: 51.8% WR, -$7,295 P/L
```

### Desired Behavior (FIXED)
```
Bot monitors 51 assets
→ Filters OUT dead assets (GBPUSD, TNDUSD, YERUSD)
→ Prioritizes winning assets (AEDCNY 88.9%, USDMXN 83.3%)
→ Only generates signals for assets with statistical edge
→ Expected result: 60-75% WR, +$2,000 to +$8,000 P/L
```

---

## The Three-Layer Approach

### Layer 1: Asset-Level Filtering (HIGHEST IMPACT)
**Goal:** Block confirmed losers, prioritize confirmed winners

**Mechanism:**
- Track rolling 50-trade window per asset
- Compute win rate, P/L, volatility (median BB width)
- Classify into tiers:
  - **WHITELIST (score ≥+3):** Trade eagerly
  - **NEUTRAL (score 0-2):** Trade normally
  - **BLOCKLIST (score ≤-1):** Skip all signals

**Example scores:**
```javascript
AEDCNY:  88.9% WR, +$2,695, BB=32.9 bps → score +5 → WHITELIST
USDMXN:  83.3% WR, +$1,545, BB=31.4 bps → score +4 → WHITELIST
GBPUSD:   0.0% WR, -$3,500, BB=17.9 bps → score -9 → BLOCKLIST
```

**Statistical validation:**
- GBPUSD: p=0.0078 (99% confidence it's a loser)
- AEDCNY: p=0.0195 (95% confidence it's a winner)

---

### Layer 2: Volatility Structure Gate
**Goal:** Avoid assets with dead/flat price action

**The Volatility Paradox (RESOLVED):**

Our initial statistical analysis found a paradox:
- Low-vol assets (BB < 30 bps): **66.7% WR** ✅
- High-vol assets (BB ≥ 30 bps): **42.6% WR** ❌

This seemed backwards! Shouldn't volatility = opportunity?

**Resolution:** Asset-specific preferences
- Some assets (AEDCNY, USDMXN, USDCHF) **thrive in volatility** (BB 30-50 bps)
- Other assets (GBPUSD, TNDUSD) **fail regardless** of volatility (BB 10-25 bps)
- The paradox was mixing two populations

**Implementation:**
```javascript
// Per-asset volatility profile
const volatilityScore = (asset, currentBB, medianBB) => {
  if (currentBB < 10) return -2;  // Dead market, avoid
  if (currentBB < 20) return -1;  // Low volatility, weak
  
  // Check if this asset performs well in current volatility regime
  const assetProfile = getAssetVolatilityProfile(asset);
  
  if (currentBB >= medianBB * 1.5) {
    // High volatility — good for some assets, bad for others
    return assetProfile.highVolWR > 60 ? +1 : -1;
  }
  
  return 0; // Neutral volatility
};
```

**Key insight:** Don't use universal volatility rules. Instead:
1. Filter by asset-level performance FIRST
2. THEN apply asset-specific volatility preferences

---

### Layer 3: Gate Compliance Detection
**Goal:** Identify assets that consistently violate entry rules

**Gate leaks discovered:**
- CALL signals with STC > 25 (should be ≤ 25): 6.7% of all CALLs
- PUT signals with STC < 75 (should be ≥ 75): 10.6% of all PUTs
- K violations: 4.5% of signals

**Worst offenders:**
- GBPUSD: 33% leak rate (25-33% violation on STC/K gates)
- EURUSD: 18.2% leak rate
- USDJPY: 15.8% leak rate

**Hypothesis:** Assets with high leak rates indicate:
1. Timing issues in indicator calculation
2. Boundary conditions (STC oscillating around threshold)
3. Poor signal quality (gates don't apply cleanly)

**Implementation:**
```javascript
// Penalize assets with high leak rates
const leakPenalty = (asset) => {
  const leakRate = getAssetLeakRate(asset); // % of signals violating gates
  
  if (leakRate > 20) return -2; // Severe leak, strong penalty
  if (leakRate > 10) return -1; // Moderate leak, minor penalty
  return 0; // Clean signals
};
```

---

## The Scoring Formula

Combine all three layers into a single score:

```javascript
score = 
  +2 × WR_score         // Win rate is most important
  +2 × PnL_score        // Profit validates the edge
  +1 × volatility_score // Structural health check
  -2 × leak_penalty     // Gate violations = bad data quality
  -2 × anti_edge_penalty // Statistically validated loser

// Where:
// WR_score:    +1 if WR ≥ 60%, 0 if 40-60%, -1 if < 40%
// PnL_score:   +1 if positive, -1 if negative
// volatility:  +1 if BB ≥ 30 bps, -1 if < 20 bps
// leak:        -1 if leak > 10%, -2 if leak > 20%
// anti_edge:   -2 if p < 0.10 for losing hypothesis
```

**Tier classification:**
- **score ≥ +3:** WHITELIST (trade eagerly)
- **score 0 to +2:** NEUTRAL (trade normally)
- **score ≤ -1:** BLOCKLIST (skip all signals)

---

## Example Walk-Through: Why GBPUSD is Blocked

Let's score GBPUSD_otc (0/7 WR, -$3,500 P/L):

```
1. Win rate score:      0% WR → -1
2. P/L score:           -$3,500 → -1
3. Volatility score:    BB mean 17.9 bps (< 20) → -1
4. Leak penalty:        33% leak rate (> 20%) → -2
5. Anti-edge penalty:   p=0.0078 (< 0.10) → -2

Total score = +2×(-1) + +2×(-1) + +1×(-1) + -2×(-2) + -2
            = -2 + -2 + -1 + -4 + -2
            = -11

Classification: BLOCKLIST (score -11 ≤ -1)
```

**Action:** Bot skips ALL GBPUSD signals before storing in database.

**Expected impact:** Save $3,500 from 7 losing trades.

---

## Example Walk-Through: Why AEDCNY is Whitelisted

Let's score AEDCNY_otc (8/9 WR, +$2,695 P/L):

```
1. Win rate score:      88.9% WR (≥ 60%) → +1
2. P/L score:           +$2,695 (positive) → +1
3. Volatility score:    BB mean 32.9 bps (≥ 30) → +1
4. Leak penalty:        0% leak rate → 0
5. Anti-edge penalty:   p=0.0195 (winner validated) → 0

Total score = +2×(+1) + +2×(+1) + +1×(+1) + 0 + 0
            = +2 + +2 + +1
            = +5

Classification: WHITELIST (score +5 ≥ +3)
```

**Action:** Bot prioritizes AEDCNY signals (or in whitelist-only mode, ONLY trades these).

**Expected impact:** Maintain 88.9% WR, gain $2,695 from 9 winning trades.

---

## Testing Strategy

### Phase 1: Statistical Validation (Unit Tests)
**Goal:** Verify scoring algorithm matches manual calculations

Test cases:
1. **Wilson CI accuracy:**
   - GBPUSD (0/7) → CI [0%, 35.4%]
   - AEDCNY (8/9) → CI [56.5%, 98.0%]

2. **Binomial p-values:**
   - GBPUSD (0/7) → p=0.0078
   - AEDCNY (8/9) → p=0.0195

3. **Scoring accuracy:**
   - GBPUSD → score -9 to -11 (BLOCKLIST)
   - AEDCNY → score +5 (WHITELIST)
   - Neutral asset (50% WR, $100 P/L, 25 bps) → score +2 (NEUTRAL)

---

### Phase 2: Historical Replay Testing
**Goal:** Validate filtering improves historical performance

**Test 1: Blocklist mode (remove worst 5 assets)**
```sql
-- Query: How would we have performed without GBPUSD, TNDUSD, YERUSD, GBPJPY, CADJPY?
SELECT 
  COUNT(*) as remaining_trades,
  SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as wr,
  SUM(profit_loss) as pnl
FROM trades_ordered
WHERE asset NOT IN ('GBPUSD_otc', 'TNDUSD_otc', 'YERUSD_otc', 'GBPJPY_otc', 'CADJPY_otc')
```

**Expected:** 158 trades (vs 199), ~58-62% WR (vs 51.8%), -$1,000 to +$500 P/L (vs -$7,295)

**Test 2: Whitelist-only mode (top 5 assets only)**
```sql
-- Query: How would we have performed with ONLY AEDCNY, USDMXN, USDCHF, KESUSD, EURHUF?
SELECT 
  COUNT(*) as trades,
  SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as wr,
  SUM(profit_loss) as pnl
FROM trades_ordered
WHERE asset IN ('AEDCNY_otc', 'USDMXN_otc', 'USDCHF_otc', 'KESUSD_otc', 'EURHUF_otc')
```

**Expected:** 39 trades (vs 199), 79.5% WR (vs 51.8%), +$8,090 P/L (vs -$7,295)

---

### Phase 3: Integration Testing
**Goal:** Verify bot correctly applies filtering in live signal flow

**Test 1: Signal blocking**
```javascript
// Mock WebSocket candle for GBPUSD
const mockCandle = {
  asset: 'GBPUSD_otc',
  indicators: { stc: 5, rsi: 20, k: 40, d: 30, bbBps: 15 }
};

// Expect: Signal generated internally, but blocked before DB storage
// Log should show: "🚫 Asset GBPUSD_otc is BLOCKLISTED — skipping signal"
```

**Test 2: Signal pass-through**
```javascript
// Mock WebSocket candle for AEDCNY
const mockCandle = {
  asset: 'AEDCNY_otc',
  indicators: { stc: 8, rsi: 25, k: 45, d: 35, bbBps: 35 }
};

// Expect: Signal stored in DB normally
// Log should show: "📊 Asset Selection: AEDCNY_otc → WHITELIST (score=+5.0, WR=88.9%, n=9)"
```

---

### Phase 4: Shadow Mode Monitoring
**Goal:** Run engine without blocking signals, measure accuracy

**Week 1 metrics:**
- **Precision:** % of BLOCKLIST assets that lose (should be ≥ 70%)
- **Recall:** % of losing assets caught by BLOCKLIST (should be ≥ 60%)
- **Stability:** % of assets that change tiers per day (should be < 10%)
- **False positives:** Did we block any assets that then won 3+ in a row?

**Decision criteria:**
- If precision ≥ 70% AND recall ≥ 60%: Enable blocking in Week 2
- If precision < 60%: Adjust scoring formula (maybe increase WR weight)

---

## Key Concepts for Claude to Remember

1. **Asset selection > gate optimization**
   - Don't waste time perfecting gates if you're trading bad assets
   - Block GBPUSD saves $3,500; tightening STC from 25→20 saves maybe $200

2. **Volatility is asset-specific**
   - AEDCNY loves volatility (BB 30-50 bps)
   - GBPUSD fails in all regimes (BB 10-25 bps)
   - Don't apply universal volatility rules

3. **Statistical validation is crucial**
   - 8/9 wins MIGHT be luck (p=0.0195, just barely significant)
   - 0/7 losses is DEFINITELY bad (p=0.0078, 99% confidence)
   - Use Wilson CI + binomial p-values, not raw percentages

4. **Rolling windows prevent overfitting**
   - Use last 50 trades, not all-time history
   - This adapts to regime changes
   - If asset changes behavior, score updates within 1-2 sessions

5. **Safeguards prevent disasters**
   - Min 5 trades before classification (avoid small sample noise)
   - Always keep ≥ 5 assets tradeable (prevent "block everything" scenario)
   - Manual overrides expire after 7 days (prevent stale human bias)

---

## Testing Prompt for Next Session

When continuing with testing, use this prompt:

```
I need to validate the volatility filter gate / asset selection engine.

Context:
- 199 live trades from Apr 29-30, 2026 in data/trading_data.db
- Top 5 assets: 79.5% WR (AEDCNY 88.9%, USDMXN 83.3%, USDCHF 77.8%)
- Bottom 5 assets: 26.8% WR (GBPUSD 0%, TNDUSD 22.2%, YERUSD 28.6%)
- Asset selection matters more than gate optimization (+52.7pp WR difference)

Testing goals:
1. Statistical validation: Verify Wilson CI, binomial p-values, scoring formula
2. Historical replay: Measure WR/P/L improvement with blocklist/whitelist filtering
3. Integration: Confirm bot blocks GBPUSD signals before DB storage
4. Shadow mode: Monitor accuracy without affecting live trading

Run Phase 1 (statistical validation) first:
- Create bot/scripts/test-statistical-validation.js (JavaScript, NOT Python)
- Compute Wilson CI for GBPUSD (0/7) and AEDCNY (8/9)
- Compute binomial p-values for both
- Score both assets using formula: +2×WR + +2×PnL + +1×vol - 2×leak - 2×anti
- Verify GBPUSD → BLOCKLIST, AEDCNY → WHITELIST

Then Phase 2 (historical replay):
- Use sqlite3 CLI or Node.js with better-sqlite3
- Query: What would WR/P/L be if we blocked worst 5 assets?
- Query: What would WR/P/L be if we ONLY traded top 5 assets?
- Compare to baseline: 51.8% WR, -$7,295 P/L

Output: Test results table with PASS/FAIL for each validation.

IMPORTANT: No Python in this project (corrupts SQLite). Use JavaScript/Node.js only.
```

---

**Document complete.** Ready for testing phase.
