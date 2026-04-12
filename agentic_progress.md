---
name: agentic MCP progress
description: Session 2 progress — intelligence layer, analysis engine, MODE D precision scoring, candle replay backtesting
type: project
---

## Session 2: Making MCP Agentic + AI Analysis

### What Was Built

#### Phase 1: Intelligence Layer (src/core/intelligence.js + src/tools/intelligence.js)
4 new tools that aggregate data across all assets into scored, actionable insights:

- **po_scan_all** — Scans all 77 assets in parallel, scores each by indicator precision (7 layers), returns ranked list
- **po_recommend** — Filters scan results by qualification + fresh signal + win rate + streak → ranked trade picks
- **po_risk_check** — Pre-trade risk audit: qualification, streak, recent form, signal match, drawdown → score 0-100 + verdict
- **po_market_state** — Overall market health: active assets, signal frequency, today's P/L, top assets, all-time stats

**Scoring algorithm** (initial — based on luck metrics like streaks/qualification):
Score = qualified(25) + fresh_signal(30) + streak(15) + win_rate(20) + form(10)

**IMPORTANT**: User corrected this — qualification layer is disabled in bot (useQualifiedAssetsLayer: false). Every signal trades regardless. Streaks are backward-looking luck, not edge. Intelligence layer needs to score based on MODE D indicator precision, not luck metrics.

#### Phase 2: Analysis Engine (src/core/analysis.js + src/tools/analysis.js)
4 new tools using candle-by-candle replay (same approach as tests/test_patterns.js):

- **po_replay_candles** — Replay ALL historical candles bar-by-bar, fire simulated MODE D signals, validate against next candle close
- **po_replay_signal** — Reconstruct ALL gate values for a specific historical signal (RSI, K crash, MA gaps, lookback values)
- **po_find_edge** — Analyze all replayed signals: win rate by RSI range, stoch range, MA gap, hour, asset, direction
- **po_optimize_gates** — Grid search over gate thresholds (RSI, K crash, D level, MA gap, RSI velocity)

**Key design decisions:**
- Uses stochastic_k_v2 / stochastic_d_v2 (video2 5,3,3) NOT stochastic_k/stochastic_d (video1 13,3,3)
- Column mapping: ma1=MA6, ma2=MA50, ma3=MA14
- Validates against NEXT candle close (same as test_patterns.js)
- Tracks gate rejections (which gates filter most candles)
- Reads from live trading_data.db (not determ backup DBs)

### MODE D Strategy (Only Active Strategy — Modes A/B/C Disabled)

**CALL — K Flash Crash Bounce** (6 gates, validated 61.5% WR, 8W/5L on 13 signals):
- Gate 1: ma6 < ma14 < ma50 (bearish stack — counter-trend)
- Gate 2: K_prev - K_curr > 25 (K crashed 25+ pts in one bar)
- Gate 3: K_curr < 25 (oversold)
- Gate 4: K_prev >= 50 (crashed from mid/high, not already oversold)
- Gate 5: RSI_curr < 40 (RSI confirms pullback)
- Gate 6: MA14-MA50 gap > -20 bps (not deeply bearish)
- Plus: candle must be green, RSI < 80 (not exhausted), streak < 3

**PUT — Late Overbought** (7 gates, validated 68.4% WR, 26W/12L on 38 signals):
- Gate 1: RSI_-2 > 70 AND RSI_-1 > 70, EXCLUDE RSI_-1 in [75,80) (fast-drop zone = 0% WR)
- Gate 2: RSI_curr falling, in [38,70), EXCLUDE [55,65) (death zone), velocity > -12, close >= BB midline
- Gate 3: K_prev > 65, K_curr in [55,80) falling (exiting overbought)
- Gate 4: D_curr >= 80 (D lagging high — 67% WR vs 21% WR if D < 80)
- Gate 5: ma6 > ma14 > ma50 (bullish stack — reversal from peak)
- Gate 6: K < D AND K-D spread < -3 (confirmed cross, not whipsaw)
- Gate 7: MA14-MA50 gap < 20 bps (not strong uptrend — >= 20 bps = 25-37% WR)
- Plus: candle must be red, streak < 3

### Current Tool Count: 31 (23 original + 4 intelligence + 4 analysis)

### What's Missing (from test_patterns.js audit)
- Multi-DB aggregation (test_patterns reads 5 determ DBs: ap5, ap5v1, ap7, ap7v1, ap9)
- Gap flag reporting (signals where next candle is missing)
- Gate effectiveness table (which gates do most filtering, what if removed)
- Avg win / avg loss (payoff ratio, not just win rate)
- Full chronological signal listing
- Per-DB breakdown

### Critical Rules
- NEVER write to socket_option/determ/ — read-only source
- All bot modifications go in pocket-option-mcp/bot/
- Bot DB path: determ/data/trading_data.db (MCP needs PO_DB_PATH env var to point there)
- MCP DB path: pocket-option-mcp/data/mcp.db
- Qualification layer is DISABLED (useQualifiedAssetsLayer: false) — every signal trades
- Modes A, B, C are DISABLED (if (false)) — only MODE D fires

### File Changes (Session 2)
- NEW: src/core/intelligence.js — scan_all, recommend, risk_check, market_state
- NEW: src/tools/intelligence.js — register 4 intelligence tools
- NEW: src/core/analysis.js — replay_candles, replay_signal, find_edge, optimize_gates
- NEW: src/tools/analysis.js — register 4 analysis tools
- NEW: scripts/reset-db.js — database reset with backup
- NEW: docs/workflow.md — full system workflow documentation
- MODIFIED: src/server.js — imports, registrations, updated instructions (23 to 31 tools)
