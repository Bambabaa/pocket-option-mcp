/**
 * Intelligence layer — scores assets based on KT video2 strategy precision.
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
// These map directly to the 9 layers in _generateSignalsKTVideo2
const LAYER_WEIGHTS = {
    maCross: 20,       // MA6 crossed MA14 (fresh or recent) — Layer 3
    gapExpansion: 15,  // Gap between MA6-MA14 expanding — Layer 4
    smaAlignment: 15,  // ma6 > ma14 > ma50 or reverse — Layer 5
    slopeHarmony: 15,  // Both MAs rising/falling together — Layer 6
    rsiStrength: 15,   // RSI in signal zone, not exhausted — Layer 7
    rsiIgnition: 10,   // RSI just crossed 50 line — Layer 8
    stochTrigger: 10,  // Stochastic K/D crossover — Layer 9
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
                'SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT 1',
                [asset]
            );
            return { asset, ind: rows[0] || null };
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
        all('SELECT asset, consecutive_wins, last_result FROM asset_streaks'),
        all('SELECT asset, consecutive_wins as qual_wins FROM qualified_assets'),
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
    for (const i of indicators) indMap[i.asset] = i.ind;

    const tradeMap = {};
    for (const t of recentTrades) tradeMap[t.asset] = t.trades;

    const streakMap = {};
    for (const s of streaks) streakMap[s.asset] = s;

    const qualMap = {};
    for (const q of qualified) qualMap[q.asset] = q;

    // Build scored entries
    const scored = [];
    for (const t of trackedRows) {
        const asset = t.asset;
        const price = priceMap[asset] || null;
        const recentSignals = signalMap[asset] || [];
        const ind = indMap[asset] || null;
        const trades = tradeMap[asset] || [];
        const streak = streakMap[asset] || { consecutive_wins: 0, last_result: null };
        const qual = qualMap[asset] || null;

        // Compute precision score from indicator layers
        const precision = ind ? scorePrecision(ind) : { score: 0, layers: {}, direction: null };

        // Recent win rate from executed trades
        const decisiveTrades = trades.filter(tr => tr.result === 'WIN' || tr.result === 'LOSS');
        const recentWins = decisiveTrades.filter(tr => tr.result === 'WIN').length;
        const recentWinRate = decisiveTrades.length > 0 ? (recentWins / decisiveTrades.length) * 100 : 50;
        const recentPL = trades.reduce((a, tr) => a + (tr.profit_loss || 0), 0);

        // Fresh signal?
        const freshSignal = recentSignals.find(s => (nowSec - s.timestamp) <= 120);

        scored.push({
            asset,
            precision_score: Math.round(precision.score * 10) / 10,
            precision_direction: precision.direction,
            layers_satisfied: Object.values(precision.layers).filter(Boolean).length,
            layers_total: Object.keys(precision.layers).length,
            layer_details: precision.layers,
            price: price ? price.price : null,
            price_age_sec: price ? nowSec - price.timestamp : null,
            streak: streak.consecutive_wins,
            last_result: streak.last_result,
            qualified: !!qual,
            qual_wins: qual ? qual.qual_wins : 0,
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
        qualified_count: qualified.length,
        top_5: scored.slice(0, 5).map(s => `${s.asset} (${s.precision_direction || 'neutral'}, score ${s.precision_score})`),
        assets: scored,
    };
}

// ─── scorePrecision() — Core scoring engine ──────────────────────────────────
//
// Scores how many of the video2 strategy's 9 layers are satisfied RIGHT NOW.
// This is NOT backward-looking — it measures current indicator alignment.

function scorePrecision(ind) {
    const layers = {};
    let score = 0;
    let direction = null;

    // Extract indicator values
    const ma6 = ind.ma6 ?? ind.ma1;
    const ma14 = ind.ma3;
    const ma50 = ind.ma2;
    const rsi = ind.rsi_5;
    const stochK = ind.stochastic_k;
    const stochD = ind.stochastic_d;
    const stochPrevD = ind.stochastic_prevD;

    // Need minimum data
    if (ma6 == null || ma14 == null || ma50 == null || rsi == null) {
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

    // ─── Layer 3: SMA Alignment (Layer 5 in bot) ─────────────────────────
    // CALL: ma6 > ma14 > ma50  |  PUT: ma6 < ma14 < ma50
    const alignedUp = (ma6 > ma14) && (ma14 > ma50);
    const alignedDown = (ma6 < ma14) && (ma14 < ma50);

    if (alignedUp) {
        layers.smaAlignment = 'bullish_stack';
        score += LAYER_WEIGHTS.smaAlignment;
    } else if (alignedDown) {
        layers.smaAlignment = 'bearish_stack';
        score += LAYER_WEIGHTS.smaAlignment;
    } else {
        // Partial alignment: ma6 vs ma14 agrees but ma14 vs ma50 doesn't
        const ma14Above50 = ma14 > ma50;
        if (maCrossUp && ma14Above50) {
            layers.smaAlignment = 'partial_bullish';
            score += LAYER_WEIGHTS.smaAlignment * 0.5;
        } else if (maCrossDown && !ma14Above50) {
            layers.smaAlignment = 'partial_bearish';
            score += LAYER_WEIGHTS.smaAlignment * 0.5;
        } else {
            layers.smaAlignment = 'misaligned';
        }
    }

    // ─── Layer 4: Slope Harmony (Layer 6 in bot) ─────────────────────────
    // We can't compute slopes from a single row, but we can infer from
    // the relationship between current price and the MAs
    const priceAboveMa6 = closePrice > ma6;
    const priceAboveMa14 = closePrice > ma14;
    const priceAboveMa50 = closePrice > ma50;

    // If price is above all MAs and MAs are stacked up → slopes likely rising
    // If price is below all MAs and MAs are stacked down → slopes likely falling
    if (priceAboveMa6 && priceAboveMa14 && priceAboveMa50 && maCrossUp) {
        layers.slopeHarmony = 'price_above_all';
        score += LAYER_WEIGHTS.slopeHarmony;
    } else if (!priceAboveMa6 && !priceAboveMa14 && !priceAboveMa50 && maCrossDown) {
        layers.slopeHarmony = 'price_below_all';
        score += LAYER_WEIGHTS.slopeHarmony;
    } else if (priceAboveMa50 && maCrossUp) {
        layers.slopeHarmony = 'price_above_ma50';
        score += LAYER_WEIGHTS.slopeHarmony * 0.5;
    } else if (!priceAboveMa50 && maCrossDown) {
        layers.slopeHarmony = 'price_below_ma50';
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
    const callLayers = [layers.maCross, layers.smaAlignment, layers.rsiStrength, layers.stochTrigger]
        .filter(l => l && (l.startsWith('bullish') || l.startsWith('CALL'))).length;
    const putLayers = [layers.maCross, layers.smaAlignment, layers.rsiStrength, layers.stochTrigger]
        .filter(l => l && (l.startsWith('bearish') || l.startsWith('PUT'))).length;

    if (callLayers > putLayers) direction = 'CALL';
    else if (putLayers > callLayers) direction = 'PUT';
    else direction = direction || 'neutral';

    return { score, layers, direction };
}

// ─── recommendTrades() ───────────────────────────────────────────────────────

export async function recommendTrades(minPrecisionScore = 50, minWinRate = 55) {
    const scan = await scanAllAssets();
    if (!scan.success) return scan;

    const nowSec = Math.floor(Date.now() / 1000);

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
            return true;
        })
        .map((a, i) => ({
            rank: i + 1,
            asset: a.asset,
            direction: a.precision_direction,
            precision_score: a.precision_score,
            layers_satisfied: `${a.layers_satisfied}/${a.layers_total}`,
            reasons: buildReasons(a),
            price: a.price,
            recent_win_rate: a.recent_win_rate,
            recent_pl: a.recent_pl,
            streak: a.streak,
        }));

    return {
        success: true,
        scanned_at: scan.scanned_at,
        total_candidates: recommendations.length,
        filters: { min_precision_score: minPrecisionScore, min_win_rate: minWinRate },
        recommendations: recommendations.slice(0, 10),
        note: recommendations.length === 0
            ? 'No assets meet the precision criteria. The market conditions are not aligned for high-confidence trades.'
            : `Top ${Math.min(recommendations.length, 10)} opportunities ranked by indicator precision score.`,
    };
}

function buildReasons(a) {
    const reasons = [];
    const ld = a.layer_details || {};

    if (ld.maCross && (ld.maCross === 'CALL' || ld.maCross === 'PUT')) {
        reasons.push(`MA cross ${ld.maCross} confirmed`);
    }
    if (ld.smaAlignment && ld.smaAlignment.includes('stack')) {
        reasons.push(`Full MA stack aligned (${ld.smaAlignment})`);
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
    if (a.qualified) {
        reasons.push(`Qualified (${a.qual_wins} consecutive wins)`);
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

    // 2. Get latest indicators
    const ind = await get(
        'SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT 1',
        [asset]
    );
    if (!ind) {
        return {
            success: false, safe: false, score: 0, asset, direction,
            verdict: 'BLOCKED',
            warnings: [`No indicator data for "${asset}"`],
        };
    }

    // 3. Score precision
    const precision = scorePrecision(ind);

    // 4. Check direction alignment
    if (direction && precision.direction) {
        if (precision.direction === direction) {
            warnings.push(`Precision score ${precision.score}/100 favors ${direction}`);
            score += 5;
        } else {
            warnings.push(`WARNING: Precision score favors ${precision.direction}, but you're considering ${direction}`);
            score -= 30;
        }
    }

    // 5. Layer-by-layer risk assessment
    const ld = precision.layers;

    if (ld.maCross === 'no_cross') {
        warnings.push('No MA cross detected — no signal trigger');
        score -= 20;
    }

    if (ld.smaAlignment === 'misaligned') {
        warnings.push('MAs are misaligned — market may be choppy');
        score -= 15;
    }

    if (ld.rsiStrength && ld.rsiStrength.includes('exhausted')) {
        warnings.push(`RSI exhausted — ${ld.rsiStrength}`);
        score -= 20;
    }

    if (ld.stochTrigger && (ld.stochTrigger.includes('overbought') || ld.stochTrigger.includes('oversold'))) {
        warnings.push(`Stochastic in extreme zone — ${ld.stochTrigger}`);
        score -= 10;
    }

    if (ld.gapExpansion && ld.gapExpansion.includes('too_tight')) {
        warnings.push('MA gap too tight — weak signal');
        score -= 15;
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

    return {
        success: true,
        safe: score >= 50,
        score,
        asset,
        direction,
        verdict,
        precision_score: precision.score,
        precision_direction: precision.direction,
        layers_satisfied: `${Object.values(precision.layers).filter(Boolean).length}/${Object.keys(precision.layers).length}`,
        warnings,
        recommendation: score >= 70
            ? 'Indicators are aligned — trade looks favorable'
            : score >= 50
                ? 'Mixed signals — proceed with reduced size'
                : score >= 30
                    ? 'Poor alignment — consider skipping'
                    : 'Indicators not aligned — do not trade',
    };
}

// ─── marketState() ───────────────────────────────────────────────────────────

export async function marketState() {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStart = nowSec - (nowSec % 86400);

    const [activeAssets, signalCount, todayTrades, overallStats, signalDirections, topAsset, qualCount, avgStreak, totalTracked] = await Promise.all([
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
        get('SELECT COUNT(*) as n FROM qualified_assets'),
        get(`SELECT ROUND(AVG(consecutive_wins), 1) as avg FROM asset_streaks`),
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
            qualified_count: qualCount?.n ?? 0,
            avg_streak: avgStreak?.avg ?? 0,
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
