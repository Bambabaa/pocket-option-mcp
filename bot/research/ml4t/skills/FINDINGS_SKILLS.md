# FINDINGS — ML4T Skills Pipeline (2026-06-10 session)

Five chained research skills built under `bot/research/ml4t/skills/`, then used to answer the
project's central question — *is there a profitable directional signal in the 32 indicators, with
momentum gain/decay/stable framing?* — across **two regimes**:

- `data/trading_data.db` — Jun 8–10, 2 days, 15 pairs, ~5.6k indicator bars
- `agent/data/agent_FXSB.db` — Apr 2–May 25, 53 days, 28 pairs, ~278k bars (schema aliased; handled
  by `_lib/po_data.py`)

All runs: 5-min bars, 5/10/15/20-min validation horizons, purged walk-forward (embargo 5 bars),
break-even WR 55.6% at 0.8 payout, read-only (immutable=1).

## The skills (each = SKILL.md + scripts/ + references/)

1. **alpha-factor-eval** — IC + block t-stat + quantile spread + payout-aware hit-rate per factor.
2. **purged-walk-forward-cv** — OOS confirmation; verdict separates *statistically real* from
   *tradeable* (STABLE-IC / SUB-BREAKEVEN tier).
3. **meta-labeling** — bet/skip abstention on a configurable primary (factor rule or bot signals).
4. **directional-momentum-edge** — forward gain/stable/decay (price-based, causal terciles) predicted
   from ALL 32 indicators engineered into family-tagged stationary features (trend / momentum /
   volatility / breakout); per-family ablation; bet gain→with-trend, decay→against, stable→skip.
5. **momentum-persistence** — "how many candles until a detected momentum-gain falls back?" —
   multi-family confluence onset (≥4/5 conditions, never one indicator), cross-back-through-entry
   duration label, per-expiry survival classifier (`--model logreg|tree`).

## Results

### rsi_14 (example factor through skills 1→2→3)
- IC real and cross-regime: block IC −0.069 (2d) / −0.088 (53d, t=−13.45, 834 blocks). Sign-consistency
  1.00 OOS on 53d. **But WR 50.9–51.9% < 55.6% → STABLE-IC / SUB-BREAKEVEN in BOTH regimes.**
- Meta-labeling can't rescue it: meta-AUC 0.513 → NO LIFT.
- `Stoch_Divergence` (the old tree's 0.988-importance feature): noise (block p>0.05). `d(stc,1)`: noise.

### Momentum state (skill 4, family ablation, cross-regime)
- 2-day set: every family 33.7–34.4% acc (≈33.3% random), WR 46–49% → NO EDGE.
- 53-day set (227k rows): acc detectably above chance — trend 34.7–35.3 / momentum 34.9–35.2 /
  volatility 35.9–36.2 / breakout 35.7–36.0 / all 36.5–36.6% — but WR 48.8–51.0% at every horizon →
  **PREDICTABLE-BUT-UNPROFITABLE**. Consistent split: decay→against-trend (~50.8–51.6%) always beats
  gain→with-trend (~47.7–49.3%).

### Persistence (skill 5, both regimes)
- **Median time-to-fall-back after a momentum-gain confluence: 1 candle** (both regimes; ~12–14%
  survive >12 bars). Detected gains revert almost immediately.
- Follow-trend WR 44–47% everywhere → the confluence is a REVERSION trigger. **Fade WR 52.6–53.8%
  (53d, both 4/5 and strict 5/5 confluence) — real, stable, and ~2.5pts SHORT of break-even.**
  (The 2-day 55.7%@10m was small-sample noise.)
- Survival model AUC ≈ 0.52 (logreg) and 0.514–0.517 (constrained tree) — **tree ≤ linear at every
  expiry**; confidence-gating collapses coverage to ~0–1% without clearing break-even.

## Consolidated conclusion

> **The market is mildly mean-reverting at 5-min scale and this is detectable with overwhelming
> significance — but the edge is ~53% where 55.6% is needed. The 80% payout deficit is the wall.
> No indicator family, confluence, target framing (state / direction / duration), model class
> (linear / tree), or abstention scheme crosses it. The bottleneck is the information content of
> 5-minute indicator inputs, not the model.**

A ~53% edge breaks even only at ~89% payout (1/(1+p)=0.53). Implications, in order of leverage:
1. **Richer inputs** — 1s tick microstructure (imbalance, run-length, micro-vol), cross-asset
   lead-lag, barrier-touch labels. The only untouched information sources.
2. **Higher-payout execution** — the same 53% edge is profitable wherever payout ≥ ~90%.
3. NOT: more model capacity on the same features (tested: tree ≤ linear, abstention no lift).

## Addendum — decay-gate replication (skill #6, `decay-gate-replication/`)

The user's original decay setup (the build behind `ml-gate.js`: ±3-bar sign-flip label, 4 kinetic
features BB_Deviation / CCI_Velocity / Stoch_Divergence / STC_Momentum, logreg + constrained tree,
0.85 gate, fade direction) was replicated faithfully and graded **out-of-fold** — which the original
build never did. Result: **the first multiply-replicated break-even-clearing lead of the project.**

OOS fade win-rate (precision) by confidence gate, per dataset:

| dataset (period, assets) | 0.60 | 0.70 | 0.85 |
|---|---|---|---|
| agent_FXSB (Apr–May, 28 FX) | 1951 / 58.8% | 745 / 60.8% | 190 / **79.5%** |
| agent_v1 (May, 13 FX — overlaps FXSB) | 1283 / 54.7% | 586 / 54.6% | 83 / **66.3%** |
| June pooled 5-02+5-03+00+current (OUT-OF-PERIOD) | 742 / **56.6%** | 101 / **61.4%** | 7 / 42.9% |
| agent_00 (May, 77 mixed assets) | 1442 / 49.9% | 509 / 55.0% | never fires |

- **logreg never reaches 0.85 OOS** (tops out ~0.65) — the deployed logreg arm of ml-gate.js
  effectively never fires; its in-sample calibration was optimistic.
- **The tree's confident region is real on FX**: monotonic precision curves, dispersed signals
  (28 assets / 28 days on FXSB; duplication ~2×), economically coherent pocket — median fired
  profile = price ~half a band-width BELOW the lower Bollinger + violent CCI down-thrust
  (capitulation → snapback). The fixed 0.85 cut is miscalibrated across training sizes; the
  tradeable region is gate ≈ 0.60–0.75, WR ≈ 56–61% out-of-period.
- **Fails on the 77-asset mixed universe** (agent_00) — the pocket looks FX-specific.
- The earlier "fade ≈ 53%, sub-break-even" finding (skill #5) measured the AVERAGE reversion;
  this shows the extreme TAIL of the same phenomenon clears the payout deficit.

**Status: promising lead, not a shipped edge.** Next gates before any freeze: characterize the
winning leaf conditions explicitly (transparent rule, not "trust the tree"), recalibrate the gate
per-training-size (percentile, not fixed 0.85), re-derive the payout floor from OOS precision
(~56–61%, not the in-sample 0.97 leaves), and shadow-validate forward on live data.

## Addendum 2 — tier strategies & the conditional Decay Onset Evaluator

- **3-tier heuristic scaling** (`tiered-entry-eval/scripts/tier_eval.py`): as specified (20% extreme
  / 50% pivot / 30% trend-confirmation) it bleeds — blended EV −0.11 to −0.14 per stake. Only the
  tier-1 extreme clears on Apr–May (57.7%/56.7% @10m); tiers 2–3 (continuation) lose 45–50%
  everywhere. The later the entry, the worse the WR. Allocation is inverted for this market.
- **Monolithic P(up) θ-ladder** (`ml_tier_eval.py`): θ=0.52/0.56 sit at/below the 55.6% break-even
  (a calibrated 52% tier loses by construction). θ-corrected it looked spectacular on Apr–May
  (GBM 62.2% on 4,124 @θ0.60, monotone calibration) — and **collapsed out-of-period** (June AUC
  0.494, calibration flat, top-confidence bucket 48.7%). Directional confidence does not transfer;
  decay-target confidence does. The most instructive false positive of the project.
- **Decay Onset Evaluator** (`directional-momentum-edge/scripts/decay_onset.py` — Stage-4 refactor:
  exhaustion pre-mask → conditional P(decay) → family ablation → per-fold percentile gate):
  mask depth is the control variable. FXSB: 2 ATR/1.05 squeeze = 4% kept, base 51.7%, AUC 0.50,
  FAILS; 4 ATR/1.20 = 0.9% kept, base 52.6%, **vol+momentum gated 57.1% (n=539) PASSES**; June at
  the same mask: base 53.6% (n=179, too few to model). Monotone depth→edge gradient both regimes.
  Caveat: each pass is individually weak (z ≈ 0.7–1.4); the LEARNED pocket (decay-gate tree:
  79.5%/61.4%) remains stronger than any hand-written mask — the onset definition should come from
  leaf-rule extraction, with this conditional architecture on top.

## Addendum 3 — surrogate extraction (interpretable proxy of the decay-onset model)

`directional-momentum-edge/scripts/surrogate_extract.py` over the onset CSVs: shallow DecisionTree
(depth 2-3) → human-readable rule, winner/loser separation, and an OUT-OF-SAMPLE disagreement matrix
(ML_Signal = p_decay_pct gate vs Heuristic_Signal = surrogate tree; surrogate fit on a temporal train
slice, scored on held-out + cross-period June). `decay_onset.py --export-full` dumps all 36 features
for a fair surrogate.

- **Curated 10-feature export is too thin to surrogate**: consensus quadrant FAILS (June Q1 45.3%),
  edge appears irreducibly in the model (black-box Q2 66.4%). Misleading — the export dropped the
  decisive feature.
- **Fair 36-feature surrogate**: consensus (rule ∧ ML) **spikes to 62.2% out-of-period June**
  (n=148, base 50.8%); held-out FXSB Q1 56.2%. Depth-3 rule importance v_bb_width 0.53,
  v_atr_pct_d 0.25, m_stoch_kd 0.22 — a volatility-width × ATR-acceleration × stoch-divergence
  confluence (the missing ingredient vs the curated export was **v_atr_pct_d**, ATR%-acceleration).
- **ML gate is NOT removable**: heuristic-fires-alone (Q1∪Q3) = 54.7% June, sub-break-even; the ML
  separates Q1 (62.2%) from Q3 (52.1%) by ~10pts — it filters noise the rule alone is fooled by.
- **Deployable artifact**: shallow rule (transparent onset gate) ∧ frozen L2-logistic p_decay (the
  decay-onset "all" model — hand-ports to ml_gate_params.json like ml-gate.js, no Python runtime).
  Deploy the CONSENSUS as the high-conviction tier: ~62% OOP, both components native to the bot.
  Status: strongest result of the project; n~148 consensus (z≈1.6 vs break-even) — confirm forward.

## Addendum 4 — consensus survival / expiry selection (Stage 5)

`momentum-persistence/scripts/consensus_survival.py` pipes the Q1 consensus events (heuristic ∧
p_decay gate) into a fade-WR-by-expiry survival curve, stratified by onset driver. On June Q1 (n=148,
out-of-period):

- **5m expiry is a LOSS (52.0%) across every split** — the reversal hasn't completed in one bar. The
  default expiry is **10m** (62.2%), not 5m. (The original fire-fast instinct entered too early.)
- **Optimal expiry depends on the driver** (fast/slow hypothesis confirmed, shifted +1 bar):
  ATR-shock onsets (atr_pct_d) peak at 10m (66.2%) and decay by 15m; stoch-grind onsets (stoch_kd)
  keep rising to 15m (64.9%). → vol-shock trades 10m, divergence-grind trades 15m.
- **The turn sticks**: of events fading at 5m, 90.9% still fading at 10m, 80.5% at 15m — no quick
  round-trip; the risk is entering before the turn, not a snap-back.
- Caveat: strata ~74 each; "5m is bad" is robust, the 10m-vs-15m driver split needs forward confirm.
- `decay_onset.py --export-full` now also carries fwd_5m/10m/15m_ret for this mapping.

## Addendum 5 — freeze, native JS gate, triple-proof, expiry sweep (deployment)

The decay-onset consensus was frozen and ported to a runtime-Python-free native gate. Full writeup:
`bot/research/tests/TEST_REPORT.md`.

- **Freeze** (`freeze-pipeline/scripts/freeze_pipeline.py` → `bot/research/tests/ml_gate_params.json`,
  schema `static-decay-gate/v2`): data-driven, nothing hardcoded. Key 1 = side-normalized shallow-tree
  confluence (`v_bb_width>13.85`, `v_atr_pct>0.0282`, `m_stoch_kd>-20.42 [×side]`); Key 2 = L2-logistic
  `p_decay ≥ 0.5698` (75th pct). JSON carries the onset mask + a `compute` formula per threshold so a
  JS bot fires blindly. Heuristic thresholds grid-searched on OOS (in-sample-to-search ceiling).
- **Native gate** (`bot/research/tests/test_gate.js`, `evaluateOnset`) — two keys from the JSON, no
  Python at runtime.
- **Three proofs**: (1) logistic parity `test_parity.js` — 100/100 within 1e-9, **max drift 1.7e-16**;
  (2) feature port `test_db_runner.js` on FXSB — onset-set 2532==2532, **feature parity 0.000e+0** over
  278k bars (JS engineer_families == Python exactly); (3) OOS realized — **51 Q1 trades, fade-WR 64.7%**
  on the out-of-period June pool (>55.6% break-even).
- **Expiry sweep** (`directional-momentum-edge/scripts/expiry_sweep.py`, 5–30m): Q1 consensus **peaks
  10–15m and fades by 25–30m** (longer ≠ better). FXSB Q1 62.4% @10m (in-sample); June OOS 64.7% @10m.
  Driver split confirmed across 6 horizons: **vol-shock (atr_pct_d) → 10m (63.3%)**, **stoch-grind
  (stoch_kd) → 15m (64.7%)**; bearish→10m (64.2%), bullish→15m (60.6%).
- **Status**: port proven exact three ways; OOS edge real but thin (n=51, z≈1.3) and consistent with
  the surrogate (62.2%) and decay-gate (61.4%) June numbers. Backtesting exhausted — forward shadow
  validation is the only remaining step before sizing.

## Reproduce

```
S=bot/research/ml4t/skills
python $S/alpha-factor-eval/scripts/alpha_eval.py --factor "rsi_14" [--db agent/data/agent_FXSB.db]
python $S/purged-walk-forward-cv/scripts/purged_wf.py --factor "rsi_14" --horizon 10 --db ...
python $S/meta-labeling/scripts/meta_label.py --primary "rsi_14" --neutral 50 --top-side put --horizon 10
python $S/directional-momentum-edge/scripts/directional_momentum.py --horizon 10 --db ...
python $S/momentum-persistence/scripts/momentum_persistence.py --db ... [--confluence 5] [--model tree]
python $S/directional-momentum-edge/scripts/expiry_sweep.py --csv $S/directional-momentum-edge/exports/onsets_fxsb_4.0_full.csv
python $S/freeze-pipeline/scripts/freeze_pipeline.py          # → bot/research/tests/*.json
node bot/research/tests/test_parity.js                        # logistic parity <1e-9
node bot/research/tests/test_db_runner.js                     # FXSB feature port + WR
```
