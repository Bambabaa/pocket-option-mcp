---
name: block-flat-assets
description: One-shot cleanup of flat, pegged, and consistently losing assets. Runs volatility scan + asset bias analysis, identifies all assets that should be blocked, and blocks them all with reasons logged. Use when the user says "clean up bad assets", "block flat assets", "remove losing assets", or "housekeeping".
---

# Block Flat Assets — Asset Cleanup

You are performing a one-shot cleanup to remove flat, pegged, and consistently losing assets from the bot's trading universe. This is a housekeeping operation — run it before a new trading session or after a bad run.

## Step 1: Health Check

Call `po_health`. Confirm mcp.db is accessible — you need write access to block assets.

## Step 2: Volatility Scan

Call `po_asset_volatility`.

Classify all assets:
- **FLAT** (< 5 bps): Dead/pegged — always block. These lose consistently regardless of signal quality.
- **WEAK** (5–10 bps): In the validated losing zone (45.8% WR). Block unless bias shows strong historical edge.
- **MARGINAL** (10–20 bps): Keep — in profitable range.
- **GOOD** (20+ bps): Keep — best setups.

## Step 3: Asset Bias Analysis

Call `po_asset_bias(min_trades=3)`.

From the results, identify:
- **AVOID** verdict: block regardless of BB width
- **BLOCK_RECOMMENDED** verdict: already flagged by bias engine as flat/pegged
- **Consistent losers**: any asset where both CALL WR < 40% AND PUT WR < 40% with 5+ trades

## Step 4: Build Block List

Combine the two sources into a single block list. Remove duplicates.

**Always block:**
- BB < 5 bps (FLAT)
- Bias verdict = AVOID
- Bias verdict = BLOCK_RECOMMENDED

**Block if both conditions met:**
- BB 5–10 bps (WEAK) AND bias shows no directional edge (BOTH verdict with < 50% WR)

**Do NOT block:**
- BB 5–10 bps but strong directional bias (e.g. PUT_ONLY at 70% WR) — keep but note
- Assets with < 3 trades in history — insufficient data, skip for now

Present the block list to the user before executing:
```
PROPOSED BLOCKS (N assets):

FLAT (BB < 5 bps):
  EURTRY_otc      — BB 0.12 bps
  JODCNY_otc      — BB 0.30 bps
  [...]

WEAK + NO EDGE (BB 5-10 bps, low WR):
  [asset]         — BB N bps, WR N%/N% (CALL/PUT)

CONSISTENT LOSERS:
  [asset]         — CALL N% / PUT N% over N trades

TOTAL: N assets to block

Proceed? (yes/no)
```

Wait for user confirmation before blocking.

## Step 5: Execute Blocks

For each asset in the confirmed block list, call `po_block_asset`:
- FLAT assets: reason = `"flat asset — BB N bps (< 5 bps dead zone)"`
- WEAK + no edge: reason = `"weak volatility — BB N bps, CALL N% / PUT N% WR"`
- Consistent losers: reason = `"consistent loser — CALL N% / PUT N% over N trades"`

After each block, confirm it was written successfully.

## Step 6: Verify

Call `po_asset_volatility` again after blocking to confirm the blocked assets are flagged.

Check `po_asset_bias` — BLOCK_RECOMMENDED assets should no longer appear in the active trading universe.

## Step 7: Report

Tell the user:

```
CLEANUP COMPLETE
═══════════════════════════════════════

Blocked N assets:

  FLAT (BB < 5 bps):          N assets
  Weak volatility + no edge:  N assets
  Consistent losers:          N assets

Assets still in play: N
  Best volatility: [top 5 by BB bps]
  Strongest bias:  [top 3 by WR with direction]

To unblock any asset: po_unblock_asset [asset_name]
To review blocks later: po_asset_volatility
```

## Rules

- Always show the block list and wait for confirmation before executing
- Never block an asset with < 3 historical trades — insufficient data
- Never block ALL assets — if the list covers > 50% of tracked assets, flag this as unusual and ask the user to confirm
- Log the reason with every block — the reason string is visible in `po_asset_volatility` and the agent audit trail
- Blocking is reversible via `po_unblock_asset` — this is not destructive
