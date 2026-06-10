# FINDINGS — Trend-Continuation State Classification

See `RESEARCH_PROCEDURE.md` for the spec. Read-only study, 21 FX pairs (June) + agent.db (May), 5-min.

## Headline
**On a price-based, tradeable target, NO indicator family — trend (H1a), momentum (H1b), or
volatility/directional (H1c) — predicts momentum gain/stable/decay above random, with any model,
in any regime or horizon. H0 holds.** This is the clean counterpart to the prior (now-wiped)
indicator-slope study: that target scored AUC 0.79–0.94 purely because it was a smoothed indicator's
own inertia; the moment the label becomes a genuine forward price move, all structure vanishes.

## Label (NEW, price-based, tradeable)
`s = sign(close[t]-close[t-k]) ; f = s*(close[t+n]-close[t])/ATR ; terciles -> gain/stable/decay`.
k=6, n=3 default. EDA confirmed: balanced 33/33/33, only 1.2% flat dropped, **no leakage** (max
feature↔label |corr| = 0.045) — and correspondingly almost no single-feature signal.

## Results — June, 14,984 bars (random = F1 0.333 / AUC 0.500)
| Feature set | LogReg F1/AUC | RF F1/AUC | XGB F1/AUC | best ML vs LogReg |
|---|---|---|---|---|
| **all (40)** | 0.352 / 0.526 | 0.349 / 0.515 | 0.341 / 0.509 | −0.002 → fail |
| **H1a trend (15)** | 0.330 / 0.500 | 0.330 / 0.502 | 0.328 / 0.497 | +0.000 → fail |
| **H1b momentum (15)** | 0.334 / 0.494 | 0.334 / 0.499 | 0.333 / 0.500 | +0.001 → fail |
| **H1c voldir (10)** | 0.352 / 0.527 | 0.341 / 0.512 | 0.335 / 0.505 | −0.011 → fail |

`voldir` carries the faintest whisper (LogReg AUC 0.527) — volatility weakly relates to continuation
magnitude — but nothing tradeable and trees never beat linear (no non-linear structure).

## Cross-regime + horizon confirmation
| Run | RF F1/AUC | RF ΔF1 | verdict |
|---|---|---|---|
| May n=3 | 0.358/0.531 | +0.006 (p=0.07) | fail |
| May n=6 | 0.369/0.540 | +0.014 (p=8e-6) | RF "reject" = large-n trap (XGB fails p=0.064; June n=6 = −0.020) |
| June n=6 | 0.324/0.493 | −0.020 | fail |
| June n=12 | 0.329/0.495 | −0.003 | fail |

Sign of the ML-vs-linear gap FLIPS between regimes (May slightly +, June slightly −) → no real effect.
The only "significant" cell is a trivial effect (AUC 0.540) inflated by 36k rows and unreplicated.

## Verdicts
- **H1 / H0:** FAIL to reject H0 — indicators do not beat baseline for the tradeable target.
- **H1a (trend):** FAIL — ≈ random standalone.
- **H1b (momentum):** FAIL — ≈ random standalone.
- **H1c (voldir):** FAIL — faintest whisper (AUC 0.527) but no ML edge, not tradeable, not cross-regime.
- **Non-linearity:** none — RF/XGB never beat LogReg → no interaction structure to exploit.

## Interpretation
The 32 indicators contain essentially no information about the *direction/continuation* of the next
price move (AUC 0.49–0.54), consistent with the project-wide finding that price is near-unpredictable
here. Predictable indicator-slope targets are non-tradeable; tradeable price targets are unpredictable.

## Files (read-only, reproducible)
`features.py` (family-grouped extractor) · `labels.py` (price-based label + EDA) · `model.py`
(walk-forward + family ablation + McNemar/bootstrap). Run: `python model.py [n]` ;
`FAMILY=trend|momentum|voldir` for ablation ; `DATASET=agent` for May.
