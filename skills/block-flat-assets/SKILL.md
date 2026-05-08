---
name: block-flat-assets
description: One-shot cleanup of flat and pegged OTC assets based on CURRENT BB width only. Blocks assets where volatility is dead (< 5 bps) right now. Never blocks by historical win rate — OTC conditions change. Use when the user says "clean up bad assets", "block flat assets", or "housekeeping".
---

# Block Flat Assets — Volatility-Based Cleanup (OTC Only)

You are performing a one-shot cleanup to remove flat and pegged OTC assets from the bot's trading universe based on **current BB width only**. This is a volatility housekeeping operation — not a performance-based purge.

**OTC market rule: never block an asset based on historical win rate.** OTC conditions change constantly — an asset that lost yesterday may be the best setup today. Only block assets that are dead/flat RIGHT NOW (BB < 5 bps).

## Step 1: Health Check

Call `po_health`. Confirm mcp.db is accessible — you need write access to block assets.

## Step 2: Volatility Scan

Call `po_asset_volatility`.

Classify all assets:
- **FLAT** (< 5 bps): Dead/pegged — always block. These lose consistently regardless of signal quality.
- **WEAK** (5–10 bps): In the validated losing zone (45.8% WR). Block unless bias shows strong historical edge.
- **MARGINAL** (10–20 bps): Keep — in profitable range.
- **GOOD** (20+ bps): Keep — best setups.

## Step 3: Build Block List

From the volatility scan only — no historical WR used.

**Block:**
- BB < 5 bps (FLAT/PEGGED) — dead market, no signal quality possible

**Do NOT block based on:**
- Historical win rate (OTC conditions change — a "loser" yesterday may set up today)
- Direction bias (CALL vs PUT preference changes with market conditions)
- Any time-based reason

Present the block list to the user before executing:
```
PROPOSED BLOCKS (N assets) — CURRENT BB WIDTH ONLY:

FLAT (BB < 5 bps):
  EURTRY_otc      — BB 0.12 bps
  JODCNY_otc      — BB 0.30 bps
  [...]

TOTAL: N assets to block

All blocks are temporary — auto-unblock when BB recovers above 5 bps.
Proceed? (yes/no)
```

Wait for user confirmation before blocking.

## Step 4: Execute Blocks

For each asset in the confirmed block list, call `po_block_asset`:
- FLAT assets: reason = `"flat asset — BB N bps (< 5 bps, dead market right now)"`

After each block, confirm it was written successfully.

## Step 5: Verify

Call `po_asset_volatility` again after blocking to confirm the blocked assets are flagged.

## Step 6: Report

Tell the user:

```
CLEANUP COMPLETE — Volatility-based (OTC)
═══════════════════════════════════════

Blocked N assets:
  FLAT (BB < 5 bps): N assets

Assets still in play: N
  Best volatility: [top 5 by BB bps]

All blocks are TEMPORARY — unblock when BB recovers.
To unblock: po_unblock_asset [asset_name]
To check later: po_asset_volatility
```

## Rules

- **Block only on current BB width — never on historical win rate.** OTC market conditions change too fast for static performance-based blocks.
- **No time-based blocks** — OTC markets run 24/7, hour-of-day has no persistent meaning.
- Always show the block list and wait for confirmation before executing
- Never block ALL assets — if the list covers > 50% of tracked assets, flag this as unusual and ask the user to confirm
- Log the reason with every block — the reason string is visible in `po_asset_volatility`
- Blocking is reversible via `po_unblock_asset` — always temporary
