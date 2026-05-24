'use strict';
// Phase 0 — R.3 Walk-forward validation
//
// For each R.2 survivor cell, run leakage pre-checks first, then re-test on
// the held-out TEST fold (fold = 1). Do not re-correct, do not re-tune.
//
// Pre-checks (per phase0-agent.md "When a report-derived gate shows huge
// train-fold WR" guidance):
//   1. Entry close correctness — entry_close must equal candles.close at bar_ts
//   2. Exit close from a different bar — exit_15m must equal candles.close at bar_ts+900
//   3. 3-bar independence — per (asset, gate, direction), min gap between fires >= 900s
//   4. Fold split chronology — per asset, max(train bar_ts) < min(test bar_ts)
//
// Verdict logic per cell:
//   PASS                — test ci_lower > 0.5405 AND |train-test delta| <= 5pp AND no leakage flags
//   PARTIAL             — test ci_lower > 0.5405 AND |delta| > 5pp (edge exists but inconsistent)
//   OVERFIT             — test ci_lower <= 0.5405 (edge gone out-of-sample)
//   LEAKAGE_SUSPECTED   — any pre-check failed, OR either-fold WR > 80%
//
// Outputs:
//   phase0_r3_results.csv              — one row per survivor cell with full metrics + verdict
//   phase0_r3_asset_breakdown.csv      — per (cell, asset) rows for concentration check
//   phase0_r3_session_breakdown.csv    — per (cell, session) rows

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'phase0_research.db');
const SURVIVORS_CSV = path.join(__dirname, 'phase0_r2_survivors.csv');
const RESULTS_CSV = path.join(__dirname, 'phase0_r3_results.csv');
const ASSET_CSV = path.join(__dirname, 'phase0_r3_asset_breakdown.csv');
const SESSION_CSV = path.join(__dirname, 'phase0_r3_session_breakdown.csv');

const BREAK_EVEN = 0.5405;
const CONSISTENCY_TOLERANCE = 0.05; // 5pp
const LEAKAGE_WR_THRESHOLD = 0.80; // either-fold WR > 80% raises suspicion
const PERIOD = 300;
const INDEP_BARS = 3; // 15 minutes
const Z_95 = 1.959963984540054;

// ── Statistical primitives (same as R.2) ────────────────────────────────────
function erf(x) {
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax*ax);
    return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function wilsonCI(k, n, z = Z_95) {
    if (n === 0) return { lower: 0, upper: 1, center: 0 };
    const p_hat = k / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p_hat + z2 / (2 * n)) / denom;
    const margin = z * Math.sqrt(p_hat * (1 - p_hat) / n + z2 / (4 * n * n)) / denom;
    return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), center };
}
function binomialPValueOneSidedUpper(k, n, p0) {
    if (n === 0) return 1.0;
    const mean = n * p0;
    const sd = Math.sqrt(n * p0 * (1 - p0));
    if (sd === 0) return k > mean ? 0 : 1;
    const z = (k - 0.5 - mean) / sd;
    return 1 - normalCDF(z);
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
    for (const r of rows) lines.push(columns.map(c => csvEscape(r[c])).join(','));
    fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf8');
}
function readCsv(filepath) {
    const text = fs.readFileSync(filepath, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return [];
    const header = lines[0].split(',');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const o = {};
        for (let j = 0; j < header.length; j++) o[header[j]] = cols[j];
        rows.push(o);
    }
    return rows;
}
function parseCsvLine(line) {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuote) {
            if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
            else if (c === '"') { inQuote = false; }
            else cur += c;
        } else {
            if (c === '"') inQuote = true;
            else if (c === ',') { result.push(cur); cur = ''; }
            else cur += c;
        }
    }
    result.push(cur);
    return result;
}

// ── Pre-checks ──────────────────────────────────────────────────────────────
function preCheck1_EntryClose(db, gate, direction) {
    // Sample 100 rows, verify entry_close matches candles.close at bar_ts
    const sample = db.prepare(`
        SELECT s.asset, s.bar_ts, s.entry_close, c.close AS candle_close
        FROM backtest_signals s
        LEFT JOIN candles c ON c.asset = s.asset AND c.timestamp = s.bar_ts
        WHERE s.gate = ? AND s.direction = ?
        LIMIT 200
    `).all(gate, direction);
    let mismatches = 0;
    for (const r of sample) {
        if (r.candle_close == null) { mismatches++; continue; }
        if (Math.abs(r.entry_close - r.candle_close) > 1e-9) mismatches++;
    }
    return {
        name: 'entry_close_correct',
        checked: sample.length,
        mismatches,
        passed: mismatches === 0
    };
}

function preCheck2_ExitFromDifferentBar(db, gate, direction, expiry) {
    // expiry "5m" -> 300, "10m" -> 600, "15m" -> 900
    const expirySec = { '5m': 300, '10m': 600, '15m': 900 }[expiry];
    const expiryCol = { '5m': 'exit_5m', '10m': 'exit_10m', '15m': 'exit_15m' }[expiry];
    const sample = db.prepare(`
        SELECT s.asset, s.bar_ts, s.entry_close, s.${expiryCol} AS sig_exit,
               c.close AS candle_exit
        FROM backtest_signals s
        LEFT JOIN candles c ON c.asset = s.asset AND c.timestamp = (s.bar_ts + ?)
        WHERE s.gate = ? AND s.direction = ? AND s.${expiryCol} IS NOT NULL
        LIMIT 300
    `).all(expirySec, gate, direction);
    let mismatches = 0;
    let sameBarValues = 0;
    for (const r of sample) {
        if (r.candle_exit == null) { mismatches++; continue; }
        if (Math.abs(r.sig_exit - r.candle_exit) > 1e-9) mismatches++;
        // Check exit timestamp is different from entry timestamp (trivially true since expirySec > 0)
        // but also check exit close value isn't suspiciously equal to entry close
        if (r.sig_exit === r.entry_close) sameBarValues++;
    }
    return {
        name: 'exit_from_different_bar',
        checked: sample.length,
        mismatches,
        same_bar_value_count: sameBarValues,
        passed: mismatches === 0
    };
}

function preCheck3_IndependenceRule(db, gate, direction) {
    // For each (asset, gate, dir), get sorted bar_ts, verify min gap >= 3*PERIOD
    const rows = db.prepare(`
        SELECT asset, bar_ts FROM backtest_signals
        WHERE gate = ? AND direction = ?
        ORDER BY asset, bar_ts
    `).all(gate, direction);
    const byAsset = new Map();
    for (const r of rows) {
        if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
        byAsset.get(r.asset).push(r.bar_ts);
    }
    let violations = 0;
    let minGap = Infinity;
    for (const [a, ts] of byAsset) {
        for (let i = 1; i < ts.length; i++) {
            const gap = ts[i] - ts[i-1];
            if (gap < minGap) minGap = gap;
            if (gap < INDEP_BARS * PERIOD) violations++;
        }
    }
    return {
        name: 'independence_rule_3bar',
        violations,
        min_gap_seconds: minGap === Infinity ? null : minGap,
        passed: violations === 0
    };
}

function preCheck4_FoldChronology(db, gate, direction) {
    // Per asset: max(bar_ts WHERE fold=0) < min(bar_ts WHERE fold=1)
    const assets = db.prepare(`
        SELECT DISTINCT asset FROM backtest_signals
        WHERE gate = ? AND direction = ?
    `).all(gate, direction).map(r => r.asset);
    let violations = 0;
    let total = 0;
    for (const a of assets) {
        // We need fold boundaries across ALL bars for this asset (not just gate-firing ones),
        // because fold was assigned by bar position over all indicator rows
        const maxTrain = db.prepare(`
            SELECT MAX(bar_ts) AS m FROM backtest_signals
            WHERE asset = ? AND fold = 0
        `).get(a);
        const minTest = db.prepare(`
            SELECT MIN(bar_ts) AS m FROM backtest_signals
            WHERE asset = ? AND fold = 1
        `).get(a);
        if (maxTrain.m == null || minTest.m == null) continue;
        total++;
        if (maxTrain.m >= minTest.m) violations++;
    }
    return {
        name: 'fold_chronology',
        assets_checked: total,
        violations,
        passed: violations === 0
    };
}

// ── Cell-level metrics ──────────────────────────────────────────────────────
function cellMetrics(db, gate, direction, expiry, fold) {
    const winCol = { '5m': 'win_5m', '10m': 'win_10m', '15m': 'win_15m' }[expiry];
    const row = db.prepare(`
        SELECT
            COUNT(CASE WHEN ${winCol} IS NOT NULL THEN 1 END) AS n,
            SUM(CASE WHEN ${winCol} = 1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate = ? AND direction = ? AND fold = ?
    `).get(gate, direction, fold);
    const n = row.n || 0;
    const k = row.k || 0;
    const wr = n > 0 ? k / n : null;
    const ci = n > 0 ? wilsonCI(k, n) : { lower: null, upper: null };
    const p = n > 0 ? binomialPValueOneSidedUpper(k, n, BREAK_EVEN) : null;
    return { n, k, wr, ci_lower: ci.lower, ci_upper: ci.upper, p_value: p };
}

function assetBreakdown(db, gate, direction, expiry) {
    const winCol = { '5m': 'win_5m', '10m': 'win_10m', '15m': 'win_15m' }[expiry];
    const rows = db.prepare(`
        SELECT asset, fold,
               COUNT(CASE WHEN ${winCol} IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN ${winCol} = 1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate = ? AND direction = ?
        GROUP BY asset, fold
        ORDER BY asset, fold
    `).all(gate, direction);
    return rows.map(r => ({
        asset: r.asset,
        fold: r.fold === 0 ? 'train' : 'test',
        n: r.n || 0,
        wins: r.k || 0,
        wr: r.n > 0 ? r.k / r.n : null
    }));
}

function sessionBreakdown(db, gate, direction, expiry) {
    const winCol = { '5m': 'win_5m', '10m': 'win_10m', '15m': 'win_15m' }[expiry];
    const rows = db.prepare(`
        SELECT session, fold,
               COUNT(CASE WHEN ${winCol} IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN ${winCol} = 1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate = ? AND direction = ?
        GROUP BY session, fold
        ORDER BY session, fold
    `).all(gate, direction);
    return rows.map(r => ({
        session: r.session,
        fold: r.fold === 0 ? 'train' : 'test',
        n: r.n || 0,
        wins: r.k || 0,
        wr: r.n > 0 ? r.k / r.n : null
    }));
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
    if (!fs.existsSync(DB_PATH)) { console.error(`ERROR: ${DB_PATH} not found`); process.exit(1); }
    if (!fs.existsSync(SURVIVORS_CSV)) { console.error(`ERROR: ${SURVIVORS_CSV} not found`); process.exit(1); }

    const survivors = readCsv(SURVIVORS_CSV);
    if (survivors.length === 0) {
        console.log('No R.2 survivors to validate. R.3 ends.');
        process.exit(0);
    }
    console.log(`R.2 survivors loaded: ${survivors.length}`);

    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    const resultRows = [];
    const assetRows = [];
    const sessionRows = [];

    for (const s of survivors) {
        const gate = s.gate;
        const direction = s.direction;
        const expiry = s.expiry;
        const cellLabel = `${gate} | ${direction} | ${expiry}`;
        console.log(`\n========== ${cellLabel} ==========`);

        // ── Step 1: Leakage pre-checks ──
        console.log(`\n[1/4] PRE-CHECKS`);
        const pc1 = preCheck1_EntryClose(db, gate, direction);
        console.log(`  ${pc1.name}: checked=${pc1.checked}, mismatches=${pc1.mismatches}, passed=${pc1.passed}`);
        const pc2 = preCheck2_ExitFromDifferentBar(db, gate, direction, expiry);
        console.log(`  ${pc2.name}: checked=${pc2.checked}, mismatches=${pc2.mismatches}, same_bar_values=${pc2.same_bar_value_count}, passed=${pc2.passed}`);
        const pc3 = preCheck3_IndependenceRule(db, gate, direction);
        console.log(`  ${pc3.name}: violations=${pc3.violations}, min_gap_seconds=${pc3.min_gap_seconds}, passed=${pc3.passed}`);
        const pc4 = preCheck4_FoldChronology(db, gate, direction);
        console.log(`  ${pc4.name}: assets_checked=${pc4.assets_checked}, violations=${pc4.violations}, passed=${pc4.passed}`);

        const allPreChecksPass = pc1.passed && pc2.passed && pc3.passed && pc4.passed;

        // ── Step 2: Train + Test fold metrics ──
        console.log(`\n[2/4] FOLD METRICS`);
        const train = cellMetrics(db, gate, direction, expiry, 0);
        const test  = cellMetrics(db, gate, direction, expiry, 1);
        const delta = (train.wr != null && test.wr != null) ? (train.wr - test.wr) : null;

        console.log(`  TRAIN  n=${train.n}  WR=${(train.wr*100).toFixed(2)}%  CI=[${(train.ci_lower*100).toFixed(2)}%, ${(train.ci_upper*100).toFixed(2)}%]  p=${train.p_value.toExponential(2)}`);
        console.log(`  TEST   n=${test.n}  WR=${test.wr != null ? (test.wr*100).toFixed(2) + '%' : 'n/a'}  CI=[${test.ci_lower != null ? (test.ci_lower*100).toFixed(2) + '%' : 'n/a'}, ${test.ci_upper != null ? (test.ci_upper*100).toFixed(2) + '%' : 'n/a'}]  p=${test.p_value != null ? test.p_value.toExponential(2) : 'n/a'}`);
        console.log(`  DELTA  train - test = ${delta != null ? (delta*100).toFixed(2) + 'pp' : 'n/a'}`);

        // ── Step 3: Per-asset breakdown ──
        console.log(`\n[3/4] PER-ASSET BREAKDOWN`);
        const assets = assetBreakdown(db, gate, direction, expiry);
        // Group by asset to show train+test side-by-side
        const assetMap = new Map();
        for (const a of assets) {
            if (!assetMap.has(a.asset)) assetMap.set(a.asset, { train: null, test: null });
            assetMap.get(a.asset)[a.fold] = a;
        }
        // Sort by total signal count (train+test) desc
        const assetList = [...assetMap.entries()].map(([asset, folds]) => {
            const trainN = folds.train?.n || 0;
            const testN = folds.test?.n || 0;
            const trainK = folds.train?.wins || 0;
            const testK = folds.test?.wins || 0;
            return {
                asset, train_n: trainN, train_k: trainK,
                train_wr: trainN > 0 ? trainK / trainN : null,
                test_n: testN, test_k: testK,
                test_wr: testN > 0 ? testK / testN : null,
                total_n: trainN + testN
            };
        }).sort((a, b) => b.total_n - a.total_n);

        console.log(`  ${'asset'.padEnd(18)}${'train_n'.padStart(8)}${'train_wr'.padStart(10)}${'test_n'.padStart(8)}${'test_wr'.padStart(10)}`);
        for (const a of assetList) {
            console.log(
                `  ${a.asset.padEnd(18)}` +
                `${String(a.train_n).padStart(8)}` +
                `${(a.train_wr != null ? (a.train_wr*100).toFixed(1) + '%' : '-').padStart(10)}` +
                `${String(a.test_n).padStart(8)}` +
                `${(a.test_wr != null ? (a.test_wr*100).toFixed(1) + '%' : '-').padStart(10)}`
            );
            assetRows.push({
                gate, direction, expiry, asset: a.asset,
                train_n: a.train_n, train_k: a.train_k,
                train_wr: a.train_wr != null ? a.train_wr.toFixed(6) : '',
                test_n: a.test_n, test_k: a.test_k,
                test_wr: a.test_wr != null ? a.test_wr.toFixed(6) : '',
            });
        }
        // Concentration metric: top-3 assets' share of train signals
        const totalTrain = assetList.reduce((s, a) => s + a.train_n, 0);
        const top3Train = assetList.slice(0, 3).reduce((s, a) => s + a.train_n, 0);
        const concentrationPct = totalTrain > 0 ? (top3Train / totalTrain) : 0;
        console.log(`  Top-3 asset concentration (train signals): ${(concentrationPct*100).toFixed(1)}%`);

        // ── Step 4: Per-session breakdown ──
        console.log(`\n[4/4] PER-SESSION BREAKDOWN`);
        const sessions = sessionBreakdown(db, gate, direction, expiry);
        const sessionMap = new Map();
        for (const s of sessions) {
            if (!sessionMap.has(s.session)) sessionMap.set(s.session, { train: null, test: null });
            sessionMap.get(s.session)[s.fold] = s;
        }
        const sessionList = ['Asian', 'European', 'American', 'Off-hours'].map(name => {
            const folds = sessionMap.get(name) || { train: null, test: null };
            const trainN = folds.train?.n || 0;
            const testN = folds.test?.n || 0;
            const trainK = folds.train?.wins || 0;
            const testK = folds.test?.wins || 0;
            return {
                session: name, train_n: trainN, train_k: trainK,
                train_wr: trainN > 0 ? trainK / trainN : null,
                test_n: testN, test_k: testK,
                test_wr: testN > 0 ? testK / testN : null
            };
        });
        console.log(`  ${'session'.padEnd(12)}${'train_n'.padStart(8)}${'train_wr'.padStart(10)}${'test_n'.padStart(8)}${'test_wr'.padStart(10)}`);
        for (const s of sessionList) {
            console.log(
                `  ${s.session.padEnd(12)}` +
                `${String(s.train_n).padStart(8)}` +
                `${(s.train_wr != null ? (s.train_wr*100).toFixed(1) + '%' : '-').padStart(10)}` +
                `${String(s.test_n).padStart(8)}` +
                `${(s.test_wr != null ? (s.test_wr*100).toFixed(1) + '%' : '-').padStart(10)}`
            );
            sessionRows.push({
                gate, direction, expiry, session: s.session,
                train_n: s.train_n, train_k: s.train_k,
                train_wr: s.train_wr != null ? s.train_wr.toFixed(6) : '',
                test_n: s.test_n, test_k: s.test_k,
                test_wr: s.test_wr != null ? s.test_wr.toFixed(6) : '',
            });
        }

        // ── Verdict ──
        const consistency = (delta != null) && (Math.abs(delta) <= CONSISTENCY_TOLERANCE);
        const testClearsBreakEven = (test.ci_lower != null) && (test.ci_lower > BREAK_EVEN);
        const leakageFlag = !allPreChecksPass ||
                            (train.wr != null && train.wr > LEAKAGE_WR_THRESHOLD) ||
                            (test.wr != null && test.wr > LEAKAGE_WR_THRESHOLD);

        let verdict;
        if (leakageFlag) verdict = 'LEAKAGE_SUSPECTED';
        else if (testClearsBreakEven && consistency) verdict = 'PASS';
        else if (testClearsBreakEven && !consistency) verdict = 'PARTIAL';
        else verdict = 'OVERFIT';

        console.log(`\n>>> VERDICT: ${verdict}`);
        console.log(`    Pre-checks all passed:  ${allPreChecksPass}`);
        console.log(`    Test clears break-even: ${testClearsBreakEven} (test ci_lower=${test.ci_lower != null ? (test.ci_lower*100).toFixed(2) + '%' : 'n/a'} vs floor=54.05%)`);
        console.log(`    Consistency |delta|<=5pp: ${consistency} (delta=${delta != null ? (delta*100).toFixed(2) + 'pp' : 'n/a'})`);

        resultRows.push({
            gate, direction, expiry,
            train_n: train.n, train_k: train.k,
            train_wr: train.wr != null ? train.wr.toFixed(6) : '',
            train_ci_lower: train.ci_lower != null ? train.ci_lower.toFixed(6) : '',
            train_p_value: train.p_value != null ? train.p_value.toExponential(4) : '',
            test_n: test.n, test_k: test.k,
            test_wr: test.wr != null ? test.wr.toFixed(6) : '',
            test_ci_lower: test.ci_lower != null ? test.ci_lower.toFixed(6) : '',
            test_p_value: test.p_value != null ? test.p_value.toExponential(4) : '',
            train_minus_test_pp: delta != null ? (delta * 100).toFixed(2) : '',
            test_clears_break_even: testClearsBreakEven ? 'TRUE' : 'FALSE',
            consistency_within_5pp: consistency ? 'TRUE' : 'FALSE',
            precheck_entry_close: pc1.passed ? 'PASS' : `FAIL (${pc1.mismatches}/${pc1.checked})`,
            precheck_exit_bar: pc2.passed ? 'PASS' : `FAIL (${pc2.mismatches}/${pc2.checked})`,
            precheck_independence: pc3.passed ? 'PASS' : `FAIL (${pc3.violations} violations, min_gap=${pc3.min_gap_seconds}s)`,
            precheck_fold_chronology: pc4.passed ? 'PASS' : `FAIL (${pc4.violations}/${pc4.assets_checked})`,
            top3_asset_concentration: (concentrationPct * 100).toFixed(1) + '%',
            r3_verdict: verdict
        });
    }

    // Write CSVs
    const mainCols = [
        'gate', 'direction', 'expiry',
        'train_n', 'train_k', 'train_wr', 'train_ci_lower', 'train_p_value',
        'test_n', 'test_k', 'test_wr', 'test_ci_lower', 'test_p_value',
        'train_minus_test_pp',
        'test_clears_break_even', 'consistency_within_5pp',
        'precheck_entry_close', 'precheck_exit_bar', 'precheck_independence', 'precheck_fold_chronology',
        'top3_asset_concentration',
        'r3_verdict'
    ];
    writeCsv(RESULTS_CSV, mainCols, resultRows);
    console.log(`\nWrote ${resultRows.length} cell(s) → ${RESULTS_CSV}`);

    const assetCols = ['gate','direction','expiry','asset','train_n','train_k','train_wr','test_n','test_k','test_wr'];
    writeCsv(ASSET_CSV, assetCols, assetRows);
    console.log(`Wrote ${assetRows.length} per-asset row(s) → ${ASSET_CSV}`);

    const sessCols = ['gate','direction','expiry','session','train_n','train_k','train_wr','test_n','test_k','test_wr'];
    writeCsv(SESSION_CSV, sessCols, sessionRows);
    console.log(`Wrote ${sessionRows.length} per-session row(s) → ${SESSION_CSV}`);

    // Summary
    const verdicts = {};
    for (const r of resultRows) verdicts[r.r3_verdict] = (verdicts[r.r3_verdict] || 0) + 1;
    console.log(`\nR.3 verdict summary:`);
    for (const [v, n] of Object.entries(verdicts)) console.log(`  ${v}: ${n}`);

    db.close();
}

main();
