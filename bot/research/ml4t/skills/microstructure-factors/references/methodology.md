# Methodology — Microstructure Factors

The mechanics behind `scripts/micro_factors.py`: turning the 1-second tick stream into per-bar
features and testing them with the alpha-factor-eval IC protocol.

## 1. Tick → bar binning

Each tick `(asset, timestamp, price)` is assigned to its 5-minute bar via `bar = (ts // 300) * 300`.
Candle timestamps are 300s-aligned, so `bar` joins exactly to `candles.timestamp` for the close and
the forward returns. Bars with `< --min-ticks` (default 10) are dropped — too few ticks for stable
features.

## 2. Features (all causal — known at bar close)

From the price ticks `p[0..k]` within one bar (`d = diff(p)`, `s = sign(d)` non-zero):

| feature | definition | family |
|---|---|---|
| `n_ticks` | tick count | intensity (tick-exclusive) |
| `net_ret` | `(p_last − p_first)/p_first` | directional (≈ candle return) |
| `imbalance` | `mean(sign(diff(p)))` | order-flow (tick-exclusive) |
| `max_run` | longest same-sign run / n_ticks | persistence (tick-exclusive) |
| `micro_vol` | `std(diff(p)/p)` | magnitude (tick-exclusive) |
| `range_bps` | `(max−min)/p_first · 1e4` | magnitude (tick-exclusive) |
| `close_pos` | `(p_last − min)/(max − min) − 0.5` | directional (≈ candle close-in-range) |
| `spike_revert` | `1 − \|p_last − p_first\|/(max − min)` | wick / round-trip (tick-exclusive) |

"Tick-exclusive" features genuinely need the stream; `net_ret`/`close_pos` are bridges — they correlate
~0.99 with the OHLC `(close−open)/open` and `(close−low)/(high−low)`, so they are candle shape, not
microstructure.

## 3. Label & IC protocol

Forward bar return `fwd_h = close[bar+n]/close[bar] − 1`, `n = h·60/bar_sec`, contiguous bars only,
`h ∈ {5,10,15}`. For each feature × horizon: Spearman IC (pooled) plus the **block t-stat** — IC
recomputed in 1-hour blocks, then `t = mean/(std/√B)` — the honest significance (pooled p-values are
autocorrelation-inflated). A `SIGNAL?` flag requires block `|IC| > 0.03` and `p < 0.05`, identical to
`alpha-factor-eval`. A flag is a *candidate*; confirmation is `purged-walk-forward-cv` (OOS IC
sign-consistency + extreme-quantile WR vs break-even).

## 4. Result (first full run)

- Pooled across all four June tick DBs (~19k bars): every **tick-exclusive** feature is noise
  (block p > 0.05). The 1s order flow carries no forward information.
- `net_ret` and `close_pos` clear (block IC ~−0.05, p < 0.01, all horizons) — but they are candle
  shape (corr 0.99 with OHLC). Cross-regime on agent_FXSB (OHLC, 53d): block IC ~−0.06, p=0.000.
  Purged-WF: **STABLE-IC / SUB-BREAKEVEN** (WR 51.5% < 55.6%). Real mean-reversion, not standalone-tradeable.

## 5. What this does NOT do

- It does not establish tradeability — that is purged-WF + WR (run separately; result above).
- It cannot cross-regime-validate tick-exclusive features — `agent_*` has no ticks.
- It does not build a model — it is an inputs probe feeding the existing gauntlet.

## References

- `alpha-factor-eval` (the IC protocol reused here), `purged-walk-forward-cv` (the tradeability gate),
  `_lib/po_data.py` (now returns open/high/low so candle-shape factors run through the gauntlet).
- Project: `bot/research/ml4t/skills/FINDINGS_SKILLS.md` (addendum 6 records this result).
