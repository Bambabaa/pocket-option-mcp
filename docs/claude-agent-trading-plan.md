# Claude Agent Trading System — Implementation Plan

**Date:** 2026-05-17  
**Status:** Draft — For Review  
**Scope:** Fully independent Claude CLI-driven scan-and-trade system targeting 5–15 minute expiries. Zero dependency on the existing bot or its database. Bot remains optional and can run in parallel for 1m trading.

---

## 1. Background & Motivation

### Problem with Current Architecture
The existing bot (`pocket-option-bot.js`) is fully autonomous: it processes 1-minute WebSocket candles, fires signals when indicator gates pass, and immediately places 1–2 minute trades. Claude (via MCP) is a read-only analyst layer on top of 1-minute data.

Three fundamental blockers for a Claude-driven 5–15m system:
1. **Wrong timeframe** — `trading_data.db` holds 1m candles and indicators. No 5m/15m data exists anywhere in the stack
2. **No analysis window** — 1–2m expiries give Claude zero time to scan and decide before expiry
3. **Execution dependency** — trade placement currently routes through the bot's DOM automation; if the bot is down, Claude cannot trade

### Solution: Fully Independent Agent System
Build a self-contained stack — own WebSocket feed, own database, own indicator engine, own execution — that requires nothing from the existing bot. The bot stays available for 1m trading if wanted but is not a dependency.

### Research Basis
- **PocketOptionAPI (ChipaDevTeam):** Confirmed Pocket Option exposes a WebSocket trading API with per-order `duration` parameter — direct execution without DOM automation
- **Timeframe validation (2026-05-17 EdgeFinder sim, 498 signals):** CALL builds to 51.6% WR at 5m. Key assets show delayed-winner profiles: GBPJPY (83% at 5m), NZDJPY (80% at 10m), USDIDR (67% at 5m), USDJPY (75% at 10m) — unsuitable for 1–2m, strong at 5–15m
- **Polymarket/agents reference:** LLM scan-loop architecture confirmed viable; identified critical gap (zero risk gates) that this system addresses

---

## 2. Architecture Overview

```
╔══════════════════════════════════════════════════════════════════╗
║                  EXISTING SYSTEM (optional)                      ║
║  pocket-option-bot.js                                            ║
║  → 1m WebSocket → trading_data.db → 1m signals → bot trades     ║
║  (runs independently, no connection to new system)               ║
╚══════════════════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════════════════╗
║               NEW INDEPENDENT AGENT SYSTEM                       ║
║                                                                  ║
║  ┌─────────────────────────────────────────────────────────┐    ║
║  │  agent-ws.js  (always-on data + execution service)      │    ║
║  │                                                          │    ║
║  │  WS IN  → tick prices                                   │    ║
║  │         → aggregate to 5m candles                       │    ║
║  │         → compute indicators (STC/BB/Stoch/CCI)         │    ║
║  │         → write to agent.db                             │    ║
║  │                                                          │    ║
║  │  WS OUT ← reads agent_orders (PENDING)                  │    ║
║  │         → send trade WS message to Pocket Option        │    ║
║  │         → update agent_orders (EXECUTED/FAILED)         │    ║
║  └──────────────────────┬──────────────────────────────────┘    ║
║                         │ read/write                             ║
║  ┌──────────────────────▼──────────────────────────────────┐    ║
║  │  data/agent.db                                           │    ║
║  │  candles · indicators · agent_orders · agent_log  │    ║
║  └──────────────────────┬──────────────────────────────────┘    ║
║                         │ read/write                             ║
║  ┌──────────────────────▼──────────────────────────────────┐    ║
║  │  MCP Server (src/server.js) — new agent tools           │    ║
║  │  po_agent_candles · po_agent_indicators · po_agent_scan │    ║
║  │  po_agent_trade · po_agent_orders · po_agent_log        │    ║
║  └──────────────────────┬──────────────────────────────────┘    ║
║                         │ stdio                                  ║
║  ┌──────────────────────▼──────────────────────────────────┐    ║
║  │  Claude CLI  (/loop every 5–10 min)                     │    ║
║  │                                                          │    ║
║  │  SCANNER   → po_agent_scan (ranked shortlist)           │    ║
║  │  ANALYST   → po_agent_indicators (safe zone check)      │    ║
║  │  EXECUTOR  → po_agent_trade (write PENDING order)       │    ║
║  │  VALIDATOR → po_agent_orders (check closed outcomes)    │    ║
║  └─────────────────────────────────────────────────────────┘    ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 3. Component Specifications

### Component 1 — WebSocket Client (`src/scripts/agent-ws.js`)

**Purpose:** Always-on service. Handles all real-time data collection and trade execution. Runs independently of the bot.

**Responsibilities:**

*Data side (WS IN):*
- Connect to Pocket Option WebSocket using the same endpoint + auth pattern as the existing bot
- Subscribe to price streams for shortlisted assets only (configurable list)
- Accumulate incoming ticks into 5m OHLC bars (bar completes at each 5-minute boundary)
- On bar completion: trigger indicator calculation → write candle + indicators to `agent.db`
- Reconnect automatically on disconnect

*Execution side (WS OUT):*
- Poll `agent_orders` table every 2 seconds for PENDING rows
- For each PENDING order: send trade placement message via WebSocket to Pocket Option with correct `duration` (expiry_seconds from order row)
- Update order status to EXECUTED, FAILED, or SKIPPED
- After expiry elapses: resolve WIN/LOSS from next price tick, write result to `agent_orders`

**Config (loaded from `agents/shortlist.json`):**
```json
{
  "assets": ["GBPJPY_otc", "USDJPY_otc", "EURJPY_otc", "NZDJPY_otc",
             "USDCOP_otc", "USDIDR_otc", "USDPKR_otc", "JODCNY_otc"],
  "candle_interval_minutes": 5,
  "max_concurrent_trades": 2
}
```

---

### Component 2 — Agent Database (`data/agent.db`)

**Purpose:** Single source of truth for all 5m data, orders, and decisions. MCP reads from it, agent-ws.js writes to it.

**Schema:**

```sql
-- 5-minute OHLC candles
CREATE TABLE candles (
    asset      TEXT    NOT NULL,
    timestamp  INTEGER NOT NULL,   -- unix seconds, bar open time
    open       REAL    NOT NULL,
    high       REAL    NOT NULL,
    low        REAL    NOT NULL,
    close      REAL    NOT NULL,
    PRIMARY KEY (asset, timestamp)
);

-- Computed indicators for each completed 5m bar
-- All 14 indicators at bot/indicators.js defaults — discover what works at 5m via data
CREATE TABLE indicators (
    asset              TEXT    NOT NULL,
    timestamp          INTEGER NOT NULL,
    -- SMA (PO defaults: 10, 20, 50)
    sma_10             REAL,
    sma_20             REAL,
    sma_50             REAL,
    -- EMA (PO defaults: 12, 26)
    ema_12             REAL,
    ema_26             REAL,
    -- RSI (Wilder, PO default period=14)
    rsi_14             REAL,
    -- MACD (fast=12, slow=26, signal=9)
    macd_line          REAL,
    macd_signal        REAL,
    macd_histogram     REAL,
    -- Bollinger Bands (period=20, stdDev=2)
    bb_upper           REAL,
    bb_middle          REAL,
    bb_lower           REAL,
    bb_width_bps       REAL,
    -- Stochastic (K=5, D=3, smooth=3)
    stoch_k            REAL,
    stoch_d            REAL,
    stoch_prev_d       REAL,
    -- Keltner Channel (PO default: ema=20, atr=10, mult=2)
    keltner_upper      REAL,
    keltner_middle     REAL,
    keltner_lower      REAL,
    -- Zig Zag (PO default: deviation=5%, minBars=4)
    zigzag_direction   INTEGER,   -- +1 up, -1 down
    zigzag_reversal    INTEGER,   -- 1 if this bar is a pivot
    zigzag_pivot       REAL,      -- price at last pivot
    -- Schaff Trend Cycle (PO default: emaFast=23, emaSlow=50, cycle=10, smooth1=3, smooth2=3)
    stc_value          REAL,
    stc_signal         REAL,
    stc_prev           REAL,
    stc_delta          REAL,
    -- ADX (period=14)
    adx                REAL,
    plus_di            REAL,
    minus_di           REAL,
    -- CCI (PO default period=20)
    cci_20             REAL,
    -- Williams %R (period=14)
    williams_r         REAL,
    -- ATR (period=14)
    atr_14             REAL,
    -- Parabolic SAR (acceleration=0.02, max=0.2)
    psar_value         REAL,
    psar_trend         INTEGER,   -- +1 bullish, -1 bearish
    psar_is_bullish    INTEGER,   -- 1 / 0
    PRIMARY KEY (asset, timestamp)
);

-- Trade orders placed by Claude
CREATE TABLE agent_orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    asset          TEXT    NOT NULL,
    direction      TEXT    NOT NULL CHECK(direction IN ('CALL','PUT')),
    amount         REAL    NOT NULL,
    expiry_seconds INTEGER NOT NULL DEFAULT 300,   -- 5m default
    signal_ts      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    executed_at    INTEGER,
    closed_at      INTEGER,
    entry_price    REAL,
    exit_price     REAL,
    status         TEXT    NOT NULL DEFAULT 'PENDING'
                           CHECK(status IN ('PENDING','EXECUTED','CLOSED','FAILED','CANCELLED')),
    result         TEXT    CHECK(result IN ('WIN','LOSS','DRAW',NULL)),
    profit_loss    REAL,
    cycle_id       TEXT    -- links order to the scan cycle that created it
);

CREATE INDEX idx_agent_orders_status ON agent_orders(status, created_at);
CREATE INDEX idx_agent_orders_asset  ON agent_orders(asset);

-- Full audit log of every Claude decision (trade and no-trade)
CREATE TABLE agent_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id   TEXT    NOT NULL,   -- uuid per loop cycle
    cycle_ts   INTEGER NOT NULL,
    asset      TEXT,
    decision   TEXT    NOT NULL CHECK(decision IN ('TRADE','SKIP','PAUSE','STOP')),
    direction  TEXT,
    expiry_min INTEGER,
    score      REAL,
    reason     TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

---

### Component 3 — Indicator Engine (`src/core/indicators-5m.js`)

**Purpose:** Pure math module. Takes an array of 5m OHLC bars, returns all indicator values for the latest bar. No DB access — stateless computation.

**Design principle:** Capture every indicator at Pocket Option's platform defaults — the values you see when you drop the indicator onto the chart without touching anything. No tuning, no exclusions. All values land in `indicators` so Claude can discover which ones have predictive power at the 5m timeframe through actual trading data.

> **Note:** These differ from the bot's `INDICATOR_CONFIG`, which was hand-tuned for 1m trading (RSI=5, CCI=8, STC=10/20/5, Keltner=18/11/2, ZigZag=0.5%). For the 5m system we use PO platform defaults so the data matches what traders see on the chart.

**All 14 indicators — Pocket Option platform defaults:**

| Indicator | Method | PO Platform Default Parameters | Output columns |
|---|---|---|---|
| SMA (fast) | `calculateSMA` | period = **10** | `sma_10` |
| SMA (mid) | `calculateSMA` | period = **20** | `sma_20` |
| SMA (slow) | `calculateSMA` | period = **50** | `sma_50` |
| EMA | `calculateEMA` | period = **12**, **26** | `ema_12`, `ema_26` |
| RSI | `calculateRSI` | period = **14**, Wilder smoothing | `rsi_14` |
| MACD | `calculateMACD` | fast=**12**, slow=**26**, signal=**9** | `macd_line`, `macd_signal`, `macd_histogram` |
| Bollinger Bands | `calculateBollingerBands` | period=**20**, stdDev=**2** | `bb_upper`, `bb_middle`, `bb_lower`, `bb_width_bps` |
| Stochastic | `calculateStochastic` | K=**5**, D=**3**, smooth=**3** | `stoch_k`, `stoch_d`, `stoch_prev_d` |
| Keltner Channel | `calculateKeltnerChannel` | ema=**20**, atr=**10**, mult=**2** | `keltner_upper`, `keltner_middle`, `keltner_lower` |
| Zig Zag | `calculateZigZag` | deviation=**5%**, minBars=**4** | `zigzag_direction`, `zigzag_reversal`, `zigzag_pivot` |
| Schaff Trend Cycle | `calculateSchaffTrendCycle` | emaFast=**23**, emaSlow=**50**, cycle=**10**, smooth1=**3**, smooth2=**3** | `stc_value`, `stc_signal`, `stc_prev`, `stc_delta` |
| ADX | `calculateADX` | period = **14** | `adx`, `plus_di`, `minus_di` |
| CCI | `calculateCCI` | period = **20** | `cci_20` |
| Williams %R | `calculateWilliamsR` | period = **14** | `williams_r` |
| ATR | `calculateATR` | period = **14** | `atr_14` |
| Parabolic SAR | `calculateParabolicSAR` | acceleration=**0.02**, max=**0.2** | `psar_value`, `psar_trend`, `psar_is_bullish` |

**Extraction approach:** Pull each `calculate*` method out of `bot/indicators.js` as pure exported functions. The bot continues importing from its own file unchanged. `indicators-5m.js` calls the same math functions with PO-default parameters on 5m bar arrays — no duplication of math, different parameters and timeframe.

---

### Component 4 — New MCP Tools

**Purpose:** Claude's interface to the agent system. Six new tools registered in `src/server.js`, reading from `agent.db`.

| Tool | What it does |
|---|---|
| `po_agent_candles` | Last N 5m candles for an asset |
| `po_agent_indicators` | Latest 5m indicator values for one or all shortlisted assets |
| `po_agent_scan` | Score all shortlisted assets by indicator state — ranked list with safe-zone verdict |
| `po_agent_trade` | Enqueue a trade: writes PENDING to `agent_orders`, agent-ws.js executes |
| `po_agent_orders` | View agent order history (filter by status, asset, result) |
| `po_agent_log` | Read Claude's decision audit log (current session or all-time) |

**`po_agent_scan` output (per asset):**
```
asset         GBPJPY_otc
stc_value     18.4          ← in CALL floor zone (≤25)
stc_delta     +4.2          ← curling up
bb_width_bps  32            ← active market
stoch_k       22.1          ← in OS zone
direction     CALL
score         3/4 gates
verdict       GO
expiry_min    10            ← delayed-winner profile
```

---

### Component 5 — Claude Scan Loop

**Purpose:** Claude's decision cycle. Runs every 5–10 minutes via `/loop`.

**Cycle structure:**

```
Every 5-10 minutes:
│
├── 1. SESSION CHECK
│      po_agent_orders → count open trades (max 2 concurrent)
│      po_agent_log    → recent decisions (avoid repeating same asset)
│      If 2 open trades → sleep, skip this cycle
│
├── 2. SCAN
│      po_agent_scan → ranked list of shortlisted assets with verdicts
│      Drop: score < 3/4 gates, bb_width_bps < 10, verdict ≠ GO
│
├── 3. ANALYSE TOP CANDIDATE
│      po_agent_indicators(asset) → full indicator state
│      Confirm: STC zone, stoch alignment, CCI position
│      Check: no EXECUTED order on this asset within last expiry window
│
├── 4. DECIDE
│      GO  → po_agent_trade(asset, direction, amount, expiry_min)
│             po_agent_log write: TRADE decision + reasoning
│      SKIP → po_agent_log write: SKIP + reason
│
└── 5. VALIDATE (every 3rd cycle)
       po_agent_orders → check CLOSED orders since last cycle
       WIN/LOSS outcomes → adjust: block asset on 2+ consecutive losses
       Session P&L negative → reduce amount or pause
```

**Safe zone — hard gates (all must pass for GO):**

| Gate | Condition |
|---|---|
| Volatility | `bb_width_bps ≥ 10` |
| STC zone | CALL: `stc_value ≤ 25` + `stc_delta > 0` / PUT: `stc_value ≥ 75` + `stc_delta < 0` |
| Stochastic | Aligned with STC direction (K in OS for CALL, OB for PUT) |
| Concurrent limit | `open_trades < 2` |
| Asset cooldown | No order on this asset in the last `expiry_seconds` |
| Session health | No 3+ consecutive losses this session |

**Expiry profile per asset (from 5m/10m WR data):**

| Profile | Condition | Expiry |
|---|---|---|
| Delayed winner | 2m WR < 50%, 5m WR ≥ 60% | 10 min |
| Quick reversal | 2m WR ≥ 65%, decays after 3m | 5 min |
| Consistent | WR stable across 2m–10m | 7 min |
| Default | | 5 min |

**Initial shortlist with profiles (from 2026-05-17 EdgeFinder sim):**

| Asset | 2m WR | 5m WR | 10m WR | Profile | Expiry |
|---|---|---|---|---|---|
| GBPJPY_otc | 33% | 83% | 67% | Delayed winner | 10m |
| NZDJPY_otc | 40% | 60% | 80% | Delayed winner | 10m |
| USDIDR_otc | 17% | 67% | 67% | Delayed winner | 10m |
| USDJPY_otc | 67% | 67% | 75% | Consistent | 7m |
| EURJPY_otc | 60% | 60% | 70% | Consistent | 7m |
| USDCOP_otc | 60% | 60% | 70% | Consistent | 7m |
| USDPKR_otc | 88% | 75% | 50% | Quick reversal | 5m |
| JODCNY_otc | 83% | 75% | 46% | Quick reversal | 5m |

---

## 4. File Structure

```
pocket-option-mcp/
│
├── agent/                               ← self-contained agent system
│   │
│   ├── websocket/                       ← all WS + indicator logic lives here
│   │   ├── client.js                    NEW — WS connect/auth, live stream, backfill mode
│   │   ├── indicators.js                NEW — 14 indicators at PO defaults (pure math)
│   │   └── config.json                  NEW — assets, candle period, gate params, expiry profiles
│   │
│   └── data/                            ← agent's own isolated data store
│       └── agent.db                     NEW — candles, indicators,
│                                               agent_orders, agent_log
│
├── src/                                 ← existing MCP server (add agent tools here)
│   ├── server.js                        MODIFIED — register 6 new po_agent_* tools
│   ├── agent-connection.js              NEW — SQLite connection to agent/data/agent.db
│   └── core/
│       └── agent-tools.js               NEW — po_agent_scan, po_agent_indicators,
│                                               po_agent_trade, po_agent_orders, etc.
│
├── data/                                ← existing bot data (untouched)
│   ├── trading_data.db                  UNCHANGED — bot's DB (readonly to MCP)
│   └── mcp.db                           UNCHANGED — MCP orders/blocks/logs
│
├── agents/
│   ├── scan-agent.md                    NEW — Claude loop prompt + decision rules
│   ├── market-scanner.md                existing
│   ├── trade-analyst.md                 existing
│   └── trade-executor.md               existing
│
└── docs/
    └── claude-agent-trading-plan.md     this file
```

**Key separation:** Everything the agent owns lives under `agent/`. The `websocket/` subdir holds both the live/backfill client and the indicator engine — they belong together because the WS client is the only process that ever calls the indicators. The `data/` subdir keeps the DB co-located with what writes to it. The existing `src/` and `data/` directories are untouched except for the new MCP tool registration.

---

## 5. Build Sequence

### Phase 1 — Data Foundation
**Goal:** 5m candles and indicators flowing into `agent/data/agent.db`

1. Create `agent/data/agent.db` schema (all four tables)
2. Build `agent/websocket/indicators.js` — extract all 14 `calculate*` methods from `bot/indicators.js` as pure exports, apply PO-default parameters
3. Build `agent/websocket/config.json` — asset shortlist, candle_interval_minutes, gate params, expiry profiles
4. Build `agent/websocket/client.js`:
   - **Live mode:** WS connect + auth → tick stream → 5m OHLC aggregation → on bar close: compute indicators → write candles + indicators → reconnect loop
   - **Backfill mode** (`--backfill`): request historical 5m candles from PO WS API for each configured asset → compute indicators on full array → write to agent.db → exit
5. Run `node agent/websocket/client.js --backfill` for all 10 shortlisted assets, verify candles + indicators populate

### Research Step — Validate Edge Before Going Live
**Goal:** Find which indicator gates produce a real edge at 5m/10m/15m expiry

6. Run backtest sim on `agent/data/agent.db` (dedicated research script, reads agent.db only):
   - Scan each bar for indicator zone conditions (STC floor/ceiling, RSI, Stoch, CCI, BB width)
   - Compute WIN/LOSS using next-bar close prices from candles
   - Output WR by: asset, direction, expiry (5m/10m/15m), indicator zone, confluence count
7. Identify load-bearing gates → set validated thresholds in `agent/websocket/config.json`
8. Do not proceed to Phase 2 until edge confirmed (WR ≥ 55%, n ≥ 50 per asset)

### Phase 2 — MCP Tools
**Goal:** Claude can read agent.db and scan assets

9. Build `src/agent-connection.js` — SQLite readonly connection to `agent/data/agent.db`
10. Build `src/core/agent-tools.js`:
    - `po_agent_candles` — last N 5m bars for asset
    - `po_agent_indicators` — latest indicator row per asset
    - `po_agent_scan` — score all shortlisted assets, return ranked list with verdicts
11. Register tools in `src/server.js`
12. Test: Claude calls `po_agent_scan` and gets live 5m data

### Phase 3 — Execution
**Goal:** Claude can place trades that execute directly on Pocket Option

13. Add `agent_orders` polling loop to `agent/websocket/client.js`:
    - Every 2s: SELECT PENDING from agent_orders
    - Send WS trade message with asset, direction, amount, duration
    - Update status → EXECUTED + entry_price
    - After expiry: resolve WIN/LOSS from next price tick → update result + profit_loss
14. Build `po_agent_trade` MCP tool — validates params, writes PENDING to agent_orders
15. Build `po_agent_orders` + `po_agent_log` tools
16. Register remaining tools in `src/server.js`
17. Test: Claude places a trade → client.js executes → result recorded in agent.db

### Phase 4 — Scan Loop Agent
**Goal:** Claude runs autonomously on a 5–10 minute cycle

18. Write `agents/scan-agent.md` — Claude's full loop prompt (scan → analyse → decide → log)
19. Test full loop: `/loop` → scan → safe zone check → trade placed → validated next cycle

---

## 6. What the Existing Bot Keeps Doing (Optional)

If the bot is running alongside:
- Continues collecting 1m candles/indicators into `trading_data.db`
- Continues its own 1m signal pipeline (separate, no interference)
- The existing MCP tools (`po_scan_all`, `po_indicators`, etc.) still work on 1m data
- `mcp.db` (manual orders, blocks, session logs) still usable for 1m manual trades

If the bot is not running:
- New agent system operates fully independently
- No data is missing — agent-ws.js is the sole data source
- No execution dependency — `agent/websocket/client.js` handles trade placement directly via WS API

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Pocket Option WS auth changes | Mirror bot's auth pattern exactly; keep bot as reference |
| 5m candle data too thin on startup | Require minimum 30 bars (150 min) before agent starts placing trades |
| WS trade placement API differs from data API | Validate via ChipaDevTeam PocketOptionAPI reference; test on demo account first |
| Claude analysis latency > 5m (misses the zone) | Pre-compute verdicts in `po_agent_scan`; Claude confirms, not re-evaluates from scratch |
| Two systems trading same asset | Shortlist assets disjoint from bot's primary assets, or block in bot via `asset_controls` |
| Agent.db write contention (agent-ws + MCP reads) | agent-ws.js as sole writer; MCP in readonly mode on agent.db |

---

## 8. Success Metrics

| Milestone | Measure |
|---|---|
| Phase 1 complete | `agent.db` populating with 5m candles + indicators for all 8 shortlisted assets |
| Phase 2 complete | `po_agent_scan` returns live ranked list with GO/SKIP verdicts |
| Phase 3 complete | First live trade placed via Claude → executed by agent-ws.js → WIN/LOSS recorded |
| Steady state | ≥30 closed trades on shortlisted assets; 5m WR ≥ 55%; session log audit complete |
