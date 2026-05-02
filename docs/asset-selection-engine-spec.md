# Dynamic Asset Selection Engine — Technical Documentation

**Document Type:** Implementation Specification & Review Document  
**Created:** 2026-05-02  
**Session:** e5c68912-9fd1-4ac2-b964-803172505b1a  
**Status:** ⏳ Awaiting Review & Approval  
**Objective:** Build a self-adaptive asset whitelisting/blocking system based on rolling performance, statistical confidence, volatility structure, and gate compliance.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Architecture Overview](#architecture-overview)
4. [Implementation Phases](#implementation-phases)
5. [Component Specifications](#component-specifications)
6. [Integration Details](#integration-details)
7. [Testing & Validation](#testing--validation)
8. [Deployment Strategy](#deployment-strategy)
9. [Success Metrics](#success-metrics)
10. [Risks & Mitigations](#risks--mitigations)
11. [Open Questions for Review](#open-questions-for-review)

---

## Executive Summary

This document specifies a **dynamic asset-selection system** that will automatically identify and block losing assets while prioritizing winning ones, based on live trading performance from the pocket-option-mcp bot.

### Current Problem
After analyzing 199 live trades from Apr 29-30, 2026:
- **Overall performance:** 51.8% WR, -$7,295 P/L
- **Worst performers:** GBPUSD (0% WR, -$3,500), TNDUSD (22.2%), YERUSD (28.6%), GBPJPY (36.4%)
- **Best performers:** AEDCNY (88.9% WR, +$2,695), USDMXN (83.3%, +$1,545), USDCHF (77.8%)
- **Key insight:** Asset selection matters more than gate optimization (+52.7pp WR difference top 5 vs bottom 5)

### Proposed Solution
Implement an autonomous engine that:
1. **Tracks rolling performance** per asset (50-trade windows)
2. **Validates statistical significance** (Wilson CI, binomial p-values)
3. **Scores assets dynamically** based on WR, P/L, volatility, and gate compliance
4. **Classifies into tiers:** WHITELIST (score ≥+3), NEUTRAL (0-2), BLOCKLIST (≤-1)
5. **Blocks signals automatically** for BLOCKLIST assets before execution
6. **Updates continuously** (session start + every 20 trades)

### Expected Impact
| Metric | Current (Baseline) | Blocklist Mode | Whitelist-Only Mode |
|---|---|---|---|
| **Win Rate** | 51.8% | 58-62% | 70-75% |
| **P/L** | -$7,295 | -$1,000 to +$500 | +$2,000 to +$8,000 |
| **Signals/day** | ~200 | ~140-160 | ~40-50 |
| **Assets traded** | 51 | 40-45 | 5-10 |

### Implementation Timeline
- **Phase 1-2 (2-3 hours):** Core engine + statistical functions
- **Phase 3-4 (2-3 hours):** Data collection + scoring logic
- **Phase 5 (1 hour):** Bot integration hooks
- **Phase 6-7 (2 hours):** Admin tools + testing
- **Phase 8 (4 weeks):** Staged deployment (shadow → blocklist → full)

**Total estimated time:** 8-10 hours of focused development

---

## Problem Statement

Current bot trades all 51 tracked assets equally, leading to:
- **GBPUSD_otc**: 0/7 WR, -$3,500 (statistically validated loser, p=0.0078)
- **TNDUSD_otc, YERUSD_otc, GBPJPY_otc**: 22-36% WR, -$8,035 combined
- **Top 5 assets**: 79.5% WR, +$8,090

**Solution:** Dynamic asset scoring system that automatically whitelists winners and blocks losers based on live performance.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Trading Bot (bot/)                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  1. WebSocket → Candles → Indicators → Signal         │  │
│  │  2. Signal generated                                   │  │
│  │  3. ✨ NEW: Asset Selection Filter ✨                 │  │
│  │     ├─ Load asset score from asset_performance table  │  │
│  │     ├─ Check tier: WHITELIST / NEUTRAL / BLOCKLIST    │  │
│  │     └─ If BLOCKLIST → skip signal                     │  │
│  │  4. Qualified assets check (existing, if enabled)     │  │
│  │  5. Execute trade                                      │  │
│  │  6. ✨ NEW: Update asset stats after validation ✨    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│          Asset Selection Engine (bot/asset-selection.js)     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Rolling Performance Tracker                           │  │
│  │  ├─ Window: last 50 trades per asset                  │  │
│  │  ├─ Metrics: WR, P/L, leak_rate, median_BB            │  │
│  │  └─ Update: session start + every 20 trades           │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Statistical Confidence Engine                         │  │
│  │  ├─ Wilson CI (95%)                                    │  │
│  │  ├─ Binomial p-value vs 50%                           │  │
│  │  └─ Edge validation (p < 0.10)                        │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Volatility Structure Analyzer                         │  │
│  │  ├─ Median BB width                                    │  │
│  │  ├─ Win BB mean vs loss BB mean                       │  │
│  │  └─ Volatility score (+1 / 0 / -1)                    │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Gate Leak Detector                                    │  │
│  │  ├─ Track STC/K violations per direction              │  │
│  │  ├─ Leak rate % (violations / total trades)           │  │
│  │  └─ Leak penalty (-1 / -2)                            │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Dynamic Scoring System                                │  │
│  │  score = +2×WR + +2×PnL + +1×vol - 2×leak - 2×anti    │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  Classification Engine                                 │  │
│  │  ├─ score ≥ +3 → WHITELIST (Tier 1)                   │  │
│  │  ├─ score 0-2 → NEUTRAL (Tier 2)                      │  │
│  │  └─ score ≤ -1 → BLOCKLIST (Tier 3)                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│        Database: trading_data.db (data/)                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ✨ NEW TABLE: asset_performance                      │  │
│  │  ├─ asset (TEXT PRIMARY KEY)                          │  │
│  │  ├─ tier (TEXT: WHITELIST/NEUTRAL/BLOCKLIST)          │  │
│  │  ├─ score (REAL)                                       │  │
│  │  ├─ n_trades (INTEGER)                                 │  │
│  │  ├─ win_rate (REAL)                                    │  │
│  │  ├─ pnl_total (REAL)                                   │  │
│  │  ├─ leak_rate (REAL)                                   │  │
│  │  ├─ median_bb (REAL)                                   │  │
│  │  ├─ ci_lower / ci_upper (REAL)                        │  │
│  │  ├─ p_value (REAL)                                     │  │
│  │  ├─ last_updated (INTEGER)                             │  │
│  │  └─ version (INTEGER, for rolling window tracking)    │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  EXISTING: trades_ordered (for stats computation)     │  │
│  │  EXISTING: signals (for leak detection)               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Database + Stats Module)
**Goal:** Build foundation for asset performance tracking

**Files to create:**
1. `bot/asset-selection.js` — Core engine module
2. `bot/scripts/init-asset-selection.js` — One-time DB setup + seed with historical data

**Database schema:**
```sql
CREATE TABLE IF NOT EXISTS asset_performance (
    asset TEXT PRIMARY KEY,
    tier TEXT DEFAULT 'NEUTRAL',
    score REAL DEFAULT 0,
    n_trades INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    pnl_total REAL DEFAULT 0,
    leak_rate REAL DEFAULT 0,
    median_bb REAL DEFAULT 0,
    ci_lower REAL DEFAULT 0,
    ci_upper REAL DEFAULT 0,
    p_value REAL DEFAULT 0.5,
    last_updated INTEGER DEFAULT 0,
    version INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for tier-based queries
CREATE INDEX IF NOT EXISTS idx_asset_tier ON asset_performance(tier);

-- Index for score-based rankings
CREATE INDEX IF NOT EXISTS idx_asset_score ON asset_performance(score DESC);
```

**Core module structure (`bot/asset-selection.js`):**
```javascript
class AssetSelectionEngine {
    constructor(db) {
        this.db = db; // TradingDatabase instance
        this.WINDOW_SIZE = 50; // rolling window size
        this.UPDATE_INTERVAL = 20; // update every N trades
        this.tradeCount = 0;
    }
    
    // ─────────────────────────────────────────────────────
    // 1. ROLLING PERFORMANCE TRACKER
    // ─────────────────────────────────────────────────────
    async getRollingStats(asset) { ... }
    async updateAssetStats(asset) { ... }
    
    // ─────────────────────────────────────────────────────
    // 2. STATISTICAL CONFIDENCE ENGINE
    // ─────────────────────────────────────────────────────
    computeWilsonCI(wins, n, confidence = 0.95) { ... }
    computeBinomialPValue(wins, n, p0 = 0.5) { ... }
    
    // ─────────────────────────────────────────────────────
    // 3. VOLATILITY STRUCTURE ANALYZER
    // ─────────────────────────────────────────────────────
    async getVolatilityScore(asset, stats) { ... }
    
    // ─────────────────────────────────────────────────────
    // 4. GATE LEAK DETECTOR
    // ─────────────────────────────────────────────────────
    async getLeakPenalty(asset, stats) { ... }
    
    // ─────────────────────────────────────────────────────
    // 5. DYNAMIC SCORING SYSTEM
    // ─────────────────────────────────────────────────────
    computeAssetScore(stats, volScore, leakPenalty) { ... }
    
    // ─────────────────────────────────────────────────────
    // 6. ASSET CLASSIFICATION ENGINE
    // ─────────────────────────────────────────────────────
    classifyAsset(score) { ... }
    
    // ─────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────
    async isAssetAllowed(asset) { ... }
    async refreshAllAssets() { ... }
    async onTradeValidated(trade) { ... }
}
```

---

### Phase 2: Statistical Functions Implementation
**Goal:** Implement all mathematical/statistical components

**Statistical functions to implement:**

1. **Wilson Score Confidence Interval** (accurate for small samples):
```javascript
computeWilsonCI(wins, n, confidence = 0.95) {
    if (n === 0) return { lower: 0, upper: 1 };
    
    const p = wins / n;
    const z = confidence === 0.95 ? 1.96 : 2.576; // 95% or 99%
    
    const denominator = 1 + z * z / n;
    const center = p + z * z / (2 * n);
    const offset = z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n)));
    
    return {
        lower: (center - offset) / denominator,
        upper: (center + offset) / denominator
    };
}
```

2. **Binomial P-Value** (two-tailed test vs 50%):
```javascript
computeBinomialPValue(wins, n, p0 = 0.5) {
    if (n === 0) return 1.0;
    
    // Use normal approximation for n ≥ 5
    const p = wins / n;
    const se = Math.sqrt(p0 * (1 - p0) / n);
    const z = (p - p0) / se;
    
    // Two-tailed p-value (we care if WR ≠ 50%, not just > 50%)
    return 2 * (1 - this._normalCDF(Math.abs(z)));
}

_normalCDF(z) {
    // Standard normal CDF approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
}
```

3. **Median calculation** (for BB width):
```javascript
median(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
        ? (sorted[mid - 1] + sorted[mid]) / 2 
        : sorted[mid];
}
```

---

### Phase 3: Data Collection Layer
**Goal:** Gather rolling stats from trades_ordered and signals tables

**Key queries to implement:**

1. **Rolling performance (last 50 trades per asset):**
```sql
SELECT 
    COUNT(*) as n,
    SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
    SUM(profit_loss) as pnl
FROM trades_ordered
WHERE asset = ?
ORDER BY entry_timestamp DESC
LIMIT 50
```

2. **BB width distribution (wins vs losses):**
```sql
SELECT 
    t.result,
    -- Parse bb_bps from signals.reasons JSON
    -- Need to join trades → signals → extract bb_bps from reasons array
FROM trades_ordered t
JOIN signals s ON t.signal_id = s.id
WHERE t.asset = ?
ORDER BY t.entry_timestamp DESC
LIMIT 50
```

3. **Gate leak detection:**
```sql
SELECT 
    t.direction,
    s.reasons,
    COUNT(*) as total,
    -- Count violations where:
    --   CALL: stc > 25 OR k >= 50
    --   PUT: stc < 75 OR k <= 50
FROM trades_ordered t
JOIN signals s ON t.signal_id = s.id
WHERE t.asset = ?
GROUP BY t.direction
ORDER BY t.entry_timestamp DESC
LIMIT 50
```

**Challenge:** `signals.reasons` is JSON array of strings. Need parser:
```javascript
parseIndicatorsFromSignal(reasonsJSON) {
    // Example: ["STC_CALL_REVERSAL: stc=6.1 prev=4.2 ... bbBps=28.7"]
    const reasons = JSON.parse(reasonsJSON);
    if (!reasons || reasons.length === 0) return null;
    
    const str = reasons[0];
    const stcMatch = str.match(/stc=([\d.]+)/);
    const kMatch = str.match(/k=([\d.]+)/);
    const bbBpsMatch = str.match(/bbBps=([\d.]+)/);
    
    return {
        stc: stcMatch ? parseFloat(stcMatch[1]) : null,
        k: kMatch ? parseFloat(kMatch[1]) : null,
        bb_bps: bbBpsMatch ? parseFloat(bbBpsMatch[1]) : null
    };
}
```

---

### Phase 4: Scoring & Classification Logic
**Goal:** Implement the dynamic scoring formula

**Scoring formula:**
```javascript
computeAssetScore(stats, volScore, leakPenalty) {
    const { n, win_rate, pnl, ci_lower, p_value } = stats;
    
    // Minimum trades required for scoring (else neutral)
    if (n < 5) return 0;
    
    // ─── WR Score (+2 / 0 / -2) ───
    let wrScore = 0;
    if (win_rate >= 0.60) wrScore = +2;
    else if (win_rate >= 0.40) wrScore = 0;
    else wrScore = -2;
    
    // ─── P/L Score (+2 / -2) ───
    const pnlScore = pnl > 0 ? +2 : -2;
    
    // ─── Volatility Score (+1 / 0 / -1) ───
    // volScore passed in from getVolatilityScore()
    
    // ─── Leak Penalty (-1 / -2 / 0) ───
    // leakPenalty passed in from getLeakPenalty()
    
    // ─── Anti-Edge Penalty (-2 if significant loser) ───
    let antiEdgePenalty = 0;
    if (p_value < 0.10 && ci_upper < 0.50) {
        antiEdgePenalty = -2; // Statistically validated loser
    }
    
    // ─── Total Score ───
    const score = wrScore + pnlScore + volScore - leakPenalty - antiEdgePenalty;
    
    return score;
}

classifyAsset(score) {
    if (score >= 3) return 'WHITELIST';
    if (score >= 0) return 'NEUTRAL';
    return 'BLOCKLIST';
}
```

**Example scoring scenarios:**

| Asset | WR | P/L | Med BB | Leak | p-val | WR_sc | PnL_sc | Vol_sc | Leak | Anti | Total | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AEDCNY | 88.9% | +$2,695 | 32.9 | 0% | 0.0195 | +2 | +2 | +1 | 0 | 0 | **+5** | WHITELIST |
| USDMXN | 83.3% | +$1,545 | 37.5 | 0% | 0.1094 | +2 | +2 | +1 | 0 | 0 | **+5** | WHITELIST |
| GBPUSD | 0% | -$3,500 | 17.9 | 33% | 0.0078 | -2 | -2 | -1 | -2 | -2 | **-9** | BLOCKLIST |
| CADJPY | 42.9% | -$705 | 26.4 | 25% | 0.50 | 0 | -2 | -1 | -1 | 0 | **-4** | BLOCKLIST |
| Neutral | 52% | +$100 | 25 | 5% | 0.80 | 0 | +2 | 0 | 0 | 0 | **+2** | NEUTRAL |

---

### Phase 5: Bot Integration
**Goal:** Hook asset selection engine into signal generation flow

**Integration points:**

1. **Initialization (bot startup):**
```javascript
// In pocket-option-bot.js, after database init
const { AssetSelectionEngine } = require('./asset-selection');
const assetEngine = new AssetSelectionEngine(database);

// Seed asset_performance table with historical data (run once)
await assetEngine.initializeFromHistory();

// Refresh all asset scores at session start
await assetEngine.refreshAllAssets();
```

2. **Pre-signal filter (in WebSocket handler, after indicators calculated):**
```javascript
// In pocket-option-bot.js, after indicators calculated but before signal stored
if (indicatorData.signals && indicatorData.signals.direction !== 'NEUTRAL') {
    // Check if asset is allowed
    const allowed = await assetEngine.isAssetAllowed(data.asset);
    
    if (!allowed) {
        log(`   🚫 Asset ${data.asset} is BLOCKLISTED — skipping signal`, 'red');
        continue; // Skip signal entirely, don't store in DB
    }
    
    // Existing signal storage logic continues...
}
```

3. **Post-trade update (after trade validation):**
```javascript
// In bot/scripts/validate-signals.js, after setting trade result
await assetEngine.onTradeValidated({
    asset: trade.asset,
    result: trade.result,
    profit_loss: trade.profit_loss
});

// Triggers:
// - Increment trade counter
// - If counter % UPDATE_INTERVAL === 0: refreshAsset(asset)
```

**Settings addition:**
```javascript
// In pocket-option-bot.js STATE.SETTINGS
assetSelection: {
    enabled: true,               // Master switch
    updateInterval: 20,          // Refresh every N trades
    windowSize: 50,              // Rolling window size
    minTrades: 5,                // Min trades before classification
    blockOnStartup: true,        // Block BLOCKLIST assets immediately
    whitelistOnly: false         // If true, only trade WHITELIST assets
}
```

---

### Phase 6: Monitoring & Admin Tools
**Goal:** Visibility and control over asset selection

**Admin script: `bot/scripts/asset-admin.js`**
```javascript
// Usage: node bot/scripts/asset-admin.js [command] [options]
// 
// Commands:
//   list              - Show all assets with scores/tiers
//   refresh [asset]   - Recalculate score for one or all assets
//   whitelist [asset] - Manually override to WHITELIST
//   block [asset]     - Manually override to BLOCKLIST
//   reset [asset]     - Clear manual override
//   history [asset]   - Show score history over time
```

**Logging additions:**
```javascript
// Log asset selection decisions
log(`   📊 Asset Selection: ${asset} → ${tier} (score=${score.toFixed(1)}, WR=${(wr*100).toFixed(1)}%, n=${n})`, 'cyan');

// Log tier changes
log(`   🔄 Asset tier changed: ${asset} ${oldTier} → ${newTier} (score ${oldScore.toFixed(1)} → ${newScore.toFixed(1)})`, 'yellow');

// Log blocklist hits
log(`   🚫 Signal blocked: ${asset} is ${tier} (score=${score.toFixed(1)})`, 'red');
```

**Dashboard query (for MCP tool: `po_asset_rankings`):**
```sql
SELECT 
    asset,
    tier,
    score,
    n_trades,
    ROUND(win_rate * 100, 1) as wr_pct,
    pnl_total,
    ROUND(leak_rate * 100, 1) as leak_pct,
    ROUND(median_bb, 1) as bb,
    ROUND(ci_lower * 100, 1) as ci_low,
    ROUND(ci_upper * 100, 1) as ci_high,
    ROUND(p_value, 4) as p_val
FROM asset_performance
WHERE n_trades >= 5
ORDER BY tier ASC, score DESC
```

---

### Phase 7: Testing & Validation
**Goal:** Verify engine works correctly before live deployment

**Test suite: `bot/scripts/test-asset-selection.js`**

Test cases:
1. **Statistical accuracy:**
   - Wilson CI for GBPUSD (0/7) = [0%, 35.4%]
   - Wilson CI for AEDCNY (8/9) = [56.5%, 98.0%]
   - Binomial p-value for GBPUSD = 0.0078
   - Binomial p-value for AEDCNY = 0.0195

2. **Scoring accuracy:**
   - AEDCNY: 88.9% WR, +$2,695, 32.9 bps → score = +5, WHITELIST
   - GBPUSD: 0% WR, -$3,500, 17.9 bps, 33% leak → score = -9, BLOCKLIST
   - 50% WR, +$100, 25 bps → score = +2, NEUTRAL

3. **Rolling window:**
   - Add 51st trade → oldest trade drops out
   - Verify stats recalculate correctly

4. **Tier transitions:**
   - Asset starts NEUTRAL (score +2)
   - 3 consecutive losses → score drops to -2 → BLOCKLIST
   - Bot stops generating signals for that asset

5. **Integration test:**
   - Mock WebSocket signal for GBPUSD
   - Verify signal is blocked (not stored in DB)
   - Mock signal for AEDCNY
   - Verify signal passes through

---

### Phase 8: Deployment & Monitoring
**Goal:** Roll out to production with safeguards

**Deployment steps:**

1. **Week 1: Shadow mode**
   - Engine runs in background
   - Logs decisions but doesn't block signals
   - Monitor accuracy: how many blocklist assets still win?

2. **Week 2: Blocklist only**
   - Enable blocking for BLOCKLIST tier only
   - WHITELIST and NEUTRAL still trade equally
   - Verify blocklist eliminates bad assets (GBPUSD, TNDUSD, etc.)

3. **Week 3: Full mode**
   - If whitelistOnly=true, only trade WHITELIST assets
   - Monitor P/L improvement vs baseline

4. **Week 4+: Auto-pilot**
   - Engine fully autonomous
   - Weekly review of tier changes
   - Manual intervention only for outliers

**Safeguards:**

1. **Min trades threshold:** Don't classify assets with < 5 trades (stay NEUTRAL)
2. **Confidence floor:** If CI is too wide (upper - lower > 0.5), keep NEUTRAL
3. **Manual override:** Admin can force WHITELIST/BLOCKLIST for 7 days
4. **Revalidation:** Every 100 trades, re-check all assets (catch regime shifts)

---

## File Structure

```
pocket-option-mcp/
├── bot/
│   ├── asset-selection.js          ← Core engine (NEW)
│   ├── pocket-option-bot.js        ← Modified (integration hooks)
│   ├── database.js                 ← Modified (add asset_performance table)
│   └── scripts/
│       ├── init-asset-selection.js ← DB setup + historical seed (NEW)
│       ├── asset-admin.js          ← Admin CLI tool (NEW)
│       ├── test-asset-selection.js ← Test suite (NEW)
│       └── validate-signals.js     ← Modified (post-trade hook)
├── data/
│   └── trading_data.db             ← Modified (new table: asset_performance)
└── src/
    └── tools/
        └── asset-tools.js          ← MCP tools: po_asset_rankings, po_asset_score (NEW)
```

---

## Success Metrics

**After deployment, track:**

1. **Asset distribution:**
   - How many assets in each tier? (Target: 5-10 WHITELIST, 5-10 BLOCKLIST)
   
2. **Signal reduction:**
   - Blocklist mode: signals reduced by ~20-30% (41 bad trades / 199 total)
   - Whitelist-only mode: signals reduced by ~80% (only 39 top trades / 199 total)

3. **Performance improvement:**
   - Overall WR increase: 51.8% baseline → target 60-70%
   - P/L improvement: -$7,295 baseline → target +$2,000 to +$8,000

4. **Tier stability:**
   - How often do assets change tiers? (Target: < 10% per week after initial convergence)

5. **Statistical validation:**
   - % of BLOCKLIST assets with p < 0.10 (should be high)
   - % of WHITELIST assets with p < 0.10 (should be high)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Overfitting to Apr 29-30 data** | Engine blocks assets that recover | Use 50-trade rolling window (spans multiple sessions) |
| **Sample size too small** | Wide confidence intervals, unstable scores | Require min 10 trades before BLOCKLIST, 20 before WHITELIST |
| **Regime shift invalidates historical stats** | Top assets start losing | Revalidate every 100 trades, detect WR drops, auto-demote |
| **Manual intervention disrupts learning** | Admin blocks a good asset | Log all overrides, expire after 7 days, alert if overridden asset would be WHITELIST |
| **Engine blocks ALL assets during bad regime** | Bot stops trading entirely | Safeguard: always keep ≥ 5 assets in WHITELIST or NEUTRAL |
| **Gate leak detection is noisy** | False positives on leak penalty | Require leak_rate > 10% (not just 1-2 violations) |

---

## Next Steps

1. **Immediate:** Review plan, confirm approach is sound
2. **Phase 1-2:** Build core engine + statistical functions (2-3 hours)
3. **Phase 3-4:** Implement data collection + scoring (2-3 hours)
4. **Phase 5:** Integrate with bot (1 hour)
5. **Phase 6-7:** Admin tools + testing (2 hours)
6. **Phase 8:** Deploy in shadow mode, monitor for 1 week

**Total estimated time:** 8-10 hours of focused development

---

---

## Open Questions for Review

Before proceeding with implementation, the following design decisions need stakeholder review:

### 1. Volatility Threshold Calibration
**Question:** Should we use 30 bps as the high-volatility cutoff, or calibrate dynamically from recent data?

**Options:**
- **Fixed 30 bps:** Simple, matches existing gate logic
- **Dynamic (rolling median + 1 std dev):** Adapts to changing market conditions
- **Asset-specific:** Each asset has its own threshold based on historical distribution

**Recommendation:** Start with fixed 30 bps for simplicity, add dynamic calibration in Phase 2 (after 2 weeks of live data).

---

### 2. Update Frequency
**Question:** Is 20 trades (~4-8 hours of live trading) the right refresh interval?

**Considerations:**
- Too frequent (e.g., every 5 trades): Unstable scores, over-reactive
- Too infrequent (e.g., every 50 trades): Slow to adapt to regime changes
- Current proposal: 20 trades = ~1 session's worth of data

**Recommendation:** 20 trades is reasonable. Monitor tier change frequency; if > 20% of assets change tiers per refresh, increase to 30-40 trades.

---

### 3. Default Operating Mode
**Question:** Should whitelist-only mode be the default, or start with blocklist-only?

**Options:**
- **Blocklist-only (recommended):** Block confirmed losers (GBPUSD, TNDUSD, YERUSD), trade everything else
  - Lower risk, easier to validate
  - Expected impact: +6-10pp WR improvement
- **Whitelist-only:** Only trade top 5-10 assets
  - Higher potential gains, but signal count drops 80%
  - Risk: miss new emerging winners

**Recommendation:** Start with blocklist-only in Week 2 deployment. Enable whitelist-only as opt-in setting for experienced users.

---

### 4. Manual Override Expiry
**Question:** Should manual asset overrides (admin forcing WHITELIST/BLOCKLIST) expire automatically?

**Options:**
- **Expire after 7 days:** Forces re-evaluation, prevents stale overrides
- **Persist until manually removed:** Admin has full control
- **Expire on tier change:** If engine wants to change tier, alert admin and revert override

**Recommendation:** Expire after 7 days with notification. This balances automation with human oversight.

---

### 5. Cross-Asset Learning
**Question:** Should we cluster similar assets (e.g., all GBP pairs) and share performance signals?

**Use case:** If GBPUSD fails with 0% WR and high leak rate, should we:
- Auto-downgrade GBPJPY, GBPCHF, EURGBP to NEUTRAL?
- Apply stricter scoring penalties to all GBP pairs?

**Options:**
- **No clustering (recommended for v1):** Each asset scored independently
- **Soft clustering:** GBP pairs share a "currency family" penalty (e.g., -0.5 to score)
- **Hard clustering:** Block entire family if majority are BLOCKLIST

**Recommendation:** No clustering in v1 (keep it simple). Revisit after 4 weeks if we see clear family patterns.

---

## Review Checklist

Before implementation approval, confirm:

- [ ] **Scope:** Is the 8-phase plan reasonable, or should we start with a minimal MVP?
- [ ] **Integration risk:** Will pre-signal filtering break existing qualification logic?
- [ ] **Performance:** Will DB queries (rolling 50 trades + indicator parsing) slow down signal generation?
- [ ] **Data quality:** Are we confident the 199-trade dataset is representative (not cherry-picked days)?
- [ ] **Rollback plan:** If engine blocks all assets or tanks performance, how do we revert?

---

## Next Steps

1. **Stakeholder review** of this document (estimated 30-60 minutes)
2. **Resolve open questions** (volatility threshold, update frequency, etc.)
3. **Approve implementation plan** or request modifications
4. **Phase 1 kickoff:** Build core engine + database schema (2-3 hours)

**Document status:** ⏳ Awaiting approval

**Last updated:** 2026-05-02
