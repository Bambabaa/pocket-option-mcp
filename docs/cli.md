# CLI Reference

The `po` CLI exposes every MCP tool as a plain shell command. All output is JSON — pipe to `jq` for filtering, or redirect to files for scripts.

## Setup

```bash
# Run directly
node src/cli/index.js <command> [options]

# Or install globally via npm link (run once from repo root)
npm link
po <command> [options]
```

Both databases default to `data/` inside this repo — no configuration needed as long as `pocket-option-bot.js` is pointed at `pocket-option-mcp/data/trading_data.db`.

Override paths only if needed:

```bash
PO_DB_PATH=/custom/path/trading_data.db po health
MCP_DB_PATH=/custom/path/mcp.db po mcp-orders
```

---

## Command reference

### Health

#### `po health`
Check bot DB connection and bot liveness.

```bash
po health
```

---

### Market data

#### `po assets`
List all assets the bot has candle data for.

```bash
po assets
po assets | jq '.assets[].asset'
```

---

#### `po prices`
Latest price for one or all tracked assets.

```bash
po prices                        # all assets
po prices --asset EURUSD_otc    # single asset
```

| Flag | Required | Description |
|---|---|---|
| `--asset` | no | Asset symbol. Omit for all. |

---

#### `po candles`
OHLC candle bars for an asset.

```bash
po candles --asset EURUSD_otc
po candles --asset EURUSD_otc --limit 50
po candles --asset EURUSD_otc --summary      # compact stats view
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | **yes** | — | Asset symbol |
| `--limit` | no | 100 | Number of bars |
| `--summary` | no | false | Return summary stats instead of full bars |

---

#### `po price-history`
Tick-level price history over a time window.

```bash
po price-history --asset EURUSD_otc --from 1744297200 --to 1744300800
po price-history --asset EURUSD_otc --from 1744297200 --to 1744300800 --limit 1000
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | **yes** | — | Asset symbol |
| `--from` | **yes** | — | Start unix timestamp (seconds) |
| `--to` | **yes** | — | End unix timestamp (seconds) |
| `--limit` | no | 500 | Max rows |

---

#### `po indicators`
Latest calculated indicator values for an asset.

```bash
po indicators --asset EURUSD_otc
po indicators --asset EURUSD_otc --limit 5   # last 5 indicator snapshots
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | **yes** | — | Asset symbol |
| `--limit` | no | 1 | Number of rows (1 = latest only) |

---

#### `po signals`
Recent CALL/PUT signals from the  strategy pipeline.

```bash
po signals
po signals --asset EURUSD_otc
po signals --direction CALL
po signals --asset EURUSD_otc --direction PUT --limit 10
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | no | all | Filter by asset |
| `--direction` | no | both | `CALL` or `PUT` |
| `--limit` | no | 20 | Max rows |

---

### Qualification

#### `po qualified`
Assets on the bot's trading allow-list (2+ consecutive wins).

```bash
po qualified
po qualified | jq '.qualified_assets[].asset'
```

---

#### `po streaks`
Current consecutive win streak per asset.

```bash
po streaks                        # all assets
po streaks --asset EURUSD_otc    # single asset
```

---

#### `po leaderboard`
Rank assets by active win streak. Useful for spotting hot assets.

```bash
po leaderboard
po leaderboard --min-wins 2      # only assets with ≥2 consecutive wins
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--min-wins` | no | 1 | Minimum streak to include |

---

#### `po outcomes`
Full signal validation history — entry/exit prices and WIN/LOSS per signal.

```bash
po outcomes
po outcomes --asset EURUSD_otc
po outcomes --asset EURUSD_otc --limit 100
po outcomes | jq '[.outcomes[] | select(.result=="WIN")] | length'
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | no | all | Filter by asset |
| `--limit` | no | 50 | Max rows |

---

#### `po asset-trades`
Trade outcomes for qualified assets only (assets that were on the allow-list when the signal fired).

```bash
po asset-trades
po asset-trades --asset EURUSD_otc
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | no | all | Filter by asset |
| `--limit` | no | 50 | Max rows |

---

#### `po validation-stats`
Aggregate win rate and P/L from the full qualification history.

```bash
po validation-stats
po validation-stats --asset EURUSD_otc
```

---

#### `po pending-signals`
Signals that have passed their expiry window but haven't been validated yet.

```bash
po pending-signals
po pending-signals --expiry 60 --limit 20
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--expiry` | no | 60 | Option expiry window in seconds |
| `--limit` | no | 50 | Max rows |

---

### Orders

#### `po bot-orders`
Read the bot's execution queue (readonly — the bot's `orders_queue` table).

```bash
po bot-orders
po bot-orders --status PENDING
po bot-orders --status EXECUTED --limit 20
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--status` | no | all | `PENDING` / `EXECUTED` / `SKIPPED` / `FAILED` |
| `--limit` | no | 50 | Max rows |

---

#### `po mcp-orders`
View manual orders you placed via `po trade` (from the MCP's own DB).

```bash
po mcp-orders
po mcp-orders --status PENDING
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--status` | no | all | `PENDING` / `EXECUTED` / `SKIPPED` / `FAILED` / `CANCELLED` |
| `--limit` | no | 50 | Max rows |

---

#### `po trade`
Enqueue a manual CALL or PUT. The bot picks it up and places the DOM click on Pocket Option.

**Nothing is written to the bot's database.**

```bash
po trade --asset EURUSD_otc --direction CALL
po trade --asset GBPUSD_otc --direction PUT --amount 100
```

| Flag | Required | Description |
|---|---|---|
| `--asset` | **yes** | Asset symbol, e.g. `EURUSD_otc` |
| `--direction` | **yes** | `CALL` or `PUT` |
| `--amount` | no | Trade size in USD. Bot uses its configured amount if omitted. |

The bot must be running with `execution.enabled=true` and polling `mcp_orders` to execute this.

---

#### `po cancel`
Cancel a PENDING manual order before the bot executes it.

```bash
po cancel --id 3
```

| Flag | Required | Description |
|---|---|---|
| `--id` | **yes** | Order ID from `po mcp-orders` |

Cannot cancel an order that is already `EXECUTED`, `FAILED`, or `SKIPPED`.

---

### Results

#### `po trades`
Executed live trades with WIN/LOSS/DRAW results from the bot's `trades_ordered` table.

```bash
po trades
po trades --result WIN
po trades --asset EURUSD_otc --result WIN
po trades --limit 100
po trades | jq '.total_profit_loss'
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--asset` | no | all | Filter by asset |
| `--result` | no | all | `WIN` / `LOSS` / `DRAW` / `STUB` |
| `--limit` | no | 50 | Max rows |

---

#### `po pnl`
P/L summary broken down by asset, sorted by total P/L descending.

```bash
po pnl
po pnl | jq '.summary'
po pnl | jq '.by_asset[] | select(.total_pnl > 0)'
```

---

### Performance

#### `po summary`
Rolling win rate, P/L, ROI computed live from `trades_ordered`.

```bash
po summary                  # last 7 days
po summary --days 30        # last 30 days
po summary --days 0         # all-time
po summary | jq '{win_rate, total_profit_loss, roi_pct}'
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--days` | no | 7 | Look-back window. `0` = all-time. |

---

#### `po performance`
Daily performance records written by the bot.

```bash
po performance
po performance --days 14
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--days` | no | 30 | Number of days |

---

#### `po hourly`
Trade count, wins, and P/L broken down by hour of day (UTC). Useful for finding peak trading windows.

```bash
po hourly
po hourly | jq '.hours | sort_by(-.pnl) | .[0]'   # best hour by P/L
po hourly | jq '[.hours[] | select(.wins > .trades / 2)]'  # winning hours
```

---

## Patterns

### Check bot is live before trading
```bash
po health | jq -e '.bot_status | startswith("live")' && po trade --asset EURUSD_otc --direction CALL
```

### Watch for new signals
```bash
watch -n 10 'node src/cli/index.js signals --limit 5'
```

### Find today's best-performing asset
```bash
po pnl | jq '.by_asset[0]'
```

### List all PENDING manual orders
```bash
po mcp-orders --status PENDING
```

### All-time stats in one line
```bash
po summary --days 0 | jq '{win_rate, total_profit_loss, roi_pct, max_win_streak}'
```

### Export last 200 trades to CSV (requires `jq`)
```bash
po trades --limit 200 | jq -r '
  ["asset","direction","result","profit_loss","entry_timestamp"],
  (.trades[] | [.asset, .direction, .result, .profit_loss, .entry_timestamp])
  | @csv' > trades.csv
```
