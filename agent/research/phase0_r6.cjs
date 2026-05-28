'use strict';
// Phase 0 Round 3 — R.6 per-dimension profiling (EXPLORATORY).
//
// The gate failed R.3 (undersized test fold), so this is NOT validation — it documents
// where the di_oversold_bounce CALL 15m edge concentrates. Pools both folds for max sample.
// Each (dimension_value) cell: WR, Wilson CI, BH-corrected p vs 0.5405.
// Tag: tradable (ci_lower>0.5405 AND n>=30) or excluded.
//
//   node agent/research/phase0_r6.cjs

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/phase0_research.db');
const db = new Database(DB_PATH, { readonly: true });
const log = (m) => console.log(`[r6] ${m}`);

const GATE='di_oversold_bounce', DIR='CALL', EXP=15;
const FLOOR=0.5405, Z=1.96, ALPHA=0.05;

function erf(x){ const t=1/(1+0.3275911*Math.abs(x));
    const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
    return x>=0?y:-y; }
const normCdf=(z)=>0.5*(1+erf(z/Math.SQRT2));
function wilson(w,n){ if(!n) return {lo:null,hi:null,wr:null}; const p=w/n,d=1+Z*Z/n;
    const c=(p+Z*Z/(2*n))/d,m=(Z*Math.sqrt(p*(1-p)/n+Z*Z/(4*n*n)))/d; return {lo:c-m,hi:c+m,wr:p}; }
function pValue(w,n,p0){ if(!n) return 1; const mean=n*p0,sd=Math.sqrt(n*p0*(1-p0)); if(!sd) return 1;
    return 1-normCdf((w-mean-0.5)/sd); }

function cellsFor(dim){
    const rows=db.prepare(`
        SELECT ${dim} v, SUM(win_${EXP}m) wins, COUNT(win_${EXP}m) n, SUM(flat_${EXP}m) flats
        FROM backtest_signals WHERE gate=? AND direction=? AND ${dim} IS NOT NULL
        GROUP BY ${dim} ORDER BY ${dim}`).all(GATE,DIR);
    return rows.map(r=>{ const wins=r.wins||0,n=r.n||0,flats=r.flats||0; const w=wilson(wins,n);
        return {dim, value:r.v, n, wins, losses:n-wins, flats, flat_pct:(n+flats)?flats/(n+flats):0,
            wr:w.wr, ci_lower:w.lo, ci_upper:w.hi, p:pValue(wins,n,FLOOR)}; });
}

let cells=[];
for (const dim of ['asset','session','vol_regime','zone']) cells=cells.concat(cellsFor(dim));

// BH across all cells with n>0
const valid=cells.filter(c=>c.n>0).sort((a,b)=>a.p-b.p);
const m=valid.length; let maxK=0;
for(let k=1;k<=m;k++){ if(valid[k-1].p<=(k/m)*ALPHA) maxK=k; }
const thr=maxK>0?valid[maxK-1].p:0;
let prev=1; for(let k=m;k>=1;k--){ const c=valid[k-1]; c.bh_adj_p=Math.min(prev,c.p*m/k); prev=c.bh_adj_p; }
for(const c of cells){ c.bh_passed=c.n>0&&c.p<=thr;
    c.tradable = (c.ci_lower!=null && c.ci_lower>FLOOR && c.n>=30); }

log(`EXPLORATORY profiling of ${GATE} ${DIR} ${EXP}m (both folds pooled; gate failed R.3 — not validated)`);
log(`BH FDR=0.05 across ${m} cells: reject p<=${thr.toExponential(3)} (maxK=${maxK})`);

const out=['dimension,value,n,wins,losses,flats,flat_pct,wr,ci_lower,ci_upper,p,bh_adj_p,bh_passed,tradable'];
for (const dim of ['asset','session','vol_regime','zone']){
    log(`--- by ${dim} ---`);
    console.log('  '+'value'.padEnd(13)+'n'.padStart(5)+'wins'.padStart(6)+'wr'.padStart(8)+'ci_lo'.padStart(8)+'ci_hi'.padStart(8)+'flat%'.padStart(7)+'  bh_adj_p   tag');
    for (const c of cells.filter(x=>x.dim===dim)){
        out.push([dim,c.value,c.n,c.wins,c.losses,c.flats,c.flat_pct.toFixed(4),
            c.wr?.toFixed(4),c.ci_lower?.toFixed(4),c.ci_upper?.toFixed(4),c.p.toExponential(4),
            c.bh_adj_p?.toExponential(4),c.bh_passed,c.tradable].join(','));
        console.log('  '+String(c.value).padEnd(13)+String(c.n).padStart(5)+String(c.wins).padStart(6)+
            (c.wr!=null?(c.wr*100).toFixed(1):'-').padStart(8)+
            (c.ci_lower!=null?(c.ci_lower*100).toFixed(1):'-').padStart(8)+
            (c.ci_upper!=null?(c.ci_upper*100).toFixed(1):'-').padStart(8)+
            (c.flat_pct*100).toFixed(1).padStart(7)+'  '+
            (c.bh_adj_p!=null?c.bh_adj_p.toExponential(2):'-').padEnd(10)+' '+
            (c.tradable?'TRADABLE':'excluded')+(c.bh_passed?' (BH✓)':''));
    }
}
fs.writeFileSync(path.join(__dirname,'phase0_r6_breakdown.csv'), out.join('\n'));

const tradable=cells.filter(c=>c.tradable);
log(`--- TRADABLE cells (ci_lower>${FLOOR} AND n>=30) ---`);
if(!tradable.length) log('NONE');
for(const c of tradable) console.log(`  ${c.dim}=${c.value}: n=${c.n} WR=${(c.wr*100).toFixed(1)}% ci_lo=${(c.ci_lower*100).toFixed(1)}% bh_adj_p=${c.bh_adj_p.toExponential(2)} ${c.bh_passed?'BH-significant':'(BH-rejected)'}`);
log('output: phase0_r6_breakdown.csv');
db.close();
