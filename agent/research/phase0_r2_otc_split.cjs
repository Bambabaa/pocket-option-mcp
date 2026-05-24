'use strict';
// Phase 0 Round 2 — Option (d)
// OTC vs non-OTC split analysis on the R1 training corpus
// for the pre-registered gate: di_oversold_bounce CALL 15m
//
// Outputs:
//   - Wilson CI and p-value for OTC vs non-OTC aggregated
//   - Per-session breakdown within each group
//   - Per-asset rows for each group sorted by WR

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const RESEARCH_DB = path.join(__dirname, '..', 'data', 'phase0_research.db');
const LOG_PATH    = path.join(__dirname, '..', 'phase0_log.md');
const OUT_CSV     = path.join(__dirname, 'phase0_r2_otc_split.csv');

const BREAK_EVEN = 0.5405;
const Z_95       = 1.959963984540054;
const GATE_NAME  = 'di_oversold_bounce';
const GATE_DIR   = 'CALL';

function erf(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign=x<0?-1:1,ax=Math.abs(x),t=1/(1+p*ax);
    return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax));
}
function normalCDF(z) { return 0.5*(1+erf(z/Math.SQRT2)); }
function wilsonCI(k,n) {
    if (!n) return {lower:null,upper:null};
    const ph=k/n,z2=Z_95*Z_95,d=1+z2/n,c=(ph+z2/(2*n))/d,m=Z_95*Math.sqrt(ph*(1-ph)/n+z2/(4*n*n))/d;
    return {lower:Math.max(0,c-m),upper:Math.min(1,c+m)};
}
function binomP(k,n,p0) {
    if (!n) return 1;
    const mean=n*p0,sd=Math.sqrt(n*p0*(1-p0));
    if (!sd) return k>mean?0:1;
    return 1-normalCDF((k-0.5-mean)/sd);
}
function pct(v,dp=2) { return v!=null?(v*100).toFixed(dp)+'%':'n/a'; }
function pRow(label,n,k) {
    const wr=n>0?k/n:null;
    const ci=wilsonCI(k,n);
    const pv=n>0?binomP(k,n,BREAK_EVEN):null;
    const clears = ci.lower!=null&&ci.lower>BREAK_EVEN;
    return {label,n,k,wr,ci_lower:ci.lower,ci_upper:ci.upper,p_value:pv,clears_floor:clears};
}

function main() {
    if (!fs.existsSync(RESEARCH_DB)) { console.error('ERROR: phase0_research.db not found'); process.exit(1); }
    const db = new Database(RESEARCH_DB, {readonly:true});
    db.pragma('journal_mode = WAL');

    // ── Full R1 training corpus (fold 0 + fold 1) ──
    const all = db.prepare(`
        SELECT
            asset, session,
            COUNT(CASE WHEN win_15m IS NOT NULL THEN 1 END) AS n,
            SUM(CASE WHEN win_15m=1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate=? AND direction=? AND fold IN (0,1)
        GROUP BY asset, session
        ORDER BY asset, session
    `).all(GATE_NAME, GATE_DIR);

    // Partition
    const otcRows    = all.filter(r=>r.asset.endsWith('_otc'));
    const nonOtcRows = all.filter(r=>!r.asset.endsWith('_otc'));

    const sumGroup = rows => ({ n: rows.reduce((s,r)=>s+(r.n||0),0), k: rows.reduce((s,r)=>s+(r.k||0),0) });
    const otc    = sumGroup(otcRows);
    const nonOtc = sumGroup(nonOtcRows);
    const total  = {n: otc.n+nonOtc.n, k: otc.k+nonOtc.k};

    // Sessions within each group
    const sessions = ['Asian','European','American','Off-hours'];
    function groupBySess(rows) {
        const m={};
        for (const s of sessions) m[s]={n:0,k:0};
        for (const r of rows) { if (m[r.session]) { m[r.session].n+=r.n||0; m[r.session].k+=r.k||0; } }
        return m;
    }
    const otcSess    = groupBySess(otcRows);
    const nonOtcSess = groupBySess(nonOtcRows);

    // Per-asset (aggregate over sessions)
    function assetSummary(rows) {
        const m={};
        for (const r of rows) {
            if (!m[r.asset]) m[r.asset]={n:0,k:0};
            m[r.asset].n+=r.n||0; m[r.asset].k+=r.k||0;
        }
        return Object.entries(m).map(([asset,{n,k}])=>({asset,n,k,wr:n>0?k/n:null})).sort((a,b)=>b.n-a.n);
    }
    const otcAssets    = assetSummary(otcRows);
    const nonOtcAssets = assetSummary(nonOtcRows);

    // ── Print ──
    const today = new Date().toISOString().slice(0,10);
    const bar = '─'.repeat(60);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`OTC vs non-OTC split — ${GATE_NAME} ${GATE_DIR} 15m — ${today}`);
    console.log(`R1 training corpus (fold 0 + fold 1, vs WR ≤ 0.5405)`);
    console.log('═'.repeat(60));

    function printGroupHeader(label, n, k) {
        const r = pRow(label, n, k);
        console.log(`\n${label.toUpperCase()}`);
        console.log(`  n=${n}  k=${k}  WR=${pct(r.wr)}  CI=[${pct(r.ci_lower)}, ${pct(r.ci_upper)}]  p=${r.p_value!=null?r.p_value.toExponential(3):'n/a'}  clears_floor=${r.clears_floor}`);
    }
    function printSessTable(sessMap) {
        console.log(`  Session breakdown:`);
        for (const s of sessions) {
            const {n,k}=sessMap[s];
            const wr=n>0?(k/n*100).toFixed(1)+'%':'-';
            const ci=wilsonCI(k,n);
            const note=ci.lower!=null&&ci.lower>BREAK_EVEN?' ← clears floor':'';
            console.log(`    ${s.padEnd(12)} n=${String(n).padStart(4)}  WR=${wr}  ci_low=${pct(ci.lower)}${note}`);
        }
    }
    function printAssetTable(rows, label) {
        console.log(`  Per-asset (${label}):`);
        for (const a of rows) {
            const ci=wilsonCI(a.k,a.n);
            const note=ci.lower!=null&&ci.lower>BREAK_EVEN?' ←':'';
            console.log(`    ${a.asset.padEnd(22)} n=${String(a.n).padStart(3)}  WR=${pct(a.wr,1)}  ci_low=${pct(ci.lower)}${note}`);
        }
    }

    printGroupHeader('ALL (combined)',  total.n,  total.k);
    printGroupHeader('OTC pairs',       otc.n,    otc.k);
    printSessTable(otcSess);
    printAssetTable(otcAssets, 'OTC');
    printGroupHeader('non-OTC pairs',   nonOtc.n, nonOtc.k);
    printSessTable(nonOtcSess);
    printAssetTable(nonOtcAssets, 'non-OTC');

    // ── Write CSV ──
    const csvRows = [];
    const push = (group, type, label, n, k) => {
        const ci=wilsonCI(k,n); const pv=n>0?binomP(k,n,BREAK_EVEN):null;
        csvRows.push({group,type,label,n,k,wr:n>0?(k/n).toFixed(6):'',ci_lower:ci.lower!=null?ci.lower.toFixed(6):'',ci_upper:ci.upper!=null?ci.upper.toFixed(6):'',p_value:pv!=null?pv.toExponential(4):'',clears_floor:ci.lower!=null&&ci.lower>BREAK_EVEN?'TRUE':'FALSE'});
    };
    push('all',    'aggregate', 'ALL',   total.n,  total.k);
    push('otc',    'aggregate', 'OTC',   otc.n,    otc.k);
    push('nonotc', 'aggregate', 'non-OTC', nonOtc.n, nonOtc.k);
    for (const s of sessions) {
        push('otc',    'session', s, otcSess[s].n,    otcSess[s].k);
        push('nonotc', 'session', s, nonOtcSess[s].n, nonOtcSess[s].k);
    }
    for (const a of otcAssets)    push('otc',    'asset', a.asset, a.n, a.k);
    for (const a of nonOtcAssets) push('nonotc', 'asset', a.asset, a.n, a.k);
    const cols=['group','type','label','n','k','wr','ci_lower','ci_upper','p_value','clears_floor'];
    const esc=v=>{ const s=String(v??''); return (s.includes(',')||s.includes('"'))?'"'+s.replace(/"/g,'""')+'"':s; };
    fs.writeFileSync(OUT_CSV, [cols.join(','),...csvRows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n')+'\n','utf8');
    console.log(`\nWrote ${csvRows.length} rows → ${OUT_CSV}`);

    const today2=new Date().toISOString().slice(0,10);
    fs.appendFileSync(LOG_PATH, `\n### Round 2 — OTC/non-OTC split (${today2})\n- OTC: n=${otc.n} WR=${pct(otc.n>0?otc.k/otc.n:null)} ci_low=${pct(wilsonCI(otc.k,otc.n).lower)}\n- non-OTC: n=${nonOtc.n} WR=${pct(nonOtc.n>0?nonOtc.k/nonOtc.n:null)} ci_low=${pct(wilsonCI(nonOtc.k,nonOtc.n).lower)}\n---\n`, 'utf8');
    db.close();
}
main();
