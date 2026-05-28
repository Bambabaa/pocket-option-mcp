'use strict';
// Phase 0 Round 3 — R.3 walk-forward validation of R.2 survivor(s).
//
// Survivor: di_oversold_bounce CALL 15m (pre-registered, single-test, BH-exempt).
// Re-test on test fold (fold=1) under same 3-class labelling. No re-tuning.
//
// Pre-checks: (1) entry_close matches candle close, (2) exit from a different bar,
//             (3) 3-bar independence holds, (4) fold chronology (train ts < test ts per asset).
// Pass: test ci_lower > 0.5405 AND |train_WR - test_WR| <= 5pp.
//
//   node agent/research/phase0_r3.cjs

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/phase0_research.db');
const db = new Database(DB_PATH, { readonly: true });
const log = (m) => console.log(`[r3] ${m}`);

const FLOOR = 0.5405, Z = 1.96;
const SURVIVORS = [{ gate: 'di_oversold_bounce', dir: 'CALL', expiry: 15, prereg: true }];

function erf(x){ const t=1/(1+0.3275911*Math.abs(x));
    const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
    return x>=0?y:-y; }
const normCdf = (z)=>0.5*(1+erf(z/Math.SQRT2));
function wilson(w,n){ if(!n) return {lo:null,hi:null,wr:null}; const p=w/n,d=1+Z*Z/n;
    const c=(p+Z*Z/(2*n))/d, m=(Z*Math.sqrt(p*(1-p)/n+Z*Z/(4*n*n)))/d; return {lo:c-m,hi:c+m,wr:p}; }
function pValue(w,n,p0){ if(!n) return 1; const mean=n*p0,sd=Math.sqrt(n*p0*(1-p0)); if(!sd) return 1;
    return 1-normCdf((w-mean-0.5)/sd); }

// ---- pre-checks (run once on the survivor's test-fold rows) ------------------
function preChecks(gate, dir){
    const out = [];
    // (1) entry_close matches candle close
    const m1 = db.prepare(`
        SELECT COUNT(*) n FROM backtest_signals s JOIN candles c
          ON c.asset=s.asset AND c.timestamp=s.timestamp
        WHERE s.gate=? AND s.direction=? AND s.fold=1
          AND ABS(s.entry_close - c.close) > 1e-9`).get(gate,dir).n;
    out.push(['entry_close matches candle close', m1, m1===0]);
    // (2) exit_15m from a DIFFERENT bar (ts+900s) — value may equal (real flat) but row must exist
    const m2 = db.prepare(`
        SELECT COUNT(*) n FROM backtest_signals s
        LEFT JOIN candles c ON c.asset=s.asset AND c.timestamp=s.timestamp+900
        WHERE s.gate=? AND s.direction=? AND s.fold=1 AND s.exit_15m IS NOT NULL
          AND (c.close IS NULL OR ABS(s.exit_15m - c.close) > 1e-9)`).get(gate,dir).n;
    out.push(['exit_15m sourced from t+900s bar', m2, m2===0]);
    // (3) 3-bar independence: min gap >= 900s between consecutive same-gate signals per asset
    const sigs = db.prepare(`
        SELECT asset, timestamp FROM backtest_signals
        WHERE gate=? AND direction=? ORDER BY asset, timestamp`).all(gate,dir);
    let viol=0, minGap=Infinity, prevA=null, prevT=null;
    for (const s of sigs){
        if (s.asset===prevA){ const g=s.timestamp-prevT; if(g<minGap)minGap=g; if(g<900)viol++; }
        prevA=s.asset; prevT=s.timestamp;
    }
    out.push([`3-bar independence (min gap ${isFinite(minGap)?minGap:'n/a'}s)`, viol, viol===0]);
    // (4) fold chronology per asset: max(train ts) < min(test ts)
    const chrono = db.prepare(`
        SELECT s.asset,
               MAX(CASE WHEN fold=0 THEN timestamp END) tr,
               MIN(CASE WHEN fold=1 THEN timestamp END) te
        FROM backtest_signals s WHERE gate=? AND direction=? GROUP BY s.asset`).all(gate,dir);
    let cviol=0;
    for (const r of chrono){ if (r.tr!=null && r.te!=null && r.tr>=r.te) cviol++; }
    out.push(['fold chronology (train ts < test ts)', cviol, cviol===0]);
    return out;
}

function foldStats(gate,dir,exp,fold){
    const r = db.prepare(`
        SELECT SUM(win_${exp}m) wins, COUNT(win_${exp}m) n, SUM(flat_${exp}m) flats
        FROM backtest_signals WHERE gate=? AND direction=? AND fold=?`).get(gate,dir,fold);
    const wins=r.wins||0, n=r.n||0, flats=r.flats||0;
    const w=wilson(wins,n);
    return { n, wins, losses:n-wins, flats, wr:w.wr, ci_lower:w.lo, ci_upper:w.hi, p:pValue(wins,n,FLOOR) };
}

for (const s of SURVIVORS){
    log(`===== ${s.gate} ${s.dir} ${s.expiry}m ${s.prereg?'(pre-registered, single-test)':''} =====`);

    log('--- pre-checks ---');
    let pcFail=0;
    for (const [name,val,ok] of preChecks(s.gate,s.dir)){ if(!ok)pcFail++;
        console.log(`  [${ok?'PASS':'FAIL'}] ${name.padEnd(42)} violations=${val}`); }

    const tr = foldStats(s.gate,s.dir,s.expiry,0);
    const te = foldStats(s.gate,s.dir,s.expiry,1);
    const delta = (tr.wr!=null && te.wr!=null) ? (tr.wr-te.wr)*100 : null;

    log('--- fold metrics ---');
    console.log('  fold   n   wins loss flat    WR     ci_lower ci_upper   p');
    for (const [lbl,f] of [['train',tr],['test ',te]]){
        console.log(`  ${lbl}  ${String(f.n).padStart(4)} ${String(f.wins).padStart(4)} `+
            `${String(f.losses).padStart(4)} ${String(f.flats).padStart(4)}  `+
            `${f.wr!=null?(f.wr*100).toFixed(2):'-'}%  `+
            `${f.ci_lower!=null?(f.ci_lower*100).toFixed(2):'-'}%  `+
            `${f.ci_upper!=null?(f.ci_upper*100).toFixed(2):'-'}%  `+
            `${f.p.toExponential(2)}`);
    }
    log(`train→test WR delta: ${delta!=null?delta.toFixed(2)+'pp':'n/a'} (tolerance 5pp)`);

    // per-asset and per-session breakdown (both folds)
    log('--- per-asset (train | test) ---');
    const assets = db.prepare(`SELECT DISTINCT asset FROM backtest_signals WHERE gate=? AND direction=? ORDER BY asset`).all(s.gate,s.dir).map(r=>r.asset);
    const abLines=['asset,train_n,train_wins,train_wr,test_n,test_wins,test_wr'];
    for (const a of assets){
        const t0=db.prepare(`SELECT SUM(win_${s.expiry}m) w,COUNT(win_${s.expiry}m) n FROM backtest_signals WHERE gate=? AND direction=? AND fold=0 AND asset=?`).get(s.gate,s.dir,a);
        const t1=db.prepare(`SELECT SUM(win_${s.expiry}m) w,COUNT(win_${s.expiry}m) n FROM backtest_signals WHERE gate=? AND direction=? AND fold=1 AND asset=?`).get(s.gate,s.dir,a);
        const w0=t0.w||0,n0=t0.n||0,w1=t1.w||0,n1=t1.n||0;
        abLines.push(`${a},${n0},${w0},${n0?(w0/n0).toFixed(4):''},${n1},${w1},${n1?(w1/n1).toFixed(4):''}`);
        console.log(`  ${a.padEnd(10)} train ${String(w0)+'/'+n0} (${n0?(w0/n0*100).toFixed(0):'-'}%)   test ${w1+'/'+n1} (${n1?(w1/n1*100).toFixed(0):'-'}%)`);
    }
    fs.writeFileSync(path.join(__dirname,'phase0_r3_asset_breakdown.csv'), abLines.join('\n'));

    log('--- per-session (train | test) ---');
    const sbLines=['session,train_n,train_wr,test_n,test_wr'];
    for (const sess of ['Asian','European','American','Off-hours']){
        const t0=db.prepare(`SELECT SUM(win_${s.expiry}m) w,COUNT(win_${s.expiry}m) n FROM backtest_signals WHERE gate=? AND direction=? AND fold=0 AND session=?`).get(s.gate,s.dir,sess);
        const t1=db.prepare(`SELECT SUM(win_${s.expiry}m) w,COUNT(win_${s.expiry}m) n FROM backtest_signals WHERE gate=? AND direction=? AND fold=1 AND session=?`).get(s.gate,s.dir,sess);
        const w0=t0.w||0,n0=t0.n||0,w1=t1.w||0,n1=t1.n||0;
        if(n0+n1===0) continue;
        sbLines.push(`${sess},${n0},${n0?(w0/n0).toFixed(4):''},${n1},${n1?(w1/n1).toFixed(4):''}`);
        console.log(`  ${sess.padEnd(10)} train ${w0}/${n0} (${n0?(w0/n0*100).toFixed(0):'-'}%)   test ${w1}/${n1} (${n1?(w1/n1*100).toFixed(0):'-'}%)`);
    }
    fs.writeFileSync(path.join(__dirname,'phase0_r3_session_breakdown.csv'), sbLines.join('\n'));

    // verdict
    let verdict;
    const consistent = delta!=null && Math.abs(delta)<=5;
    const clears = te.ci_lower!=null && te.ci_lower>FLOOR;
    const passP = s.prereg ? te.p<0.05 : true;
    if (pcFail>0) verdict='LEAKAGE_SUSPECTED (pre-check failed)';
    else if (clears && consistent && passP) verdict='PASS';
    else if (clears && !consistent) verdict='PARTIAL (clears floor but delta>5pp)';
    else if (!clears && consistent) verdict='OVERFIT (consistent WR but test CI below floor)';
    else verdict='FAIL';

    log(`>>> r3_verdict: ${verdict}`);
    const resLines=['gate,direction,expiry,train_n,train_wr,train_ci_lower,test_n,test_wr,test_ci_lower,test_p,delta_pp,verdict'];
    resLines.push([s.gate,s.dir,s.expiry,tr.n,tr.wr?.toFixed(4),tr.ci_lower?.toFixed(4),
        te.n,te.wr?.toFixed(4),te.ci_lower?.toFixed(4),te.p.toExponential(3),delta?.toFixed(2),verdict].join(','));
    fs.writeFileSync(path.join(__dirname,'phase0_r3_results.csv'), resLines.join('\n'));
}
log('outputs: phase0_r3_results.csv, phase0_r3_asset_breakdown.csv, phase0_r3_session_breakdown.csv');
db.close();
