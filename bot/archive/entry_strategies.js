// ═══════════════════════════════════════════════════════════════════════════
//  FX BINARY ENTRY STRATEGIES — 15m HORIZON
//  Source: research_findings.md (51,813 bars, 13 spot FX pairs, UTC-5)
//  All edges validated: expectancy > 0 (ATR units), p < 0.01, walk-forward checked
//
//  Confidence tiers
//    T1   — Aggressive  (2.0% risk/trade)  conf >= 0.80
//    T2   — Standard    (1.0% risk/trade)  conf >= 0.65
//    T3   — Cautious    (0.5% risk/trade)  conf >= 0.50
//
//  Each strategy follows the contract:
//    { name, direction, thresholds, gates[], reason }
//
//  `ind`  = raw indicators (stc_value, macd_hist, atr_pct, bb_width_bps, …)
//  `feat` = derived features (z-scores, slopes, regime, SMC flags, …)
//  `t`    = the thresholds object — keep ALL numeric tunables here, never inline
//
//  Every gate is null-safe (`x != null && …`) so a missing feature short-circuits
//  rather than throwing. The `reason` callback is invoked only when ALL gates pass
//  so it can safely render the firing values for the trade log.
// ═══════════════════════════════════════════════════════════════════════════

const ENTRY_STRATEGIES = [

  // T1_SMC_SWEEP_LOW_BULL_OB  — DELETED: look-ahead artefact. Research bull_ob used close[t+1].
  //   Validated WR=53.6% N=69 (CALL). See validation_report.md §8.
  // T1_SMC_SWEEP_HIGH_BEAR_OB — DELETED: same look-ahead. Validated WR=45.7% N=81 (PUT). See §8.

  // ─── T1-CALL: Extreme Z-Score Reversion (-3σ below EMA20) ─────────────────
  // Train: 64.3% n=406  |  Test: 55.2% n=87   decay=-0.10 ATR ✅ stable
  // 15m: WR=62.7% n=493  exp=+0.565 ATR  PF=2.49  p<0.0001
  // Horizon scan: 30m best (WR 64.9%, exp +0.92 ATR) — let trade breathe
  // Sessions: Asian 72.1% (n=222, exp +1.06) | European 60.3% | American 49.6%
  // Assets: EURAUD 76.9%, EURCHF 72.5%, EURJPY 66.7%, CADJPY 64.9%
  // SMC: NEUTRAL — pure statistical reversion, no structural confluence required
  {
    name:      'T1_ZSCORE_EXTREME_LOW',
    direction: 'CALL',
    thresholds: {
      z_max: -3.0,
    },
    gates: [
      { label: 'z_extreme_low', fn: (ind, feat, t) => feat.z_close_ema20 != null && feat.z_close_ema20 <= t.z_max },
    ],
    reason: (ind, feat) =>
      `[T1-CALL] z_close_ema20=${feat.z_close_ema20?.toFixed(2)}σ` +
      ` dist_ema20_atr=${feat.dist_ema20_atr?.toFixed(2)}` +
      ` session=${feat.session}`,
  },

  // ─── T1-PUT: Regime Transition RANGING → VOL_EXPANSION ────────────────────
  // 15m raw EV = -0.617 ATR  N=389  WR_up=40.9%  (i.e. WR_down=59.1%)
  // The single strongest state-transition directional signal in the study.
  // Compression-break-to-vol-expansion preferentially resolves DOWN on 5m FX.
  // Requires regime label on previous bar — keep regime_prev in your feature ring.
  {
    name:      'T1_TRANSITION_RANGE_TO_VOL_EXPANSION',
    direction: 'PUT',
    thresholds: {},
    gates: [
      { label: 'prev_was_ranging',  fn: (ind, feat) => feat.regime_prev === 'RANGING' },
      { label: 'now_vol_expansion', fn: (ind, feat) => feat.regime      === 'VOL_EXPANSION' },
    ],
    reason: (ind, feat) =>
      `[T1-PUT] regime_prev=RANGING regime=VOL_EXPANSION` +
      ` bb_w_z20=${feat.bb_w_z20?.toFixed(2)} atr_slope5=${feat.atr_slope5?.toFixed(3)}`,
  },

  // ─── T2-CALL: BB-Width Peak + Bearish Bar (vol exhaustion bounce) ─────────
  // Train: 62.6% n=334  |  Test: 59.3% n=81   decay=-0.03 ATR ✅ stable
  // 15m: WR=61.9% n=415  exp=+0.320 ATR  PF=2.02  p<0.0001
  // Horizon scan: 20m and 30m both add exp; 5m is the noisiest
  // Sessions: Asian 73.3% (n=150, exp +0.71) | American 59.1% | European 51.6%
  // Assets: CHFJPY 71.1%, EURJPY 71.0%, CADJPY 70.6%, USDCAD 70.6%, EURAUD 69.4%
  // SMC: aligned with classic exhaustion — wide bands rolling over + selling = bounce
  {
    name:      'T2_BB_PEAK_BEAR_BOUNCE',
    direction: 'CALL',
    thresholds: {
      bb_w_z_min: 1.5,        // BB width z-score must be in upper tail
      bb_w_slope_max: 0.0,    // …and starting to contract (slope flipped negative)
    },
    gates: [
      { label: 'bb_width_extended',  fn: (ind, feat, t) => feat.bb_w_z20    != null && feat.bb_w_z20    >= t.bb_w_z_min },
      { label: 'bb_width_rolling_over', fn: (ind, feat, t) => feat.bb_w_slope5 != null && feat.bb_w_slope5 <  t.bb_w_slope_max },
      { label: 'bearish_candle',     fn: (ind, feat) => feat.is_bear_bar === true },
    ],
    reason: (ind, feat) =>
      `[T2-CALL] bb_w_z20=${feat.bb_w_z20?.toFixed(2)}` +
      ` bb_w_slope5=${feat.bb_w_slope5?.toFixed(3)} bearish_bar=true`,
  },

  // ─── T2-CALL: Range-Expansion Bear Bar (capitulation bounce) ──────────────
  // Train: 60.8% n=744  |  Test: 58.3% n=223  decay=-0.03 ATR ✅ stable
  // 15m: WR=60.2% n=967  exp=+0.362 ATR  PF=1.77  p<0.0001
  // Horizon scan: monotonic improvement to 30m (exp +0.54 ATR)
  // Sessions: Asian 61.6% (n=518) | European 59.2% | American 57.9%
  // Assets: EURAUD 76.5%, USDCHF 65.5%, AUDCHF 63.6%, AUDCAD 61.8%
  // SMC: aligned — capitulation candles tend to mark short-term lows
  {
    name:      'T2_RANGE_EXPAND_BEAR_BOUNCE',
    direction: 'CALL',
    thresholds: {
      range_exp_min: 2.0,     // current bar range must be >= 2x rolling-20 mean
    },
    gates: [
      { label: 'large_bar',     fn: (ind, feat, t) => feat.range_expansion != null && feat.range_expansion >= t.range_exp_min },
      { label: 'bearish_close', fn: (ind, feat) => feat.is_bear_bar === true },
    ],
    reason: (ind, feat) =>
      `[T2-CALL] range_expansion=${feat.range_expansion?.toFixed(2)}x` +
      ` body_atr=${feat.body_atr?.toFixed(2)} bear=true`,
  },

  // ─── T2-CALL: Z-Score -2σ Reversion (medium-N reversion) ──────────────────
  // Train: 56.8% n=1622  |  Test: 56.4% n=330  decay=-0.00 ATR ✅ stable
  // 15m: WR=56.8% n=1952  exp=+0.267 ATR  PF=1.70  p<0.0001
  // Horizon scan: 30m best by exp (+0.48 ATR)
  // Sessions: Asian 62.8% (n=723, exp +0.54) | American 54.1% | European 52.3%
  // Assets: EURJPY 63.9%, USDCHF 61.5%, USDCAD 59.3%, CHFJPY 59.1%, EURUSD 59.0%
  // SMC: neutral — fires too often for SMC alignment to add meaningfully
  {
    name:      'T2_ZSCORE_LOW_2SIG',
    direction: 'CALL',
    thresholds: {
      z_max: -2.0,
      z_floor: -3.0,         // exclude rows already captured by T1_ZSCORE_EXTREME_LOW
    },
    gates: [
      { label: 'z_low',         fn: (ind, feat, t) => feat.z_close_ema20 != null && feat.z_close_ema20 <= t.z_max },
      { label: 'not_T1_already', fn: (ind, feat, t) => feat.z_close_ema20 >  t.z_floor },
    ],
    reason: (ind, feat) =>
      `[T2-CALL] z_close_ema20=${feat.z_close_ema20?.toFixed(2)}σ` +
      ` dist_ema20_atr=${feat.dist_ema20_atr?.toFixed(2)} session=${feat.session}`,
  },

  // ─── T2-PUT: Fade Fresh Up-Breakout (persist == 1) ────────────────────────
  // 15m: WR=60.6% n=442  exp=+0.202 ATR  PF=1.51  p<0.0001
  // Median breakout survival in this dataset = 3 bars; 25th pctile = 1 bar.
  // Most up-breakouts fail within 1 horizon — fade on the same bar of break.
  // After persist >= 4 bars the edge disappears, so this gate is timing-sensitive.
  {
    name:      'T2_FADE_FRESH_UP_BREAK',
    direction: 'PUT',
    thresholds: {
      persist_match: 1,       // must be the FIRST bar above prior 20-bar high
    },
    gates: [
      { label: 'fresh_up_break', fn: (ind, feat, t) => feat.persist_above_break === t.persist_match },
    ],
    reason: (ind, feat) =>
      `[T2-PUT] persist_above_break=${feat.persist_above_break}` +
      ` break_strength_up=${feat.break_strength_up?.toFixed(2)}`,
  },

  // ─── T3-CALL: Fade Fresh Down-Breakout (persist == 1)  [DEMOTED T2→T3] ───────
  // 15m: WR=52.2% n=377  exp=+0.200 ATR  PF=1.50  p=0.28 (not significant)
  // Demoted by v2 validation — edge does NOT mirror the up-break fade (WR 52% vs T2_UP WR 57%).
  // Keep at T3 (0.5% risk) pending ≥ 300 fresh OOS samples. See validation_report.md §8.
  {
    name:      'T3_FADE_FRESH_DOWN_BREAK',
    direction: 'CALL',
    thresholds: {
      persist_match: 1,
    },
    gates: [
      { label: 'fresh_down_break', fn: (ind, feat, t) => feat.persist_below_break === t.persist_match },
    ],
    reason: (ind, feat) =>
      `[T2-CALL] persist_below_break=${feat.persist_below_break}` +
      ` break_strength_down=${feat.break_strength_down?.toFixed(2)}`,
  },

  // ─── T2-CALL: Lower-Wick Growth Spike (buying pressure) ───────────────────
  // 15m: WR=55.9% n=1102  exp=+0.230 ATR  p<0.001
  // Rolling-5 lower-wick mean is >= 2x the rolling-20 baseline = recent rejection
  // of lower prices. NOTE: the symmetric upper-wick fade does NOT work — see
  // report §4.3 for the asymmetry discussion.
  {
    name:      'T2_LOWER_WICK_GROWTH_2X',
    direction: 'CALL',
    thresholds: {
      lwick_ratio_min: 2.0,
    },
    gates: [
      { label: 'lwick_surge', fn: (ind, feat, t) => feat.lwick_growth_rate != null && feat.lwick_growth_rate >= t.lwick_ratio_min },
    ],
    reason: (ind, feat) =>
      `[T2-CALL] lwick_growth=${feat.lwick_growth_rate?.toFixed(2)}x` +
      ` lwick_atr=${feat.lwick_atr?.toFixed(2)}`,
  },

  // ─── T3-CALL: Z-Score -1.5σ Reversion (highest-N reversion) ───────────────
  // Train: 55.5% n=3043  |  Test: 55.5% n=670  decay=0.00 ATR ✅ stable
  // 15m: WR=55.5% n=3713  exp=+0.203 ATR  PF=1.52  p<0.0001
  // Highest-frequency rule in the cascade; pair with cooldown to avoid clustering.
  {
    name:      'T3_ZSCORE_LOW_1_5SIG',
    direction: 'CALL',
    thresholds: {
      z_max:   -1.5,
      z_floor: -2.0,         // exclude rows already captured by T2_ZSCORE_LOW_2SIG
    },
    gates: [
      { label: 'z_low_mod',      fn: (ind, feat, t) => feat.z_close_ema20 != null && feat.z_close_ema20 <= t.z_max },
      { label: 'not_T2_already', fn: (ind, feat, t) => feat.z_close_ema20 >  t.z_floor },
    ],
    reason: (ind, feat) =>
      `[T3-CALL] z_close_ema20=${feat.z_close_ema20?.toFixed(2)}σ`,
  },

];

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER — cascade, first match wins (ordered by tier then confidence)
// ═══════════════════════════════════════════════════════════════════════════
//
//  TIER → RISK SIZE
const TIER_RISK = {
  T1: 0.020,   // 2.0% of account equity per trade
  T2: 0.010,   // 1.0%
  T3: 0.005,   // 0.5%
};

function routeEntry(ind, feat) {
  for (const strat of ENTRY_STRATEGIES) {
    let allPassed = true;
    const failed = [];
    for (const g of strat.gates) {
      const ok = g.fn(ind, feat, strat.thresholds);
      if (!ok) { allPassed = false; failed.push(g.label); break; }
    }
    if (allPassed) {
      const tier = strat.name.startsWith('T1_') ? 'T1'
                 : strat.name.startsWith('T2_') ? 'T2' : 'T3';
      return {
        action:     strat.direction,             // 'CALL' | 'PUT'
        edge_name:  strat.name,
        tier,
        risk_pct:   TIER_RISK[tier],
        horizon:    '15m',
        reason:     strat.reason(ind, feat),
        thresholds: strat.thresholds,
      };
    }
    // For debug: which gate failed for each strategy in order
    // (uncomment in dev mode)
    // console.debug(`  ${strat.name}: failed at ${failed.join(',')}`);
  }
  return null;
}

module.exports = { ENTRY_STRATEGIES, routeEntry };

// ═══════════════════════════════════════════════════════════════════════════
//  FEATURE BUILDER REFERENCE — what `feat` must contain
// ═══════════════════════════════════════════════════════════════════════════
//
//  These are the derived features the gates depend on. Compute them once per
//  closed 5m bar, per asset. All thresholds in the strategies refer to these.
//
//   ── Z-score features ──
//     feat.z_close_ema20    : ((close - ema20) − mean50) / std50    [σ units]
//     feat.dist_ema20_atr   : (close - ema20) / atr_14               [ATR units]
//
//   ── Volatility regime ──
//     feat.bb_w_z20         : (bb_width_bps − mean50) / std50        [σ units]
//     feat.bb_w_slope5      : linear-fit slope of bb_width over last 5 bars
//     feat.atr_z20          : (atr_14 − mean50) / std50               [σ units]
//     feat.atr_slope5       : linear-fit slope of atr over last 5 bars
//
//   ── Candle structure ──
//     feat.body_atr         : abs(close − open) / atr_14
//     feat.uwick_atr        : (high − max(open,close)) / atr_14
//     feat.lwick_atr        : (min(open,close) − low)  / atr_14
//     feat.range_atr        : (high − low) / atr_14
//     feat.range_expansion  : (high − low) / mean(high−low, 20)
//     feat.is_bull_bar      : close > open
//     feat.is_bear_bar      : close < open
//
//   ── Exhaustion dynamics ──
//     feat.lwick_growth_rate: mean(lwick,5) / mean(lwick,20)
//     feat.uwick_growth_rate: mean(uwick,5) / mean(uwick,20)
//     feat.body_decay_rate  : mean(body,5)  / mean(body,20)
//
//   ── Breakout persistence ──
//     feat.persist_above_break : 0 if close <= prior_high_20
//                              : 1 on the bar of break
//                              : N+1 on each subsequent bar still above
//     feat.persist_below_break : same logic for the low side
//
//   ── SMC flags ──
//     feat.sweep_high  : high > rolling_max_high_20 AND close <  rolling_max_high_20
//     feat.sweep_low   : low  < rolling_min_low_20  AND close >  rolling_min_low_20
//     feat.bull_ob     : bearish bar followed by a ≥ 1.2 ATR bullish move next bar
//                        (confirmed at t+1 — emit feature at t with 1-bar lag)
//     feat.bear_ob     : bullish bar followed by a ≥ 1.2 ATR bearish move next bar
//     feat.sweep_dist_up_atr   : (high − prior_high_20) / atr_14 if sweep_high
//     feat.sweep_dist_down_atr : (prior_low_20 − low)   / atr_14 if sweep_low
//
//   ── Regime tags (composite classifier, see report §2.4) ──
//     feat.regime      : current regime label
//     feat.regime_prev : regime label of the previous bar
//     feat.session     : 'Asian' | 'European' | 'American'  (UTC-5 windows)
//
// ═══════════════════════════════════════════════════════════════════════════
//  COOLDOWN AND CONCURRENCY
// ═══════════════════════════════════════════════════════════════════════════
//
//  T3_ZSCORE_LOW_1_5SIG fires on ~7% of all bars across 13 pairs (~120/day).
//  Without controls you'd be in 50+ correlated trades at once on a quiet day.
//  Recommended caps:
//
//   - Per-pair cooldown:    no second entry on the same pair within 3 bars (15m)
//   - Global concurrency:   max 5% of equity at-risk across open positions
//   - Correlation gate:     decline new entry if ≥ 2 same-direction positions
//                           are open on EUR-crosses (or JPY-crosses, etc.)
//
// ═══════════════════════════════════════════════════════════════════════════
