/**
 * Intelligence layer — scores assets based on   strategy precision.
 *
 * The bot's signal fires when 9 layers of indicator conditions align.
 * This layer scores how many of those layers are satisfied RIGHT NOW,
 * giving a real-time precision score — not backward-looking luck metrics.
 *
 * Scoring is based on the actual indicator state:
 *   - MA alignment (ma6 vs ma14 vs ma50)
 *   - Gap expansion (is the MA6-MA14 gap widening?)
 *   - RSI position (in the signal zone? exhausted?)
 *   - Stochastic trigger (K crossing D in the right zone?)
 *   - Slope harmony (both MAs moving in the same direction?)
 */

import { all, get } from '../connection.js';
import { mcpAll, mcpGet } from '../mcp-db.js';

// ─── Scoring weights (total = 100) ───────────────────────────────────────────
// Used by scorePrecision() for legacy single-bar scoring in riskCheck fallback.
// NOTE: MA50 (ma2) is NOT used in   — only MA6 (ma1) and MA14 (ma3).
// Primary scoring now uses evaluateModeD() which implements the actual gate logic.
const LAYER_WEIGHTS = {
    maCross: 20,       // MA6 crossed MA14 — Layer 3
    gapExpansion: 15,  // MA6-MA14 gap width
    bbPosition: 15,    // Price vs BB bands
    slopeHarmony: 15,  // Price position relative to MAs
    rsiStrength: 15,   // RSI in signal zone — Layer 7
    rsiIgnition: 10,   // RSI near 50 line — Layer 8
    stochTrigger: 10,  // Stochastic K/D v2 (5,3,3) crossover — Layer 9
};

// ─── scanAllAssets() ─────────────────────────────────────────────────────────

export async function scanAllAssets() {
    const trackedRows = await all(
        `SELECT asset, COUNT(*) as candle_count, MAX(timestamp) as latest_candle_ts
         FROM candles GROUP BY asset ORDER BY latest_candle_ts DESC`
    );

    if (!trackedRows.length) {
        return { success: false, error: 'No assets found in candles table' };
    }

    const assets = trackedRows.map(r => r.asset);
    const nowSec = Math.floor(Date.now() / 1000);
    const signalCutoff = nowSec - 300; // 5 min

    // Parallel fetch: prices, signals, indicators, recent trades
    const [prices, signals, indicators, recentTrades, streaks, qualified] = await Promise.all([
        all(
            `SELECT p.asset, p.price, p.timestamp
             FROM prices p
             INNER JOIN (SELECT asset, MAX(timestamp) as max_ts FROM prices GROUP BY asset) latest
               ON p.asset = latest.asset AND p.timestamp = latest.max_ts`,
        ),
        all(
            `SELECT asset, timestamp, direction, strategy_used
             FROM signals WHERE timestamp >= ? ORDER BY timestamp DESC`,
            [signalCutoff]
        ),
        Promise.all(assets.map(async (asset) => {
            const rows = await all(
                'SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT 6',
                [asset]
            );
            return { asset, ind: rows[0] || null, bars: rows };
        })),
        Promise.all(assets.map(async (asset) => {
            const rows = await all(
                `SELECT result, profit_loss FROM trades_ordered
                 WHERE asset = ? AND result IN ('WIN','LOSS','DRAW')
                 ORDER BY entry_timestamp DESC LIMIT 10`,
                [asset]
            );
            return { asset, trades: rows };
        })),
    ]);

    // Index lookups
    const priceMap = {};
    for (const p of prices) priceMap[p.asset] = p;

    const signalMap = {};
    for (const s of signals) {
        if (!signalMap[s.asset]) signalMap[s.asset] = [];
        signalMap[s.asset].push(s);
    }

    const indMap = {};
    const barsMap = {};
    for (const i of indicators) {
        indMap[i.asset] = i.ind;
        barsMap[i.asset] = i.bars;
    }

    const tradeMap = {};
    for (const t of recentTrades) tradeMap[t.asset] = t.trades;

    // Also fetch latest candle close price per asset (needed for precision scoring)
    const latestCandles = await all(
        `SELECT c.asset, c.close
         FROM candles c
         INNER JOIN (SELECT asset, MAX(timestamp) as max_ts FROM candles GROUP BY asset) latest
           ON c.asset = latest.asset AND c.timestamp = latest.max_ts`
    );
    const closeMap = {};
    for (const c of latestCandles) closeMap[c.asset] = c.close;

    // Build scored entries
    const scored = [];
    for (const t of trackedRows) {
        const asset = t.asset;
        const price = priceMap[asset] || null;
        const recentSignals = signalMap[asset] || [];
        const ind = indMap[asset] || null;
        const trades = tradeMap[asset] || [];

        // Evaluate all 4   patterns — primary scoring engine
        const bars = barsMap[asset] || [];
        const modeD = bars.length >= 2 ? evaluateModeD(bars) : { success: false };

        // Map   strength to a 0-100 precision score for ranking
        // PERFECT=100, STRONG=80, MARGINAL=60, WEAK=30, no pattern=0
        const strengthScore = { PERFECT: 100, STRONG: 80, MARGINAL: 60, WEAK: 30 };
        let precision_score = 0;
        let precision_direction = null;
        let best_pattern = null;
        let layers_satisfied = 0;
        let layers_total = 0;
        let layer_details = {};

        if (modeD.success) {
            const top = modeD.patterns
                .filter(p => p.strength !== 'WEAK' || p.gates_passed >= 4)
                .sort((a, b) => b.gates_passed - a.gates_passed)[0];
            if (top) {
                precision_score = strengthScore[top.strength] ?? 0;
                precision_direction = top.direction;
                best_pattern = top.pattern;
                layers_satisfied = top.gates_passed;
                layers_total = top.gates_total;
                layer_details = top.gates;
            }
        }

        // Recent win rate from executed trades
        const decisiveTrades = trades.filter(tr => tr.result === 'WIN' || tr.result === 'LOSS');
        const recentWins = decisiveTrades.filter(tr => tr.result === 'WIN').length;
        const recentWinRate = decisiveTrades.length > 0 ? (recentWins / decisiveTrades.length) * 100 : 50;
        const recentPL = trades.reduce((a, tr) => a + (tr.profit_loss || 0), 0);

        // Fresh signal?
        const freshSignal = recentSignals.find(s => (nowSec - s.timestamp) <= 120);

        scored.push({
            asset,
            precision_score: Math.round(precision_score * 10) / 10,
            precision_direction,
            best_pattern,
            layers_satisfied,
            layers_total,
            layer_details,
            mode_d: modeD.success ? {
                top_pattern: modeD.top_pattern,
                top_direction: modeD.top_direction,
                best_call: modeD.best_call,
                best_put: modeD.best_put,
                bb_bps: modeD.bb_bps,
            } : null,
            price: price ? price.price : null,
            price_age_sec: price ? nowSec - price.timestamp : null,
            recent_signal: freshSignal ? {
                direction: freshSignal.direction,
                age_sec: nowSec - freshSignal.timestamp,
                strategy: freshSignal.strategy_used,
            } : null,
            recent_win_rate: Math.round(recentWinRate * 10) / 10,
            recent_trades: trades.length,
            recent_pl: Math.round(recentPL * 100) / 100,
            candle_count: t.candle_count,
            has_indicators: !!ind,
        });
    }

    // Sort by precision score descending
    scored.sort((a, b) => b.precision_score - a.precision_score);

    return {
        success: true,
        scanned_at: new Date(nowSec * 1000).toISOString(),
        total_assets: scored.length,
        assets_with_signals: Object.keys(signalMap).length,
        assets_with_precision: scored.filter(a => a.has_indicators && a.precision_score > 0).length,
        top_5: scored.slice(0, 5).map(s => `${s.asset} (${s.precision_direction || 'neutral'}, ${s.best_pattern || 'no pattern'}, score ${s.precision_score})`),
        assets: scored,
    };
}

// ─── scorePrecision() — Core scoring engine ──────────────────────────────────
//
// Scores how many of the   strategy's 9 layers are satisfied RIGHT NOW.
// This is NOT backward-looking — it measures current indicator alignment.

function scorePrecision(ind) {
    const layers = {};
    let score = 0;
    let direction = null;

    // Extract indicator values
    // NOTE: ma1=MA6, ma3=MA14. ma2=MA50 is NOT used in   signals.
    const ma6 = ind.ma6 ?? ind.ma1;
    const ma14 = ind.ma3;
    const rsi = ind.rsi_5;
    //   uses stochastic_k_v2/stochastic_d_v2 (5,3,3 periods), NOT stochastic_k/d (13,3,3)
    const stochK = ind.stochastic_k_v2;
    const stochD = ind.stochastic_d_v2;
    const bbUpper = ind.bb_upper;
    const bbMiddle = ind.bb_middle;
    const bbLower = ind.bb_lower;

    // Need minimum data
    if (ma6 == null || ma14 == null || rsi == null) {
        return { score: 0, layers: {}, direction: null };
    }

    const closePrice = ind.close ?? (ind.lastCandle_close ? JSON.parse(ind.lastCandle || '{}').close : null);
    if (closePrice == null) {
        return { score: 0, layers: {}, direction: null };
    }

    const bps = closePrice / 10000;
    const minDelta = bps * 0.3;

    // ─── Layer 1: MA Cross (Layer 3 in bot) ──────────────────────────────
    // MA6 above or below MA14 — the fundamental signal trigger
    const maCrossUp = ma6 > ma14;
    const maCrossDown = ma6 < ma14;
    const gap = Math.abs(ma6 - ma14);
    const gapMeetsMin = gap >= bps * 0.3;

    if (maCrossUp && gapMeetsMin) {
        layers.maCross = 'CALL';
        score += LAYER_WEIGHTS.maCross;
        direction = 'CALL';
    } else if (maCrossDown && gapMeetsMin) {
        layers.maCross = 'PUT';
        score += LAYER_WEIGHTS.maCross;
        direction = 'PUT';
    } else {
        layers.maCross = 'no_cross';
    }

    // ─── Layer 2: Gap Expansion (Layer 4 in bot) ─────────────────────────
    // We can't compute historical gap from a single row, but we can check
    // if the current gap is meaningfully wide (not a micro-cross)
    const gapBps = gap / bps;
    if (gapBps >= 2.0) {
        layers.gapExpansion = `wide (${gapBps.toFixed(1)} bps)`;
        score += LAYER_WEIGHTS.gapExpansion;
    } else if (gapBps >= 0.3) {
        layers.gapExpansion = `narrow (${gapBps.toFixed(1)} bps)`;
        score += LAYER_WEIGHTS.gapExpansion * 0.5;
    } else {
        layers.gapExpansion = `too_tight (${gapBps.toFixed(1)} bps)`;
    }

    // ─── Layer 3: BB Position ─────────────────────────────────────────────
    // CALL signal: price near or below BB lower band (oversold, bounce candidate)
    // PUT signal: price near or above BB upper band (overbought, reversal candidate)
    // Also checks BB width as a volatility filter —  's bbStable gate
    if (bbUpper != null && bbMiddle != null && bbLower != null && bbMiddle > 0 && closePrice != null) {
        const bbWidth = bbUpper - bbLower;
        const bbWidthBps = (bbWidth / bbMiddle) * 10000;
        const pctB = bbWidth > 0 ? (closePrice - bbLower) / bbWidth : 0.5; // 0=at lower, 1=at upper

        if (bbWidthBps < 2) {
            layers.bbPosition = `flat (${bbWidthBps.toFixed(1)} bps) —   gates unreliable`;
            // No score for flat assets — this is the volatility filter
        } else if (pctB <= 0.25 && maCrossDown) {
            // Price at/below lower BB AND bearish MA cross — CALL bounce setup
            layers.bbPosition = `near_lower_bb (${(pctB * 100).toFixed(0)}%B, ${bbWidthBps.toFixed(1)} bps)`;
            score += LAYER_WEIGHTS.bbPosition;
        } else if (pctB >= 0.75 && maCrossUp) {
            // Price at/above upper BB AND bullish MA cross — PUT reversal setup
            layers.bbPosition = `near_upper_bb (${(pctB * 100).toFixed(0)}%B, ${bbWidthBps.toFixed(1)} bps)`;
            score += LAYER_WEIGHTS.bbPosition;
        } else if (bbWidthBps >= 5) {
            // Adequate volatility, neutral position
            layers.bbPosition = `mid_band (${(pctB * 100).toFixed(0)}%B, ${bbWidthBps.toFixed(1)} bps)`;
            score += LAYER_WEIGHTS.bbPosition * 0.3;
        } else {
            layers.bbPosition = `low_vol (${bbWidthBps.toFixed(1)} bps)`;
        }
    } else {
        layers.bbPosition = 'no_data';
    }

    // ─── Layer 4: Slope Harmony (Layer 6 in bot) ─────────────────────────
    // Infer from price position relative to MA6 and MA14.
    // If price is above both MAs (MA6 > MA14) → likely rising slopes
    // If price is below both MAs (MA6 < MA14) → likely falling slopes
    const priceAboveMa6 = closePrice != null && closePrice > ma6;
    const priceAboveMa14 = closePrice != null && closePrice > ma14;

    if (priceAboveMa6 && priceAboveMa14 && maCrossUp) {
        layers.slopeHarmony = 'price_above_ma6_ma14';
        score += LAYER_WEIGHTS.slopeHarmony;
    } else if (!priceAboveMa6 && !priceAboveMa14 && maCrossDown) {
        layers.slopeHarmony = 'price_below_ma6_ma14';
        score += LAYER_WEIGHTS.slopeHarmony;
    } else if (priceAboveMa14 && maCrossUp) {
        layers.slopeHarmony = 'price_above_ma14';
        score += LAYER_WEIGHTS.slopeHarmony * 0.5;
    } else if (!priceAboveMa14 && maCrossDown) {
        layers.slopeHarmony = 'price_below_ma14';
        score += LAYER_WEIGHTS.slopeHarmony * 0.5;
    } else {
        layers.slopeHarmony = 'mixed';
    }

    // ─── Layer 5: RSI Strength (Layer 7 in bot) ──────────────────────────
    // CALL: RSI >= 65  |  PUT: RSI <= 38
    // Exhausted: RSI >= 80 (CALL is overbought, bad entry)
    if (rsi >= 65 && rsi < 80) {
        layers.rsiStrength = `bullish (${rsi.toFixed(1)})`;
        score += LAYER_WEIGHTS.rsiStrength;
    } else if (rsi <= 38) {
        layers.rsiStrength = `bearish (${rsi.toFixed(1)})`;
        score += LAYER_WEIGHTS.rsiStrength;
    } else if (rsi >= 80) {
        layers.rsiStrength = `exhausted (${rsi.toFixed(1)}) — overbought`;
    } else if (rsi > 38 && rsi < 65) {
        layers.rsiStrength = `neutral (${rsi.toFixed(1)})`;
        score += LAYER_WEIGHTS.rsiStrength * 0.25;
    } else {
        layers.rsiStrength = `unknown (${rsi})`;
    }

    // ─── Layer 6: RSI Ignition (Layer 8 in bot) ──────────────────────────
    // RSI just crossed 50 line — we can't detect the cross from one row,
    // but we can check if RSI is near 50 (potential ignition zone)
    if (rsi > 48 && rsi < 55) {
        layers.rsiIgnition = `just_above_50 (${rsi.toFixed(1)})`;
        score += LAYER_WEIGHTS.rsiIgnition;
    } else if (rsi > 45 && rsi < 52) {
        layers.rsiIgnition = `near_50 (${rsi.toFixed(1)})`;
        score += LAYER_WEIGHTS.rsiIgnition * 0.5;
    } else {
        layers.rsiIgnition = `away_from_50 (${rsi.toFixed(1)})`;
    }

    // ─── Layer 7: Stochastic Trigger (Layer 9 in bot) ────────────────────
    if (stochK != null && stochD != null) {
        const kAboveD = stochK > stochD;
        const kBelowD = stochK < stochD;

        // CALL: K > D, both rising, in oversold or neutral zone
        // PUT: K < D, both falling, in overbought or neutral zone
        if (kAboveD && stochK < 80) {
            layers.stochTrigger = `bullish_cross (K=${stochK.toFixed(1)} D=${stochD.toFixed(1)})`;
            score += LAYER_WEIGHTS.stochTrigger;
        } else if (kBelowD && stochK > 20) {
            layers.stochTrigger = `bearish_cross (K=${stochK.toFixed(1)} D=${stochD.toFixed(1)})`;
            score += LAYER_WEIGHTS.stochTrigger;
        } else if (stochK > 80) {
            layers.stochTrigger = `overbought (K=${stochK.toFixed(1)})`;
        } else if (stochK < 20) {
            layers.stochTrigger = `oversold (K=${stochK.toFixed(1)})`;
        } else {
            layers.stochTrigger = `neutral (K=${stochK.toFixed(1)} D=${stochD.toFixed(1)})`;
            score += LAYER_WEIGHTS.stochTrigger * 0.25;
        }
    } else {
        layers.stochTrigger = 'no_data';
    }

    // Determine overall direction from the layers
    const callLayers = [layers.maCross, layers.bbPosition, layers.rsiStrength, layers.stochTrigger]
        .filter(l => l && (l.startsWith('bullish') || l.startsWith('CALL') || l.startsWith('near_lower'))).length;
    const putLayers = [layers.maCross, layers.bbPosition, layers.rsiStrength, layers.stochTrigger]
        .filter(l => l && (l.startsWith('bearish') || l.startsWith('PUT') || l.startsWith('near_upper'))).length;

    if (callLayers > putLayers) direction = 'CALL';
    else if (putLayers > callLayers) direction = 'PUT';
    else direction = direction || 'neutral';

    return { score, layers, direction };
}

// ─── evaluateModeD() ─────────────────────────────────────────────────────────
//
// Evaluates STC reversal patterns against the current bar window.
// Returns a structured verdict per pattern — gates passed, lookback context,
// strength rating — so the Analyst reads verdicts not raw numbers.
//
// Patterns:
//   STC_CALL_REVERSAL — STC at floor (≤25) curling up: oversold reversal
//   STC_PUT_REVERSAL  — STC at ceiling (≥75) rolling down: overbought reversal
//
// bars: array of indicator rows newest-first [bar0, barM1, ...]
// Returns: { patterns: [...], best_call, best_put, top_pattern }

export function evaluateModeD(bars) {
    if (!bars || bars.length < 2) {
        return { success: false, error: 'Need at least 2 bars', patterns: [] };
    }

    const [bar0, barM1] = bars;

    // ── Shared computed values ────────────────────────────────────────────────
    const ma6  = bar0.ma1;
    const ma14 = bar0.ma3;
    const rsi  = bar0.rsi_5;
    const k0   = bar0.stochastic_k_v2;
    const d0   = bar0.stochastic_d_v2;
    const kM1  = barM1?.stochastic_k_v2;
    const stcValue = bar0.schaff_value;
    const stcPrev  = barM1?.schaff_value;

    const bbBps = bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null && bar0.bb_middle > 0
        ? (bar0.bb_upper - bar0.bb_lower) / bar0.bb_middle * 10000 : null;

    const maTrendBps = ma6 != null && ma14 != null && ma14 > 0
        ? ((ma6 - ma14) / ma14) * 10000 : null;

    // MA gap trend: compare current gap to bar 3 bars ago
    const barOld = bars[3] || bars[bars.length - 1];
    let ma_gap_trend = 'unknown';
    if (ma6 != null && ma14 != null && barOld?.ma1 != null && barOld?.ma3 != null) {
        const gapNow  = ma6 - ma14;
        const gapPrev = barOld.ma1 - barOld.ma3;
        const deltaBps = ((gapNow - gapPrev) / ma14) * 10000;
        if (Math.abs(gapPrev) - Math.abs(gapNow) > (ma14 * 0.0001)) ma_gap_trend = 'narrowing';
        else if (Math.abs(deltaBps) < 1) ma_gap_trend = 'flat';
        else if (deltaBps > 0) ma_gap_trend = 'widening_up';
        else ma_gap_trend = 'widening_down';
    }

    // BB expanding: compare current width to bar 5 bars ago
    const barBbOld = bars[5] || bars[bars.length - 1];
    let bb_expanding = null;
    if (bar0.bb_upper != null && bar0.bb_lower != null && bar0.bb_middle != null &&
        barBbOld?.bb_upper != null && barBbOld?.bb_lower != null && barBbOld?.bb_middle != null) {
        const widthNow  = (bar0.bb_upper  - bar0.bb_lower)  / bar0.bb_middle;
        const widthPrev = (barBbOld.bb_upper - barBbOld.bb_lower) / barBbOld.bb_middle;
        bb_expanding = widthNow > widthPrev;
    }

    // K extension: consecutive bars K > 65 or K < 35 going back from barM1
    let k_bars_above_65 = 0, k_bars_below_35 = 0;
    for (let i = 1; i < bars.length; i++) {
        const k = bars[i]?.stochastic_k_v2;
        if (k == null) break;
        if (k > 65) k_bars_above_65++; else break;
    }
    for (let i = 1; i < bars.length; i++) {
        const k = bars[i]?.stochastic_k_v2;
        if (k == null) break;
        if (k < 35) k_bars_below_35++; else break;
    }

    const rsiHistory = bars.slice(1).map(b => b?.rsi_5).filter(v => v != null);
    const rsi_peak_10   = rsiHistory.length > 0 ? Math.max(...rsiHistory) : null;
    const rsi_trough_10 = rsiHistory.length > 0 ? Math.min(...rsiHistory) : null;

    const lookback = { rsi_peak_10, rsi_trough_10, k_bars_above_65, k_bars_below_35, ma_gap_trend, bb_expanding };

    // ── Helper: strength from gate pass rate ─────────────────────────────────
    function strength(passed, total) {
        const ratio = passed / total;
        if (ratio >= 1.0) return 'PERFECT';
        if (ratio >= 0.8)  return 'STRONG';
        if (ratio >= 0.6)  return 'MARGINAL';
        return 'WEAK';
    }

    const patterns = [];

    // ── STC_CALL_REVERSAL — STC floor bounce (7 gates) ───────────────────────
    {
        const g = {
            g1_stcFloor:    stcValue != null && stcValue <= 25,
            g2_stcRising:   stcValue != null && stcPrev != null && stcValue > stcPrev,
            g3_rsiOversold: rsi != null && rsi < 30,
            g4_stochBull:   k0 != null && d0 != null && k0 > d0 && k0 < 50,
            g5_bbWide:      bbBps != null && bbBps >= 10,
            g6_bbExpanding: bb_expanding !== false,   // volatility releasing into reversal (p=0.019)
            g7_noNarrowGap: ma_gap_trend !== 'narrowing', // trend momentum intact (p=0.007)
        };
        const passed = Object.values(g).filter(Boolean).length;
        const total  = Object.keys(g).length;
        patterns.push({
            pattern: 'STC_CALL_REVERSAL',
            direction: 'CALL',
            type: 'reversal',
            label: 'STC Floor Bounce',
            gates_passed: passed,
            gates_total: total,
            gates: g,
            values: { stcValue, stcPrev, rsi, k0, d0, bbBps, maTrendBps, ma6, ma14 },
            lookback,
            strength: strength(passed, total),
            fires: passed === total,
        });
    }

    // ── STC_PUT_REVERSAL — STC ceiling rollover (6 gates) ────────────────────
    {
        const g = {
            g1_stcCeiling:  stcValue != null && stcValue >= 90,
            g2_stcFalling:  stcValue != null && stcPrev != null && stcValue < stcPrev,
            g3_rsiOB:       rsi != null && rsi > 70,
            g4_stochBear:   k0 != null && d0 != null && k0 < d0 && k0 > 50,
            g5_bbWide:      bbBps != null && bbBps >= 10,
            g6_noNarrowGap: ma_gap_trend !== 'narrowing', // trend momentum intact (p=0.007)
        };
        const passed = Object.values(g).filter(Boolean).length;
        const total  = Object.keys(g).length;
        patterns.push({
            pattern: 'STC_PUT_REVERSAL',
            direction: 'PUT',
            type: 'reversal',
            label: 'STC Ceiling Rollover',
            gates_passed: passed,
            gates_total: total,
            gates: g,
            values: { stcValue, stcPrev, rsi, k0, d0, bbBps, maTrendBps, ma6, ma14 },
            lookback,
            strength: strength(passed, total),
            fires: passed === total,
        });
    }

    // ── Placeholder blocks so the rest of the function compiles ──────────────
    // (kept so ranked_verdicts / best_call / best_put structure is unchanged)
    {
        // CALL_TREND removed — STC strategy is reversal only
        const passed = 0, total = 1;
        patterns.push({
            pattern: 'CALL_TREND', direction: 'CALL', type: 'trend',
            label: 'N/A', gates_passed: passed, gates_total: total,
            gates: {}, values: {}, lookback,
            strength: strength(passed, total), fires: false,
        });
    }
    {
        // PUT_TREND removed
        const passed = 0, total = 1;
        patterns.push({
            pattern: 'PUT_TREND', direction: 'PUT', type: 'trend',
            label: 'N/A', gates_passed: passed, gates_total: total,
            gates: {}, values: {}, lookback,
            strength: strength(passed, total), fires: false,
        });
    }

    // ── Dummy variables so patternVerdict / buildLookbackNarrative compile ───
    const k_0 = k0;
    const kM1_ref = kM1;
    // (rsiM2 used in old PUT_REVERSAL verdict — no longer needed but kept for compat)
    const rsiM1 = barM1?.rsi_5;
    const rsiM2 = bars[2]?.rsi_5;

    // ── Verdict summaries ─────────────────────────────────────────────────────
    function patternVerdict(p) {
        const bbFlat = bbBps != null && bbBps < 10;
        const bbStr  = bbBps != null ? `BB=${bbBps.toFixed(1)}bps` : 'BB=?';
        const kStr   = k0  != null ? `K=${k0.toFixed(0)}` : 'K=?';
        const rsiStr = rsi != null ? `RSI=${rsi.toFixed(0)}` : 'RSI=?';
        const stcStr = stcValue != null ? `STC=${stcValue.toFixed(1)}` : 'STC=?';

        if (p.type === 'trend') return 'N/A — trend patterns removed';
        if (bbFlat) return `SKIP — flat market (${bbStr} < 10bps gate)`;
        if (p.fires) return `FIRES — all ${p.gates_total} gates pass. ${stcStr} ${bbStr} ${kStr} ${rsiStr}.`;

        const failedKeys = Object.entries(p.gates).filter(([, v]) => !v).map(([k]) => k);
        const failedStr  = failedKeys.join(', ');

        if (p.strength === 'STRONG')   return `STRONG setup — ${p.gates_passed}/${p.gates_total} gates pass. Missing: ${failedStr}. ${stcStr} ${bbStr} ${kStr} ${rsiStr}.`;
        if (p.strength === 'MARGINAL') return `MARGINAL — ${p.gates_passed}/${p.gates_total} gates. Needs: ${failedStr}.`;
        return `WEAK — only ${p.gates_passed}/${p.gates_total} gates pass. Not a valid setup.`;
    }

    // ── Lookback narrative ────────────────────────────────────────────────────
    function buildLookbackNarrative(lb) {
        const lines = [];
        if (stcValue != null) lines.push(`STC=${stcValue.toFixed(1)} (prev=${stcPrev?.toFixed(1) ?? '?'}) — ${stcValue <= 25 ? 'at floor' : stcValue >= 75 ? 'at ceiling' : 'mid-zone'}`);
        if (lb.rsi_peak_10   != null) lines.push(`RSI peaked at ${lb.rsi_peak_10.toFixed(0)} in last 10 bars`);
        if (lb.rsi_trough_10 != null) lines.push(`RSI troughed at ${lb.rsi_trough_10.toFixed(0)} in last 10 bars`);
        if (lb.k_bars_above_65 > 0) lines.push(`K above 65 for ${lb.k_bars_above_65} consecutive bars — overbought extension`);
        if (lb.k_bars_below_35 > 0) lines.push(`K below 35 for ${lb.k_bars_below_35} consecutive bars — oversold extension`);
        if (lb.ma_gap_trend === 'narrowing')    lines.push('MA6/MA14 gap narrowing — trend exhausting');
        else if (lb.ma_gap_trend === 'widening_up')   lines.push('MA6/MA14 gap widening upward — bullish momentum');
        else if (lb.ma_gap_trend === 'widening_down')  lines.push('MA6/MA14 gap widening downward — bearish momentum');
        if (lb.bb_expanding === true)  lines.push('BB expanding — volatility rising at entry');
        if (lb.bb_expanding === false) lines.push('BB contracting — volatility shrinking at entry');
        return lines.length ? lines : ['Insufficient bar history for lookback narrative'];
    }

    // Attach verdict summaries
    for (const p of patterns) {
        p.verdict_summary    = patternVerdict(p);
        p.lookback_narrative = buildLookbackNarrative(lookback);
    }

    // ── Rank and pick best per direction ─────────────────────────────────────
    const strengthOrder = { PERFECT: 4, STRONG: 3, MARGINAL: 2, WEAK: 1 };

    const callPatterns = patterns.filter(p => p.direction === 'CALL' && p.type === 'reversal')
        .sort((a, b) => b.gates_passed - a.gates_passed);
    const putPatterns  = patterns.filter(p => p.direction === 'PUT'  && p.type === 'reversal')
        .sort((a, b) => b.gates_passed - a.gates_passed);

    const best_call = callPatterns[0] || null;
    const best_put  = putPatterns[0]  || null;

    // ── CALL_TREND / PUT_TREND placeholder blocks ─────────────────────────────
    // (variables required by strength() / patternVerdict() but no longer used
    //  in real gate logic — keeping so downstream callers don't break)
    void(kM1_ref); void(rsiM1); void(rsiM2);

    {
        const ma6Rising = barM1?.ma1 != null && ma6 != null && ma6 > barM1.ma1;
        const kRising   = kM1 != null && k0 != null && k0 > kM1;
        const gapNow    = ma6 != null && ma14 != null ? Math.abs(ma6 - ma14) : null;
        const gapOld    = bars[3]?.ma1 != null && bars[3]?.ma3 != null
            ? Math.abs(bars[3].ma1 - bars[3].ma3) : null;
        const g = {
            g1_ma6BelowMa14:   ma6 != null && ma14 != null && ma6 < ma14,
            g2_ma6Converging:  ma6Rising && ma6 != null && ma14 != null && ma6 < ma14,
            g3_rsiAbove50:     rsi != null && rsi > 50,
            g4_rsiRising:      rsi != null && barM1?.rsi_5 != null && rsi > barM1.rsi_5,
            g5_kRisingAbove30: k0 != null && k0 > 30 && kRising,
            g6_gapShrinking:   gapNow != null && gapOld != null && gapNow < gapOld,
        };
        const passed = Object.values(g).filter(Boolean).length;
        const total  = Object.keys(g).length;
        // Update the placeholder CALL_TREND entry with real values for any callers
        const idx = patterns.findIndex(p => p.pattern === 'CALL_TREND');
        if (idx !== -1) {
            patterns[idx] = {
                ...patterns[idx], gates_passed: passed, gates_total: total, gates: g,
                values: { ma6, ma14, maTrendBps, rsi_0: rsi, k_0: k0, k_m1: kM1, gapNow, gapOld },
                strength: strength(passed, total),
            };
            patterns[idx].verdict_summary    = patternVerdict(patterns[idx]);
            patterns[idx].lookback_narrative = buildLookbackNarrative(lookback);
        }
    }

    // ── PUT_TREND — DOWN TREND continuation (6 gates) ────────────────────────
    {
        const ma6Falling = barM1?.ma1 != null && ma6 != null && ma6 < barM1.ma1;
        const kFalling2 = kM1 != null && k0 != null && k0 < kM1;
        const gapNow = ma6 != null && ma14 != null ? Math.abs(ma6 - ma14) : null;
        const gapOld = bars[3]?.ma1 != null && bars[3]?.ma3 != null
            ? Math.abs(bars[3].ma1 - bars[3].ma3) : null;
        const g = {
            g1_ma6AboveMa14: ma6 != null && ma14 != null && ma6 > ma14,
            g2_ma6Converging: ma6Falling && ma6 != null && ma14 != null && ma6 > ma14,
            g3_priceBelowMa14: bar0.close != null && ma14 != null && bar0.close < ma14,
            g4_rsiFallingFrom50: rsiM1 != null && rsiM1 > 50 && rsi != null && rsi < rsiM1 && rsi < 55,
            g5_kFallingBelow70: k0 != null && k0 < 70 && kFalling2,
            g6_gapShrinking: gapNow != null && gapOld != null && gapNow < gapOld,
        };
        const passed = Object.values(g).filter(Boolean).length;
        const total = Object.keys(g).length;
        patterns.push({
            pattern: 'PUT_TREND',
            direction: 'PUT',
            type: 'trend',
            label: 'DOWN TREND Continuation',
            gates_passed: passed,
            gates_total: total,
            gates: g,
            values: {
                ma6, ma14, maTrendBps,
                rsi_0: rsi, rsi_m1: rsiM1,
                k_0: k0, k_m1: kM1,
                close: bar0.close, bbBps,
                gapNow, gapOld,
            },
            lookback,
            strength: strength(passed, total),
            fires: passed === total,
        });
    }

    // ── Verdict summaries — one readable sentence per pattern ────────────────
    function patternVerdict(p) {
        const bbFlat = bbBps != null && bbBps < 10;
        const bbStr = bbBps != null ? `BB=${bbBps.toFixed(1)}bps` : 'BB=?';
        const kStr = k0 != null ? `K=${k0.toFixed(0)}` : 'K=?';
        const rsiStr = rsi != null ? `RSI=${rsi.toFixed(0)}` : 'RSI=?';

        if (bbFlat) return `SKIP — flat market (${bbStr} < 10bps gate)`;
        if (p.fires) return `FIRES — all ${p.gates_total} gates pass. ${bbStr} ${kStr} ${rsiStr}.`;

        const failedKeys = Object.entries(p.gates).filter(([, v]) => !v).map(([k]) => k);
        const failedStr = failedKeys.join(', ');

        if (p.strength === 'STRONG') {
            return `STRONG setup — ${p.gates_passed}/${p.gates_total} gates pass. Missing: ${failedStr}. ${bbStr} ${kStr} ${rsiStr}.`;
        }
        if (p.strength === 'MARGINAL') {
            return `MARGINAL — ${p.gates_passed}/${p.gates_total} gates. Needs: ${failedStr}.`;
        }
        return `WEAK — only ${p.gates_passed}/${p.gates_total} gates pass. Not a valid setup.`;
    }

    // ── Lookback narrative — how the setup formed ─────────────────────────────
    function buildLookbackNarrative(lb) {
        const lines = [];
        if (lb.rsi_peak_10 != null) lines.push(`RSI peaked at ${lb.rsi_peak_10.toFixed(0)} in last 10 bars`);
        if (lb.rsi_trough_10 != null) lines.push(`RSI troughed at ${lb.rsi_trough_10.toFixed(0)} in last 10 bars`);
        if (lb.k_bars_above_65 > 0) lines.push(`K was above 65 for ${lb.k_bars_above_65} consecutive bars before current — overbought extension`);
        if (lb.k_bars_below_35 > 0) lines.push(`K was below 35 for ${lb.k_bars_below_35} consecutive bars before current — oversold extension`);
        if (lb.ma_gap_trend === 'narrowing') lines.push('MA6/MA14 gap narrowing — trend is exhausting');
        else if (lb.ma_gap_trend === 'widening_up') lines.push('MA6/MA14 gap widening upward — bullish trend strengthening');
        else if (lb.ma_gap_trend === 'widening_down') lines.push('MA6/MA14 gap widening downward — bearish trend strengthening');
        else if (lb.ma_gap_trend === 'flat') lines.push('MA6/MA14 gap flat — no directional conviction');
        if (lb.bb_expanding === true) lines.push('BB expanding — volatility rising at entry');
        if (lb.bb_expanding === false) lines.push('BB contracting — volatility shrinking at entry (REVERSAL_CALL loses 39% on contracting BB)');
        return lines.length ? lines : ['Insufficient bar history for lookback narrative'];
    }

    const top_pattern = [best_call, best_put]
        .filter(Boolean)
        .sort((a, b) => (strengthOrder[b.strength] - strengthOrder[a.strength]) || (b.gates_passed - a.gates_passed))[0] || null;

    // ── Ranked verdict table — what the Analyst reads first ──────────────────
    const ranked_verdicts = [...patterns]
        .sort((a, b) => (strengthOrder[b.strength] - strengthOrder[a.strength]) || (b.gates_passed - a.gates_passed))
        .map(p => ({
            pattern: p.pattern,
            direction: p.direction,
            strength: p.strength,
            gates: `${p.gates_passed}/${p.gates_total}`,
            fires: p.fires,
            verdict_summary: p.verdict_summary,
        }));

    return {
        success: true,
        // ── Analyst-first section ──
        ranked_verdicts,     // ranked list: strongest setup first
        top_pattern: top_pattern ? top_pattern.pattern : null,
        top_direction: top_pattern ? top_pattern.direction : null,
        top_verdict: top_pattern ? top_pattern.verdict_summary : 'No clear setup',
        best_call: best_call ? {
            pattern: best_call.pattern,
            strength: best_call.strength,
            gates: `${best_call.gates_passed}/${best_call.gates_total}`,
            fires: best_call.fires,
            verdict_summary: best_call.verdict_summary,
        } : null,
        best_put: best_put ? {
            pattern: best_put.pattern,
            strength: best_put.strength,
            gates: `${best_put.gates_passed}/${best_put.gates_total}`,
            fires: best_put.fires,
            verdict_summary: best_put.verdict_summary,
        } : null,
        // ── Context ──
        bb_bps: bbBps,
        ma_gap_bps: maTrendBps,
        lookback,
        lookback_narrative: buildLookbackNarrative(lookback),
        // ── Full gate detail (for debugging) ──
        patterns,
    };
}

// ─── recommendTrades() ───────────────────────────────────────────────────────

export async function recommendTrades(minPrecisionScore = 50, minWinRate = 55) {
    // Run scan and bias lookup in parallel
    const [scan, bias] = await Promise.all([
        scanAllAssets(),
        assetBias(3).catch(() => null),
    ]);
    if (!scan.success) return scan;

    // Build bias lookup: asset → { preferred_direction, verdict, is_flat }
    const biasMap = new Map();
    if (bias?.assets) {
        for (const b of bias.assets) biasMap.set(b.asset, b);
    }

    const skipped = [];

    const recommendations = scan.assets
        .filter(a => {
            // Must have indicator data
            if (!a.has_indicators) return false;
            // Must meet precision threshold
            if (a.precision_score < minPrecisionScore) return false;
            // Must have a clear direction
            if (!a.precision_direction || a.precision_direction === 'neutral') return false;
            // Win rate threshold
            if (a.recent_win_rate < minWinRate) return false;

            const b = biasMap.get(a.asset);
            if (b) {
                // Hard block: flat asset — BB too low for reliable signals
                if (b.is_flat) {
                    skipped.push({ asset: a.asset, reason: `flat asset (${b.avg_bb_bps} bps)` });
                    return false;
                }
                // Hard block: consistently losing in both directions
                if (b.verdict === 'AVOID') {
                    skipped.push({ asset: a.asset, reason: 'historical AVOID — losing in both directions' });
                    return false;
                }
                // Direction conflict: indicator says CALL but asset only wins PUT, and vice versa
                if (b.preferred_direction && b.preferred_direction !== a.precision_direction) {
                    const assetDir = b[a.precision_direction.toLowerCase()];
                    // Only block if there's meaningful evidence against this direction (5+ trades, <40% WR)
                    if (assetDir && assetDir.trades >= 5 && parseFloat(assetDir.win_rate) < 40) {
                        skipped.push({
                            asset: a.asset,
                            reason: `indicator says ${a.precision_direction} but historical WR in that direction is ${assetDir.win_rate} (preferred: ${b.preferred_direction})`,
                        });
                        return false;
                    }
                }
            }

            return true;
        })
        .map((a, i) => {
            const b = biasMap.get(a.asset);
            return {
                rank: i + 1,
                asset: a.asset,
                direction: a.precision_direction,
                precision_score: a.precision_score,
                layers_satisfied: `${a.layers_satisfied}/${a.layers_total}`,
                reasons: buildReasons(a),
                price: a.price,
                recent_win_rate: a.recent_win_rate,
                recent_pl: a.recent_pl,
                // Bias context
                historical_bias: b ? {
                    preferred_direction: b.preferred_direction,
                    verdict: b.verdict,
                    call_wr: b.call?.win_rate ?? null,
                    put_wr: b.put?.win_rate ?? null,
                } : null,
            };
        });

    return {
        success: true,
        scanned_at: scan.scanned_at,
        total_candidates: recommendations.length,
        filters: { min_precision_score: minPrecisionScore, min_win_rate: minWinRate },
        recommendations: recommendations.slice(0, 10),
        skipped_by_bias: skipped,
        note: recommendations.length === 0
            ? 'No assets meet the precision + bias criteria. Try lowering min_precision_score or check po_asset_bias for blocked assets.'
            : `Top ${Math.min(recommendations.length, 10)} opportunities — filtered by indicator precision AND historical direction bias.`,
    };
}

function buildReasons(a) {
    const reasons = [];
    const ld = a.layer_details || {};

    if (ld.maCross && (ld.maCross === 'CALL' || ld.maCross === 'PUT')) {
        reasons.push(`MA cross ${ld.maCross} confirmed`);
    }
    if (ld.bbPosition && (ld.bbPosition.includes('near_upper') || ld.bbPosition.includes('near_lower'))) {
        reasons.push(`Price at BB band (${ld.bbPosition})`);
    }
    if (ld.rsiStrength && !ld.rsiStrength.includes('neutral') && !ld.rsiStrength.includes('exhausted')) {
        reasons.push(`RSI in signal zone (${ld.rsiStrength})`);
    }
    if (ld.stochTrigger && ld.stochTrigger.includes('cross')) {
        reasons.push(`Stochastic ${ld.stochTrigger.includes('bullish') ? 'bullish' : 'bearish'} cross`);
    }
    if (ld.gapExpansion && ld.gapExpansion.includes('wide')) {
        reasons.push(`MA gap wide (${ld.gapExpansion})`);
    }
    return reasons;
}

// ─── riskCheck() ─────────────────────────────────────────────────────────────

export async function riskCheck(asset, direction = null) {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnings = [];
    let score = 100;

    // 1. Is asset tracked?
    const tracked = await get(
        'SELECT COUNT(*) as n FROM candles WHERE asset = ?', [asset]
    );
    if (!tracked || tracked.n === 0) {
        return {
            success: false, safe: false, score: 0, asset, direction,
            verdict: 'BLOCKED',
            warnings: [`Asset "${asset}" not found in tracked assets`],
        };
    }

    // 2. Get latest 6 indicator rows (bar0 + history for lookback)
    const indRows = await all(
        'SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT 6',
        [asset]
    );
    if (!indRows.length) {
        return {
            success: false, safe: false, score: 0, asset, direction,
            verdict: 'BLOCKED',
            warnings: [`No indicator data for "${asset}"`],
        };
    }
    const ind = indRows[0];

    // 3. Evaluate all 4   patterns
    const modeD = evaluateModeD(indRows);

    // 4. Score precision (legacy generic scorer — kept for backward compat)
    const precision = scorePrecision(ind);

    // 5.   pattern scoring — weight the requested direction's best pattern
    if (modeD.success && direction) {
        const targetPatterns = modeD.patterns.filter(p => p.direction === direction)
            .sort((a, b) => b.gates_passed - a.gates_passed);
        const best = targetPatterns[0];
        if (best) {
            const ratio = best.gates_passed / best.gates_total;
            if (best.fires) {
                warnings.push(`  ${best.pattern} FIRES — all ${best.gates_total} gates pass`);
                score += 15;
            } else if (best.strength === 'STRONG') {
                warnings.push(`  ${best.pattern} STRONG — ${best.gates_passed}/${best.gates_total} gates`);
                score += 8;
            } else if (best.strength === 'MARGINAL') {
                warnings.push(`  ${best.pattern} MARGINAL — ${best.gates_passed}/${best.gates_total} gates`);
            } else {
                warnings.push(`  ${best.pattern} WEAK — only ${best.gates_passed}/${best.gates_total} gates`);
                score -= 20;
            }
            // Gate-specific warnings
            if (best.gates.g7_bbWide === false || best.gates.g8_bbWide === false) {
                warnings.push(`BB width ${modeD.bb_bps?.toFixed(1)} bps — below 10 bps gate (flat market)`);
                score -= 20;
            }
        }
        // Check if opposite direction has a stronger pattern — conflict warning
        const oppositeDir = direction === 'CALL' ? 'PUT' : 'CALL';
        const oppBest = modeD.patterns.filter(p => p.direction === oppositeDir)
            .sort((a, b) => b.gates_passed - a.gates_passed)[0];
        if (oppBest && best && oppBest.gates_passed > best.gates_passed) {
            warnings.push(`WARNING: ${oppBest.pattern} (${oppBest.gates_passed}/${oppBest.gates_total}) is stronger than requested ${best.pattern} — consider ${oppositeDir}`);
            score -= 15;
        }
    } else if (modeD.success && !direction) {
        // No direction specified — report top pattern
        if (modeD.top_pattern) {
            warnings.push(`Strongest setup: ${modeD.top_pattern} (${modeD.top_direction})`);
        }
    }

    // 6. BB width hard check — flat market kills both directions
    if (modeD.bb_bps != null && modeD.bb_bps < 10) {
        warnings.push(`BB width ${modeD.bb_bps.toFixed(1)} bps — flat/dead market (< 10 bps losing zone)`);
        score -= 25;
    }

    // 7. Lookback context warnings
    if (modeD.success && modeD.lookback) {
        const lb = modeD.lookback;
        if (lb.bb_expanding === false && direction === 'CALL' &&
            modeD.patterns.find(p => p.pattern === 'CALL_REVERSAL')?.gates_passed >= 5) {
            warnings.push('BB contracting — CALL_REVERSAL on contracting BB loses at 39% historically');
            score -= 10;
        }
        if (lb.ma_gap_trend === 'narrowing') {
            warnings.push('MA gap narrowing — trend exhausting, reversal setups favored');
        }
        if (lb.k_bars_above_65 >= 3 && direction === 'PUT') {
            warnings.push(`K extended above 65 for ${lb.k_bars_above_65} bars — PUT reversal conviction strong`);
            score += 5;
        }
        if (lb.k_bars_below_35 >= 3 && direction === 'CALL') {
            warnings.push(`K extended below 35 for ${lb.k_bars_below_35} bars — CALL reversal conviction strong`);
            score += 5;
        }
    }

    // 6. Recent performance
    const recentTrades = await all(
        `SELECT result FROM trades_ordered
         WHERE asset = ? AND result IN ('WIN','LOSS')
         ORDER BY entry_timestamp DESC LIMIT 20`,
        [asset]
    );
    if (recentTrades.length > 0) {
        const wins = recentTrades.filter(t => t.result === 'WIN').length;
        const wr = (wins / recentTrades.length) * 100;
        if (wr < 40) {
            warnings.push(`Poor recent win rate: ${wr.toFixed(1)}%`);
            score -= 20;
        } else if (wr >= 65) {
            warnings.push(`Strong recent win rate: ${wr.toFixed(1)}%`);
            score += 5;
        }
    }

    // 7. Consecutive losses check
    const last5 = await all(
        `SELECT result FROM trades_ordered
         WHERE asset = ? AND result IN ('WIN','LOSS')
         ORDER BY entry_timestamp DESC LIMIT 5`,
        [asset]
    );
    let consecLosses = 0;
    for (const t of last5) {
        if (t.result === 'LOSS') consecLosses++;
        else break;
    }
    if (consecLosses >= 3) {
        warnings.push(`⚠ ${consecLosses} consecutive losses — asset may be in a bad regime`);
        score -= 15;
    }

    // Clamp
    score = Math.max(0, Math.min(100, score));

    let verdict;
    if (score >= 70) verdict = 'GOOD';
    else if (score >= 50) verdict = 'CAUTION';
    else if (score >= 30) verdict = 'RISKY';
    else verdict = 'AVOID';

    // ── Build the primary   verdict block the Analyst reads ─────────────
    const modeD_verdict = modeD.success ? {
        // Ranked from strongest to weakest — Analyst reads top entry first
        ranked_verdicts: modeD.ranked_verdicts,
        top_pattern: modeD.top_pattern,
        top_direction: modeD.top_direction,
        top_verdict: modeD.top_verdict,
        best_call: modeD.best_call,
        best_put: modeD.best_put,
        bb_bps: modeD.bb_bps,
        ma_gap_bps: modeD.ma_gap_bps,
        lookback_narrative: modeD.lookback_narrative,
        // Full gate detail for debugging
        patterns: modeD.patterns,
    } : null;

    // ── Determine requested-direction pattern for the trade_verdict ──────────
    let trade_verdict_detail = null;
    if (modeD.success && direction) {
        const dirPattern = modeD.patterns
            .filter(p => p.direction === direction)
            .sort((a, b) => b.gates_passed - a.gates_passed)[0];
        trade_verdict_detail = dirPattern
            ? `${dirPattern.pattern} — ${dirPattern.verdict_summary}`
            : `No ${direction} pattern in evaluation`;
    }

    return {
        success: true,
        // ── Primary: what the Analyst needs to decide ──
        asset,
        direction,
        verdict,           // GOOD | CAUTION | RISKY | AVOID
        score,             // 0–100
        safe: score >= 50,
        trade_verdict: trade_verdict_detail || (modeD.success ? modeD.top_verdict : 'No   data'),
        recommendation: score >= 70
            ? 'Indicators aligned — trade looks favorable'
            : score >= 50
                ? 'Mixed signals — proceed with reduced size'
                : score >= 30
                    ? 'Poor alignment — consider skipping'
                    : 'Indicators not aligned — do not trade',
        warnings,
        // ──   pattern verdicts — ranked strongest first ──
        mode_d: modeD_verdict,
        // ── Legacy precision scorer (secondary reference) ──
        precision: {
            score: precision.score,
            direction: precision.direction,
            layers_satisfied: `${Object.values(precision.layers).filter(Boolean).length}/${Object.keys(precision.layers).length}`,
        },
    };
}

// ─── marketState() ───────────────────────────────────────────────────────────

export async function marketState() {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStart = nowSec - (nowSec % 86400);

    const [activeAssets, signalCount, todayTrades, overallStats, signalDirections, topAsset, totalTracked] = await Promise.all([
        get(`SELECT COUNT(DISTINCT asset) as n FROM candles WHERE timestamp >= ?`, [nowSec - 300]),
        get(`SELECT COUNT(*) as n FROM signals WHERE timestamp >= ?`, [nowSec - 3600]),
        all(
            `SELECT result, profit_loss, amount FROM trades_ordered
             WHERE entry_timestamp >= ? AND result IN ('WIN','LOSS','DRAW')`,
            [todayStart]
        ),
        get(
            `SELECT COUNT(*) as total,
                    SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
             FROM trades_ordered WHERE result IN ('WIN','LOSS','DRAW')`
        ),
        all(
            `SELECT direction, COUNT(*) as cnt FROM signals
             WHERE timestamp >= ? GROUP BY direction`,
            [nowSec - 3600]
        ),
        all(
            `SELECT asset, COUNT(*) as trades,
                    SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
                    ROUND(SUM(profit_loss), 2) as pnl
             FROM trades_ordered
             WHERE entry_timestamp >= ? AND result IN ('WIN','LOSS','DRAW')
             GROUP BY asset ORDER BY pnl DESC LIMIT 3`,
            [todayStart]
        ),
        get('SELECT COUNT(DISTINCT asset) as n FROM candles'),
    ]);

    const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
    const todayLosses = todayTrades.filter(t => t.result === 'LOSS').length;
    const todayPL = todayTrades.reduce((a, t) => a + (t.profit_loss || 0), 0);
    const todayRisked = todayTrades.reduce((a, t) => a + (t.amount || 0), 0);

    return {
        success: true,
        timestamp: new Date(nowSec * 1000).toISOString(),
        market: {
            active_assets: activeAssets?.n ?? 0,
            total_tracked: totalTracked?.n ?? 0,
        },
        signals_last_hour: {
            total: signalCount?.n ?? 0,
            by_direction: signalDirections.reduce((a, d) => { a[d.direction] = d.cnt; return a; }, {}),
        },
        today: {
            trades: todayTrades.length,
            wins: todayWins,
            losses: todayLosses,
            win_rate: todayTrades.length > 0 ? ((todayWins / todayTrades.length) * 100).toFixed(1) + '%' : 'N/A',
            pnl: Math.round(todayPL * 100) / 100,
            risked: Math.round(todayRisked * 100) / 100,
            roi: todayRisked > 0 ? ((todayPL / todayRisked) * 100).toFixed(2) + '%' : 'N/A',
            top_assets: topAsset,
        },
        all_time: {
            total_trades: overallStats?.total ?? 0,
            win_rate: overallStats?.total > 0
                ? ((overallStats.wins / overallStats.total) * 100).toFixed(1) + '%'
                : 'N/A',
        },
    };
}

// ─── assetBias() ─────────────────────────────────────────────────────────────
//
// Per-asset directional bias from historical trades_ordered.
// For each asset with enough trade history, computes:
//   - CALL win rate vs PUT win rate
//   - Preferred direction (which direction wins more)
//   - Verdict: CALL_ONLY, PUT_ONLY, BOTH, AVOID
//   - BB width classification from indicators (flat asset detection)
//   - BLOCK_RECOMMENDED flag for flat/consistently-losing assets
//
// This drives po_recommend direction filtering so signals are only surfaced
// in the direction that asset historically wins.

export async function assetBias(minTrades = 3) {
    const now = Math.floor(Date.now() / 1000);

    // Historical win/loss per asset per direction
    const tradeRows = await all(
        `SELECT asset, direction,
                SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
                COUNT(*) as total,
                ROUND(SUM(profit_loss), 2) as pl
         FROM trades_ordered
         WHERE result IN ('WIN','LOSS')
         GROUP BY asset, direction
         ORDER BY asset, direction`,
        []
    );

    // BB width per asset (last 100 bars) for flat detection
    const bbRows = await all(
        `SELECT asset,
                ROUND(AVG((bb_upper - bb_lower) / NULLIF(bb_middle, 0) * 10000), 2) AS avg_bb_bps
         FROM (
           SELECT asset, bb_upper, bb_lower, bb_middle,
                  ROW_NUMBER() OVER (PARTITION BY asset ORDER BY timestamp DESC) AS rn
           FROM indicators WHERE bb_middle > 0
         ) sub
         WHERE rn <= 100
         GROUP BY asset`,
        []
    );
    const bbMap = new Map(bbRows.map(r => [r.asset, r.avg_bb_bps]));

    // Active blocks
    const blocks = await mcpAll(
        `SELECT asset FROM asset_controls WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`,
        [now]
    );
    const blockedSet = new Set(blocks.map(b => b.asset));

    // Group by asset
    const byAsset = {};
    for (const r of tradeRows) {
        if (!byAsset[r.asset]) byAsset[r.asset] = {};
        byAsset[r.asset][r.direction] = { wins: r.wins, losses: r.losses, total: r.total, pl: r.pl };
    }

    const assets = Object.entries(byAsset).map(([asset, dirs]) => {
        const call = dirs['CALL'] || null;
        const put = dirs['PUT'] || null;
        const totalTrades = (call?.total || 0) + (put?.total || 0);

        const callWR = call && call.total > 0 ? (call.wins / call.total) * 100 : null;
        const putWR = put && put.total > 0 ? (put.wins / put.total) * 100 : null;
        const netPL = (call?.pl || 0) + (put?.pl || 0);

        const bbBps = bbMap.get(asset) ?? null;
        const isFlat = bbBps !== null && bbBps < 5;

        // Determine verdict
        let verdict, preferred_direction;
        if (isFlat) {
            verdict = 'BLOCK_RECOMMENDED';
            preferred_direction = null;
        } else if (callWR === null && putWR === null) {
            verdict = 'NO_DATA';
            preferred_direction = null;
        } else if (callWR !== null && putWR !== null) {
            if (callWR >= 60 && putWR < 45) { verdict = 'CALL_ONLY'; preferred_direction = 'CALL'; }
            else if (putWR >= 60 && callWR < 45) { verdict = 'PUT_ONLY'; preferred_direction = 'PUT'; }
            else if (callWR < 40 && putWR < 40) { verdict = 'AVOID'; preferred_direction = null; }
            else { verdict = 'BOTH'; preferred_direction = callWR >= putWR ? 'CALL' : 'PUT'; }
        } else if (callWR !== null) {
            verdict = callWR >= 55 ? 'CALL_PREFERRED' : callWR < 40 ? 'AVOID' : 'BOTH';
            preferred_direction = callWR >= 40 ? 'CALL' : null;
        } else {
            verdict = putWR >= 55 ? 'PUT_PREFERRED' : putWR < 40 ? 'AVOID' : 'BOTH';
            preferred_direction = putWR >= 40 ? 'PUT' : null;
        }

        return {
            asset,
            total_trades: totalTrades,
            net_pl: parseFloat(netPL.toFixed(2)),
            avg_bb_bps: bbBps,
            is_flat: isFlat,
            blocked: blockedSet.has(asset),
            verdict,
            preferred_direction,
            call: call ? {
                trades: call.total, wins: call.wins, losses: call.losses,
                win_rate: callWR !== null ? callWR.toFixed(1) + '%' : 'N/A',
                pl: call.pl,
            } : null,
            put: put ? {
                trades: put.total, wins: put.wins, losses: put.losses,
                win_rate: putWR !== null ? putWR.toFixed(1) + '%' : 'N/A',
                pl: put.pl,
            } : null,
        };
    }).filter(a => a.total_trades >= minTrades)
        .sort((a, b) => b.net_pl - a.net_pl);

    const blockRecommended = assets.filter(a => a.verdict === 'BLOCK_RECOMMENDED').map(a => a.asset);
    const callOnly = assets.filter(a => a.verdict === 'CALL_ONLY' || a.verdict === 'CALL_PREFERRED').map(a => a.asset);
    const putOnly = assets.filter(a => a.verdict === 'PUT_ONLY' || a.verdict === 'PUT_PREFERRED').map(a => a.asset);
    const avoid = assets.filter(a => a.verdict === 'AVOID').map(a => a.asset);

    return {
        success: true,
        total_assets: assets.length,
        summary: {
            block_recommended: blockRecommended,
            call_favored: callOnly,
            put_favored: putOnly,
            avoid: avoid,
        },
        assets,
        note: 'preferred_direction is the direction with better historical win rate. BLOCK_RECOMMENDED = BB width < 5 bps (flat/pegged asset).',
    };
}
