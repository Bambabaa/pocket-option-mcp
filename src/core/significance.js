/**
 * Statistical significance engine — binomial test of randomness.
 *
 * For each slice of replay signals (overall, direction, asset, STC zone, hour),
 * tests H0: WR = 50% (random coin flip).
 * Uses exact binomial CDF for n <= 100, normal approximation above.
 *
 * Exports: significanceTests()
 */

import { all } from '../connection.js';
import { replayCandles } from './analysis.js';

// ─── Statistical primitives ───────────────────────────────────────────────────

// Standard normal CDF via Horner's method for erf (Abramowitz & Stegun 7.1.26)
function normalCDF(z) {
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
    const p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + p * x);
    const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t;
    const erf = 1 - poly * Math.exp(-x * x);
    return 0.5 * (1 + sign * erf);
}

// Log-space factorial (exact via cumulative sum — accurate for n up to ~170)
function logFactorial(n) {
    if (n <= 1) return 0;
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
}
function logBinom(n, k) {
    return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-tailed p-value: P(X >= wins | n, p0).
 * Returns 1.0 if observed WR <= p0 (no positive edge to test).
 * Exact binomial CDF for n <= 120; normal approximation above.
 */
function binomPValue(wins, n, p0 = 0.5) {
    if (n === 0 || wins / n <= p0) return 1.0;
    if (n > 120) {
        const z = (wins / n - p0) / Math.sqrt(p0 * (1 - p0) / n);
        return Math.max(0, 1 - normalCDF(z));
    }
    const logP = Math.log(p0), logQ = Math.log(1 - p0);
    let pval = 0;
    for (let k = wins; k <= n; k++) {
        pval += Math.exp(logBinom(n, k) + k * logP + (n - k) * logQ);
    }
    return Math.min(1, pval);
}

// Z-score (normal approximation) — for display alongside exact p-value
function zScore(wins, n, p0 = 0.5) {
    if (n === 0) return 0;
    return (wins / n - p0) / Math.sqrt(p0 * (1 - p0) / n);
}

// Wilson score interval (more accurate than Wald, especially at extreme WR)
function wilsonCI(wins, n, alpha = 0.05) {
    if (n === 0) return { lower: '0.0%', upper: '100.0%' };
    const z = alpha === 0.01 ? 2.576 : alpha === 0.10 ? 1.645 : 1.960;
    const p = wins / n, z2 = z * z;
    const center = (p + z2 / (2 * n)) / (1 + z2 / n);
    const margin  = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return {
        lower: (Math.max(0, center - margin) * 100).toFixed(1) + '%',
        upper: (Math.min(1, center + margin) * 100).toFixed(1) + '%',
    };
}

/**
 * Minimum sample size to achieve p < 0.05 (one-tailed) at the observed WR.
 * Returns null if WR <= 50% (no edge) or already significant.
 */
function requiredN(wins, n, p0 = 0.5) {
    if (n === 0 || wins / n <= p0) return null;
    const pHat = wins / n;
    const z_alpha = 1.645;
    return Math.ceil((z_alpha * Math.sqrt(p0 * (1 - p0)) / (pHat - p0)) ** 2);
}

/**
 * Kelly fraction (full Kelly) for binary options with given payout.
 * f = p - (1-p)/b  where b = payout ratio (0.92 for PO binary options).
 * Positive = bet this fraction of bankroll per trade.
 * Negative = don't trade (expected negative value).
 */
function kellyFraction(wins, n, payout = 0.92) {
    if (n === 0) return null;
    const p = wins / n, q = 1 - p;
    const f = p - q / payout;
    return parseFloat((f * 100).toFixed(2));
}

// ─── Test record builder ──────────────────────────────────────────────────────

const MIN_N = 20;

function buildTest(label, wins, n, meta = {}) {
    const base = { label, wins, n, ...meta };
    if (n < MIN_N) {
        return { ...base, win_rate: n > 0 ? ((wins / n) * 100).toFixed(1) + '%' : 'N/A',
            verdict: 'INSUFFICIENT_DATA', required_n: MIN_N };
    }
    const pHat = wins / n;
    const wr   = (pHat * 100).toFixed(1) + '%';
    if (pHat <= 0.5) {
        return { ...base, win_rate: wr, z_score: parseFloat(zScore(wins, n).toFixed(3)),
            p_value: 1.0, ci_95: wilsonCI(wins, n), verdict: 'NO_EDGE', kelly_pct: kellyFraction(wins, n) };
    }
    const pv = binomPValue(wins, n);
    const z  = parseFloat(zScore(wins, n).toFixed(3));
    const ci = wilsonCI(wins, n);
    const kf = kellyFraction(wins, n);
    const rn = pv >= 0.05 ? requiredN(wins, n) : null;

    let verdict;
    if      (pv < 0.01) verdict = 'SIGNIFICANT_99';  // <1% chance of random
    else if (pv < 0.05) verdict = 'SIGNIFICANT_95';  // <5% chance of random
    else if (pv < 0.10) verdict = 'MARGINAL_90';     // <10% chance of random
    else                verdict = 'NOT_SIGNIFICANT';

    return {
        ...base, win_rate: wr, z_score: z, p_value: parseFloat(pv.toFixed(4)),
        ci_95: ci, verdict, kelly_pct: kf,
        ...(rn ? { required_n_for_sig: rn } : {}),
    };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function significanceTests() {
    const replay = await replayCandles(null, { amount: 500 });
    if (!replay.success) return replay;

    const sigs = replay.signals_all || [];
    if (sigs.length === 0) return { success: false, error: 'No replay signals found — run po_replay_candles first.' };

    const v60  = sigs.filter(s => s.result_60  != null);
    const v120 = sigs.filter(s => s.result_120 != null);

    const tests = [];

    // ── Overall (both expiries) ──────────────────────────────────────────────
    tests.push(buildTest('ALL directions — 60s',  v60.filter(s => s.result_60  === 'WIN').length, v60.length,  { expiry: '60s',  direction: 'ALL', category: 'overall' }));
    tests.push(buildTest('ALL directions — 120s', v120.filter(s => s.result_120 === 'WIN').length, v120.length, { expiry: '120s', direction: 'ALL', category: 'overall' }));

    // ── By direction ─────────────────────────────────────────────────────────
    for (const dir of ['CALL', 'PUT']) {
        for (const [expLabel, resultKey, validSet] of [['60s', 'result_60', v60], ['120s', 'result_120', v120]]) {
            const sub = validSet.filter(s => s.direction === dir);
            tests.push(buildTest(`${dir} — ${expLabel}`, sub.filter(s => s[resultKey] === 'WIN').length, sub.length,
                { expiry: expLabel, direction: dir, category: 'direction' }));
        }
    }

    // ── By asset (only assets with >= MIN_N validated signals) ──────────────
    const assets = [...new Set(sigs.map(s => s.asset))].sort();
    for (const asset of assets) {
        for (const [expLabel, resultKey, validSet] of [['60s', 'result_60', v60], ['120s', 'result_120', v120]]) {
            const sub = validSet.filter(s => s.asset === asset);
            if (sub.length >= MIN_N) {
                tests.push(buildTest(`${asset} — ${expLabel}`, sub.filter(s => s[resultKey] === 'WIN').length, sub.length,
                    { expiry: expLabel, direction: 'ALL', asset, category: 'asset' }));
            }
        }
    }

    // ── By STC entry zone ────────────────────────────────────────────────────
    const callZones = [
        { label: 'CALL STC 0–10',  min: 0,  max: 10  },
        { label: 'CALL STC 10–20', min: 10, max: 20  },
        { label: 'CALL STC 20–25', min: 20, max: 25  },
    ];
    const putZones = [
        { label: 'PUT STC 75–85',  min: 75, max: 85  },
        { label: 'PUT STC 85–95',  min: 85, max: 95  },
        { label: 'PUT STC 95–100', min: 95, max: 101 },
    ];
    for (const zone of callZones) {
        for (const [expLabel, resultKey, validSet] of [['60s', 'result_60', v60], ['120s', 'result_120', v120]]) {
            const sub = validSet.filter(s => s.direction === 'CALL' && s.stcValue != null && s.stcValue >= zone.min && s.stcValue < zone.max);
            if (sub.length >= MIN_N) {
                tests.push(buildTest(`${zone.label} — ${expLabel}`, sub.filter(s => s[resultKey] === 'WIN').length, sub.length,
                    { expiry: expLabel, direction: 'CALL', category: 'stc_zone' }));
            }
        }
    }
    for (const zone of putZones) {
        for (const [expLabel, resultKey, validSet] of [['60s', 'result_60', v60], ['120s', 'result_120', v120]]) {
            const sub = validSet.filter(s => s.direction === 'PUT' && s.stcValue != null && s.stcValue >= zone.min && s.stcValue < zone.max);
            if (sub.length >= MIN_N) {
                tests.push(buildTest(`${zone.label} — ${expLabel}`, sub.filter(s => s[resultKey] === 'WIN').length, sub.length,
                    { expiry: expLabel, direction: 'PUT', category: 'stc_zone' }));
            }
        }
    }

    // ── By hour of day (UTC) ─────────────────────────────────────────────────
    const hourBuckets = {};
    for (const s of sigs) {
        const h = Math.floor((s.signalTs % 86400) / 3600);
        if (!hourBuckets[h]) hourBuckets[h] = { v60: [], v120: [] };
        if (s.result_60  != null) hourBuckets[h].v60.push(s);
        if (s.result_120 != null) hourBuckets[h].v120.push(s);
    }
    for (const [hStr, data] of Object.entries(hourBuckets)) {
        const h = parseInt(hStr);
        const hourLabel = String(h).padStart(2, '0') + ':00 UTC';
        for (const [expLabel, subset, resultKey] of [['60s', data.v60, 'result_60'], ['120s', data.v120, 'result_120']]) {
            if (subset.length >= MIN_N) {
                tests.push(buildTest(`Hour ${hourLabel} — ${expLabel}`, subset.filter(s => s[resultKey] === 'WIN').length, subset.length,
                    { expiry: expLabel, direction: 'ALL', hour_utc: h, category: 'hour' }));
            }
        }
    }

    // Sort by p-value ascending (most significant first), then by n descending
    tests.sort((a, b) => {
        const pa = a.p_value ?? 2, pb = b.p_value ?? 2;
        return pa !== pb ? pa - pb : (b.n || 0) - (a.n || 0);
    });

    // ── Live trade tests (from trades_ordered DB table) ──────────────────────
    const liveRows = await all(
        `SELECT direction, result FROM trades_ordered WHERE result IN ('WIN','LOSS') ORDER BY entry_timestamp DESC`,
        []
    );
    const liveTests = [];
    if (liveRows.length > 0) {
        const lw = liveRows.filter(r => r.result === 'WIN').length;
        liveTests.push(buildTest('LIVE — all', lw, liveRows.length, { source: 'live_trades' }));
        for (const dir of ['CALL', 'PUT']) {
            const dr = liveRows.filter(r => r.direction === dir);
            const dw = dr.filter(r => r.result === 'WIN').length;
            if (dr.length >= MIN_N) liveTests.push(buildTest(`LIVE — ${dir}`, dw, dr.length, { source: 'live_trades', direction: dir }));
        }
    }

    // ── Summary counts ────────────────────────────────────────────────────────
    const sigCount    = tests.filter(t => t.verdict?.startsWith('SIGNIFICANT')).length;
    const margCount   = tests.filter(t => t.verdict === 'MARGINAL_90').length;
    const noEdgeCount = tests.filter(t => t.verdict === 'NO_EDGE').length;
    const insufCount  = tests.filter(t => t.verdict === 'INSUFFICIENT_DATA').length;

    return {
        success: true,
        methodology: {
            null_hypothesis: 'WR = 50.0% (random — no edge)',
            alternative:     'WR > 50.0% (one-tailed)',
            test:            'Exact binomial (n ≤ 120) | Normal approximation (n > 120)',
            ci:              'Wilson score interval, 95%',
            min_n:           MIN_N,
            alpha_levels:    { significant_99: 'p < 0.01', significant_95: 'p < 0.05', marginal_90: 'p < 0.10' },
            kelly_payout:    '0.92 (Pocket Option binary payout)',
        },
        data_summary: {
            total_replay_signals: sigs.length,
            validated_60s: v60.length,
            validated_120s: v120.length,
            live_trades: liveRows.length,
        },
        summary: {
            slices_tested: tests.length,
            significant_99: tests.filter(t => t.verdict === 'SIGNIFICANT_99').length,
            significant_95: tests.filter(t => t.verdict === 'SIGNIFICANT_95').length,
            marginal_90: margCount,
            no_edge: noEdgeCount,
            insufficient_data: insufCount,
        },
        significance_table: tests,
        live_trade_tests: liveTests,
    };
}
