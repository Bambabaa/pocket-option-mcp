# Two-Key Decay Gate — Test Report

This directory is the **deployment home** of the decay-onset trading signal: the frozen model
artifacts, the native JS gate, and the validation suite that proves the JS reproduces the Python
research pipeline exactly. This test report documents the signal, the artifacts, the three independent
proofs, the full expiry analysis, and the deployment recipe.

Research provenance: `../ml4t/README.md` (the 6-stage pipeline that discovered the edge) and
`../ml4t/skills/FINDINGS_SKILLS.md` (the running results log).

---

## 1. The signal in one paragraph

The FX market at 5-minute scale is mildly **mean-reverting**, but the *average* reversion (~53%) sits
below the 55.6% break-even at 0.8 payout. The exploitable structure is the **extreme tail**: when
price is stretched well outside its bands and momentum is decelerating against the move
(a *capitulation-snapback*), **fading the stretch** clears break-even and replicates out-of-period.
The gate fires only on those extremes, confirmed by two keys, and trades the fade at a 10-minute expiry.

---

## 2. The artifacts

| File | Role |
|---|---|
| `ml_gate_params.json` | the frozen gate — `static-decay-gate/v2`: onset mask, heuristic rule, logistic weights+scaler, expiry/direction. **Generic schema; a JS bot parses it blindly.** |
| `parity_test_cases.json` | 100 OOS feature vectors + Python `p_decay`, for the parity proof |
| `test_gate.js` | native `evaluateOnset(currentFeatures)` — the gate |
| `test_parity.js` | proves JS `p_decay` == Python to `<1e-9` |
| `test_db_runner.js` | drives the gate over a whole SQLite DB; proves the feature port + tallies realized fade-WR |
| `TEST_REPORT.md` | this report |

Built by `../ml4t/skills/freeze-pipeline/scripts/freeze_pipeline.py` (training-time only, never at runtime).

---

## 3. The Two-Key gate (how a bar fires)

For each 5-minute bar, compute the engineered features from raw indicators, then:

**Onset mask** — a bar is a *candidate* only if it is structurally exhausted (and its stretch sign
sets the side):
```
squeeze     = (bb_upper-bb_lower)/(kc_upper-kc_lower)  > 1.20
stretch_atr = |(close-sma_50)/atr_14|                 > 4.0     → sign>0 bullish / <0 bearish
decel       = stc_delta against the stretch           ( < 0 folded )
```

**Key 1 — Heuristic confluence** (data-driven, side-normalized; `[×side]` folds by the stretch sign):
```
v_bb_width   = bb_width_bps        > 13.85
v_atr_pct    = atr_pct             >  0.0282
m_stoch_kd   = stoch_k - stoch_d   > -20.42   [×side]
```

**Key 2 — Logistic gate**: standardize all 36 features, `sigmoid(Σ z·w + b)` → `p_decay`, fire if
`p_decay ≥ 0.5698` (75th percentile of OOS).

**Verdict**: heuristic fails → *Heuristic Trap* (skip); heuristic passes + `p_decay` clears → *Q1
Consensus* (**trade the fade, 10m**); heuristic passes + `p_decay` below → *Model Abstention* (skip).

**Direction**: fade the stretch — bullish exhaustion → **PUT**, bearish exhaustion → **CALL**.

---

## 4. The three proofs (the JS gate IS the Python pipeline)

| Proof | Command | Result |
|---|---|---|
| **Logistic math** | `node test_parity.js` | 100/100 cases, **max drift 1.7e-16** (machine epsilon) |
| **Feature port** | `node test_db_runner.js` (FXSB) | onset-set 2532==2532, **feature parity 0.000e+0** over 278k bars |
| **OOS realized edge** | `node test_db_runner.js <june dbs> none` | **51 Q1 trades, fade-WR 64.7%** > 55.6% (out-of-period) |

Together: the native gate reproduces Python's `p_decay` to 1e-9 *and* its feature engineering + onset
detection to exact double precision across an entire database — and the captured signals clear
break-even on data disjoint from training.

---

## 5. Expiry analysis (which timeframe to trade)

Fade-WR of the Q1 consensus signal across forward expiries (`expiry_sweep.py`):

| set | n | 5m | 10m | 15m | 20m | 25m | 30m | best |
|---|---|---|---|---|---|---|---|---|
| FXSB (in-sample) | 425 | 59.3 | **62.4** | 60.4 | 60.6 | 60.4 | 59.4 | 10m |
| June (OOS) | 51 | 56.9 | **64.7** | 62.7 | 64.7 | 52.9 | 56.9 | 10m |

The edge **peaks at 10–15m and fades by 25–30m** — longer expiry is not better; the reversion
completes by ~15m. Driver- and side-conditional optima (FXSB Q1):

| split | best expiry |
|---|---|
| **FAST** onset (vol-shock, `atr_pct_d`) | **10m** (63.3%, sharp; spent by 15m) |
| **SLOW** onset (stoch-grind, `stoch_kd`) | **15m** (64.7%, holds to 20m) |
| bearish side | 10m (64.2%) |
| bullish side | 15m (60.6%, builds slower) |

**Deployable expiry rule:** default **10m**; vol-shock → 10m; stoch-grind → 15m; bearish → 10m,
bullish → 15m; avoid ≥ 25m.

---

## 6. Run everything

```bash
# from repo root
node bot/research/tests/test_parity.js                       # logistic parity <1e-9
node bot/research/tests/test_db_runner.js                    # FXSB feature port + in-sample WR
JUNE="data/trading_data_5-02.db,data/trading_data_5-03.db,data/trading_data00.db,data/trading_data.db"
node bot/research/tests/test_db_runner.js "$JUNE" none        # OOS realized fade-WR

# expiry sweep (Python, analysis only)
S=bot/research/ml4t/skills/directional-momentum-edge
python $S/scripts/expiry_sweep.py --csv $S/exports/onsets_fxsb_4.0_full.csv
python $S/scripts/expiry_sweep.py --csv $S/exports/onsets_june_4.0_full.csv

# re-freeze the gate from fresh data (training-time)
python bot/research/ml4t/skills/freeze-pipeline/scripts/freeze_pipeline.py
```

---

## 7. Live firing recipe (for the bot)

```
on each closed 5m bar, per asset:
  F = engineerFeatures(bar, prevBar)            # 36 ATR-normalized features
  if not onsetMask(F): continue                 # squeeze>1.20, |stretch|>4 ATR, decel
  side = F.t_close_sma50 > 0 ? bullish : bearish
  res  = evaluateOnset({...F, side})            # test_gate.js, from ml_gate_params.json
  if res.execute:                               # Q1 Consensus
     dir    = side == bullish ? PUT : CALL      # fade the stretch
     expiry = driverIsStochGrind(F) ? 15m : 10m # else default 10m
     placeTrade(asset, dir, expiry)
```
No Python at runtime — `evaluateOnset` + the JSON are self-contained.

---

## 8. Honest limitations (read before sizing)

1. **OOS is thin.** The out-of-period edge rests on **51 Q1 trades** (z ≈ 1.3 vs break-even). It is
   *consistent* across three independent methods (decay-gate 61.4%, surrogate 62.2%, this gate 64.7%),
   but not yet statistically conclusive alone.
2. **In-sample numbers are optimistic.** FXSB (62.4%) is the training DB; the heuristic thresholds
   were grid-searched on a June set — so the freeze's own WR is an in-sample-to-search ceiling.
3. **Mask provenance.** The freeze tuned its threshold/grid on a *looser-mask* June export (2.0/1.05)
   while the deployed mask is 4.0/1.20; the gate-consistent OOS validation (DB runner, 4.0) is the
   cleaner number and the one cited here.
4. **The only honest next step is forward shadow validation** — run `test_db_runner.js` against fresh
   captures as they accumulate, watching Q1 consensus hold ~60%+ and `n` grow past 51 toward
   significance. Backtesting is exhausted; live confirmation is what remains before risking size.

---

## 9. Forward validation №1 — agent.db (May 29 – Jun 12): NOT confirmed

First fresh-capture shadow run (`agent/data/agent.db`, 15 FX assets, 59,805 bars, ~14 days;
oracle `onsets_agent_4.0_full.csv`, 379 onsets, base fade 52.5%).

| check | result |
|---|---|
| Port (onset-set / feature parity) | **379==379 / 0.000e+0 — exact** on a never-seen DB ✓ |
| Q1 consensus fade-WR @10m | **54.4% (n=68) — below break-even** ✗ |
| …window B Jun 2–10 (overlaps tuning pool) | 57.4% (n=54) — discount, tuning-contaminated |
| …clean windows May 29–Jun 1 + Jun 10–12 (truly forward) | **42.9% (n=14)** |
| p_decay calibration monotonicity | **+0.81 (June pool) → +0.28** — decile curve zigzags, lie detector fires |
| Verdict ordering | INVERTED: Abstention 60.7% (n=107) > Q1 54.4% |

**Reading:** the code is perfect; the edge did not show up. Not a definitive kill — a true 62% edge
would produce ≤54.4% on n=68 roughly 10% of the time, and the clean-window n is only 14 — but every
secondary diagnostic (calibration, verdict ordering) degraded simultaneously. **Decision: DO NOT
SIZE. Stay in shadow.** Either the capitulation-snapback edge was regime-specific (Apr–May +
early-June) and has decayed, or the gate needs re-freezing on recent data under the same
out-of-period discipline. Re-evaluate when accumulated clean-window n reaches ~50.

---

## 9. File map

```
bot/research/tests/
├── TEST_REPORT.md            ← this report
├── ml_gate_params.json       ← frozen static-decay-gate/v2
├── parity_test_cases.json    ← 100 vectors + python p_decay
├── test_gate.js              ← evaluateOnset() native gate
├── test_parity.js            ← p_decay parity (<1e-9)
└── test_db_runner.js         ← full-DB feature port + realized fade-WR

bot/research/ml4t/skills/
├── freeze-pipeline/scripts/freeze_pipeline.py        ← builds the JSON artifacts
└── directional-momentum-edge/scripts/
    ├── decay_onset.py         ← onset detection + CSV export (--export-full)
    ├── surrogate_extract.py   ← interpretable heuristic discovery
    ├── consensus_survival.py  ← Q1 survival by driver (5/10/15m)
    └── expiry_sweep.py        ← fade-WR × expiry × verdict (5–30m)
```
