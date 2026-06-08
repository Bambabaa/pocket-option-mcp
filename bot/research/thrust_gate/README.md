# Thrust Gate — XGBoost Continuation (RESEARCH_SHADOW, NOT for live)

Squeeze-conditioned momentum-thrust continuation gate. **Confirmed single-regime overfit** —
kept as a research + JS-export/parity demo, not a deployable gate.

## Verdict (do not deploy)
The Step-4 separability probe found the squeeze+`Thrust_dir` lead was **June-only**:
`Thrust_dir` permutation p **June 0.020 → May 0.700**; squeeze continuation **56.6% → 47.7%**.
The XGBoost gate confirms it: on **June** it clears 60% (64.1% @0.65, 65.4% @0.70) but on
**May** the identical model gives **45–50%** (break-even payout >100%, unwinnable). The 60%+
is a curve-fit of the regime where the signal was a statistical artifact.

## Files
| File | Role |
|---|---|
| `xgb_continuation_gate.py` | purged-CV eval + threshold sweep, runs `agent`/`snapshots`/`both` |
| `export_xgb_gate.py` | full-data fit → `thrust_xgb_params.json` + `thrust_xgb_fixtures.json` (SOP Step 10) |
| `thrust-xgb-gate.js` | JS port — walks the dumped trees, `sigmoid(base + Σ leaf)` |
| `test-thrust-xgb-gate.mjs` | parity test: JS vs Python proba over 600 fixtures |

## Features / target
```
Thrust_dir = |plus_di - minus_di| * williams_r          (canonical: adx_plus_di/adx_minus_di/williams_14)
F_macro    = (close - keltner_middle) / atr_14           (canonical: kc_middle)
Squeeze_Release = squeeze_on[t-1] AND NOT squeeze_on[t]  (squeeze_on = BB width < KC width)
Target_Continuation = 1 if sign(close[t+3]-close[t]) == sign(close[t]-close[t-1])  (3-class, flats dropped)
```
Trained-13 pairs only. agent.db has the indicators under OLD names (plus_di/minus_di/williams_r/
keltner_*); the snapshots use the new names (adx_plus_di/.../kc_*).

## ⚠ JS-port gotcha (float32)
XGBoost evaluates splits in **float32**. The JS walk MUST compare with `Math.fround(v) < Math.fround(t)` —
plain float64 `<` flips branches at boundaries and silently corrupts predictions by up to ~0.2.
(sklearn models are float64, so `macd-gate.js` was fine with a plain `<`; XGBoost is not.)
Parity with the float32 fix: **max|Δproba| = 7e-8**.

## Run
```
python export_xgb_gate.py          # writes params + fixtures
node   test-thrust-xgb-gate.mjs    # parity check
python xgb_continuation_gate.py both
```
