# Complete Pocket Option MCP Workflow

## System Architecture (2026-04-21)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CLAUDE DESKTOP (MCP Client)                        │
│                         User Interface + Agent System                       │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ stdio protocol (43 tools)
                                 ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                     POCKET-OPTION-MCP SERVER (Node.js)                      │
│                            src/server.js + 9 tool groups                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  Health Tools        │ po_health, po_market_state, po_tracked_assets        │
│  Intelligence Tools  │ po_scan_all, po_recommend, po_risk_check, bias       │
│  Analysis Tools      │ po_replay_candles, po_find_edge, po_simulate         │
│  Agent Tools         │ po_signal_context, po_drawdown_check, block/unblock  │
│  Order Tools         │ po_trade, po_mcp_orders, po_bot_orders, po_cancel    │
│  Performance Tools   │ po_trades_ordered, po_pnl_summary, po_rolling_summary│
│  Data Tools          │ po_candles, po_indicators, po_signals, po_prices     │
│  Validation Tools    │ po_qualified_assets, po_signal_outcomes              │
│  Asset Tools         │ po_asset_volatility, po_asset_streaks                │
└────────────┬──────────────────────────────────────────┬─────────────────────┘
             │                                          │
             ↓ READONLY                                 ↓ WRITABLE
┌────────────────────────────────┐      ┌──────────────────────────────────┐
│  BOT DB (trading_data.db)      │      │  MCP DB (mcp.db)                 │
│  Written by: Bot               │      │  Written by: MCP Server          │
│  Read by: MCP Server           │      │  Read by: Bot + MCP Server       │
├────────────────────────────────┤      ├──────────────────────────────────┤
│  Tables:                       │      │  Tables:                         │
│  • candles (OHLCV)             │      │  • mcp_orders (manual trades)    │
│  • prices (tick data)          │      │  • asset_controls (blocks)       │
│  • indicators (MA/RSI/BB/etc)  │      │  • agent_session_log (audit)     │
│  • signals (strategy output)   │      │                                  │
│  • orders_queue (bot signals)  │      │  Status Flow:                    │
│  • trades_ordered (results)    │      │  PENDING → bot claims            │
│  • qualified_assets (allow)    │      │  → EXECUTED/SKIPPED/FAILED       │
│  • signal_outcomes (validation)│      │                                  │
└────────────┬───────────────────┘      └──────────────┬───────────────────┘
             │                                         │
             └────────────────┬────────────────────────┘
                              ↓ Both DBs read by bot
┌─────────────────────────────────────────────────────────────────────────────┐
│                     POCKET-OPTION-BOT.JS (Puppeteer)                        │
│                         bot/pocket-option-bot.js                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  WebSocket Intercept  →  Parse market data  →  Write to trading_data.db    │
│  Strategy Pipeline    →  Calculate signals  →  Write to orders_queue       │
│  MCP Orders Worker    →  Poll mcp_orders    →  Execute PENDING orders      │
│  Order Executor       →  Click Puppeteer    →  Write to trades_ordered     │
│  Validation Worker    →  Check outcomes     →  Write to signal_outcomes    │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 ↓ controls browser via Puppeteer
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POCKET OPTION WEB PLATFORM                           │
│                     https://pocketoption.com/en/cabinet/                    │
│                         (live trading interface)                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                     SESSION MONITOR (Autonomous)                            │
│                   src/scripts/session-monitor.js                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  Every 2 min:  Loss Monitor  →  Block assets with 3 consecutive losses     │
│  Every 10 min: Unblock Sweep →  Unblock stale blocks if conditions pass    │
│  Reads: trading_data.db (trades_ordered)                                    │
│  Writes: mcp.db (asset_controls with source='session')                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Manual Trade (po_trade)

```
1. Claude Desktop
   User: "Trade EUR/USD CALL $1"
   ↓
2. MCP Server (src/tools/orders.js)
   po_trade → INSERT INTO mcp_orders (asset, direction, amount, status='PENDING')
   ↓
3. Bot MCP Worker (bot/pocket-option-bot.js L67-164)
   Polls: SELECT * FROM mcp_orders WHERE status='PENDING'
   ↓
4. Asset Block Check (L112-120)
   isAssetBlocked(asset) → checks mcp.db.asset_controls
   If blocked → UPDATE status='SKIPPED', SKIP execution
   If not blocked → proceed
   ↓
5. Atomic Claim (L100-108)
   UPDATE mcp_orders SET status='SKIPPED', reason='claimed-for-execution' WHERE id=? AND status='PENDING'
   (Transitional status prevents double-pickup)
   ↓
6. Execute Order (via order-executor.js)
   • calibrateTradingPanelIfNeeded() — set amount/expiration once per session
   • selectAsset() — switch chart to target asset
   • clickCallOrPut() — click CALL/PUT button via Puppeteer
   ↓
7. Write Result
   • shimDb.updateOrderStatus() → UPDATE mcp_orders SET status='EXECUTED'
   • shimDb.insertOrderedTradeClosed() → INSERT INTO trades_ordered (result, pnl)
   ↓
8. Claude reads result
   po_mcp_orders → SELECT * FROM mcp_orders WHERE id=?
   po_trades_ordered → SELECT * FROM trades_ordered WHERE order_id LIKE 'mcp-%'
```

---

## Data Flow: Bot-Generated Signal

```
1. Pocket Option WebSocket
   Market data (candles, prices) → bot intercepts via CDP (Chrome DevTools Protocol)
   ↓
2. Bot Message Queue Worker (bot/pocket-option-bot.js)
   processWebSocketMessage() → parse JSON payload
   messageTaskQueue prevents intensive operations from blocking execution worker
   ↓
3. Bot Database Writer (bot/database.js)
   insertCandle() → INSERT INTO candles (asset, timestamp, open, high, low, close, volume)
                    ON CONFLICT DO UPDATE (preserves candle.id for FK integrity)
   
   Price Batch Buffer → accumulates ticks, flushes every 10s or 200 items
   insertPriceBatch() → BEGIN IMMEDIATE; INSERT OR REPLACE INTO prices (asset, timestamp, price); COMMIT
   ↓
4. Indicator Calculator (bot/indicators.js)
   calculateAll(asset, candles, settings) →
   
   Video 2 Indicators (MODE D only):
   • ma1 = MA6 (SMA, period 6)
   • ma2 = MA50 (SMA, period 50) — NOT used in gates
   • ma3 = MA14 (SMA, period 14)
   • rsi_5 = RSI period 5
   • stochastic_k_v2, stochastic_d_v2 (Stochastic 5,3,3 — video2)
   • bb_upper, bb_middle, bb_lower (Bollinger Bands 20,2)
   • v2History = 10-bar lookback buffer for context checks
   
   INSERT INTO indicators (asset, timestamp, ma1, ma3, rsi_5, stochastic_k_v2, bb_upper, ...)
   ↓
5. Strategy Engine (bot/indicators.js _generateSignalsKTVideo2)
   
   4 Patterns: 2 Reversal + 2 Continuation (only Reversal patterns active in production)
   
   ════════════════════════════════════════════════════════════════════════════
   CALL REVERSAL: K Flash Crash Bounce (Strict + Relaxed variants)
   ════════════════════════════════════════════════════════════════════════════
   Strict Gates (all must pass):
     g1: K_crash >= 25 (k_1 - k_curr)  ← replay 2026-04-17: relaxed from 30
     g2: K_curr >= 25 AND < 30  ← session_report 2026-04-17: 25-30 landing zone = 58.9% WR
     g3: K_prev >= 50 (was in mid/high zone before crash)
     g4: RSI < 30  ← replay 2026-04-17: relaxed from <20 (pattern died at <20)
     g5: priceNearLowerBB (close <= lower + 15% of BB range)
     g6: bbStable (BB width not expanding/contracting > 5%)
     g7: BB width >= 10 bps  ← VALIDATED: <10 bps = 45.8% WR, -$3,580 P/L
   
   3-Bar Lookback Confirmation:
     • RSI stayed <45 for all 3 bars (no premature bounce)
     • K crash occurred within last 3-4 bars (not stale)
     • No premature K/D crossover during crash window
   
   Relaxed Gates (fallback if strict fails):
     Similar thresholds but allows slightly looser K/RSI conditions
   
   Streak Guard:
     Block if asset fired 3+ consecutive signals within 120s windows
     (prevents overtrading same setup)
   
   reasons = "OVERSOLD | Reversal | K crash 47.0pts (68.0->21.0) | RSI 28.3 (<45) | 
              Price near lower BB | BB stable | BB 12.3bps | UTC 14"
   
   ════════════════════════════════════════════════════════════════════════════
   PUT REVERSAL: Late Overbought Reversal (Strict + Relaxed variants)
   ════════════════════════════════════════════════════════════════════════════
   Strict Gates (all must pass):
     g0: RSI[-2] >= 80  ← session_report 2026-04-17: 88.9% WR at rsiFrom 80-82
     g1: RSI[-1] > 70 (was overbought prior bar)
     g2: Exclude RSI[-1] in [75,80) (fast drop zone = weak signal)
     g3: RSI falling, now in [38,70), exclude [55,65) (dead zone)
     g4: RSI velocity in [-15,-8]  ← session_report: golden band
     g5: K[-1] > 65, K falling, K_curr in [55,80)
     g6: D_curr >= 75 (lagging indicator still overbought)
     g7: K-D spread < -3 (K crossed below D)
     g8: close >= BB middle (price in upper half)
     g9: BB width >= 50 bps  ← session_debrief_2026-04-18 §12: bbW[10,30) is kill zone
   
   3-Bar Lookback Confirmation:
     • RSI stayed >70 for prior 2-3 bars (genuine overbought phase)
     • Stochastic remained overbought entire time (K > 65)
     • No early bullish K/D crossover during overbought phase
   
   Relaxed Gates:
     Slightly looser RSI/K thresholds but still requires RSI[-2] >= 80
   
   reasons = "OVERBOUGHT | Reversal | RSI 52.3 (from 78.4, vel=-13.2) | 
              K 67.8 (55-80, from 82.1) | D 78.9 (>=75) | K-D -11.1 (<-3) | 
              close >= BB mid | BB 52.3bps | UTC 15"
   
   ════════════════════════════════════════════════════════════════════════════
   CONTINUATION PATTERNS (DISABLED IN PRODUCTION — if (false) wrapper)
   ════════════════════════════════════════════════════════════════════════════
   CALL Continuation: Pre-cross uptrend
   PUT Continuation: Pre-cross downtrend
   (Not validated — low win rate in testing)
   ↓
6. Signal Writer (bot/indicators.js → bot/pocket-option-bot.js)
   INSERT INTO signals (asset, timestamp, direction, strategy_used, reasons)
   reasons stored as JSON array string
   ↓
7. Qualification Layer (DISABLED — useQualifiedAssetsLayer: false in STATE.SETTINGS)
   All signals proceed to orders_queue without qualification check
   No writes to qualified_assets, asset_streaks, or assets_trades tables
   ↓
8. Order Enqueuer (bot/pocket-option-bot.js processWebSocketMessage)
   INSERT INTO orders_queue (signal_id, asset, direction, status='PENDING', created_at)
   executionQueue.push({ database, order, config })
   ↓
9. Execution Worker (bot/pocket-option-bot.js runExecutionWorker)
   Runs asynchronously every cycle via setInterval
   Polls executionQueue, processes FIFO
   
   executeOneOrder(database, order, { page, execution, tradeAmount, ... }) →
     • Skip if asset blocked (checks MCP DB asset_controls)
     • Skip if duplicate live trade exists
     • Skip if status already EXECUTED/SKIPPED
     • calibrateTradingPanelIfNeeded() — set amount/expiration once per session
     • selectAsset(page, asset) — switch chart
     • clickCallOrPut(page, direction) — DOM click via Puppeteer
     • UPDATE orders_queue SET status='EXECUTED', executed_at, executed_price
   ↓
10. Result Sync Worker (bot/scripts/order-executor.js syncLiveTradeResultsFromDOM)
    Runs every 60s, polls Pocket Option "Closed" tab DOM
    
    For each deal row:
      • Parse asset, direction, result (WIN/LOSS), pnl, timestamp from DOM
      • Match to orders_queue via (asset + direction + hour:minute signature)
      • INSERT INTO trades_ordered (order_id, asset, direction, entry_price, exit_price, 
                                     result, profit_loss, entry_timestamp, exit_timestamp)
      • Prevents duplicates via _syncedDealSignatures Set (asset_direction_h:m_result)
   ↓
11. Validation Worker (bot/scripts/validate-signals.js validatePendingSignals)
    Runs every 60s via validation loop (enabled: STATE.SETTINGS.enableValidationLoop)
    
    For each signal past expiry (signal_timestamp + lookAheadSeconds < now):
      • Fetch entry candle: SELECT * FROM candles WHERE asset=? AND timestamp=?
      • Fetch exit price: getPriceAtTimestamp(asset, expirationTime, tolerance)
        Fallback: closest candle close within 60s window
      • Compute result: WIN if (direction=CALL AND exit > entry) OR (direction=PUT AND exit < entry)
      • Compute P/L: WIN = tradeAmount * 0.92, LOSS = -tradeAmount
      • INSERT INTO signal_outcomes (asset, signal_timestamp, signal_id, direction, 
                                      entry_price, exit_timestamp, exit_price, result, profit_loss)
    
    Does NOT write to qualified_assets, asset_streaks, or assets_trades
    (Those tables removed — MODE D gates ARE the qualification)
```

---

## Data Flow: Intelligence Tools (Multi-Layer Analysis)

```
1. Claude: "Recommend trades"
   ↓
2. MCP Server: po_recommend
   ↓
3. Core Intelligence (src/core/intelligence.js)
   
   Layer 1: Price Check
   SELECT price FROM prices WHERE asset=? ORDER BY timestamp DESC LIMIT 1
   Score: price exists → +14.3 pts
   
   Layer 2: Signal Freshness
   SELECT COUNT(*) FROM signals WHERE asset=? AND timestamp > now - 5min
   Score: recent signal → +14.3 pts
   
   Layer 3: Win Streak
   SELECT result FROM trades_ordered WHERE asset=? ORDER BY entry_timestamp DESC LIMIT 5
   Score: positive streak → +14.3 pts, negative → -14.3 pts
   
   Layer 4: Win Rate (20-trade window)
   SELECT AVG(CASE WHEN result='WIN' THEN 100 ELSE 0 END) FROM trades_ordered WHERE asset=? LIMIT 20
   Score: WR > 60% → +14.3 pts, WR < 40% → -14.3 pts
   
   Layer 5: Volatility (BB width)
   SELECT (bb_upper - bb_lower) / bb_middle * 10000 FROM indicators WHERE asset=? LIMIT 1
   Score: BB width >= 20 bps → +14.3 pts, < 10 bps → -28.6 pts (double penalty for dead zone)
   
   Layer 6: Recent Performance (today)
   SELECT SUM(CASE WHEN result='WIN' THEN 1 ELSE -1 END) FROM trades_ordered WHERE asset=? AND date=today
   Score: positive P/L → +14.3 pts
   
   Layer 7: Directional Bias
   po_asset_bias → CALL WR vs PUT WR delta
   Score: strong bias (delta > 20%) → +14.3 pts
   ↓
4. Filter + Rank
   • Precision filter: Only assets with WR > 55%
   • Min score: 50 / 100
   • Sort by: score DESC, recent_signal_count DESC
   ↓
5. Return to Claude
   [
     { asset: "EUR/USD", direction: "PUT", score: 85.7, confidence: "HIGH", wr: 65.2%, bias_delta: 22% },
     { asset: "GBP/USD", direction: "CALL", score: 71.4, confidence: "MEDIUM", wr: 58.3%, bias_delta: 15% }
   ]
```

---

## Data Flow: Analysis Tools (Backtesting)

```
1. Claude: "Find edge on EUR/USD signals"
   ↓
2. MCP Server: po_find_edge
   ↓
3. Core Analysis (src/core/analysis.js)
   
   Step 1: Fetch all validated signals
   SELECT s.*, o.result, o.entry_price, o.exit_price
   FROM signals s
   JOIN signal_outcomes o ON s.id = o.signal_id
   WHERE s.asset = 'EUR/USD'
   
   Step 2: Parse gate values from reasons string
   parsePatternFromReasons(signal.reasons) →
     { pattern: "K_Flash_Crash_Bounce",
       gates: { ma1: 0.91522, ma3: 0.91541, K_crash: 47, RSI: 18.3, ... }
     }
   
   Step 3: Dimension Breakdown (11 dimensions)
   
   a) RSI Range
      Group by: RSI < 20, [20-40), [40-60), [60-80), >= 80
      Aggregate: COUNT(*), SUM(result='WIN'), AVG(pnl)
      Output: "RSI < 20: 12 signals, 75% WR, +$45 P/L"
   
   b) Stochastic K Range
      Group by: K < 20, [20-40), [40-60), [60-80), >= 80
   
   c) MA Trend Gap (maTrendBps = (ma1-ma3)/ma3 * 10000)
      Group by: < -50, [-50,-20), [-20,0), [0,20), [20,50), >= 50
   
   d) BB Width Range (validated dimension)
      Group by: < 5, [5-10), [10-20), [20-50), >= 50 bps
      Critical finding: < 10 bps = 45.8% WR, -$3,580 P/L
   
   e) Hour of Day
      Group by: 0-23 (UTC or local TZ)
      Output: "Hour 14: 8 signals, 87.5% WR" (best performing hour)
   
   f) Direction (CALL vs PUT)
      Overall: PUT 59.8% WR vs CALL 42.1% WR
   
   g) Win Streak Context
      Group by: prior asset streak = 0, 1, 2, 3+
      Output: "After 2-win streak: 65% WR vs cold start 48% WR"
   
   h) Retracement Context (NEW — 2026-04-16 session report)
      For CALL: was price in lower 50% of BB at signal time?
      For PUT: was price in upper 50% of BB at signal time?
      Output: "CALL from lower half: 68% WR vs upper half: 38% WR"
   
   i) Price Position vs MA
      CALL: price < ma1 (oversold bounce) vs price > ma1
      PUT: price > ma1 (overbought reversal) vs price < ma1
   
   j) Stochastic Divergence (K-D spread)
      Group by: spread < -10, [-10,-5), [-5,0), [0,5), >= 5
   
   k) Pattern-Specific Gates
      For K_Flash_Crash: group by K_crash magnitude (25-35, 35-45, 45+)
      For Late_Overbought: group by RSI velocity (-20, -15, -10)
   ↓
4. Return Summary
   {
     total_signals: 135,
     overall_wr: 52.6%,
     by_rsi: [ { range: "<20", signals: 12, wr: 75.0, pnl: 45.0 }, ... ],
     by_bb_width: [ { range: "<10", signals: 48, wr: 45.8, pnl: -3580 }, ... ],
     by_hour: [ { hour: 14, signals: 8, wr: 87.5, pnl: 120 }, ... ],
     best_conditions: "RSI < 20 AND BB width >= 20 bps AND hour IN (13,14,15) → 82% WR"
   }
```

---

## Data Flow: Simulate Gates (Pre-Deployment Testing)

```
1. Claude: "Test raising K crash gate to 30 and RSI gate to 15"
   ↓
2. MCP Server: po_simulate
   params: { minKCrash: 30, maxCallRsi: 15, minBbWidthBps: 20 }
   ↓
3. Core Analysis (src/core/analysis.js)
   
   Step 1: Fetch all historical candles + indicators
   SELECT c.*, i.ma1, i.ma3, i.rsi_5, i.stochastic_k_v2, i.bb_upper, i.bb_lower, i.bb_middle
   FROM candles c
   JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
   ORDER BY asset, timestamp
   
   Step 2: Baseline Replay (current gates)
   For each candle window [t-3, t-2, t-1, t]:
     Apply MODE D CALL gates (original thresholds):
       g1: ma1 < ma3
       g2: K_prev - K_curr > 25  ← baseline
       g3: K_curr < 25
       g4: K_prev >= 50
       g5: RSI < 20  ← baseline
       g6: maTrendBps > -20
       g7: BB width >= 10 bps  ← baseline
     
     If ALL gates pass → fire signal
     Validate: next bar result = WIN/LOSS based on (close[t+1] > close[t]) for CALL
   
   Baseline Results:
     Signals: 135
     Wins: 71
     Losses: 64
     WR: 52.6%
     P/L: +$280
   
   Step 3: Modified Replay (new thresholds)
   For each candle window [t-3, t-2, t-1, t]:
     Apply MODE D CALL gates (modified):
       g2: K_prev - K_curr > 30  ← RAISED (filters weak crashes)
       g5: RSI < 15  ← TIGHTENED (deeper oversold only)
       g7: BB width >= 20 bps  ← RAISED (filters flat markets)
     
     If ALL gates pass → fire signal
     Validate: same next-bar logic
   
   Modified Results:
     Signals: 42  ← 93 signals filtered out
     Wins: 35
     Losses: 7
     WR: 83.3%  ← +30.7% improvement
     P/L: +$1,120  ← +$840 improvement
   ↓
4. Side-by-Side Comparison
   {
     baseline: { signals: 135, wr: 52.6, pnl: 280, filtered_out: 0 },
     modified: { signals: 42, wr: 83.3, pnl: 1120, filtered_out: 93 },
     delta: { signals: -93, wr: +30.7, pnl: +840 },
     verdict: "SIGNIFICANT IMPROVEMENT — stricter gates eliminate 69% of signals but boost WR by 30%",
     recommendation: "Deploy to bot/indicators.js after validating on live data for 1 session"
   }
```

---

## Data Flow: Asset Block (Autonomous Control)

```
1. Trigger: Session Monitor or Claude Command
   
   A) Session Monitor (autonomous — every 2 min)
      runLossMonitor() → detect 3 consecutive losses
      ↓
      INSERT INTO asset_controls (asset, action='BLOCK', source='session', reason='3 consecutive losses', active=1)
   
   B) Claude Manual Block
      User: "Block GBP/USD for 1 hour — choppy price action"
      po_block_asset(asset='GBP/USD', reason='choppy', duration_minutes=60)
      ↓
      expires_at = now + 60min
      INSERT INTO asset_controls (asset, action='BLOCK', source='manual', reason='choppy price action', expires_at, active=1)
   
   C) Agent Auto-Block (po_auto_block_check)
      po_auto_block_check() → scans all tracked assets
      For each asset:
        • Check BB width < 5 bps (dead market)
        • Check 2+ consecutive losses
        If either condition met:
          INSERT INTO asset_controls (asset, action='BLOCK', source='auto', reason='BB width 3.2 bps', active=1)
   ↓
2. Bot Reads Block Before Executing
   
   MCP Orders Worker (bot/pocket-option-bot.js L112-120):
   ```javascript
   const blockEntry = await isAssetBlocked(asset);
   if (blockEntry) {
     log(`[BLOCK] Order skipped — ${asset} blocked: ${blockEntry.reason}`);
     UPDATE mcp_orders SET status='SKIPPED', reason='asset-blocked'
     continue; // Skip execution
   }
   ```
   
   Bot Signal Executor (similar logic in order-executor.js):
   Same isAssetBlocked() check before executing bot-generated signals
   ↓
3. Unblock Flow
   
   A) Automatic Expiry
      isAssetBlocked() query includes:
      WHERE expires_at IS NULL OR expires_at > now
      → Expired blocks are ignored automatically (no UPDATE needed)
   
   B) Manual Unblock
      User: "Unblock GBP/USD"
      po_unblock_asset(asset='GBP/USD')
      ↓
      UPDATE asset_controls SET active=0 WHERE asset=? AND active=1
   
   C) Session Restart
      Session Monitor startup:
      clearSessionBlocks() →
      UPDATE asset_controls SET active=0 WHERE source='session'
      → All session blocks cleared on monitor restart
   
   D) Auto-Unblock Sweep (every 10 min)
      runUnblockSweep() → check all active blocks
      For each blocked asset:
        • BB width >= 10 bps? (volatility returned)
        • No consecutive losses?
        • Block age > 30 min? (cooled off)
        If all conditions pass:
          UPDATE asset_controls SET active=0 WHERE asset=?
```

---

## Tool Selection Decision Tree

```
START: What do you want to do?
│
├─ Check system health?
│  └─ po_health (always call first)
│     → bot liveness, DB row counts, latest data timestamps
│
├─ "What should I trade right now?"
│  └─ po_recommend (one call replaces many)
│     → 7-layer scoring + precision filter + ranked list
│     → includes WR, bias, volatility, streak
│
├─ "Is this specific trade safe?"
│  └─ po_risk_check(asset, direction)
│     → score 0-100 + verdict (GOOD/CAUTION/RISKY/AVOID)
│     → checks qualification, streak, volatility, bias
│
├─ Research why signals win/lose?
│  ├─ po_find_edge(asset, direction, days)
│  │  → 11-dimension breakdown (RSI, BB, hour, pattern, etc)
│  └─ po_replay_candles(asset, hours, summary=true)
│     → full historical replay with context (all 4 patterns)
│
├─ Test gate changes before deploying?
│  └─ po_simulate(modifiedGates)
│     → baseline vs modified side-by-side
│     → shows signal count delta, WR delta, P/L delta
│
├─ Find best gate thresholds?
│  └─ po_optimize_gates(gateRanges)
│     → grid search across all combinations
│     → ranks by WR, shows signal count tradeoff
│
├─ Place a trade manually?
│  ├─ po_risk_check(asset, direction) first
│  └─ po_trade(asset, direction, amount)
│     → writes to mcp_orders, bot executes
│
├─ Check trade results?
│  ├─ po_mcp_orders() — manual orders status
│  ├─ po_trades_ordered() — executed trades with WIN/LOSS
│  └─ po_pnl_summary() — P/L by asset
│
├─ Block/unblock assets?
│  ├─ po_asset_volatility() — find flat assets
│  ├─ po_auto_block_check() — auto-block bad assets
│  ├─ po_block_asset(asset, reason, duration)
│  └─ po_unblock_asset(asset)
│
├─ Analyze performance trends?
│  ├─ po_rolling_summary(days=0) — all-time WR
│  ├─ po_hourly_breakdown() — best trading hours
│  └─ po_performance(days=7) — daily table
│
└─ Multi-agent orchestration?
   ├─ Scanner: po_scan_all → ranked assets
   ├─ Analyst: po_signal_context → full snapshot
   │           po_asset_bias → directional edge
   └─ Executor: po_drawdown_check → safety gate
                po_session_log_write → audit trail
```

---

## Critical Validation Facts (Do Not Ignore)

### Validated Gates (2026-04-16 Session Report)

**BB Width < 10 bps = Losing Zone:**
- 48 signals fired in BB width < 10 bps range
- Win rate: 45.8% (22 wins, 26 losses)
- P/L: -$3,580
- **Gate raised to 20 bps in bot/indicators.js** (g7 for both CALL and PUT)

**Flat Asset Identification:**
- BB width < 5 bps = dead/pegged market
- Must be checked dynamically (volatility changes over time)
- Use `po_asset_volatility()` to identify, then `po_block_asset()`
- No static block list maintained — volatility fluctuates

**RSI Gate Tightening:**
- Original CALL gate: RSI < 40 (too permissive)
- **Tightened to RSI < 20** (deeply oversold only) — validated improvement

**PUT Pattern g0 Addition:**
- New gate: RSI[-2] > 80 (genuine prior overbought confirmation)
- Filters false signals where RSI never reached true overbought
- Reduces noise in Late_Overbought_Reversal pattern

### Indicator Mapping (MODE D Only)

**Moving Averages:**
- `ma1` = MA6 (fast — early trend catch)
- `ma3` = MA14 (slow — trend confirmation)
- `ma2` = MA50 (NOT used in MODE D gates — display only)

**maTrendBps = (ma1 - ma3) / ma3 × 10000**
- Positive = uptrend (MA6 > MA14)
- Negative = downtrend (MA6 < MA14)
- Used in gates: CALL g6 (maTrendBps > -20), PUT g7 (maTrendBps < 20)

**Stochastic:**
- Use `stochastic_k_v2` / `stochastic_d_v2` (video2 config: 5,3,3)
- NOT `stochastic_k` / `stochastic_d` (video1 config: 13,3,3)

### Qualification Layer

**Status: DISABLED**
- `useQualifiedAssetsLayer: false` in bot config
- Every signal that passes MODE D gates proceeds to orders_queue
- No asset qualification check before execution
- Manual orders bypass qualification entirely (`skipQualifiedGate: true`)

### Directional Bias

**Baseline Win Rates:**
- PUT: 59.8% WR (stronger edge)
- CALL: 42.1% WR (weaker edge)
- **Recommendation:** Favor PUT signals in `po_recommend` scoring

---

## File Modification Rules

### READONLY — Never Touch
```
socket_option/determ/*
  └─ Original source — modifications not tracked by git
```

### ALL Bot Modifications Go Here
```
pocket-option-mcp/bot/*
  ├─ pocket-option-bot.js   ← MCP worker, execution logic
  ├─ indicators.js          ← MODE D gates (BB width, RSI, K crash thresholds)
  ├─ database.js            ← Schema, inserts
  └─ scripts/
      ├─ order-executor.js  ← Puppeteer clicks, validation
      └─ validate-signals.js ← Signal outcome logic
```

### MCP Server Core
```
pocket-option-mcp/src/
  ├─ server.js              ← Tool registration
  ├─ bot-db.js / mcp-db.js  ← Dual-DB connections
  ├─ core/                  ← Business logic (intelligence, analysis, agent-tools)
  └─ tools/                 ← Tool wrappers (call core/, return to MCP)
```

### Data Persistence
```
pocket-option-mcp/data/
  ├─ trading_data.db        ← Bot writes, MCP reads (READONLY from MCP)
  └─ mcp.db                 ← MCP writes, bot reads (orders/blocks/logs)
```

---

## Deployment Checklist

### Before Changing Gates
1. `po_health` → confirm bot is live
2. `po_replay_candles(asset, hours=24, summary=true)` → get baseline
3. `po_find_edge(asset)` → identify weak dimensions
4. `po_simulate(modifiedGates)` → test changes on historical data
5. If WR improvement > 10% and signal count > 20 → proceed

### After Changing Gates
1. Sync changes to `bot/indicators.js`
2. Restart bot process
3. Monitor for 1 full session (4-6 hours)
4. `po_rolling_summary(days=0)` → compare before/after WR
5. `po_pnl_summary()` → check P/L impact
6. If degradation → revert immediately

### Session Startup Routine
1. Start bot: `node bot/pocket-option-bot.js`
2. Start monitor: `node src/scripts/session-monitor.js`
3. `po_health` → verify both DBs accessible
4. `po_auto_block_check()` → block flat/losing assets
5. `po_recommend()` → get initial trade suggestions

### Session Shutdown Routine
1. `po_pnl_summary()` → record session P/L
2. `po_session_log_read()` → review agent decisions
3. `po_find_edge()` → analyze today's signals for new insights
4. Stop monitor (Ctrl+C) → clears session blocks on next restart
5. Stop bot (Ctrl+C)

---

## Emergency Procedures

### Bot Crashed / Not Responding
```bash
# 1. Check process
ps aux | grep pocket-option-bot

# 2. Kill if frozen
pkill -f pocket-option-bot

# 3. Check DB lock
sqlite3 data/trading_data.db "PRAGMA integrity_check;"

# 4. Restart bot
node bot/pocket-option-bot.js

# 5. Verify via MCP
po_health
```

### Database Corruption
```bash
# NEVER use Python sqlite3 — corrupts WAL mode
# Use sqlite3 CLI only:

sqlite3 data/trading_data.db "PRAGMA integrity_check;"
sqlite3 data/mcp.db "PRAGMA integrity_check;"

# If corruption detected:
# 1. Stop bot + monitor
# 2. Backup:
cp data/trading_data.db data/trading_data.db.backup
# 3. Rebuild from backup or re-scrape
```

### Runaway Losses
```bash
# 1. Block all assets immediately
po_block_asset('ALL', reason='emergency-stop', duration_minutes=60)

# 2. Check what's trading
po_trades_ordered(limit=20, asset='ALL')

# 3. Review session log
po_session_log_read(limit=50)

# 4. Analyze losing pattern
po_find_edge(asset='problem-asset', days=1)

# 5. Tighten gates or disable pattern
# Edit bot/indicators.js → wrap pattern in `if (false)` to disable
```

### Stale Data / Feed Lag
```sql
-- Bot has guards for stale prices (60sec) and stale indicators (5min)
-- Check latest timestamps:

SELECT asset, MAX(timestamp) as latest, 
       (strftime('%s','now') - MAX(timestamp)) as age_sec
FROM prices 
GROUP BY asset 
HAVING age_sec > 60;

-- If multiple assets stale → WebSocket connection dropped
-- Restart bot to reconnect
```

---

*End of Complete Workflow Documentation*
*Last Updated: 2026-04-21 07:23 UTC*
*Validated Against: pocket-option-mcp main branch, MODE D strategy only*
