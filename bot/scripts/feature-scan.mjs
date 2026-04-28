/**
 * Full feature scan — every computed feature, WIN mean vs LOSS mean.
 * Runs across all 6 historical DBs combined.
 * Shows which features actually separate wins from losses at 120s.
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

function openDb(path){return new Promise((res,rej)=>{const db=new sqlite3.Database(path,sqlite3.OPEN_READONLY,err=>err?rej(err):res(db));});}
function dbAll(db,sql,p=[]){return new Promise((res,rej)=>db.all(sql,p,(err,rows)=>err?rej(err):res(rows||[])));}
function closeDb(db){return new Promise((res,rej)=>db.close(err=>err?rej(err):res()));}

// ── Context ────────────────────────────────────────────────────────────────────
function computeCtx(candles, t) {
    const bar0 = candles[t], barPrev3 = t >= 3 ? candles[t-3] : null, barPrev5 = t >= 5 ? candles[t-5] : null;

    let ma_gap_trend = 'unknown';
    if (bar0.ma1!=null&&bar0.ma3!=null&&barPrev3?.ma1!=null&&barPrev3?.ma3!=null) {
        const gN=bar0.ma1-bar0.ma3, gP=barPrev3.ma1-barPrev3.ma3;
        const d=((gN-gP)/bar0.ma3)*10000;
        ma_gap_trend = Math.abs(d)<1?'flat':d>0?'widening_up':'widening_down';
        if (Math.abs(gP)-Math.abs(gN)>bar0.ma3*0.0001) ma_gap_trend='narrowing';
    }

    let bb_expanding=null;
    if (bar0.bb_upper!=null&&bar0.bb_lower!=null&&bar0.bb_middle!=null&&
        barPrev5?.bb_upper!=null&&barPrev5?.bb_lower!=null&&barPrev5?.bb_middle!=null) {
        bb_expanding=(bar0.bb_upper-bar0.bb_lower)/bar0.bb_middle>(barPrev5.bb_upper-barPrev5.bb_lower)/barPrev5.bb_middle;
    }

    // RSI lookback (10 bars)
    let rsi_peak_10=null, rsi_trough_10=null;
    const rsiHist=[];
    for(let i=Math.max(0,t-10);i<t;i++) if(candles[i].rsi_5!=null) rsiHist.push(candles[i].rsi_5);
    if(rsiHist.length) { rsi_peak_10=Math.max(...rsiHist); rsi_trough_10=Math.min(...rsiHist); }

    // Consecutive K extension bars
    let k_bars_above_65=0, k_bars_below_35=0;
    for(let i=t-1;i>=0;i--){const k=candles[i].stochastic_k_v2;if(k==null)break;if(k>65)k_bars_above_65++;else break;}
    for(let i=t-1;i>=0;i--){const k=candles[i].stochastic_k_v2;if(k==null)break;if(k<35)k_bars_below_35++;else break;}

    return { ma_gap_trend, bb_expanding, rsi_peak_10, rsi_trough_10, k_bars_above_65, k_bars_below_35 };
}

// ── Gates ──────────────────────────────────────────────────────────────────────
function bbBps(b){if(b.bb_upper==null||b.bb_lower==null||b.bb_middle==null)return null;return((b.bb_upper-b.bb_lower)/b.bb_middle)*10000;}
function bbPct(b){if(b.bb_upper==null||b.bb_lower==null||b.close==null)return null;const r=b.bb_upper-b.bb_lower;return r<=0?null:(b.close-b.bb_lower)/r;}
function gatesCall(m1,b0,ctx){const bps=bbBps(b0);return b0.schaff_value<=25&&b0.schaff_value>m1.schaff_value&&b0.rsi_5!=null&&b0.rsi_5<30&&b0.stochastic_k_v2!=null&&b0.stochastic_d_v2!=null&&b0.stochastic_k_v2>b0.stochastic_d_v2&&b0.stochastic_k_v2<50&&bps!=null&&bps>=10&&ctx.bb_expanding!==false&&ctx.ma_gap_trend!=='narrowing';}
function gatesPut(m1,b0,ctx){const bps=bbBps(b0);return b0.schaff_value>=90&&b0.schaff_value<m1.schaff_value&&b0.rsi_5!=null&&b0.rsi_5>70&&b0.stochastic_k_v2!=null&&b0.stochastic_d_v2!=null&&b0.stochastic_k_v2<b0.stochastic_d_v2&&b0.stochastic_k_v2>50&&bps!=null&&bps>=10&&ctx.ma_gap_trend!=='narrowing';}

// ── Expiry ─────────────────────────────────────────────────────────────────────
function findExpiry(list,ts,secs){if(!list?.length)return null;const tgt=ts+secs;let c=null,md=Infinity;for(const p of list){if(p.timestamp<tgt-30)continue;if(p.timestamp>tgt+30)break;const d=Math.abs(p.timestamp-tgt);if(d<md){md=d;c=p.price;}}return c;}
function resolveExit(dir,entry,tick,fbC,fbTs,ts,secs){let e=tick;if(e==null&&fbC!=null&&fbTs!=null&&fbTs<=ts+secs+30)e=fbC;if(e==null)return null;return dir==='CALL'?e>entry:e<entry;}

// ── Per-DB ─────────────────────────────────────────────────────────────────────
async function replayDb(dbPath) {
    let db; try{db=await openDb(dbPath);}catch{return [];}
    const rows = await dbAll(db,`
        SELECT c.asset,c.timestamp,c.open,c.close,c.high,c.low,
               i.rsi_5,i.stochastic_k_v2,i.stochastic_d_v2,
               i.ma1,i.ma3,i.bb_upper,i.bb_middle,i.bb_lower,i.schaff_value
        FROM candles c LEFT JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        ORDER BY c.asset,c.timestamp`);
    const priceRows = await dbAll(db,`SELECT asset,timestamp,price FROM prices ORDER BY asset,timestamp`);
    await closeDb(db);

    const pm={};for(const p of priceRows){if(!pm[p.asset])pm[p.asset]=[];pm[p.asset].push(p);}
    const bm={};for(const r of rows){if(!bm[r.asset])bm[r.asset]=[];bm[r.asset].push(r);}

    const signals=[];
    for(const [asset,candles] of Object.entries(bm)) {
        const pl=pm[asset]||null;
        for(let t=1;t<candles.length;t++) {
            const m1=candles[t-1],b0=candles[t];
            if(b0.schaff_value==null||m1.schaff_value==null)continue;
            const ctx=computeCtx(candles,t);
            const tick120=findExpiry(pl,b0.timestamp,120);
            const bar2=candles[t+2];
            const win120=resolveExit('CALL',b0.close,tick120,bar2?.close,bar2?.timestamp,b0.timestamp,120); // placeholder

            for(const [dir,pass] of [['CALL',gatesCall(m1,b0,ctx)],['PUT',gatesPut(m1,b0,ctx)]]) {
                if(!pass)continue;
                const t120=findExpiry(pl,b0.timestamp,120);
                const b2=candles[t+2];
                const w=resolveExit(dir,b0.close,t120,b2?.close,b2?.timestamp,b0.timestamp,120);
                if(w==null)continue;

                const bps=bbBps(b0);
                const pct=bbPct(b0);
                const stcDelta=b0.schaff_value-m1.schaff_value;
                const kdSpread=b0.stochastic_k_v2!=null&&b0.stochastic_d_v2!=null?Math.abs(b0.stochastic_k_v2-b0.stochastic_d_v2):null;
                // Candle body: positive = bullish (close > open), as fraction of range
                const hi=b0.high??b0.close, lo=b0.low??b0.open??b0.close;
                const range=hi-lo;
                const bodyDir=b0.close-b0.open; // positive=bullish, negative=bearish
                const bodyPct=range>0?Math.abs(bodyDir)/range:null; // body size as % of candle range
                const bullishCandle=bodyDir>0;

                signals.push({
                    direction:dir, result:w?'WIN':'LOSS',
                    // Gate inputs
                    stcValue:b0.schaff_value, stcPrev:m1.schaff_value, stcDelta,
                    rsi:b0.rsi_5,
                    k:b0.stochastic_k_v2, d:b0.stochastic_d_v2, kdSpread,
                    bbBps:bps, bbPct:pct, bb_expanding:ctx.bb_expanding,
                    maTrendBps:b0.ma1!=null&&b0.ma3!=null?((b0.ma1-b0.ma3)/b0.ma3)*10000:null,
                    ma_gap_trend:ctx.ma_gap_trend,
                    // Candle structure
                    bodyDir, bodyPct, bullishCandle,
                    // Lookback
                    rsi_peak_10:ctx.rsi_peak_10, rsi_trough_10:ctx.rsi_trough_10,
                    k_bars_above_65:ctx.k_bars_above_65, k_bars_below_35:ctx.k_bars_below_35,
                    // Time
                    hour: Math.floor((b0.timestamp%86400)/3600),
                    asset,
                });
            }
        }
    }
    return signals;
}

// ── Collect ────────────────────────────────────────────────────────────────────
const all=[];
for(const ds of DATASETS){all.push(...await replayDb(ds.path));}
const calls=all.filter(s=>s.direction==='CALL');
const puts =all.filter(s=>s.direction==='PUT');
console.log(`\nTotal validated: ${all.length}  (CALL ${calls.length} / PUT ${puts.length})\n`);

// ── Feature scan helper ────────────────────────────────────────────────────────
function scan(sigs, features) {
    const wins =sigs.filter(s=>s.result==='WIN');
    const losses=sigs.filter(s=>s.result==='LOSS');
    const mean=(arr,f)=>{const v=arr.map(s=>s[f]).filter(x=>x!=null);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
    const fmt=v=>v==null?'  N/A ':v.toFixed(3).padStart(7);

    console.log(`  ${'Feature'.padEnd(22)} ${'WIN mean'.padStart(9)}  ${'LOSS mean'.padStart(9)}  ${'delta'.padStart(8)}  note`);
    console.log('  '+'-'.repeat(72));
    for(const f of features) {
        const wm=mean(wins,f), lm=mean(losses,f);
        const delta=wm!=null&&lm!=null?wm-lm:null;
        const note=delta==null?'':Math.abs(delta)<0.001?'≈same':(delta>0?'↑ wins higher':'↓ wins lower');
        console.log(`  ${f.padEnd(22)} ${fmt(wm)}   ${fmt(lm)}   ${fmt(delta)}  ${note}`);
    }
}

// ── Boolean feature scan ───────────────────────────────────────────────────────
function scanBool(sigs, features) {
    const fmt2=(w,n)=>n===0?'N/A':`${(w/n*100).toFixed(0)}% (${n})`;
    console.log(`  ${'Feature'.padEnd(22)} ${'TRUE wr'.padStart(12)}  ${'FALSE wr'.padStart(12)}  ${'null wr'.padStart(12)}`);
    console.log('  '+'-'.repeat(64));
    for(const f of features) {
        const t=sigs.filter(s=>s[f]===true), tt=t.filter(s=>s.result==='WIN').length;
        const fa=sigs.filter(s=>s[f]===false), ff=fa.filter(s=>s.result==='WIN').length;
        const nu=sigs.filter(s=>s[f]==null), nn=nu.filter(s=>s.result==='WIN').length;
        console.log(`  ${f.padEnd(22)} ${fmt2(tt,t.length).padStart(12)}  ${fmt2(ff,fa.length).padStart(12)}  ${fmt2(nn,nu.length).padStart(12)}`);
    }
}

// ── Categorical scan ───────────────────────────────────────────────────────────
function scanCat(sigs, field) {
    const cats={};
    for(const s of sigs){const c=s[field]??'null';if(!cats[c])cats[c]={w:0,n:0};cats[c].n++;if(s.result==='WIN')cats[c].w++;}
    console.log(`  ${'Value'.padEnd(20)} ${'WR'.padStart(8)}  n`);
    console.log('  '+'-'.repeat(36));
    for(const [cat,d] of Object.entries(cats).sort((a,b)=>b[1].n-a[1].n))
        console.log(`  ${cat.padEnd(20)} ${(d.n?d.w/d.n*100:0).toFixed(0).padStart(6)}%  ${d.n}`);
}

// ── Hour scan ─────────────────────────────────────────────────────────────────
function scanHour(sigs) {
    const hrs={};
    for(const s of sigs){if(!hrs[s.hour])hrs[s.hour]={w:0,n:0};hrs[s.hour].n++;if(s.result==='WIN')hrs[s.hour].w++;}
    console.log(`  ${'Hour UTC'.padEnd(10)} ${'WR'.padStart(8)}  n`);
    console.log('  '+'-'.repeat(26));
    for(const [h,d] of Object.entries(hrs).sort((a,b)=>+a[0]-+b[0]))
        console.log(`  ${String(h).padEnd(10)} ${(d.w/d.n*100).toFixed(0).padStart(6)}%  ${d.n}`);
}

const NUM_FEATURES = ['stcValue','stcPrev','stcDelta','rsi','k','d','kdSpread','bbBps','bbPct','maTrendBps','bodyDir','bodyPct','rsi_peak_10','rsi_trough_10','k_bars_above_65','k_bars_below_35'];
const BOOL_FEATURES = ['bb_expanding','bullishCandle'];

for(const [label,sigs] of [['CALL',calls],['PUT',puts]]) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${label} — numeric features (WIN mean vs LOSS mean, 120s)`);
    console.log('═'.repeat(80));
    scan(sigs, NUM_FEATURES);

    console.log(`\n  ${label} — boolean features`);
    scanBool(sigs, BOOL_FEATURES);

    console.log(`\n  ${label} — ma_gap_trend`);
    scanCat(sigs, 'ma_gap_trend');

    console.log(`\n  ${label} — hour of day`);
    scanHour(sigs);
}

// ── Top discriminating features ───────────────────────────────────────────────
console.log('\n\n=== STRONGEST DISCRIMINATORS (|delta| rank) ===\n');
for(const [label,sigs] of [['CALL',calls],['PUT',puts]]) {
    const wins=sigs.filter(s=>s.result==='WIN'), losses=sigs.filter(s=>s.result==='LOSS');
    const mean=(arr,f)=>{const v=arr.map(s=>s[f]).filter(x=>x!=null);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
    const rows=NUM_FEATURES.map(f=>{const wm=mean(wins,f),lm=mean(losses,f);return{f,wm,lm,delta:wm!=null&&lm!=null?Math.abs(wm-lm):null};})
        .filter(r=>r.delta!=null).sort((a,b)=>b.delta-a.delta);
    console.log(`  ${label}:`);
    for(const r of rows.slice(0,8))
        console.log(`    ${r.f.padEnd(22)} |delta|=${r.delta.toFixed(4).padStart(8)}  win=${r.wm?.toFixed(3)}  loss=${r.lm?.toFixed(3)}`);
    console.log();
}
