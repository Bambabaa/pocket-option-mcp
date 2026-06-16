# ML Gate Workflow — bot → dependencies → tests

Trace of the deployed ML model workflow, its training/export source, and the test layer.
Key finding: **two separate gate systems exist; only one is live.**

---

## 1. Live runtime chain (what actually trades)

```
pocket-option-bot.js
  └─ require('./ml-gate.js')                                   [bot:14]
       └─ PARAMS literal  ←  bot/research/ml_gate_params.json  (4-feature reversal gate)
```

Per closed bar, per asset:

```
bot: evaluateMLGate(indicatorData, asset, candles, 0.80)      [bot:330, called :752/:913]
  │   - blocks OTC assets
  │   - payout HARDCODED 0.80  (NOT live broker payout)  <-- bug
  ▼
ml-gate.js: evaluateGate(ind, payout)                         [ml-gate.js:151]
  │   1. computeKineticFeatures(ind, state)                   [:60]
  │        per-asset rolling rings: cci_history(3), stc_history(2)
  │        BB_Deviation     = (close-bb_lower)/(bb_upper-bb_lower)   contemporaneous
  │        CCI_Velocity     = (cci[t]-cci[t-2])/2                    needs 3 samples
  │        Stoch_Divergence = |stoch_k-stoch_d|                      contemporaneous
  │        STC_Momentum     = stc[t]-stc[t-1]                        needs 2 samples
  │   2. scoreDecisionTree(feat)  walk 22-leaf tree            [:122]
  │   3. scoreLogReg(feat)        standardize + sigmoid        [:133]
  │   4. decide(score, model): approved = score>=0.85 AND payout>=floor   [:161]
  │        floors: tree 0.70, logreg 0.78
  ▼
bot: cascade + direction                                      [bot:344-367]
      TREE approved  -> ML_REVERSAL_GATE_TREE,  dirMode='follow' (continuation)
      else LOGREG    -> ML_REVERSAL_GATE_LOGREG, dirMode='fade'  (reversal)
      direction = computeDirectionFromRecentMove(asset,candles,dirMode)  [bot:318]
        recentMove = close[t]-close[t-3]
        fade:   up->PUT,  down->CALL
        follow: up->CALL, down->PUT
```

**Separation of concerns:** `ml-gate.js` is DIRECTION-AGNOSTIC — it only outputs reversal
probabilities. The fade/follow choice lives entirely in the bot at
`dirMode = isTree ? 'follow' : 'fade'` [bot:366].

---

## 2. Training -> export side

```
reversal_gate_pipeline_v2.py   (sklearn; trains tree + logreg on merged candles+indicators CSV)
        |  trained_rows 49,515 | reversal_base_rate 0.398
        v
bot/research/ml_gate_params.json   (tree nodes + logreg coef/scaler + thresholds + payout_floor)
        v  embedded as PARAMS literal
bot/ml-gate.js
```

Both arms hinge on ONE feature: ml-gate.js header states tree feature importance
**Stoch_Divergence 0.988**; logreg coef is 0.593 on Stoch_Divergence vs ~0 on the other
three (see TREE_DIRECTION_REPORT.md sec E — single-feature collapse).

---

## 3. Test layer — TWO suites guarding TWO gates

### A. Deployed reversal gate  ->  bot/research/test-ml-gate.js
5 tests, all vs sklearn:
  1. Tree parity   JS == Python proba  < 1e-9  (600 vectors)
  2. LogReg parity JS == Python proba  < 1e-9  (600 vectors)
  3. Feature builder JS == pandas      (210 real bars)
  4. Gate decisions approve/reject @0.85 match Python
  5. Payout kill-switch flips below each floor

### B. Two-Key static-decay-gate/v2  ->  bot/research/tests/   (NOT wired into the bot)
  - test_gate.js      Key1 heuristic confluence + Key2 logistic p_decay,
                      from bot/research/tests/ml_gate_params.json (freeze_pipeline output)
  - test_parity.js    JS p_decay == Python  < 1e-9
  - test_db_runner.js drives the gate over a whole SQLite DB, reproduces
                      po_data.engineer_families in JS, cross-checks onsets/features vs the
                      Python oracle CSV

---

## 4. The fork — two systems, only one live

| | Deployed (LIVE) | Two-Key (research/tests) |
|---|---|---|
| code | bot/ml-gate.js | bot/research/tests/test_gate.js |
| params | bot/research/ml_gate_params.json | bot/research/tests/ml_gate_params.json |
| model | 4 kinetic features, tree+logreg cascade | heuristic Key1 + logistic p_decay |
| source | reversal_gate_pipeline_v2.py | freeze_pipeline.py (ml4t skill chain) |
| tests | test-ml-gate.js | test_parity.js + test_db_runner.js |
| in the running bot? | YES (bot:14) | NO — never imported |

The entire ml4t research pipeline (decay_onset -> freeze -> Two-Key gate) is parity-proven
but **not deployed**; the bot runs the older reversal_gate_pipeline_v2 artifact.

## 5. Wiring gaps in the LIVE path

1. **Hardcoded 0.80 payout** [bot:752,913] defeats the payout_floor kill-switch ml-gate.js
   implements — the real broker payout (often 60-69%) never reaches the gate. The toxic
   80-90% payout trades (SETTLED_TRADE_REPORT.md, -$4,815) got through because of this.
2. **dirMode = isTree ? 'follow' : 'fade'** [bot:366] — the direction call that agent.db
   big-n (n=5,702) showed has no durable edge either way at 15m (TREE_DIRECTION_REPORT
   sec D, Test B).
3. ml-gate.js is stateful (per-asset rings); re-evaluating a bar advances the rings and
   corrupts features (bot:1138 guards against this — do not double-evaluate).
