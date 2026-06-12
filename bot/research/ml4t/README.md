# ML4T — Machine Learning Research Pipeline for the Pocket Option Bot

Master documentation for the offline ML research effort under `bot/research/ml4t/`. This is the
entry point: it explains *what the pipeline is, the rules it obeys, every stage, what we found, and
the one deployable result*. Companion docs: `RESEARCH_PROCEDURE.md` (the original spec),
`FINDINGS.md` (the prior trend-continuation study), `skills/FINDINGS_SKILLS.md` (the running results
log this README summarizes).

---

## 0. TL;DR

We built a six-stage research pipeline to answer one question: **is there a profitable, tradeable
signal in the bot's 32 indicators on 5-minute FX?** Across two regimes (June 2-day + April–May
53-day, 278k bars) the answer is:

- **Direction is unpredictable.** P(up) AUC ≈ 0.50; the market is mildly **mean-reverting** (a
  detected momentum-gain falls back in a *median of 1 candle*).
- **The average reversion is ~53% — below the 55.6% break-even** at 0.8 payout. The payout deficit
  is the wall; no family, model, or abstention beats it on average.
- **The exploitable structure is the extreme tail:** a *capitulation-snapback* pocket (price stretched
  well outside the bands + violent thrust, momentum decelerating) clears break-even and **replicates
  out-of-period** (decay-gate tree 61.4% @ gate 0.70 on June; surrogate consensus 62.2% on June).
- **Deployable artifact:** a transparent volatility×ATR-acceleration×stoch-divergence **rule** paired
  with a freezable **L2-logistic `p_decay` gate** — their *consensus* is the high-conviction signal.
  Both run natively in the bot (no Python). Status: validated out-of-period, awaiting forward shadow.

---

## 1. Core principles (the rules every stage obeys)

These are not style preferences; each one kills a specific way of fooling yourself, learned the hard
way (the prior study scored AUC 0.94 predicting an indicator's own slope — non-tradeable).

1. **Labels are forward PRICE, never an indicator's own value/slope.** A positive result must mean a
   real future price move, graded the way a trade settles.
2. **Success = win-rate > break-even = 1/(1+payout)** (55.6% at 0.8), *not* F1/AUC. Statistical
   significance without break-even clearance is explicitly labeled unprofitable.
3. **Purge + embargo, always.** Training rows whose forward label reaches the test period are dropped;
   an embargo guards the boundary. No leakage.
4. **One dataset = one regime.** Every verdict is re-run cross-regime; an edge that flips sign or
   vanishes out-of-period is not real. The June *out-of-period* pool is the decisive test.
5. **No single-indicator verdicts.** The 32 indicators are engineered into ~36 stationary features
   tagged by family (trend / momentum / volatility / breakout); verdicts come from families, via a
   per-family ablation.
6. **Read-only, Python offline only.** Snapshots opened `immutable=1`; nothing touches the live bot
   (the no-runtime-Python rule is about the bot process, not offline research).
7. **Reproducible.** Every result is regenerable from a command line; deployable models are frozen to
   plain JSON (the `ml-gate.js` pattern), not pickles.

---

## 2. Data

### Datasets (snapshots, read-only)
| File | Period | Assets | Bars | Role |
|---|---|---|---|---|
| `data/trading_data.db` | Jun 8–10 | 15 | ~5.6k | small live snapshot |
| `data/trading_data_5-02 / 5-03 / 00 / 08220.db` | Jun 2–8 | 15–21 | 1–2d each | **pooled = June out-of-period test** |
| `agent/data/agent_FXSB.db` | Apr 2 – May 25 | 28 | ~278k | **primary cross-regime set** |
| `agent/data/agent_v1.db` | May 12–26 | 13 | ~52k | third-regime check |
| `agent/agent_00.db` | May 20–23 | 77 | ~28k | mixed-universe check |

Bars are **5-minute**; predictions validated at **5/10/15/20-minute** horizons (1/2/3/4 bars ahead).

### Schema-adaptive layer — `skills/_lib/po_data.py`
One shared module every script imports so results are comparable and run on **both** DB schemas
(`trading_data` vs the aliased `agent_*` names; derives missing `atr_pct`). Provides:
- `load(db)` / `load_ohlcv(db)` / `load_signals(db)` — read-only, canonical column names.
- `build_factor(df, expr)` — any pandas expression over indicators; `d(col,k)` = per-asset diff.
- `forward_return(df, mins, bar_sec)` — contiguous-bar-guarded forward return.
- `engineer_families(df)` → `(X, registry)` — the 32 indicators → ~36 stationary, family-tagged
  features (ATR-normalized distances/spreads, deltas, ratios). `family_cols(registry, fam)`.
- `make_folds(times, n)` — sequential expanding-train folds over unique timestamps (purge base).

---

## 3. The pipeline — stages

Each stage asks a harder question; a hypothesis must pass one to earn the next. Stages 1–5 and the
freeze are full skills (`SKILL.md` + `references/methodology.md`); the rest are script-only tools.

### Stage 1 — `alpha-factor-eval`  *"Is there any signal?"*
`scripts/alpha_eval.py --factor "<expr>"`. Information Coefficient of a factor vs forward return, with
an **honest block t-stat** (pooled p-values are autocorrelation-inflated), quantile spread, and
payout-aware hit-rate. The cheap first gate that kills noise before modeling.
> Found: `rsi_14` mean-reversion IC real (block t −13 cross-regime); `Stoch_Divergence` = noise.

### Stage 2 — `purged-walk-forward-cv`  *"Does it survive out-of-sample?"*
`scripts/purged_wf.py --factor "<expr>" --horizon 10`. Purged/embargoed walk-forward; per-fold OOS IC,
sign-consistency, and the binary-option-specific verdict tier **STABLE-IC / SUB-BREAKEVEN** — real
edge that can't pay the payout deficit.
> Found: `rsi_14` STABLE-IC but SUB-BREAKEVEN in both regimes (WR ~51%, sign-consistency 1.00).

### Stage 3 — `meta-labeling`  *"Can abstention rescue a weak edge?"*
`scripts/meta_label.py --primary "<expr>"|signals`. A secondary L2-logistic predicts whether the
primary wins; trade only the confident subset. Verdict gates on meta-AUC and minimum coverage.
> Found: NO LIFT for `rsi_14` (meta-AUC 0.513) — abstention can't rescue a sub-break-even primary.

### Stage 4 — `directional-momentum-edge`  *"Predict momentum state from all families."*
`scripts/directional_momentum.py --horizon 10`. Forward gain/stable/decay (price-based, causal
terciles) predicted from all families; **per-family ablation**; bet gain→with-trend, decay→against,
stable→skip. Plus two refactors:
- `scripts/decay_onset.py` — **conditional Decay Onset Evaluator**: pre-mask to structural exhaustion,
  predict P(decay) within the stretched state, family ablation, **per-fold percentile gate**. Exports
  onset rows to CSV (`--export` curated / `--export-full` all 36 features).
- `scripts/surrogate_extract.py` — turns the decay-onset model into an interpretable rule (Stage S
  below).
> Found: unconditional state prediction ≈ random (acc 36% on 278k, WR ~50% → PREDICTABLE-BUT-
> UNPROFITABLE). Conditional decay-onset PASSES at deep masks (vol+momentum 57.1%); AUC 0.49→0.59 once
> conditioned on the extreme.

### Stage 5 — `momentum-persistence`  *"How many candles until it falls back?"*
`scripts/momentum_persistence.py [--model logreg|tree]`. Multi-family confluence onset, cross-back-
through-entry duration label, per-expiry survival classifier. Stage A characterizes true persistence;
Stage B predicts it.
> Found: median fall-back = **1 candle**; follow-trend 44–47%, **fade ~53%** (real, both regimes) but
> sub-break-even; tree ≤ logistic.

### Stage 6 — `decay-gate-replication`  *"Grade the deployed setup honestly."*
`scripts/decay_gate.py [--db a,b,c] [--inspect]`. The original `ml-gate.js` build (±3-bar sign-flip
decay label, 4 kinetic features, logreg+tree, 0.85 gate, fade direction) replicated and scored
**out-of-fold and out-of-period**, with `--inspect` for asset/day/feature concentration.
> Found: the deployed logreg arm never reaches 0.85 OOS (effectively dead); the tree's 0.97 leaves
> were in-sample artifacts (honest OOS 56–61%); the **capitulation pocket clears out-of-period**
> (61.4% @ gate 0.70 on June) — the project's first replicated edge.

### Stage S — surrogate extraction (interpretable proxy)
`directional-momentum-edge/scripts/surrogate_extract.py --csv <onsets> --test-csv <oos> --full`.
Shallow tree → human-readable rule; winner/loser separation; **out-of-sample disagreement matrix**
(ML p_decay gate vs heuristic, fit on a train slice, scored on held-out + cross-period June).
> Found: with all 36 features the **consensus (rule ∧ ML) = 62.2% on out-of-period June** (base 50.8%);
> the ML gate is *not* removable (heuristic-alone 54.7%); decisive feature = `v_atr_pct_d`.

### Stage S2 — expiry selection (`consensus_survival.py`, `expiry_sweep.py`)
`momentum-persistence/scripts/consensus_survival.py` (Q1 survival by driver, 5/10/15m) and
`directional-momentum-edge/scripts/expiry_sweep.py` (fade-WR × expiry × verdict, 5–30m).
> Found: Q1 fade-WR **peaks 10–15m and fades by 25–30m** (longer ≠ better). Driver split: vol-shock
> (`atr_pct_d`) → **10m** (63.3%); stoch-grind (`stoch_kd`) → **15m** (64.7%). Bearish→10m, bullish→15m.

### Stage 7 — `freeze-pipeline` (deployment)  *"Ship it without Python."*
`scripts/freeze_pipeline.py` → `bot/research/tests/ml_gate_params.json` + `parity_test_cases.json`.
Data-driven freeze of the consensus into a Two-Key `static-decay-gate/v2` JSON (heuristic confluence +
L2-logistic `p_decay`), with a `compute` formula per threshold so a native JS gate fires blindly.
Full `SKILL.md`.
> Result: the native gate (`../tests/test_gate.js`) is proven to BE the Python pipeline — logistic
> parity **1.7e-16**, feature port **0.000e+0** over 278k bars, OOS realized **64.7% (n=51)**.

### Deployment & validation — `bot/research/tests/`
The frozen artifacts, the native gate, and the three proofs live in `../tests/` with a full
`TEST_REPORT.md`. Run `node ../tests/test_parity.js` (logistic <1e-9) and
`node ../tests/test_db_runner.js [db] [csv]` (feature port + realized fade-WR on any DB).

### Side-quest — `tiered-entry-eval`
`tier_eval.py` (3-tier heuristic scaling: blended EV −0.11 to −0.14, allocation inverted for this
market) and `ml_tier_eval.py` (monolithic P(up) θ-ladder: in-regime 62% **collapses out-of-period** —
directional confidence doesn't transfer; the most instructive false positive of the project).

---

## 4. Consolidated findings

1. **Direction is unpredictable; the market mean-reverts mildly.** Six studies, AUC 0.49–0.52 for
   direction; fade beats follow everywhere (~53% vs ~47%).
2. **Average reversion (~53%) is sub-break-even.** The 80% payout (needs 55.6%) is the wall. A ~53%
   edge would break even only at ~89% payout.
3. **The edge is the extreme tail, not the average.** Conditioning on structural exhaustion
   (capitulation snapback) is what clears break-even and replicates out-of-period.
4. **Model class doesn't matter; inputs and conditioning do.** Trees ≤ logistic throughout; the wins
   came from the *conditional label* and the *extreme mask*, not capacity. The decisive single feature
   was ATR%-acceleration (`v_atr_pct_d`), absent from the original 4-feature gate.
5. **The deployed `ml-gate.js` was right in spirit, miscalibrated in practice** — correct phenomenon,
   but in-sample leaf probabilities and a non-portable 0.85 gate. Honest OOS calibration fixes it.

---

## 5. The deployable artifact + freeze path

The consensus signal, both components runnable in the bot **without Python**:

1. **Onset gate (transparent rule):** structural exhaustion mask + the shallow surrogate confluence
   (volatility-width × ATR-acceleration × stoch-divergence). Auditable, hand-codable in `indicators.js`.
2. **Calibrated gate (frozen model):** the decay-onset **L2 logistic** `p_decay` → export coef +
   scaler to `ml_gate_params.json` (the existing `ml-gate.js` pattern), gated by **per-fold
   percentile**, not a fixed absolute threshold.
3. **Trade the CONSENSUS** (rule ∧ p_decay-gate) as the high-conviction tier: ~62% out-of-period.

**Pre-sizing checklist** (status):
- [x] Extract the surrogate leaf rule explicitly (`surrogate_extract.py`; thresholds locked).
- [x] Freeze to `bot/research/tests/ml_gate_params.json` + `<1e-9` JS parity test (`freeze-pipeline`,
      `test_parity.js`) — and a full-DB feature port proof (`test_db_runner.js`, 0 diff).
- [x] Payout floor from OOS realized WR (64.7% @10m, n=51), not in-sample leaves.
- [ ] **Forward shadow-validate** the consensus on live data before risking capital — the only
      remaining gate (OOS n=51 is promising but thin). See `bot/research/tests/TEST_REPORT.md`.

---

## 6. Directory map

```
bot/research/ml4t/
├── README.md                      ← this file (master doc)
├── RESEARCH_PROCEDURE.md          ← original spec
├── FINDINGS.md                    ← prior trend-continuation study
└── skills/
    ├── FINDINGS_SKILLS.md         ← running results log (addenda 1–5)
    ├── _lib/po_data.py            ← schema-adaptive data + family engineering
    ├── alpha-factor-eval/         ← Stage 1   (SKILL.md + scripts + references)
    ├── purged-walk-forward-cv/    ← Stage 2   (SKILL.md + scripts + references)
    ├── meta-labeling/             ← Stage 3   (SKILL.md + scripts + references)
    ├── directional-momentum-edge/ ← Stage 4   (directional_momentum + decay_onset
    │   │                            + surrogate_extract + expiry_sweep)
    │   └── exports/               ← onset CSVs (curated + _full 36-feature, 5–30m fwd)
    ├── momentum-persistence/      ← Stage 5   (+ consensus_survival)  (SKILL.md + refs)
    ├── freeze-pipeline/           ← Stage 7   (SKILL.md + scripts + references) → deploy
    ├── decay-gate-replication/    ← Stage 6   (script-only)
    └── tiered-entry-eval/         ← tier strategy evals (script-only)

bot/research/tests/                ← DEPLOYMENT: TEST_REPORT.md, ml_gate_params.json,
                                     parity_test_cases.json, test_gate/parity/db_runner.js
```

---

## 7. Reproduce

```bash
S=bot/research/ml4t/skills
# Stage 1-3: factor lifecycle
python $S/alpha-factor-eval/scripts/alpha_eval.py --factor "rsi_14" --db agent/data/agent_FXSB.db
python $S/purged-walk-forward-cv/scripts/purged_wf.py --factor "rsi_14" --horizon 10 --db agent/data/agent_FXSB.db
python $S/meta-labeling/scripts/meta_label.py --primary "rsi_14" --neutral 50 --top-side put --horizon 10

# Stage 4: momentum state + conditional decay onset (+ export for surrogate)
python $S/directional-momentum-edge/scripts/directional_momentum.py --horizon 10 --db agent/data/agent_FXSB.db
python $S/directional-momentum-edge/scripts/decay_onset.py --db agent/data/agent_FXSB.db \
       --stretch-atr 4.0 --squeeze-min 1.20 --export-full $S/directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv

# Stage 5-6
python $S/momentum-persistence/scripts/momentum_persistence.py --db agent/data/agent_FXSB.db --model tree
python $S/decay-gate-replication/scripts/decay_gate.py --db agent/data/agent_FXSB.db --inspect

# Stage S: surrogate extraction + out-of-period shootout
python $S/directional-momentum-edge/scripts/surrogate_extract.py --full \
       --csv $S/directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv \
       --test-csv $S/directional-momentum-edge/exports/onsets_june_2.0_full.csv --depth 3

# Stage S2: expiry selection
python $S/momentum-persistence/scripts/consensus_survival.py \
       --csv $S/directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv \
       --test-csv $S/directional-momentum-edge/exports/onsets_june_2.0_full.csv
python $S/directional-momentum-edge/scripts/expiry_sweep.py --csv $S/directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv

# Stage 7: freeze → JSON, then PROVE the native gate (no Python at runtime)
python $S/freeze-pipeline/scripts/freeze_pipeline.py          # → bot/research/tests/*.json
node bot/research/tests/test_parity.js                        # logistic parity <1e-9
node bot/research/tests/test_db_runner.js                     # feature port (0 diff) + in-sample WR

# June out-of-period pool (the cross-period test throughout)
JUNE="data/trading_data_5-02.db,data/trading_data_5-03.db,data/trading_data00.db,data/trading_data.db"
node bot/research/tests/test_db_runner.js "$JUNE" none        # OOS realized fade-WR
```

---

## 8. Glossary

- **break-even WR** — `1/(1+payout)`; 55.6% at 0.8. The bar every signal must clear.
- **IC** — Information Coefficient; Spearman corr of a factor vs forward return. **Block t-stat** — IC
  recomputed in time blocks then t-tested (the honest significance, vs the autocorrelation-inflated
  pooled p).
- **purge / embargo** — drop training rows whose forward label overlaps (purge) or sits within N bars
  of (embargo) the test segment.
- **family** — trend / momentum / volatility / breakout grouping of the engineered features.
- **onset** — a bar passing the structural-exhaustion pre-condition (where the edge lives).
- **fade** — bet against the recent move (the mean-reversion / decay trade).
- **out-of-period (OOP)** — the June pool, disjoint in time from the April–May training data; the
  decisive generalization test.
- **surrogate / consensus** — interpretable rule approximating the model; consensus = rule ∧ ML gate.
- **freeze** — export a trained linear/tree model to `ml_gate_params.json` for native (no-Python)
  execution in the bot, with a `<1e-9` parity test (the `ml-gate.js` pattern).
