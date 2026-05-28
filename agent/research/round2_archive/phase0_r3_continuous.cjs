'use strict';
// Phase 0 Round 2 — Continuous R.3 check
//
// Pre-registered gate (locked 2026-05-24):
//
//   di_oversold_bounce_nonOTC  CALL  15m
//   Condition: (plus_di - minus_di) < -25.6
//              AND cci_20 < -65
//              AND bb_width_bps BETWEEN 13.7 AND 37.7
//              AND asset NOT LIKE '%_otc'    ← non-OTC only
//   Training:  n=176  WR=71.6%  CI=[64.5%, 77.7%]
//
// OTC signals are collected and reported but excluded from pass/fail.
//
// Does NOT sync or populate — run phase0_r2_sync.cjs first.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const RESEARCH_DB = path.join(__dirname, '..', 'data', 'phase0_research.db');
const LOG_PATH    = path.join(__dirname, '..', 'phase0_log.md');

const BREAK_EVEN = 0.5405;
const Z_95       = 1.959963984540054;
const CUTOFF_DT  = '2026-05-23 04:40:00 UTC';
const GATE_NAME  = 'di_oversold_bounce';
const GATE_DIR   = 'CALL';

// Training corpus constants (R1 full dataset, non-OTC subset — locked 2026-05-24)
const TRAIN_NOTC_N     = 176;
const TRAIN_NOTC_WR    = 0.7159;
const TRAIN_NOTC_CI_LO = 0.6452;
const TRAIN_NOTC_CI_HI = 0.7774;
const TRAIN_OTC_N      = 31;
const TRAIN_OTC_WR     = 0.5484;

// ── Stats ────────────────────────────────────────────────────────────────────
function erf(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign=x<0?-1:1,ax=Math.abs(x),t=1/(1+p*ax);
    return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax));
}
function normalCDF(z) { return 0.5*(1+erf(z/Math.SQRT2)); }

function wilsonCI(k, n) {
    if (!n) return { lower: null, upper: null };
    const ph=k/n, z2=Z_95*Z_95, d=1+z2/n;
    const c=(ph+z2/(2*n))/d;
    const m=Z_95*Math.sqrt(ph*(1-ph)/n+z2/(4*n*n))/d;
    return { lower: Math.max(0, c-m), upper: Math.min(1, c+m) };
}

function binomP(k, n, p0) {
    if (!n) return 1;
    const mean=n*p0, sd=Math.sqrt(n*p0*(1-p0));
    if (!sd) return k>mean ? 0 : 1;
    return 1 - normalCDF((k-0.5-mean)/sd);
}

// Verdict logic — 4 levels
function verdict(n, ciLower) {
    if (n < 20)  return 'WAITING';
    if (n < 50)  return ciLower!=null && ciLower > BREAK_EVEN ? 'PASS (low_n)'   : 'INCONCLUSIVE';
    if (n < 100) return ciLower!=null && ciLower > BREAK_EVEN ? 'PASS (caution)' : 'FAIL';
    return ciLower!=null && ciLower > BREAK_EVEN ? 'PASS' : 'FAIL';
}

function pct(v, dp=1) { return v!=null ? (v*100).toFixed(dp)+'%' : 'n/a'; }
function fmtCI(lo, hi) {
    if (lo==null || hi==null) return 'n/a';
    return `[${pct(lo)}, ${pct(hi)}]`;
}

function main() {
    if (!fs.existsSync(RESEARCH_DB)) {
        console.error('ERROR: phase0_research.db not found'); process.exit(1);
    }
    const db = new Database(RESEARCH_DB, { readonly: true });
    db.pragma('journal_mode = WAL');

    // ── VALIDATION QUERY — non-OTC only ──────────────────────────────────────
    const notcSignals = db.prepare(`
        SELECT asset, win_15m
        FROM backtest_signals
        WHERE gate      = '${GATE_NAME}'
          AND direction = '${GATE_DIR}'
          AND fold      = 'test_r2'
          AND asset NOT LIKE '%_otc'
          AND win_15m IS NOT NULL
    `).all();

    const notcN = notcSignals.length;
    const notcK = notcSignals.filter(r => r.win_15m === 1).length;
    const notcWR = notcN > 0 ? notcK / notcN : null;
    const notcCI = wilsonCI(notcK, notcN);
    const notcPV = notcN > 0 ? binomP(notcK, notcN, BREAK_EVEN) : null;
    const notcV  = verdict(notcN, notcCI.lower);

    // ── INFORMATIONAL QUERY — OTC only (reported but not validated) ───────────
    const otcSignals = db.prepare(`
        SELECT asset, win_15m
        FROM backtest_signals
        WHERE gate      = '${GATE_NAME}'
          AND direction = '${GATE_DIR}'
          AND fold      = 'test_r2'
          AND asset LIKE '%_otc'
          AND win_15m IS NOT NULL
    `).all();

    const otcN = otcSignals.length;
    const otcK = otcSignals.filter(r => r.win_15m === 1).length;
    const otcWR = otcN > 0 ? otcK / otcN : null;

    // ── Per-asset breakdowns ──────────────────────────────────────────────────
    const assetQuery = db.prepare(`
        SELECT asset,
               COUNT(CASE WHEN win_15m IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN win_15m = 1 THEN 1 ELSE 0 END)   AS k
        FROM backtest_signals
        WHERE gate = ? AND direction = ? AND fold = 'test_r2'
        GROUP BY asset ORDER BY n DESC
    `);
    const allAssets = assetQuery.all(GATE_NAME, GATE_DIR);
    const notcAssets = allAssets.filter(r => !r.asset.endsWith('_otc'));
    const otcAssets  = allAssets.filter(r =>  r.asset.endsWith('_otc'));

    // Milestone for next check (based on non-OTC n)
    const milestones = [10, 20, 30, 50, 85, 100, 150, 200];
    const next = milestones.find(m => m > notcN) ?? notcN + 50;

    // ── Output ────────────────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const W = 62;
    const bar = '='.repeat(W);

    console.log(`\n${bar}`);
    console.log(`=== di_oversold_bounce CALL 15m — Round 2 check ${today} ===`);
    console.log(bar);

    // Training summary
    console.log(`Training:    non-OTC n=${TRAIN_NOTC_N}  WR=${pct(TRAIN_NOTC_WR)}  CI=${fmtCI(TRAIN_NOTC_CI_LO, TRAIN_NOTC_CI_HI)}  PASS`);
    console.log(`             OTC     n=${TRAIN_OTC_N}   WR=${pct(TRAIN_OTC_WR)}  NO EDGE (excluded from gate)`);
    console.log('');

    // Non-OTC test fold — validation
    console.log(`Test fold (test_r2 — non-OTC only):`);
    console.log(`  n:        ${notcN}   (target ≥50 for PASS eligibility)`);
    if (notcN < 20) {
        console.log(`  WR:       n/a  (need n≥20 to report)`);
        console.log(`  CI lower: n/a`);
    } else {
        console.log(`  WR:       ${pct(notcWR)}`);
        console.log(`  CI lower: ${pct(notcCI.lower)}  (need >54.05%)`);
        console.log(`  CI upper: ${pct(notcCI.upper)}`);
        console.log(`  p-value:  ${notcPV.toExponential(3)}  (vs H0: WR≤0.5405)`);
    }
    console.log(`  Verdict:  ${notcV}`);
    console.log('');

    // OTC test fold — informational
    console.log(`Test fold (test_r2 — OTC, informational only):`);
    console.log(`  n:        ${otcN}`);
    if (otcN < 5) {
        console.log(`  WR:       n/a  (n<5)`);
    } else {
        console.log(`  WR:       ${pct(otcWR)}  (expected ~50-55%, not traded)`);
    }
    console.log('');

    // Per-asset detail
    if (notcAssets.length) {
        console.log(`Per-asset non-OTC (test fold):`);
        for (const a of notcAssets) {
            const wr = a.n > 0 ? (a.k/a.n*100).toFixed(1)+'%' : '-';
            const ci = wilsonCI(a.k, a.n);
            const ciStr = a.n >= 10 ? `  CI lower=${pct(ci.lower)}` : '';
            console.log(`  ${a.asset.padEnd(20)} n=${String(a.n).padStart(3)}  WR=${wr}${ciStr}`);
        }
        console.log('');
    }

    if (otcAssets.length) {
        console.log(`Per-asset OTC (informational):`);
        for (const a of otcAssets) {
            const wr = a.n > 0 ? (a.k/a.n*100).toFixed(1)+'%' : '-';
            console.log(`  ${a.asset.padEnd(20)} n=${String(a.n).padStart(3)}  WR=${wr}`);
        }
        console.log('');
    }

    if (!notcAssets.length && !otcAssets.length) {
        console.log('No test_r2 signals yet. Run phase0_r2_sync.cjs first.');
        console.log('');
    }

    console.log(`Next check: when non-OTC n_test reaches ${next}`);
    console.log(bar);

    // ── Log append ────────────────────────────────────────────────────────────
    const entry = [
        '',
        `### Round 2 — Continuous check (${today})`,
        `- non-OTC test_r2:  n=${notcN}  WR=${pct(notcWR)}  ci_lower=${pct(notcCI.lower)}  verdict=${notcV}`,
        `- OTC test_r2:      n=${otcN}  WR=${pct(otcWR)}  (informational only — excluded from gate)`,
        `- Next non-OTC milestone: n=${next}`,
        '---',
        ''
    ].join('\n');
    fs.appendFileSync(LOG_PATH, entry, 'utf8');

    db.close();
}
main();
