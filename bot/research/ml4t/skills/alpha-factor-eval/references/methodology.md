# Methodology — Alpha-Factor Evaluation

The math behind `scripts/alpha_eval.py`, and why each threshold is set where it is. This is the
ML4T / Alphalens alpha-research workflow adapted to a 5-minute binary-option dataset.

## 1. The label — forward return over n bars

```
fwd_ret_{m} = close[t + n] / close[t] - 1,   n = (m * 60) / bar_sec   (m ∈ {5,10,15,20} min)
```

`bar_sec` is the candle interval in seconds, floored at 300 (5m) — no shorter bars exist here — and
each horizon must be a whole bar-multiple, so n ∈ {1,2,3,4}.

Computed per asset off the candle **close**, only when bar t+n is exactly n*bar_sec later
(contiguous bars — a session gap voids the window). This mirrors how the bot validates a
prediction: decide at bar close, check the outcome 1/2/3/4 bars later. Using close (not sub-bar
ticks) removes timestamp-convention ambiguity and matches the validation horizons exactly.

The label is a genuine forward PRICE move — not an indicator's own slope. The prior research's hard
lesson: indicator-slope targets score AUC 0.79–0.94 but are non-tradeable; the moment the label is a
real forward price move, structure collapses to AUC ~0.5. This skill only ever uses the price label.

## 2. Information Coefficient (IC)

```
IC = Spearman_rank_correlation(factor[t], fwd_ret[t])
```

Rank correlation, so it is scale-invariant and robust to the heavy tails of FX returns. Sign carries
direction: IC > 0 means a high factor value precedes up-moves (a CALL tilt); IC < 0 a PUT tilt.

**Pooled IC** is computed over all (asset, t) rows. It is reported but its p-value is *not* trusted,
because overlapping forward windows make rows autocorrelated — the effective sample size is far below
the row count, so a naive p-value overstates significance. (You will often see pooled p < 0.05 on
pure noise for this reason.)

## 3. Block IC, IR, and the honest t-stat

To get a defensible significance test we compute IC **within time blocks** (default 1 hour =
`--block-sec 3600`), producing a series of per-block ICs `{IC_1 … IC_B}`:

```
mean_IC = mean(IC_b)
IR      = mean_IC / std(IC_b)              # information ratio (per block)
t       = IR * sqrt(B)
p       = two-sided t-test, dof = B-1
```

A block needs ≥20 valid rows and ≥3 distinct factor values to contribute, else it is skipped. This
is a block-bootstrap-flavoured test: each block is treated as a roughly independent draw of the
factor's edge, so the t-stat reflects **consistency across time**, not just a one-off pooled
correlation. This is the number the verdict uses.

Why blocks beat one big correlation: an edge that shows up only in one hour and reverses in the next
nets to a strong pooled IC but a near-zero IR. The IR/t-stat exposes that; the pooled IC hides it.

## 4. Decision threshold

A factor is a **candidate** iff, at some horizon:

```
|block mean_IC| > 0.03   AND   block p < 0.05
```

- **0.03** floor: below this there is nothing to trade even if "significant" — in equities |IC|
  0.03–0.05 is the weak-but-real band; binary options need a *stronger* edge than equities because of
  the payout deficit, so 0.03 is a deliberately low *gate to even keep looking*, not a deploy bar.
- **p < 0.05** on the block t-stat: time-consistency, not pooled luck.

Both conditions are necessary because each catches a different illusion: the IC floor catches
"statistically significant but economically trivial"; the block p catches "large but inconsistent /
autocorrelation artifact."

## 5. Quantile spread and monotonicity

Rows are sorted into `q` buckets (default 5 = quintiles) by factor value. Per bucket we report mean
forward return (bps) and hit-rate. Two things matter:

- **Monotonicity** = Spearman(bucket_index, mean_return). Near ±1 means the relationship is smooth
  and ordered — the hallmark of a real factor. A big top−bottom spread with a jagged middle
  (monotonicity ~0) is usually overfitting to a couple of extreme buckets.
- **Top−bottom spread** (bps) = does the highest-factor bucket actually out-return the lowest.

## 6. The payout-aware hit-rate test (binary-option specific)

A binary option pays `payout` on a win and loses the stake on a loss, so:

```
break-even WR = 1 / (1 + payout)        # 0.8 payout -> 55.56%
```

A bucket is only tradeable if its directional hit-rate clears break-even on the correct side: the
**top** bucket as a CALL (hit-rate of up-moves > break-even) or the **bottom** bucket as a PUT
(hit-rate of down-moves, i.e. 1 − up-rate, > break-even). Mean return in bps is necessary but not
sufficient — a +0.2 bps edge that wins only 51% of the time still loses money at 0.8 payout. This is
the ML4T "the gap between a good model and a profitable strategy is vast" principle, made concrete:
your transaction cost is the payout deficit (~5.6 points of WR at 0.8), not basis points of slippage.

## 7. What this skill deliberately does NOT do

- It does not train or persist a model. It is the gate *before* modeling.
- It does not run purged walk-forward or cross-regime replication — those are the confirmation steps
  a `candidate` must pass next (`RESEARCH_PROCEDURE.md`).
- It does not prove an edge from one snapshot. ~2 days × 15 pairs is one regime; a `candidate` is a
  lead, and the only honest verdict comes from out-of-sample + cross-regime + cost-netting.

## References

- Stefan Jansen, *Machine Learning for Trading* (2nd ed.) — Ch. 4 (alpha factors, IC, Alphalens),
  Ch. 6–8 (the ML4T workflow, validation, costs).
- Project: `bot/research/ml4t/RESEARCH_PROCEDURE.md`, `FINDINGS.md` (the price-label discipline and
  the AUC ~0.5 prior result this skill operationalizes).
