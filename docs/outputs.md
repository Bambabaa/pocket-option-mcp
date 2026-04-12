# Output Reference

Every tool and CLI command returns JSON. This document shows the exact shape of each response so you know what fields to expect and what they mean.

All timestamps are **unix seconds (UTC)** unless noted. Prices are raw floats in the asset's native quote currency.

---

## Health

### `po_health` / `po health`

```json
{
  "success": true,
  "bot_db_path": "/path/to/trading_data.db",
  "bot_db_accessible": true,
  "mcp_db_path": "/path/to/data/mcp.db",
  "mcp_db_accessible": true,
  "mcp_order_count": 3,
  "candle_count": 14820,
  "price_count": 298441,
  "signal_count": 203,
  "bot_order_count": 87,
  "qualified_asset_count": 2,
  "latest_price": {
    "asset": "EURUSD_otc",
    "price": 1.08423,
    "timestamp": 1744300812
  },
  "latest_candle": {
    "asset": "EURUSD_otc",
    "timestamp": 1744300800
  },
  "latest_price_age_seconds": 4,
  "bot_status": "live — price data is fresh"
}
```

`bot_status` values:
- `"live — price data is fresh"` — latest price < 30s old, bot is running
- `"stale — last price Xs ago (bot may not be running)"` — bot stopped or paused
- `"no price data yet"` — bot has never run against this DB

---

## Market Data

### `po_tracked_assets` / `po assets`

```json
{
  "count": 3,
  "assets": [
    { "asset": "EURUSD_otc", "candle_count": 4820, "latest_candle_ts": 1744300800 },
    { "asset": "GBPUSD_otc", "candle_count": 3201, "latest_candle_ts": 1744300740 },
    { "asset": "EURUSD",     "candle_count": 1100, "latest_candle_ts": 1744298400 }
  ]
}
```

---

### `po_prices` / `po prices`

**Single asset** (`--asset EURUSD_otc`):
```json
{ "asset": "EURUSD_otc", "price": 1.08423, "timestamp": 1744300812 }
```

**All assets** (no `--asset`):
```json
[
  { "asset": "EURUSD",     "price": 1.08401, "timestamp": 1744300810 },
  { "asset": "EURUSD_otc", "price": 1.08423, "timestamp": 1744300812 },
  { "asset": "GBPUSD_otc", "price": 1.26711, "timestamp": 1744300809 }
]
```

---

### `po_candles` / `po candles`

**Full bars** (`summary=false`, default):
```json
{
  "asset": "EURUSD_otc",
  "candle_count": 5,
  "candles": [
    { "timestamp": 1744300500, "open": 1.08400, "high": 1.08431, "low": 1.08388, "close": 1.08423, "volume": 0 },
    { "timestamp": 1744300560, "open": 1.08423, "high": 1.08450, "low": 1.08410, "close": 1.08441, "volume": 0 }
  ]
}
```

**Summary** (`summary=true`):
```json
{
  "asset": "EURUSD_otc",
  "candle_count": 100,
  "latest_timestamp": 1744300800,
  "oldest_timestamp": 1744294800,
  "latest_close": 1.08423,
  "high_14": 1.08512,
  "low_14": 1.08301,
  "avg_close_14": 1.08407
}
```

Candles are sorted oldest → newest. `volume` is always `0` — Pocket Option does not expose volume.

---

### `po_price_history` / `po price-history`

```json
{
  "asset": "EURUSD_otc",
  "count": 312,
  "prices": [
    { "timestamp": 1744300500, "price": 1.08400 },
    { "timestamp": 1744300501, "price": 1.08402 }
  ]
}
```

Sorted oldest → newest. Tick-level (approximately one row per second when bot is running).

---

### `po_indicators` / `po indicators`

```json
{
  "asset": "EURUSD_otc",
  "count": 1,
  "indicators": [
    {
      "id": 841,
      "asset": "EURUSD_otc",
      "timestamp": 1744300800,
      "ma1": 1.08391,
      "ma2": 1.08312,
      "ma3": 1.08367,
      "rsi": 58.2,
      "rsi_5": 61.4,
      "rsi_8": 59.8,
      "bb_upper": 1.08521,
      "bb_middle": 1.08390,
      "bb_lower": 1.08259,
      "stochastic_k": 72.1,
      "stochastic_d": 68.4,
      "stochastic_k_v2": 74.3,
      "stochastic_d_v2": 70.1,
      "keltner_upper": 1.08490,
      "keltner_lower": 1.08290,
      "schaff_value": 81.2,
      "created_at": "2025-04-11 18:00:01"
    }
  ]
}
```

Indicator columns per KT strategy:

| Column | Strategy | Description |
|---|---|---|
| `ma1` | video2 | EMA-6 (green line) |
| `ma2` | video2 | EMA-50 (red line) |
| `ma3` | video2 | EMA-14 (white line) |
| `rsi_5` | video2 | RSI-5 |
| `rsi_8` | video3 | RSI-8 |
| `bb_upper/middle/lower` | video3 | Bollinger Bands (20, 2σ) |
| `stochastic_k/d` | video1 | Stochastic (13, 3, 3) |
| `stochastic_k_v2/d_v2` | video2 | Stochastic (5, 3, 3) |
| `keltner_upper/lower` | video1 | Keltner Channel (EMA-18, ATR-11, ×2) |
| `schaff_value` | video3 | Schaff Trend Cycle |

---

### `po_signals` / `po signals`

```json
{
  "count": 4,
  "signals": [
    {
      "id": 203,
      "asset": "EURUSD_otc",
      "timestamp": 1744300800,
      "direction": "CALL",
      "strategy_used": "video2",
      "reasons": "[\"MA1 > MA3 > MA2\",\"RSI5 crossed above 45\",\"Stoch K crossed D upward\"]"
    },
    {
      "id": 202,
      "asset": "GBPUSD_otc",
      "timestamp": 1744300740,
      "direction": "PUT",
      "strategy_used": "video2",
      "reasons": "[\"MA1 < MA3 < MA2\",\"RSI5 crossed below 65\"]"
    }
  ]
}
```

`reasons` is a JSON-serialised string array — parse it with `JSON.parse(row.reasons)`.
`direction` is always `CALL` or `PUT`. `NEUTRAL` signals are never stored.

---

## Qualification & Validation

### `po_qualified_assets` / `po qualified`

```json
{
  "count": 2,
  "qualified_assets": [
    { "asset": "EURUSD_otc", "consecutive_wins": 3, "qualified_since": 1744290000, "updated_at": 1744300800 },
    { "asset": "GBPUSD_otc", "consecutive_wins": 2, "qualified_since": 1744295000, "updated_at": 1744299600 }
  ]
}
```

An asset appears here when `consecutive_wins >= 2`. The bot only executes orders for assets in this list (unless `useQualifiedAssetsLayer` is disabled).

---

### `po_asset_streaks` / `po streaks`

**Single asset:**
```json
{
  "asset": "EURUSD_otc",
  "consecutive_wins": 3,
  "last_result": "WIN",
  "last_result_timestamp": 1744300800,
  "updated_at": 1744300800
}
```

**All assets:**
```json
{
  "count": 5,
  "streaks": [
    { "asset": "EURUSD_otc", "consecutive_wins": 3, "last_result": "WIN",  "last_result_timestamp": 1744300800, "updated_at": 1744300800 },
    { "asset": "GBPUSD_otc", "consecutive_wins": 2, "last_result": "WIN",  "last_result_timestamp": 1744299600, "updated_at": 1744299600 },
    { "asset": "USDJPY_otc", "consecutive_wins": 0, "last_result": "LOSS", "last_result_timestamp": 1744298400, "updated_at": 1744298400 }
  ]
}
```

Sorted by `consecutive_wins` descending. A LOSS resets streak to 0.

---

### `po_streak_leaderboard` / `po leaderboard`

```json
{
  "count": 2,
  "streaks": [
    { "asset": "EURUSD_otc", "consecutive_wins": 3, "last_result": "WIN", "last_result_timestamp": 1744300800, "qualified_since": 1744290000 },
    { "asset": "GBPUSD_otc", "consecutive_wins": 2, "last_result": "WIN", "last_result_timestamp": 1744299600, "qualified_since": 1744295000 }
  ]
}
```

`qualified_since` is `null` if the asset has a streak but hasn't reached the qualification threshold yet.

---

### `po_qualification_outcomes` / `po outcomes`

```json
{
  "count": 50,
  "outcomes": [
    {
      "id": 441,
      "asset": "EURUSD_otc",
      "signal_timestamp": 1744300800,
      "signal_id": 203,
      "direction": "CALL",
      "entry_price": 1.08423,
      "exit_timestamp": 1744300860,
      "exit_price": 1.08441,
      "result": "WIN",
      "profit_loss": 460.00,
      "updated_at": 1744300862,
      "created_at": "2025-04-11 18:01:02"
    }
  ]
}
```

`result` values: `WIN`, `LOSS`, `DRAW`. `profit_loss` is in USD based on the configured `tradeAmount`.

---

### `po_asset_trades` / `po asset-trades`

```json
{
  "count": 12,
  "wins": 8,
  "losses": 4,
  "win_rate": "66.7%",
  "total_profit_loss": 1840.00,
  "trades": [
    {
      "id": 31,
      "asset": "EURUSD_otc",
      "signal_timestamp": 1744300800,
      "signal_id": 203,
      "direction": "CALL",
      "entry_price": 1.08423,
      "exit_timestamp": 1744300860,
      "exit_price": 1.08441,
      "result": "WIN",
      "profit_loss": 460.00,
      "created_at": "2025-04-11 18:01:02"
    }
  ]
}
```

Only contains outcomes for assets that were in `qualified_assets` at signal time.

---

### `po_validation_stats` / `po validation-stats`

```json
{
  "total_validated": 203,
  "wins": 118,
  "losses": 79,
  "draws": 6,
  "win_rate": "58.1%",
  "by_asset": [
    { "asset": "EURUSD_otc", "total": 98,  "wins": 61, "losses": 35, "total_pnl": 11960.00 },
    { "asset": "GBPUSD_otc", "total": 72,  "wins": 40, "losses": 29, "total_pnl":  5060.00 },
    { "asset": "USDJPY_otc", "total": 33,  "wins": 17, "losses": 15, "total_pnl":   920.00 }
  ]
}
```

---

### `po_pending_signals` / `po pending-signals`

```json
{
  "count": 3,
  "pending_signals": [
    { "id": 204, "asset": "EURUSD_otc", "timestamp": 1744300680, "direction": "CALL", "strategy_used": "video2" }
  ]
}
```

These signals have passed their expiry window (`look_ahead_seconds`) but the bot's validation loop hasn't processed them yet. Usually clears within 60s.

---

## Orders

### `po_bot_orders` / `po bot-orders`

```json
{
  "source": "bot_db",
  "count": 5,
  "orders": [
    {
      "id": 87,
      "signal_id": 203,
      "asset": "EURUSD_otc",
      "direction": "CALL",
      "signal_timestamp": 1744300800,
      "created_at": "2025-04-11 18:00:01",
      "status": "EXECUTED",
      "status_reason": "placed_via=live-execution; entry_price=1.08423",
      "last_update_at": "2025-04-11 18:00:03"
    }
  ]
}
```

`status` lifecycle: `PENDING` → `EXECUTED` (placed) or `FAILED` / `SKIPPED`.

---

### `po_mcp_orders` / `po mcp-orders`

```json
{
  "source": "mcp_db",
  "count": 2,
  "orders": [
    {
      "id": 1,
      "asset": "EURUSD_otc",
      "direction": "CALL",
      "amount": 100.0,
      "signal_ts": 1744300900,
      "created_at": 1744300900,
      "status": "PENDING",
      "status_reason": null,
      "updated_at": null
    }
  ]
}
```

These are orders you placed via `po_trade` / `po trade`. The bot reads this table to execute them.

---

### `po_trade` / `po trade`

```json
{
  "success": true,
  "order_id": 1,
  "asset": "EURUSD_otc",
  "direction": "CALL",
  "amount": 100.0,
  "signal_timestamp": 1744300900,
  "status": "PENDING",
  "mcp_db": "/path/to/data/mcp.db",
  "note": "Order written to MCP DB — bot execution worker will place this trade on next cycle"
}
```

The bot must be running and polling `mcp_orders` for this to result in a live trade.

---

### `po_cancel_order` / `po cancel`

**Success:**
```json
{ "success": true, "order_id": 1, "new_status": "CANCELLED" }
```

**Already executed:**
```json
{ "success": false, "error": "Cannot cancel order in status: EXECUTED" }
```

---

### `po_trades_ordered` / `po trades`

```json
{
  "count": 20,
  "wins": 13,
  "losses": 7,
  "win_rate": "65.0%",
  "total_profit_loss": 2760.00,
  "trades": [
    {
      "id": 44,
      "order_id": 87,
      "signal_id": 203,
      "asset": "EURUSD_otc",
      "entry_timestamp": 1744300803,
      "direction": "CALL",
      "amount": 500.0,
      "entry_price": 1.08423,
      "exit_timestamp": 1744300863,
      "exit_price": 1.08441,
      "result": "WIN",
      "profit_loss": 460.00,
      "payout": null,
      "notes": "live-execution",
      "created_at": "2025-04-11 18:01:03"
    }
  ]
}
```

`result` values: `WIN`, `LOSS`, `DRAW`, `STUB` (dry-run / test orders).
`profit_loss` for a WIN = `amount * 0.92` (92% payout). For a LOSS = `-amount`.

---

### `po_pnl_summary` / `po pnl`

```json
{
  "summary": {
    "total_trades": 87,
    "wins": 52,
    "losses": 34,
    "total_pnl": 8280.00
  },
  "by_asset": [
    { "asset": "EURUSD_otc", "total_trades": 41, "wins": 26, "losses": 14, "total_pnl": 4600.00, "avg_pnl": 112.20 },
    { "asset": "GBPUSD_otc", "total_trades": 29, "wins": 17, "losses": 12, "total_pnl": 2300.00, "avg_pnl":  79.31 }
  ]
}
```

---

## Performance

### `po_rolling_summary` / `po summary`

```json
{
  "period_days": 7,
  "total_trades": 42,
  "wins": 27,
  "losses": 14,
  "draws": 1,
  "win_rate": "64.3%",
  "total_profit_loss": 4968.00,
  "total_risked": 21000.00,
  "roi_pct": "23.66%",
  "best_trade": 460.00,
  "worst_trade": -500.00,
  "max_win_streak": 6
}
```

Pass `days=0` for all-time. `total_risked` = sum of all `amount` fields. `roi_pct` = `total_profit_loss / total_risked`.

---

### `po_performance` / `po performance`

```json
{
  "count": 7,
  "performance": [
    {
      "id": 14,
      "date": "2025-04-11",
      "total_trades": 8,
      "winning_trades": 5,
      "losing_trades": 3,
      "win_rate": 62.5,
      "total_profit_loss": 920.00,
      "best_trade": 460.00,
      "worst_trade": -500.00,
      "average_profit": 115.00,
      "created_at": "2025-04-11 23:59:01"
    }
  ]
}
```

Written by the bot's daily aggregation job. May lag behind `po_rolling_summary` which is computed live.

---

### `po_hourly_breakdown` / `po hourly`

```json
{
  "hours": [
    { "hour_utc": 8,  "trades": 6,  "wins": 4, "pnl":  736.00 },
    { "hour_utc": 9,  "trades": 11, "wins": 7, "pnl": 1288.00 },
    { "hour_utc": 12, "trades": 8,  "wins": 5, "pnl":  920.00 },
    { "hour_utc": 14, "trades": 9,  "wins": 4, "pnl":  -92.00 }
  ]
}
```

Hours with no trades are omitted. `hour_utc` is 0–23. Useful for identifying peak performance windows.

---

## Error shape

All tools return `{ "success": false, "error": "..." }` on failure. The CLI exits with code 1 and prints to stderr.

```json
{ "success": false, "error": "Bot DB not found at: /path/to/trading_data.db\nSet PO_DB_PATH or ensure pocket-option-bot.js has run at least once." }
```
