# Methodology — Directional-Momentum Edge

The protocol behind `scripts/directional_momentum.py`. This is the project's central research
question expressed as one purged, profit-graded study. It reuses the price-label discipline of
`alpha-factor-eval` and the purge/embargo of `purged-walk-forward-cv`.

## 1. The momentum-state label (forward price, causal terciles)

```
s    = sign(close[t] - close[t-k])               recent trend over k bars
move = close[t+n] - close[t]                      forward move over n bars (= horizon)
cont = s * move / ATR_14[t]                        ATR-normalized signed continuation
```

`cont > 0` means price continued in the recent-trend direction; `cont < 0` means it reversed.
Terciles of `cont` are fit **on the training fold only** and applied to test:

```
decay  = cont <= lo(train)     bottom third  (reversal / momentum loss)
stable = lo < cont < hi        middle third  (flat)
gain   = cont >= hi(train)     top third     (acceleration / continuation)
```

Validity requires both windows contiguous (`t-k` and `t+n` exactly k/n bars away — no session gaps)
and `ATR > 0` and `s ≠ 0`. The state is a **forward** quantity: unknown at t, so it is a prediction
target, never a feature. This is the firewall against the prior study's leakage.

## 2. Features

`FEATS` = bounded/stationary indicators only (rsi, stoch ×3, bb_width_bps, stc value/signal/prev/delta,
cci, macd_hist, adx + ±DI, williams, atr_pct, psar_bull). Price-level columns (sma/ema/bb/kc/psar
absolute values) are excluded — they are non-stationary and invite fitting the price level. Imputation
(train median) and scaling (train StandardScaler) are fit per fold, on train only.

## 3. Model and validation

Multinomial L2 `LogisticRegression(C=0.5, class_weight="balanced")`. Linear is deliberate: the
project's repeated finding is that trees/boosting do not beat linear here (no exploitable interaction
structure), and a linear model hand-ports to `ml_gate_params.json` if it ever earns a freeze.

Purged walk-forward (skill #2's `make_folds`): sequential expanding-train folds over unique
timestamps; a train row is dropped if its label window reaches within `embargo` bars of the test
start. Every test row gets an **out-of-fold** predicted state + probability — no row scored by a model
that trained on its own period.

## 4. Betting rule and scoring

```
predicted gain (2)   -> side = s    (CALL if s>0 else PUT)   bet WITH trend
predicted decay (0)  -> side = -s                            bet AGAINST trend
predicted stable (1) -> SKIP
optional: bet only if predicted-state probability >= min_prob   (abstention)

win      = sign(forward move) == side
coverage = bets / scored rows
OOS WR   = mean(win over bets)
break-even WR = 1 / (1 + payout)
```

The per-state WR split (gain→with-trend, decay→against-trend) is reported so a one-sided edge isn't
hidden by averaging with the other side.

## 5. Verdict thresholds

| Verdict | Condition |
|---|---|
| **PROFITABLE** | OOS WR > break-even AND coverage ≥ min_coverage |
| **PREDICTABLE-BUT-UNPROFITABLE** | state accuracy > ~0.36 (above the 0.333 random floor) but WR ≤ break-even |
| **NO EDGE** | accuracy ≈ random AND WR ≤ break-even |

State-prediction **accuracy vs the 0.333 random floor** is the diagnostic that explains the WR: if the
model can't classify the forward state above chance, the betting rule is guessing and no threshold or
abstention level rescues it. That is the current observed regime (~32–34% accuracy, 47–50% WR, all
horizons, stable under `--min-prob`).

## 6. Interpreting NO EDGE

NO EDGE is a finding about *inputs*, not models. Accuracy ≈ 0.333 means the standard indicators at the
5-min bar carry essentially no information about the forward momentum state. The productive responses
are new inputs (tick-level microstructure from the 1s `prices` stream; cross-asset lead-lag; a
barrier-touch label) — not a heavier model over the same features. The project's body of results is
consistent: the bottleneck is information in the inputs, not model capacity.

## References

- Stefan Jansen, *Machine Learning for Trading* (2nd ed.) — alpha factors, CV, the model→strategy gap.
- López de Prado, *Advances in Financial Machine Learning* — purged CV, labeling.
- Project: `bot/research/ml4t/RESEARCH_PROCEDURE.md`, `FINDINGS.md` (the prior gain/stable/decay study
  this one supersedes with a tradeable, directional, profit-graded target).
```
