/**
 * Simulate adding two new statistically-proven gates to current defaults:
 *   G6: bb_expanding = true     (phi=+0.218, p=0.019)
 *   G7: ma_gap_trend != narrowing  (phi=-0.259, p=0.007)
 *
 * Compares four scenarios side-by-side:
 *   A) Baseline (current 5 gates)
 *   B) + G6 bb_expanding
 *   C) + G7 no_narrow_gap
 *   D) + G6 + G7 (both)
 */

import { replayCandles } from '../../src/core/analysis.js';

// ── Stat helpers ─────────────────────────────────────────────────────────────
function normalCDF(z) {
    const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
    const sign=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);
    return 0.5*(1+sign*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));
}
function logFactorial(n) { let s=0; for(let i=2;i<=n;i++) s+=Math.log(i); return s; }
function logBinom(n,k) { return logFactorial(n)-logFactorial(k)-logFactorial(n-k); }
function binomP(wins,n,p0=0.5) {
    if(n===0||wins/n<=p0) return 1;
    if(n>120) return Math.max(0,1-normalCDF((wins/n-p0)/Math.sqrt(p0*(1-p0)/n)));
    let pv=0; const lp=Math.log(p0),lq=Math.log(1-p0);
    for(let k=wins;k<=n;k++) pv+=Math.exp(logBinom(n,k)+k*lp+(n-k)*lq);
    return Math.min(1,pv);
}
function zScore(wins,n,p0=0.5) { return (wins/n-p0)/Math.sqrt(p0*(1-p0)/n); }
function wilsonCI(wins,n) {
    if(n===0) return 'N/A';
    const z=1.96,p=wins/n,z2=z*z,c=(p+z2/(2*n))/(1+z2/n);
    const m=(z/(1+z2/n))*Math.sqrt(p*(1-p)/n+z2/(4*n*n));
    return `[${(Math.max(0,c-m)*100).toFixed(1)}%,${(Math.min(1,c+m)*100).toFixed(1)}%]`;
}
function kelly(wins,n,pay=0.92) {
    const p=wins/n; return parseFloat(((p-(1-p)/pay)*100).toFixed(1));
}
function verdict(p) {
    if(p<0.01) return 'SIG_99';
    if(p<0.05) return 'SIG_95';
    if(p<0.10) return 'MARGINAL';
    return 'NOT_SIG';
}

function stat(sigs, rKey, plKey, amount=500) {
    const valid = sigs.filter(s=>s[rKey]!=null);
    const wins  = valid.filter(s=>s[rKey]==='WIN').length;
    const n     = valid.length;
    if(n===0) return { n:0, wins:0, wr:'N/A', pl:0, z:'N/A', p:'N/A', ci:'N/A', k:'N/A', verdict:'INSUFFICIENT' };
    const p = binomP(wins,n);
    const pl = valid.reduce((a,s)=>a+(s[plKey]||0),0);
    return {
        n, wins, losses:n-wins,
        wr: (wins/n*100).toFixed(1)+'%',
        pl: Math.round(pl),
        z:  zScore(wins,n).toFixed(3),
        p:  p.toFixed(4),
        ci: wilsonCI(wins,n),
        k:  kelly(wins,n),
        verdict: verdict(p),
    };
}

function printRow(label, s) {
    const sig = s.verdict==='SIG_99'?'***':s.verdict==='SIG_95'?'** ':s.verdict==='MARGINAL'?'*  ':'   ';
    console.log(`  ${label.padEnd(30)} n=${String(s.n).padStart(3)}  wr=${s.wr.padEnd(7)}  pl=$${String(s.pl).padStart(7)}  z=${s.z.padStart(7)}  p=${s.p}  ci=${s.ci}  k=${s.k}%  ${sig}`);
}

// ── Load data ─────────────────────────────────────────────────────────────────
const r = await replayCandles(null, { amount: 500 });
const all = r.signals_all || [];
console.log(`\nTotal signals: ${all.length}  (validated_120s: ${all.filter(s=>s.result_120!=null).length})\n`);

// ── Define the four scenarios ─────────────────────────────────────────────────
const scenarios = [
    { label: 'A  Baseline (5 gates)',        filter: ()  => true },
    { label: 'B  +G6 bb_expanding',          filter: s => s.bb_expanding === true },
    { label: 'C  +G7 no_narrow_gap',         filter: s => s.ma_gap_trend !== 'narrowing' },
    { label: 'D  +G6 +G7 both',              filter: s => s.bb_expanding === true && s.ma_gap_trend !== 'narrowing' },
];

// Also test the deep-STC + both gates combination
const extScenarios = [
    { label: 'E  CALL stc<=10 +G6+G7',       dir:'CALL', filter: s => s.stcValue<=10 && s.bb_expanding===true && s.ma_gap_trend!=='narrowing' },
    { label: 'F  PUT  kdSpread>5 +G6+G7',    dir:'PUT',  filter: s => s.k!=null&&s.d!=null&&Math.abs(s.k-s.d)>5 && s.bb_expanding===true && s.ma_gap_trend!=='narrowing' },
    { label: 'G  PUT  maWideUp +G6+G7',      dir:'PUT',  filter: s => s.ma_gap_trend==='widening_up' && s.bb_expanding===true },
];

// ── Print results ─────────────────────────────────────────────────────────────
for (const dir of ['CALL','PUT','ALL']) {
    console.log(`\n${'═'.repeat(90)}`);
    console.log(`  ${dir} — 120s expiry`);
    console.log('═'.repeat(90));
    console.log(`  ${'Scenario'.padEnd(30)} ${'n'.padStart(4)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'z'.padStart(7)}  ${'p-val'}   ${'CI 95%'.padEnd(18)}  ${'Kelly'}  sig`);
    console.log('  '+'-'.repeat(86));

    for (const sc of scenarios) {
        const base = dir==='ALL' ? all : all.filter(s=>s.direction===dir);
        const sigs = base.filter(s=>s.result_120!=null).filter(sc.filter);
        printRow(sc.label, stat(sigs, 'result_120', 'profitLoss_120'));
    }
}

// ── Extended scenarios ────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(90)}`);
console.log('  EXTENDED GATE COMBINATIONS — 120s');
console.log('═'.repeat(90));
console.log(`  ${'Scenario'.padEnd(30)} ${'n'.padStart(4)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'z'.padStart(7)}  ${'p-val'}   ${'CI 95%'.padEnd(18)}  ${'Kelly'}  sig`);
console.log('  '+'-'.repeat(86));
for (const sc of extScenarios) {
    const base = sc.dir ? all.filter(s=>s.direction===sc.dir) : all;
    const sigs = base.filter(s=>s.result_120!=null).filter(sc.filter);
    printRow(sc.label, stat(sigs,'result_120','profitLoss_120'));
}

// ── Signal rejection counts ───────────────────────────────────────────────────
console.log('\n\n=== GATE REJECTION COUNTS (how many signals each new gate removes) ===');
const v120 = all.filter(s=>s.result_120!=null);
const bb_null = v120.filter(s=>s.bb_expanding==null).length;
const narrow  = v120.filter(s=>s.ma_gap_trend==='narrowing').length;
const both    = v120.filter(s=>s.bb_expanding===true && s.ma_gap_trend!=='narrowing').length;
const baseN   = v120.length;
console.log(`  Baseline validated signals : ${baseN}`);
console.log(`  Removed by G6 (bb_expanding null/false): ${v120.filter(s=>s.bb_expanding!==true).length}  (${(v120.filter(s=>s.bb_expanding!==true).length/baseN*100).toFixed(1)}%)`);
console.log(`  Removed by G7 (ma_gap_trend=narrowing) : ${narrow}  (${(narrow/baseN*100).toFixed(1)}%)`);
console.log(`  Remaining after G6+G7                  : ${both}  (${(both/baseN*100).toFixed(1)}%)`);
console.log(`  Signals with bb_expanding=null          : ${bb_null}`);

// ── 60s comparison (to confirm 60s is still not viable) ──────────────────────
console.log('\n\n=== 60s EXPIRY COMPARISON (confirm 60s still not viable after new gates) ===');
for (const dir of ['CALL','PUT']) {
    console.log(`\n  ${dir} 60s:`);
    for (const sc of scenarios.slice(0,4)) {
        const base = all.filter(s=>s.direction===dir&&s.result_60!=null).filter(sc.filter);
        const s = stat(base,'result_60','profitLoss_60');
        console.log(`    ${sc.label.padEnd(30)} n=${String(s.n).padStart(3)}  wr=${s.wr.padEnd(7)}  pl=$${String(s.pl).padStart(7)}  verdict=${s.verdict}`);
    }
}

// ── Summary table ─────────────────────────────────────────────────────────────
console.log('\n\n=== SUMMARY: BASELINE vs BEST SCENARIO (120s) ===');
console.log('  '.padEnd(10) + ['Scenario','n','WR','P/L','p-val','Kelly','verdict'].map(h=>h.padEnd(12)).join(''));
console.log('  '+'-'.repeat(78));
for (const dir of ['CALL','PUT']) {
    const base    = all.filter(s=>s.direction===dir&&s.result_120!=null);
    const filtered = base.filter(s=>s.bb_expanding===true && s.ma_gap_trend!=='narrowing');
    const bStat = stat(base, 'result_120','profitLoss_120');
    const fStat = stat(filtered,'result_120','profitLoss_120');
    const line = (label,s) => console.log(`  ${dir} ${label.padEnd(8)}` + [label,s.n,s.wr,'$'+s.pl,s.p,s.k+'%',s.verdict].map(v=>String(v).padEnd(12)).join(''));
    line('baseline', bStat);
    line('+G6+G7  ', fStat);
    console.log('');
}
