'use strict';
// Phase 0 Round 3 — R.2 per-gate significance (train fold only).
//
// For each (gate, direction, expiry) cell on fold=0:
//   wins = SUM(win), n_decisive = COUNT(win)  [flats are NULL → excluded]
//   flats = SUM(flat),  flat_pct = flats/(n_decisive+flats)
//   WR = wins/n_decisive
//   ci_lower = Wilson 95% lower bound
//   p = one-sided binomial (normal approx + continuity correction) vs p0=0.5405
//   BH FDR=0.05 across all cells
//   pass = n_decisive>=100 AND ci_lower>0.5405 AND bh_passed
//
//   node agent/research/phase0_r2.cjs

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/phase0_research.db');
const db = new Database(DB_PATH, { readonly: true });
const log = (m) => console.log(`[r2] ${m}`);

const FLOOR = 0.5405;
const Z = 1.96;
const ALPHA = 0.05;
const EXPIRIES = [5, 10, 15, 20];

// standard normal CDF via erf
function erf(x){
    const t = 1/(1+0.3275911*Math.abs(x));
    const y = 1 - (((((1.061405429*t -1.453152027)*t)+1.421413741)*t -0.284496736)*t +0.254829592)*t*Math.exp(-x*x);
    return x>=0 ? y : -y;
}
const normCdf = (z) => 0.5*(1+erf(z/Math.SQRT2));

function wilson(wins, n){
    if (n===0) return { lo:null, hi:null, wr:null };
    const p = wins/n;
    const d = 1 + Z*Z/n;
    const c = (p + Z*Z/(2*n))/d;
    const m = (Z*Math.sqrt(p*(1-p)/n + Z*Z/(4*n*n)))/d;
    return { lo:c-m, hi:c+m, wr:p };
}

// one-sided upper binomial p-value, H0: WR <= p0
function pValue(wins, n, p0){
    if (n===0) return 1;
    const mean = n*p0, sd = Math.sqrt(n*p0*(1-p0));
    if (sd===0) return 1;
    const z = (wins - mean - 0.5)/sd;   // continuity correction
    return 1 - normCdf(z);
}

const cells = [];
const gates = db.prepare(`SELECT DISTINCT gate, direction FROM backtest_signals`).all();
for (const {gate, direction} of gates){
    for (const exp of EXPIRIES){
        const row = db.prepare(`
            SELECT SUM(win_${exp}m) wins, COUNT(win_${exp}m) n, SUM(flat_${exp}m) flats
            FROM backtest_signals
            WHERE gate=? AND direction=? AND fold=0
        `).get(gate, direction);
        const wins = row.wins||0, n = row.n||0, flats = row.flats||0;
        const w = wilson(wins, n);
        const p = pValue(wins, n, FLOOR);
        const flat_pct = (n+flats)>0 ? flats/(n+flats) : 0;
        cells.push({ gate, direction, expiry:exp, n, wins, losses:n-wins, flats,
            flat_pct, wr:w.wr, ci_lower:w.lo, ci_upper:w.hi, p });
    }
}

// Pre-registered gate (single-test, EXEMPT from BH per prompt): di_oversold_bounce CALL 15m
const isPrereg = (c) => c.gate==='di_oversold_bounce' && c.direction==='CALL' && c.expiry===15;
for (const c of cells) c.prereg = isPrereg(c);

// BH FDR correction across all EXPLORATORY cells (pre-registered cell excluded from the pool)
const valid = cells.filter(c => c.n>0 && !c.prereg).sort((a,b)=>a.p-b.p);
const m = valid.length;
let maxK = 0;
for (let k=1;k<=m;k++){ if (valid[k-1].p <= (k/m)*ALPHA) maxK = k; }
const bhThreshold = maxK>0 ? valid[maxK-1].p : 0;
for (const c of cells){
    c.bh_passed = c.n>0 && !c.prereg && c.p <= bhThreshold;
    c.bh_adj_p = null;
}
// compute adjusted p (step-up)
let prev = 1;
for (let k=m; k>=1; k--){
    const c = valid[k-1];
    const adj = Math.min(prev, c.p * m / k);
    c.bh_adj_p = adj; prev = adj;
}

for (const c of cells){
    c.flags = [];
    if (c.n>0 && c.n<100) c.flags.push('low_n');
    if (c.flat_pct>0.15) c.flags.push('high_flat');
    if (c.ci_lower!=null && c.ci_lower<=FLOOR) c.flags.push('below_floor');
    if (c.prereg) c.flags.push('prereg_single_test');
    else if (!c.bh_passed) c.flags.push('bh_failed');
    // pre-registered cell: single-test (raw p<0.05), exempt from BH; others: BH-corrected
    c.pass = c.prereg
        ? (c.n>=100 && c.ci_lower>FLOOR && c.p<0.05)
        : (c.n>=100 && c.ci_lower>FLOOR && c.bh_passed);
}

// ---- output -----------------------------------------------------------------
const header = 'gate,direction,expiry,n_decisive,wins,losses,flats,flat_pct,wr,ci_lower,ci_upper,p_value,bh_adj_p,bh_passed,pass,flags';
const fmt = (x)=> x==null?'':(typeof x==='number'?x.toFixed(6):x);
const lines = [header];
for (const c of cells.sort((a,b)=> (b.ci_lower||-9)-(a.ci_lower||-9))){
    lines.push([c.gate,c.direction,c.expiry,c.n,c.wins,c.losses,c.flats,
        fmt(c.flat_pct),fmt(c.wr),fmt(c.ci_lower),fmt(c.ci_upper),fmt(c.p),fmt(c.bh_adj_p),
        c.bh_passed,c.pass,'"'+c.flags.join(';')+'"'].join(','));
}
fs.writeFileSync(path.join(__dirname,'phase0_r2_results.csv'), lines.join('\n'));

const survivors = cells.filter(c=>c.pass);
const sHeader = header;
const sLines = [sHeader];
for (const c of survivors) sLines.push([c.gate,c.direction,c.expiry,c.n,c.wins,c.losses,c.flats,
    fmt(c.flat_pct),fmt(c.wr),fmt(c.ci_lower),fmt(c.ci_upper),fmt(c.p),fmt(c.bh_adj_p),
    c.bh_passed,c.pass,'"'+c.flags.join(';')+'"'].join(','));
fs.writeFileSync(path.join(__dirname,'phase0_r2_survivors.csv'), sLines.join('\n'));

log(`cells tested: ${m} (with n>0)`);
log(`BH FDR=0.05 reject threshold p<=${bhThreshold.toExponential(3)} (maxK=${maxK}/${m})`);
log('--- top 15 cells by Wilson CI lower bound ---');
console.log('  '+'gate'.padEnd(22)+'dir'.padEnd(5)+'exp'.padStart(4)+'n'.padStart(7)+'wr'.padStart(8)+'ci_lo'.padStart(8)+'flat%'.padStart(7)+'  bh_adj_p   flags');
for (const c of cells.slice(0,15)){
    console.log('  '+c.gate.padEnd(22)+c.direction.padEnd(5)+String(c.expiry).padStart(4)+
        String(c.n).padStart(7)+(c.wr!=null?(c.wr*100).toFixed(1):'-').padStart(8)+
        (c.ci_lower!=null?(c.ci_lower*100).toFixed(1):'-').padStart(8)+
        (c.flat_pct*100).toFixed(1).padStart(7)+'  '+
        (c.bh_adj_p!=null?c.bh_adj_p.toExponential(2):'-').padEnd(10)+' '+c.flags.join(';'));
}
log('--- SURVIVORS (n>=100 AND ci_lower>0.5405 AND bh_passed) ---');
if (survivors.length===0) log('NONE');
for (const c of survivors){
    const pTag = c.prereg ? `raw_p=${c.p.toExponential(2)} (pre-reg, BH-exempt)` : `bh_adj_p=${c.bh_adj_p.toExponential(2)}`;
    console.log(`  ${c.gate} ${c.direction} ${c.expiry}m | n=${c.n} wins=${c.wins} losses=${c.losses} flats=${c.flats} `+
        `WR=${(c.wr*100).toFixed(2)}% ci=[${(c.ci_lower*100).toFixed(2)},${(c.ci_upper*100).toFixed(2)}] `+
        `flat=${(c.flat_pct*100).toFixed(1)}% ${pTag}`);
}
log(`results → phase0_r2_results.csv | survivors → phase0_r2_survivors.csv`);
db.close();
