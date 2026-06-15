# Settled-Trade Report — all trade DBs (broker truth)

Pooled `trades_ordered` across `trading_data_5-02 / _5-03 / 00 / _08220 / trading_data`,
broker-settled `result`/`profit_loss` only (stored prices ignored). Arm from
`signals.strategy_used`. Generated 2026-06-15.

**OVERALL: 91 trades | 53% WR | P/L −$6,230**

## By arm — the loss is one arm

| Arm | n | WR | P/L |
|---|---|---|---|
| LOGREG | 58 | 64% | +$1,475 |
| TREE | 33 | 33% | −$7,705 |

## By arm × direction

| Arm × Dir | n | WR | P/L |
|---|---|---|---|
| LOGREG PUT | 24 | 67% | +$1,380 |
| LOGREG CALL | 34 | 62% | +$95 |
| TREE CALL | 23 | 26% | −$6,840 |
| TREE PUT | 10 | 50% | −$865 |

**TREE-CALL = −$6,840 ≈ the whole drawdown.**

## By direction

| Dir | n | WR | P/L |
|---|---|---|---|
| CALL | 57 | 47% | −$6,745 |
| PUT | 34 | 62% | +$515 |

(The CALL loss is TREE-CALL, not CALL per se — LOGREG-CALL is +$95.)

## By payout bin

| payout | n | WR | P/L |
|---|---|---|---|
| 20–30% | 3 | 100% | +$375 |
| 30–40% | 3 | 33% | −$845 |
| 40–50% | 7 | 57% | −$600 |
| 50–60% | 21 | 62% | −$440 |
| 60–70% | 13 | 69% | +$940 |
| 70–80% | 18 | 50% | −$1,145 |
| 80–90% | 17 | 24% | −$4,815 |
| 90–100% | 9 | 56% | +$300 |

Toxic 80–90% bin = −$4,815; sweet spot 60–70% = +$940. (Payout is non-stationary —
these bands are a snapshot, not a fixed rule.)

## By asset

Worst: AUDUSD −$2,410 (30%, n=10) | AUDCAD −$2,000 (0%, n=4) | USDCAD −$1,500 (0%, n=3) |
AUDJPY −$1,260 (44%, n=9). Best: EURAUD +$1,320 (100%, n=4) | EURCHF +$1,245 (86%, n=7) |
AUDCHF +$1,210 (83%, n=6) | EURCAD +$505 (71%, n=7).

## Reconciliation with agent.db (n=41,762, candle proxy)

| | trade DBs settled (n=91) | agent.db proxy (big n) |
|---|---|---|
| LOGREG | 64% / +$1,475 | ~53% (coin) |
| TREE | 33% / −$7,705 | ~50% (coin) |

No real contradiction once weighted by n:
- LOGREG 64% on n=58 → 95% CI ≈ 51–76% — lower bound touches the coin flip; consistent with
  agent.db's ~53%. A small, NOISY positive, not a proven edge.
- TREE 33% on n=33 is firmly negative but contaminated: mostly reversal-era + high-payout +
  CALL → it measures wrong-direction + payout selection, not model skill. Direction-neutral
  agent.db shows the underlying tree at ~coin.

## Verdict (settled-money view)

- **If forced to run one arm: LOGREG only.** It is the sole net-positive arm (+$1,475) — but
  its edge is within sampling noise of break-even, so do NOT size up on it.
- **Never the reversal-era TREE-CALL into 80–90% payouts** — that one cell is the drawdown.
- Consistent with the agent.db finding: neither arm has a DURABLE statistical edge; the
  settled book's only profit (LOGREG) is real dollars but not a proven edge. Concede or
  retarget stands; if running live, LOGREG-only + payout sanity + drop TREE is the
  least-bad configuration of the current gate.
