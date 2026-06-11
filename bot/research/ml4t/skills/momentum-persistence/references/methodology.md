# Methodology — Momentum-Persistence

The protocol behind `scripts/momentum_persistence.py`. A duration/survival treatment of "how long
does a detected momentum-gain last before it falls back", graded on binary-option profitability.
Reuses `po_data` (schema-adaptive load, family feature engineering, purged folds).

## 1. Onset — multi-family confluence (causal)

At each bar, trend direction `s = sign(close[t] - close[t-k])`. An **onset** is a bar where at least
`--confluence` (default 4) of five trend-aligned conditions hold, deliberately spread across families
so no single indicator can trigger it:

| # | condition | family |
|---|---|---|
| c1 | sign(close − SMA20) == s | trend |
| c2 | sign(MACD-hist) == s | momentum |
| c3 | ADX14 > ADX14[−1] (strengthening) | breakout |
| c4 | sign(STC − 50) == s | momentum |
| c5 | +DI>−DI if s>0 (else −DI>+DI) | breakout |

All are known at bar close → the onset is tradeable, not hindsight.

## 2. Persistence label — price crosses back through entry

"Fall-back" is binary-option-native: the move has fallen back at +j bars when price is no longer
beyond entry in the trend direction.

```
duration = first j in 1..max_dur with sign(close[t+j] - close[t]) != s   (else max_dur+1 = survived)
persist_m = 1 if sign(close[t+h] - close[t]) == s else 0,   h = m*60/bar_sec bars
```

Bars are only counted while contiguous (no session gap). `duration` is the survival target for the
descriptive stage; `persist_m` is the per-expiry binary target for the predictive stage.

`persist_m` is exactly how an option settles: a CALL placed with an uptrend onset wins at expiry m iff
price is still above entry, i.e. `persist_m == 1`. The **follow-trend WR** at expiry m is the base
rate of `persist_m`; the **fade WR** is `1 − persist_m` (exact ties negligible for 5m FX closes).

## 3. Stage A — characterization (model-free)

Over all onsets: median bars-to-fall-back, share surviving `max_dur`, and per-expiry follow vs fade
WR against break-even `1/(1+payout)`. This answers the literal question and reveals the regime: if
follow WR ≪ 50%, the confluence is a **reversion** trigger and fade is the tradeable side.

## 4. Stage B — prediction (survival model)

For each expiry m, a per-horizon L2 `LogisticRegression(C=0.5, class_weight="balanced")` on the full
family feature set predicts `P(persist_m)`. Purged walk-forward over unique timestamps (train rows
dropped if their label window reaches within `embargo` bars of the test start) → out-of-fold
probabilities. Reports:

- **AUC** — can the model rank persistent moves above non-persistent? ≤ 0.52 ⇒ persistence carries no
  extra information beyond the base rate.
- **confidence-gated WR** — follow WR among onsets with `P ≥ --min-prob`, with its coverage. A model
  earns its keep only if gating lifts WR over break-even at usable coverage.

Modeling persistence as one binary per horizon is a discrete-time survival approximation; it is linear
on purpose (hand-portable to `ml_gate_params.json` if an edge is confirmed).

## 5. Verdict

Checks both directions, because detected gains here tend to revert:

| Verdict | Condition |
|---|---|
| **PROFITABLE (raw, FADE)** | some expiry's fade WR > break-even |
| **PROFITABLE (raw, follow)** | some expiry's follow WR > break-even |
| **PROFITABLE (gated)** | a confidence-gated survival model clears break-even at ≥ min-coverage |
| **PREDICTABLE-BUT-UNPROFITABLE** | AUC > 0.52 but nothing clears break-even |
| **NO EDGE** | gains don't persist past break-even and persistence is unpredictable |

**Thin-margin caution.** A WR a hair over break-even (55.7% vs 55.6%) on a single horizon is within
noise and gross of cost — a lead, not an edge. Confirm cross-regime (the other DB) and under stricter
`--confluence` before believing it.

## 6. What this skill does NOT do

- It does not net costs beyond the payout break-even (no spread/skew).
- It does not persist a model — a confirmed edge goes to the freeze/export step.
- A single-regime PROFITABLE flag is a lead; cross-regime replication is mandatory.

## References

- Discrete-time survival analysis (per-horizon hazard as binary classification).
- López de Prado — purged walk-forward; Jansen ML4T — costs, the model→strategy gap.
- Project siblings: `directional-momentum-edge` (fixed-horizon state), `purged-walk-forward-cv`
  (the purge reused here), `_lib/po_data.py` (families + schema adapter).
