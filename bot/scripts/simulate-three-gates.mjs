/**
 * Validate three new gate candidates against baseline (120s expiry):
 *
 *   G_BULL  — bullishCandle: close > open at signal bar
 *             CALL: confirms price bouncing up at floor
 *             PUT:  confirms price still being pushed up before rollover
 *
 *   G_BB    — directional BB width split
 *             CALL: bbBps >= 30  (wins avg 288 vs losses 190 — wider is better)
 *             PUT:  bbBps <= 100 (wins avg 71 vs losses 106 — lower is better)
 *
 *   G_PUT_MA — PUT only: reject ma_gap_trend === 'widening_up'
 *              (widening_up PUT WR = 29% vs flat 63%)
 *
 * Tests: baseline, each gate solo, all three combined — CALL/PUT/ALL.
 */

import sqlite3pkg from 'sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, '../../data');

const DATASETS = [
    { path: `${DATA}/trading_data_v1.db`       },
    { path: `${DATA}/trading_data_v2_13-15.db` },
    { path: `${DATA}/trading_data_V3_17.db`    },
    { path: `${DATA}/trading_data-V4_18.db`    },
    { path: `${DATA}/trading_data-V5_25.db`    },
    { path: `${DATA}/trading_data.db`          },
];
const AMOUNT = 500, PAYOUT = 0.92;

// ── SQLite ─────────────────────────────────────────────────────────────────────
function openDb(p){return new Promise((res,rej)=>{const db=new sqlite3.Database(p,sqlite3.OPEN_READONLY,err=>err?rej(err):res(db));});}
function dbAll(db,sql,p=[]){return new Promise((res,rej)=>db.all(sql,p,(err,rows)=>err?rej(err):res(rows||[])));}
function closeDb(db){return new Promise((res,rej)=>db.close(err=>err?rej(err):res()));}

// ── Stats ──────────────────────────────────────────────────────────────────────
function normalCDF(z){const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;const sign=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);return 0.5*(1+sign*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));}
function logFact(n){let s=0;for(let i=2;i<=n;i++)s+=Math.log(i);return s;}
function logBinom(n,k){return logFact(n)-logFact(k)-logFact(n-k);}
function binomP(w,n,p0=0.5){if(n===0||w/n<=p0)return 1;if(n>120)return Math.max(0,1-normalCDF((w/n-p0)/Math.sqrt(p0*(1-p0)/n)));let pv=0;const lp=Math.log(p0),lq=Math.log(1-p0);for(let k=w;k<=n;k++)pv+=Math.exp(logBinom(n,k)+k*lp+(n-k)*lq);return Math.min(1,pv);}
function wilsonCI(w,n){if(n===0)return 'N/A';const z=1.96,p=w/n,z2=z*z,c=(p+z2/(2*n))/(1+z2/n),m=(z/(1+z2/n))*Math.sqrt(p*(1-p)/n+z2/(4*n*n));return`[${(Math.max(0,c-m)*100).toFixed(0)}%,${(Math.min(1,c+m)*100).toFixed(0)}%]`;}
function sigMark(p){return p<0.01?'***':p<0.05?'** ':p<0.10?'*  ':'   ';}

// ── Context ────────────────────────────────────────────────────────────────────
function computeCtx(candles, t) {
    const b=candles[t], p3=t>=3?candles[t-3]:null, p5=t>=5?candles[t-5]:null;
    let ma_gap_trend='unknown';
    if(b.ma1!=null&&b.ma3!=null&&p3?.ma1!=null&&p3?.ma3!=null){
        const gN=b.ma1-b.ma3,gP=p3.ma1-p3.ma3,d=((gN-gP)/b.ma3)*10000;
        ma_gap_trend=Math.abs(d)<1?'flat':d>0?'widening_up':'widening_down';
        if(Math.abs(gP)-Math.abs(gN)>b.ma3*0.0001)ma_gap_trend='narrowing';
    }
    let bb_expanding=null;
    if(b.bb_upper!=null&&b.bb_lower!=null&&b.bb_middle!=null&&p5?.bb_upper!=null&&p5?.bb_lower!=null&&p5?.bb_middle!=null)
        bb_expanding=(b.bb_upper-b.bb_lower)/b.bb_middle>(p5.bb_upper-p5.bb_lower)/p5.bb_middle;
    return{ma_gap_trend,bb_expanding};
}

// ── Gates ──────────────────────────────────────────────────────────────────────
function getBbBps(b){if(b.bb_upper==null||b.bb_lower==null||b.bb_middle==null)return null;return((b.bb_upper-b.bb_lower)/b.bb_middle)*10000;}

function gatesCall(m1,b0,ctx){
    const bps=getBbBps(b0);
    return b0.schaff_value<=25&&b0.schaff_value>m1.schaff_value&&
        b0.rsi_5!=null&&b0.rsi_5<30&&
        b0.stochastic_k_v2!=null&&b0.stochastic_d_v2!=null&&
        b0.stochastic_k_v2>b0.stochastic_d_v2&&b0.stochastic_k_v2<50&&
        bps!=null&&bps>=10&&ctx.bb_expanding!==false&&ctx.ma_gap_trend!=='narrowing';
}
function gatesPut(m1,b0,ctx){
    const bps=getBbBps(b0);
    return b0.schaff_value>=90&&b0.schaff_value<m1.schaff_value&&
        b0.rsi_5!=null&&b0.rsi_5>70&&
        b0.stochastic_k_v2!=null&&b0.stochastic_d_v2!=null&&
        b0.stochastic_k_v2<b0.stochastic_d_v2&&b0.stochastic_k_v2>50&&
        bps!=null&&bps>=10&&ctx.ma_gap_trend!=='narrowing';
}

// ── Expiry ─────────────────────────────────────────────────────────────────────
function findExpiry(list,ts,secs){if(!list?.length)return null;const tgt=ts+secs;let c=null,md=Infinity;for(const p of list){if(p.timestamp<tgt-30)continue;if(p.timestamp>tgt+30)break;const d=Math.abs(p.timestamp-tgt);if(d<md){md=d;c=p.price;}}return c;}
function resolveExit(dir,entry,tick,fbC,fbTs,ts,secs){let e=tick;if(e==null&&fbC!=null&&fbTs!=null&&fbTs<=ts+secs+30)e=fbC;if(e==null)return null;return dir==='CALL'?e>entry:e<entry;}

// ── Per-DB replay ──────────────────────────────────────────────────────────────
async function replayDb(dbPath) {
    let db; try{db=await openDb(dbPath);}catch{return[];}
    const rows=await dbAll(db,`
        SELECT c.asset,c.timestamp,c.open,c.close,c.high,c.low,
               i.rsi_5,i.stochastic_k_v2,i.stochastic_d_v2,
               i.ma1,i.ma3,i.bb_upper,i.bb_middle,i.bb_lower,i.schaff_value
        FROM candles c LEFT JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        ORDER BY c.asset,c.timestamp`);
    const priceRows=await dbAll(db,`SELECT asset,timestamp,price FROM prices ORDER BY asset,timestamp`);
    await closeDb(db);

    const pm={};for(const p of priceRows){if(!pm[p.asset])pm[p.asset]=[];pm[p.asset].push(p);}
    const bm={};for(const r of rows){if(!bm[r.asset])bm[r.asset]=[];bm[r.asset].push(r);}

    const signals=[];
    for(const [asset,candles] of Object.entries(bm)){
        const pl=pm[asset]||null;
        for(let t=1;t<candles.length;t++){
            const m1=candles[t-1],b0=candles[t];
            if(b0.schaff_value==null||m1.schaff_value==null)continue;
            const ctx=computeCtx(candles,t);

            for(const [dir,pass] of [['CALL',gatesCall(m1,b0,ctx)],['PUT',gatesPut(m1,b0,ctx)]]){
                if(!pass)continue;
                const tick=findExpiry(pl,b0.timestamp,120);
                const b2=candles[t+2];
                const win=resolveExit(dir,b0.close,tick,b2?.close,b2?.timestamp,b0.timestamp,120);
                if(win==null)continue;

                const bps=getBbBps(b0);
                const bullishCandle=b0.close>b0.open;
                signals.push({
                    direction:dir,
                    result:win?'WIN':'LOSS',
                    bbBps:bps,
                    bullishCandle,
                    ma_gap_trend:ctx.ma_gap_trend,
                });
            }
        }
    }
    return signals;
}

// ── Collect ────────────────────────────────────────────────────────────────────
const all=[];
for(const ds of DATASETS) all.push(...await replayDb(ds.path));
console.log(`\nTotal validated signals: ${all.length}  (CALL ${all.filter(s=>s.direction==='CALL').length} / PUT ${all.filter(s=>s.direction==='PUT').length})\n`);

// ── Report row ─────────────────────────────────────────────────────────────────
function row(label, sigs, baseline_wr=null) {
    const n=sigs.length;
    if(n===0) return `  ${label.padEnd(32)} n=  0  —`;
    const w=sigs.filter(s=>s.result==='WIN').length;
    const wr=(w/n*100);
    const p=binomP(w,n);
    const pl=Math.round(w*AMOUNT*PAYOUT-(n-w)*AMOUNT);
    const delta=baseline_wr!=null?` Δ${(wr-baseline_wr>0?'+':'')}${(wr-baseline_wr).toFixed(1)}%`:'';
    const rejected=baseline_wr!=null?`  -${(all.filter(s=>s.direction===sigs[0]?.direction||true).length - n)} removed`:'';
    return `  ${label.padEnd(32)} n=${String(n).padStart(3)}  wr=${(wr.toFixed(1)+'%').padEnd(7)}  pl=${('$'+pl).padStart(8)}  ci=${wilsonCI(w,n).padEnd(14)}  p=${p.toFixed(4)} ${sigMark(p)}${delta}`;
}

// ── Define scenarios ───────────────────────────────────────────────────────────
// G_BULL: close > open
// G_BB_CALL: bbBps >= 30
// G_BB_PUT:  bbBps <= 100
// G_PUT_MA:  ma_gap_trend !== 'widening_up'

const scenarios = {
    CALL: [
        { label: 'A  Baseline',                  f: ()=>true },
        { label: 'B  +G_BULL (close>open)',       f: s=>s.bullishCandle },
        { label: 'C  +G_BB   (bbBps>=30)',        f: s=>s.bbBps>=30 },
        { label: 'D  +G_BB   (bbBps>=50)',        f: s=>s.bbBps>=50 },
        { label: 'E  +G_BULL +G_BB>=30',          f: s=>s.bullishCandle&&s.bbBps>=30 },
        { label: 'F  +G_BULL +G_BB>=50',          f: s=>s.bullishCandle&&s.bbBps>=50 },
    ],
    PUT: [
        { label: 'A  Baseline',                  f: ()=>true },
        { label: 'B  +G_BULL (close>open)',       f: s=>s.bullishCandle },
        { label: 'C  +G_BB   (bbBps<=100)',       f: s=>s.bbBps<=100 },
        { label: 'D  +G_BB   (bbBps<=80)',        f: s=>s.bbBps<=80 },
        { label: 'E  +G_PUT_MA (no widening_up)', f: s=>s.ma_gap_trend!=='widening_up' },
        { label: 'F  +G_BULL +G_BB<=100',         f: s=>s.bullishCandle&&s.bbBps<=100 },
        { label: 'G  +G_BULL +G_PUT_MA',          f: s=>s.bullishCandle&&s.ma_gap_trend!=='widening_up' },
        { label: 'H  +G_BB<=100 +G_PUT_MA',       f: s=>s.bbBps<=100&&s.ma_gap_trend!=='widening_up' },
        { label: 'I  +ALL THREE',                 f: s=>s.bullishCandle&&s.bbBps<=100&&s.ma_gap_trend!=='widening_up' },
    ],
};

// ── Print ──────────────────────────────────────────────────────────────────────
for(const dir of ['CALL','PUT']){
    const base=all.filter(s=>s.direction===dir);
    const baseWR=base.length?base.filter(s=>s.result==='WIN').length/base.length*100:0;
    console.log(`\n${'═'.repeat(90)}`);
    console.log(`  ${dir} — 120s expiry   (baseline n=${base.length} wr=${baseWR.toFixed(1)}%)`);
    console.log('═'.repeat(90));
    console.log(`  ${'Scenario'.padEnd(32)} ${'n'.padStart(4)}  ${'WR'.padEnd(7)}  ${'P/L'.padEnd(9)}  ${'CI 95%'.padEnd(14)}  ${'p-val'}  sig  delta`);
    console.log('  '+'-'.repeat(86));
    for(const sc of scenarios[dir]){
        const sigs=base.filter(sc.f);
        const bwr=sc.label.startsWith('A')?null:baseWR;
        console.log(row(sc.label,sigs,bwr));
    }
}

// ── ALL combined (best scenario per direction) ─────────────────────────────────
console.log(`\n${'═'.repeat(90)}`);
console.log('  ALL SIGNALS combined — best scenario vs baseline');
console.log('═'.repeat(90));

const bestCall = all.filter(s=>s.direction==='CALL'&&s.bullishCandle&&s.bbBps>=30);
const bestPut  = all.filter(s=>s.direction==='PUT' &&s.bullishCandle&&s.bbBps<=100&&s.ma_gap_trend!=='widening_up');
const baseAll  = all;
const bestAll  = [...bestCall,...bestPut];

for(const [label,sigs] of [['Baseline (all)',baseAll],['Best CALL (E) + PUT (I)',bestAll]]){
    const n=sigs.length,w=sigs.filter(s=>s.result==='WIN').length;
    const p=binomP(w,n);
    const pl=Math.round(w*AMOUNT*PAYOUT-(n-w)*AMOUNT);
    console.log(`  ${label.padEnd(32)} n=${String(n).padStart(3)}  wr=${(w/n*100).toFixed(1).padEnd(6)}%  pl=$${String(pl).padStart(7)}  ci=${wilsonCI(w,n).padEnd(14)}  p=${p.toFixed(4)} ${sigMark(p)}`);
}

// ── Gate rejection counts ──────────────────────────────────────────────────────
console.log('\n\n=== GATE REJECTION COUNTS ===');
const callBase=all.filter(s=>s.direction==='CALL');
const putBase =all.filter(s=>s.direction==='PUT');
console.log(`\n  CALL baseline: ${callBase.length}`);
console.log(`  Removed by G_BULL (bearish candle)      : ${callBase.filter(s=>!s.bullishCandle).length}`);
console.log(`  Removed by G_BB>=30                     : ${callBase.filter(s=>s.bbBps<30).length}`);
console.log(`  Removed by G_BB>=50                     : ${callBase.filter(s=>s.bbBps<50).length}`);
console.log(`  Remaining after G_BULL+G_BB>=30         : ${callBase.filter(s=>s.bullishCandle&&s.bbBps>=30).length}`);

console.log(`\n  PUT baseline: ${putBase.length}`);
console.log(`  Removed by G_BULL (bearish candle)      : ${putBase.filter(s=>!s.bullishCandle).length}`);
console.log(`  Removed by G_BB<=100                    : ${putBase.filter(s=>s.bbBps>100).length}`);
console.log(`  Removed by G_BB<=80                     : ${putBase.filter(s=>s.bbBps>80).length}`);
console.log(`  Removed by G_PUT_MA (widening_up)       : ${putBase.filter(s=>s.ma_gap_trend==='widening_up').length}`);
console.log(`  Remaining after G_BULL+G_BB<=100+G_PUT_MA: ${putBase.filter(s=>s.bullishCandle&&s.bbBps<=100&&s.ma_gap_trend!=='widening_up').length}`);

// ── bbBps sweep for PUT ────────────────────────────────────────────────────────
console.log('\n\n=== PUT bbBps CAP SWEEP (find optimal upper limit) ===');
console.log(`  ${'Cap'.padEnd(16)} ${'n'.padStart(4)}  ${'WR'.padEnd(8)}  ${'CI'.padEnd(14)}  p-val  sig`);
console.log('  '+'-'.repeat(56));
for(const cap of [60,70,80,90,100,120,150,200,999]){
    const sigs=putBase.filter(s=>s.bbBps<=cap);
    const n=sigs.length,w=sigs.filter(s=>s.result==='WIN').length;
    const p=binomP(w,n);
    const label=cap===999?'no cap':(`bbBps <= ${cap}`);
    console.log(`  ${label.padEnd(16)} ${String(n).padStart(4)}  ${(w/n*100).toFixed(1).padEnd(7)}%  ${wilsonCI(w,n).padEnd(14)}  ${p.toFixed(4)} ${sigMark(p)}`);
}

// ── bbBps floor sweep for CALL ─────────────────────────────────────────────────
console.log('\n\n=== CALL bbBps FLOOR SWEEP (find optimal minimum) ===');
console.log(`  ${'Floor'.padEnd(16)} ${'n'.padStart(4)}  ${'WR'.padEnd(8)}  ${'CI'.padEnd(14)}  p-val  sig`);
console.log('  '+'-'.repeat(56));
for(const floor of [10,20,30,40,50,75,100,150]){
    const sigs=callBase.filter(s=>s.bbBps>=floor);
    const n=sigs.length,w=sigs.filter(s=>s.result==='WIN').length;
    const p=binomP(w,n);
    console.log(`  ${('bbBps >= '+floor).padEnd(16)} ${String(n).padStart(4)}  ${(w/n*100).toFixed(1).padEnd(7)}%  ${wilsonCI(w,n).padEnd(14)}  ${p.toFixed(4)} ${sigMark(p)}`);
}
