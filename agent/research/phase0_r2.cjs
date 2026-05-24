'use strict';
// Phase 0 — R.2 Per-gate Significance
//
// For each (gate, direction, expiry) cell using TRAIN FOLD ONLY:
//   - n = count of signals with non-null win
//   - k = sum of wins
//   - WR = k/n
//   - Wilson 95% CI lower bound (z=1.96)
//   - One-sided binomial p-value against H0: WR <= 0.5405 (break-even floor)
//     using normal approximation with continuity correction
//
// Apply Benjamini-Hochberg correction at FDR=0.05 across all 102 p-values.
//
// Pass criteria: n >= 100 AND ci_lower > 0.5405 AND bh_passed = TRUE.
//
// Also computes per-session WR + n per cell (Asian, European, American,
// Off-hours) but does NOT apply significance testing per-session here —
// that's R.6.
//
// Outputs:
//   phase0_r2_results.csv   — all 102 cells with full metrics
//   phase0_r2_survivors.csv — only cells passing all criteria
//
// Hard constraints honoured:
//   - Train fold only (fold = 0)
//   - Break-even floor 0.5405 (NOT 0.5)
//   - BH FDR=0.05 (NOT Bonferroni)
//   - Minimum n=100 for pass

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'phase0_research.db');
const RESULTS_CSV = path.join(__dirname, 'phase0_r2_results.csv');
const SURVIVORS_CSV = path.join(__dirname, 'phase0_r2_survivors.csv');

const BREAK_EVEN = 0.5405;
const MIN_N = 100;
const FDR = 0.05;
const Z_95 = 1.959963984540054; // two-tailed 95% z-score (precise)

// ── Statistical primitives ──────────────────────────────────────────────────

// erf via Abramowitz & Stegun 7.1.26, max error 1.5e-7
function erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax*ax);
    return sign * y;
}

function normalCDF(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Wilson 95% confidence interval (two-tailed)
function wilsonCI(k, n, z = Z_95) {
    if (n === 0) return { lower: 0, upper: 1, center: 0 };
    const p_hat = k / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p_hat + z2 / (2 * n)) / denom;
    const margin = z * Math.sqrt(p_hat * (1 - p_hat) / n + z2 / (4 * n * n)) / denom;
    return {
        lower: Math.max(0, center - margin),
        upper: Math.min(1, center + margin),
        center
    };
}

// One-sided binomial p-value against H0: WR <= p0 (alternative H1: WR > p0)
// Uses normal approximation with continuity correction.
// For n in our range (100-5000+), normal approx is highly accurate.
function binomialPValueOneSidedUpper(k, n, p0) {
    if (n === 0) return 1.0;
    const mean = n * p0;
    const sd = Math.sqrt(n * p0 * (1 - p0));
    if (sd === 0) return k > n * p0 ? 0 : 1;
    // P(X >= k) ≈ P(Z >= (k - 0.5 - mean) / sd)
    const z = (k - 0.5 - mean) / sd;
    return 1 - normalCDF(z);
}

// Benjamini-Hochberg FDR step-up procedure.
// Returns array aligned to input order: { adjustedP, rejected }
function benjaminiHochberg(pvals, alpha = 0.05) {
    const m = pvals.length;
    const indexed = pvals.map((p, i) => ({ p, i }));
    // Sort ascending by p
    indexed.sort((a, b) => a.p - b.p);

    // Compute step-up q values: q_(k) = min over j >= k of (p_(j) * m / j)
    const qByRank = new Array(m);
    let runningMin = 1.0;
    for (let rank = m; rank >= 1; rank--) {
        const idx0 = rank - 1; // 0-based
        const adj = Math.min(1.0, indexed[idx0].p * m / rank);
        runningMin = Math.min(runningMin, adj);
        qByRank[idx0] = runningMin;
    }

    // Map back to original order
    const result = new Array(m);
    for (let rank = 0; rank < m; rank++) {
        const item = indexed[rank];
        result[item.i] = {
            adjustedP: qByRank[rank],
            rejected: qByRank[rank] <= alpha
        };
    }
    return result;
}

// ── CSV helpers ─────────────────────────────────────────────────────────────
function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function writeCsv(filepath, columns, rows) {
    const lines = [columns.join(',')];
    for (const r of rows) {
        lines.push(columns.map(c => csvEscape(r[c])).join(','));
    }
    fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf8');
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`ERROR: ${DB_PATH} not found`);
        process.exit(1);
    }
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    // Get distinct (gate, direction) pairs from backtest_signals
    const gates = db.prepare(`
        SELECT DISTINCT gate, direction FROM backtest_signals
        ORDER BY direction, gate
    `).all();

    if (gates.length === 0) {
        console.error('ERROR: backtest_signals is empty. Run R.1 first.');
        process.exit(1);
    }

    console.log(`Gates found in backtest_signals: ${gates.length}`);
    const expiries = ['5m', '10m', '15m'];
    const winCols = { '5m': 'win_5m', '10m': 'win_10m', '15m': 'win_15m' };

    // Aggregation queries (train-fold only) — parameterized
    // Overall n/wins per (gate, dir, expiry)
    const aggOverall = db.prepare(`
        SELECT
            COUNT(CASE WHEN __WIN__ IS NOT NULL THEN 1 END) AS n,
            SUM(CASE WHEN __WIN__ = 1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate = ? AND direction = ? AND fold = 0
    `.replace(/__WIN__/g, '$WIN$')); // placeholder, we'll build per-expiry below

    // We need per-expiry queries (column names can't be parameterized in SQL)
    const aggByExpiryAll = {};
    const aggByExpirySess = {};
    for (const exp of expiries) {
        const wc = winCols[exp];
        aggByExpiryAll[exp] = db.prepare(`
            SELECT
                COUNT(CASE WHEN ${wc} IS NOT NULL THEN 1 END) AS n,
                SUM(CASE WHEN ${wc} = 1 THEN 1 ELSE 0 END) AS k
            FROM backtest_signals
            WHERE gate = ? AND direction = ? AND fold = 0
        `);
        aggByExpirySess[exp] = db.prepare(`
            SELECT
                session,
                COUNT(CASE WHEN ${wc} IS NOT NULL THEN 1 END) AS n,
                SUM(CASE WHEN ${wc} = 1 THEN 1 ELSE 0 END) AS k
            FROM backtest_signals
            WHERE gate = ? AND direction = ? AND fold = 0
            GROUP BY session
        `);
    }

    // Build cell records
    const cells = [];
    for (const g of gates) {
        for (const exp of expiries) {
            const overall = aggByExpiryAll[exp].get(g.gate, g.direction);
            const n = overall.n || 0;
            const k = overall.k || 0;

            const cell = {
                gate: g.gate,
                direction: g.direction,
                expiry: exp,
                n, k,
                wr: n > 0 ? k / n : null,
                ci_lower: null,
                ci_upper: null,
                p_value: null,
                bh_adjusted_p: null,
                bh_passed: null,
                low_n: n < MIN_N,
                clears_break_even: null,
                passes_all_criteria: null,
                // per-session WR + n
                wr_asian: null,    n_asian: 0,
                wr_european: null, n_european: 0,
                wr_american: null, n_american: 0,
                wr_offhours: null, n_offhours: 0,
            };

            if (n > 0) {
                const ci = wilsonCI(k, n);
                cell.ci_lower = ci.lower;
                cell.ci_upper = ci.upper;
                cell.p_value = binomialPValueOneSidedUpper(k, n, BREAK_EVEN);
                cell.clears_break_even = cell.ci_lower > BREAK_EVEN;
            } else {
                cell.p_value = 1.0;
            }

            // Per-session breakdown
            const sessRows = aggByExpirySess[exp].all(g.gate, g.direction);
            for (const sr of sessRows) {
                const sn = sr.n || 0;
                const sk = sr.k || 0;
                const wr = sn > 0 ? sk / sn : null;
                if (sr.session === 'Asian')     { cell.wr_asian = wr;     cell.n_asian = sn; }
                else if (sr.session === 'European') { cell.wr_european = wr; cell.n_european = sn; }
                else if (sr.session === 'American') { cell.wr_american = wr; cell.n_american = sn; }
                else if (sr.session === 'Off-hours') { cell.wr_offhours = wr; cell.n_offhours = sn; }
            }

            cells.push(cell);
        }
    }

    // ── Apply Benjamini-Hochberg correction across all 102 p-values ─────────
    const pvals = cells.map(c => c.p_value ?? 1.0);
    const bhResults = benjaminiHochberg(pvals, FDR);
    for (let i = 0; i < cells.length; i++) {
        cells[i].bh_adjusted_p = bhResults[i].adjustedP;
        cells[i].bh_passed = bhResults[i].rejected;
    }

    // ── Apply final pass criteria ───────────────────────────────────────────
    for (const c of cells) {
        c.passes_all_criteria = (
            !c.low_n &&
            c.clears_break_even === true &&
            c.bh_passed === true
        );
    }

    // ── Write outputs ───────────────────────────────────────────────────────
    const cols = [
        'gate', 'direction', 'expiry',
        'n', 'k', 'wr',
        'ci_lower', 'ci_upper',
        'p_value', 'bh_adjusted_p', 'bh_passed',
        'low_n', 'clears_break_even', 'passes_all_criteria',
        'wr_asian', 'n_asian',
        'wr_european', 'n_european',
        'wr_american', 'n_american',
        'wr_offhours', 'n_offhours',
    ];
    const formatted = cells.map(c => {
        const o = { ...c };
        for (const k of ['wr','ci_lower','ci_upper','p_value','bh_adjusted_p',
                         'wr_asian','wr_european','wr_american','wr_offhours']) {
            if (o[k] != null) o[k] = Number(o[k]).toFixed(6);
        }
        for (const k of ['low_n','clears_break_even','passes_all_criteria','bh_passed']) {
            if (o[k] != null) o[k] = o[k] ? 'TRUE' : 'FALSE';
        }
        return o;
    });
    writeCsv(RESULTS_CSV, cols, formatted);
    console.log(`Wrote ${cells.length} cells → ${RESULTS_CSV}`);

    const survivors = cells.filter(c => c.passes_all_criteria === true);
    const formattedSurvivors = survivors.map(c => {
        const o = { ...c };
        for (const k of ['wr','ci_lower','ci_upper','p_value','bh_adjusted_p',
                         'wr_asian','wr_european','wr_american','wr_offhours']) {
            if (o[k] != null) o[k] = Number(o[k]).toFixed(6);
        }
        for (const k of ['low_n','clears_break_even','passes_all_criteria','bh_passed']) {
            if (o[k] != null) o[k] = o[k] ? 'TRUE' : 'FALSE';
        }
        return o;
    });
    writeCsv(SURVIVORS_CSV, cols, formattedSurvivors);
    console.log(`Wrote ${survivors.length} survivor(s) → ${SURVIVORS_CSV}`);

    // ── Console summary ─────────────────────────────────────────────────────
    console.log(`\nR.2 — Per-gate significance (train fold, vs WR<=${BREAK_EVEN}, BH FDR=${FDR})\n`);
    console.log(
        'gate'.padEnd(24) + 'dir'.padEnd(5) + 'exp'.padEnd(5) +
        'n'.padStart(7) + 'wr'.padStart(8) +
        'ci_low'.padStart(9) + 'p_val'.padStart(11) + 'bh_p'.padStart(11) +
        '  flags'
    );
    console.log('-'.repeat(95));

    // Sort: passing first, then by WR desc within each group
    const sorted = [...cells].sort((a, b) => {
        if (a.passes_all_criteria !== b.passes_all_criteria) {
            return a.passes_all_criteria ? -1 : 1;
        }
        return (b.wr ?? 0) - (a.wr ?? 0);
    });

    let passCount = 0;
    let breakEvenButFailedBH = 0;
    let breakEvenButLowN = 0;
    for (const c of sorted) {
        const flags = [];
        if (c.low_n) flags.push('low_n');
        if (c.clears_break_even === false) flags.push('below_floor');
        if (c.bh_passed === false && c.clears_break_even === true && !c.low_n) flags.push('bh_failed');
        if (c.passes_all_criteria === true) { flags.push('PASS'); passCount++; }
        if (c.clears_break_even === true && c.bh_passed === false && !c.low_n) breakEvenButFailedBH++;
        if (c.clears_break_even === true && c.low_n) breakEvenButLowN++;

        console.log(
            c.gate.padEnd(24) +
            c.direction.padEnd(5) +
            c.expiry.padEnd(5) +
            String(c.n).padStart(7) +
            (c.wr != null ? (c.wr * 100).toFixed(2) + '%' : '-').padStart(8) +
            (c.ci_lower != null ? (c.ci_lower * 100).toFixed(2) + '%' : '-').padStart(9) +
            (c.p_value != null ? c.p_value.toExponential(2) : '-').padStart(11) +
            (c.bh_adjusted_p != null ? c.bh_adjusted_p.toExponential(2) : '-').padStart(11) +
            '  ' + flags.join(' ')
        );
    }

    console.log(`\nSummary:`);
    console.log(`  cells tested:                       ${cells.length}`);
    console.log(`  cells PASSING all criteria:         ${passCount}`);
    console.log(`  cells clearing 54.05% floor but BH-rejected: ${breakEvenButFailedBH}`);
    console.log(`  cells clearing 54.05% floor but low_n:        ${breakEvenButLowN}`);

    if (passCount === 0) {
        console.log(`\n*** R.2 outcome: ZERO gates clear significance. ***`);
        console.log(`Per phase0-agent.md stop condition: do not proceed to R.3 without explicit user approval.`);

        // Closest non-passing cell (highest CI lower not below floor)
        const closest = [...cells]
            .filter(c => c.wr != null && c.ci_lower != null)
            .sort((a, b) => (b.ci_lower) - (a.ci_lower))
            .slice(0, 5);
        console.log(`\nClosest 5 (by ci_lower descending):`);
        for (const c of closest) {
            console.log(`  ${c.gate.padEnd(24)} ${c.direction} ${c.expiry}  n=${c.n}  wr=${(c.wr*100).toFixed(2)}%  ci_low=${(c.ci_lower*100).toFixed(2)}%  bh_p=${c.bh_adjusted_p.toExponential(2)}  low_n=${c.low_n}`);
        }
    } else {
        console.log(`\n${passCount} cell(s) passed. Survivors written to ${SURVIVORS_CSV}.`);
        console.log(`R.3 walk-forward is the next step (pending user confirmation).`);
    }

    db.close();
}

main();
