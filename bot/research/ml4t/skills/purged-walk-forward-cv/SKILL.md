---
name: purged-walk-forward-cv
description: >-
  Confirm whether a candidate trading factor's edge SURVIVES out-of-sample using purged
  walk-forward cross-validation — sequential time folds, with overlapping forward-label windows
  purged and an embargo applied at each train/test boundary to kill leakage. Reports per-fold
  out-of-sample IC, sign-consistency, a pooled t-stat, the directional extreme-quantile win-rate vs
  the binary-option break-even, and a STABLE / STABLE-IC-SUB-BREAKEVEN / MODERATE / UNSTABLE verdict.
  Use this skill WHENEVER alpha-factor-eval flags a factor as a candidate, or when asked "does this
  edge hold out of sample", "is this overfit", "will this survive walk-forward", "is the IC stable
  across time", or before training/freezing any model or wiring a live gate. It is the confirmation
  gate between "signal exists in one snapshot" and "edge is real" — it stops a lucky single-period
  correlation (or an autocorrelation artifact) from reaching production.
---

# Purged Walk-Forward CV

## Why this exists

`alpha-factor-eval` (skill #1) finds factors with signal *in one snapshot*. But a single-snapshot IC
can be a fluke of one regime, or an artifact of overlapping (autocorrelated) bars. The prior momentum
study died exactly here: its edge had the **opposite sign in May vs June**. This skill is the
confirmation gate — it asks whether the edge persists out-of-sample once leakage is removed, and
whether it's actually *tradeable* after the payout deficit, not merely *statistically real*.

The decisive property is **consistency**, not one good fold. An edge whose sign flips across folds is
not an edge.

## What "purged" means (and why it's not optional)

A forward label at bar `t` peeks `n` bars ahead (5/10/15/20-min horizon = 1/2/3/4 bars). If a training
row's label window reaches into the test segment, the model has seen test-period prices — leakage that
inflates every metric. So:

- **Split on unique timestamps** — the 15-asset cross-section moves together, so a whole timestamp is
  the atomic unit; a minute never straddles train and test.
- **Purge** — drop training rows whose label window (`t .. t + horizon`) reaches the test segment.
- **Embargo** — additionally drop training rows within `--embargo` bars of the test start, killing
  residual serial correlation across the boundary.

The per-fold `purged` column shows how many rows this removed — that number is the leakage you'd
otherwise have shipped.

## How to run

`scripts/purged_wf.py` — read-only (`immutable=1`), no model persisted. The `--factor` interface is
identical to `alpha-factor-eval`, so a candidate flows straight through.

```bash
python bot/research/ml4t/skills/purged-walk-forward-cv/scripts/purged_wf.py \
  --factor "<expression>" --horizon <minutes> \
  [--folds 5] [--embargo 5] [--bar-sec 300] [--payout 0.8] [--json out.json]
```

- `--horizon` (minutes, whole bar-multiple) — use the horizon `alpha-factor-eval` flagged strongest.
- `--folds` — sequential expanding-train folds (default 5).
- `--embargo` — boundary embargo in **bars** (default 5).
- `--bar-sec` — candle interval, floored at 300s.

Factor expression + the `d(col, k)` per-asset diff helper are exactly as in `alpha-factor-eval`
(see that skill's SKILL.md for the column list and examples).

## How to read the output

Per-fold table, then a summary line, then a verdict.

- **IC train vs IC test** — train IC is sanity (does the in-sample sign even hold); **test IC is the
  product**. You want test IC to keep the same sign across folds with meaningful magnitude.
- **p test** — per-fold significance; informative but thin per fold, so weight the *pattern* over any
  single cell.
- **extreme-WR** — win-rate of trading the extreme quintile in the direction the *train* edge implies
  (top quintile as CALL if train-IC>0, as PUT if <0). This is the tradeability number.
- **Summary** — `mean OOS IC`, `sign-consistency` (fraction of folds matching the mean sign),
  pooled `t (p)` over folds, and `mean extreme-WR` vs break-even.

### Verdict tiers

- **STABLE & TRADEABLE** — sign-consistency ≥ 0.8, |mean OOS IC| > 0.03 with p < 0.05, AND mean
  extreme-WR clears break-even. The only tier that earns a path to modeling.
- **STABLE-IC / SUB-BREAKEVEN** — the edge is statistically real and consistent OOS, but its WR does
  not clear break-even. **This is the most important tier to understand:** the factor is genuine but
  too weak to trade alone against the payout deficit. It is *not* a standalone gate — it is a useful
  *input* to a stronger combined model or an abstention/meta-label layer (skill #3). `rsi_14` lands
  here on this snapshot (OOS IC stable & negative, WR ~52% < 55.6%).
- **MODERATE** — sign holds but under-powered; gather more data / cross-regime before deciding.
- **UNSTABLE** — sign flips or edge ≈ 0 across folds. Not a real edge; stop here.

## What even a STABLE verdict does NOT grant

Purged walk-forward removes *leakage within one dataset* — it does not make one dataset into many
regimes. A STABLE verdict still owes:

1. **Cross-regime replication** — re-run on the May agent.db / other snapshots. Sign must hold.
2. **Cost-netting** — net-of-payout PnL, not gross IC.
3. Only then → modeling / meta-labeling → `model-freeze-export`.

The whole point of this skill is that the gap between "significant IC" and "money" is wide; it makes
you walk across it deliberately instead of assuming it.

## Notes & limits

- **Read-only / offline.** Python on an immutable snapshot — does not touch the live bot process.
- **Thin folds.** ~2 days × 15 pairs yields modest test blocks; treat fold-level p-values as
  directional, lean on sign-consistency and the cross-fold t-stat.
- See `references/methodology.md` for the purge/embargo math and the verdict thresholds.
