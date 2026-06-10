---
name: meta-labeling
description: >-
  Decide BET-or-SKIP on top of a primary directional signal using López de Prado meta-labeling — a
  secondary (meta) model predicts whether the primary will win, so you trade only the subset of bars
  where out-of-sample win-rate clears the binary-option break-even, accepting lower coverage for
  higher WR. The primary is configurable: a factor-derived directional rule, OR the live bot's
  signals table. Validated with purged walk-forward; the meta-model is an L2 logistic (hand-portable
  to a params.json for ml-gate.js). Use this skill WHENEVER a factor is STABLE-IC but SUB-BREAKEVEN
  (real edge, too weak to trade alone), or when asked "which of these signals should we skip", "can
  we filter to the high-confidence trades", "how do we raise win-rate by trading less", "add an
  abstention/confidence gate", or before freezing any directional gate. It is the layer that turns a
  real-but-unprofitable directional edge into a tradeable subset — or proves it cannot be rescued.
---

# Meta-Labeling (Abstention Layer)

## Why this exists

Skill #2 can return **STABLE-IC / SUB-BREAKEVEN**: a directional edge that is real out-of-sample but
whose win-rate can't clear the payout deficit if you trade every signal. Meta-labeling is the answer
to that exact situation. Instead of betting every primary signal, a secondary model predicts
*whether the primary will win on this bar*, and you trade only where it's confident — converting a
50–52% primary into a tradeable subset (if the features carry win/loss information at all).

The structure (de Prado): the **primary** picks the side (CALL/PUT); the **meta** model picks
bet/skip. Separating "which way" from "whether to bet" is what lets you raise precision by lowering
coverage — the only lever that helps when raw directional WR sits just under break-even.

## Configurable primary

```bash
# factor-rule primary: side = top-side if factor>neutral else opposite (causal — neutral is constant)
python bot/research/ml4t/skills/meta-labeling/scripts/meta_label.py \
  --primary "rsi_14" --neutral 50 --top-side put --horizon 10

# bot-signals primary: meta-label the live strategy's actual CALL/PUT signals
python bot/research/ml4t/skills/meta-labeling/scripts/meta_label.py --primary signals --horizon 10
```

- **factor primary** fires on every bar (lots of rows) — best for method development and for
  meta-labeling a confirmed factor like the `rsi_14` mean-reversion lead.
- **signals primary** meta-labels the deployed strategy directly — most useful operationally, but
  needs a populated `signals` table (the current snapshot has only ~45; the script warns and stops).

Other flags: `--horizon` (min), `--folds`, `--embargo` (bars), `--payout`, `--bar-sec` (≥300),
`--min-coverage` (min fraction of signals taken to call a threshold usable, default 0.10).

## What it does

1. **Primary side** per bar (factor rule or signals table).
2. **Meta-label** = 1 if that side would WIN over the horizon (price moved the predicted way), else 0.
3. **Secondary model**: L2 LogisticRegression on standardized, bounded indicator features (oscillators,
   widths, ADX, MACD-hist, ATR% — price levels excluded as non-stationary), trained per fold.
4. **Purged walk-forward**: out-of-fold P(win) for every signal, leakage removed (same purge/embargo
   as skill #2), so the abstention curve is honest.

## How to read the output

- **primary base WR (take all)** — WR if you bet every primary signal. Usually near/under break-even
  (that's why you're here).
- **meta-model OOS AUC** — can the meta-model separate wins from losses *at all*? **AUC ≤ 0.52 means
  no** — abstention is hopeless and no threshold will save it. This is the first thing to read.
- **Abstention curve** — for each P(win) threshold: how many signals you'd take (`coverage`) and the
  OOS WR on them. You're hunting for a row where **WR > break-even at ≥ min-coverage**.

### Verdict tiers

- **WORKS** — some threshold gives OOS WR > break-even at usable coverage. Abstention rescued the
  primary. Confirm cross-regime, then freeze (skill #4).
- **NO LIFT** — meta AUC ≤ 0.52. The features hold no win/loss information; the primary cannot be
  rescued by filtering. (On this snapshot, `rsi_14` lands here — AUC 0.513.)
- **PARTIAL** — meta separates a little but no threshold clears break-even at usable coverage. Needs a
  stronger primary or more/cross-regime data.

## Limits

- **Read-only / offline**, immutable snapshot — does not touch the live bot.
- **One regime.** Even a WORKS verdict needs cross-regime replication before any freeze — a coverage/WR
  point found on 2 days can be an artifact.
- **Coverage honesty.** A threshold that clears break-even on 1% of signals (tiny n) is noise; that's
  why `--min-coverage` gates the verdict. Read coverage and n together.
- See `references/methodology.md` for the meta-label definition, feature rationale, and AUC/coverage
  thresholds.
