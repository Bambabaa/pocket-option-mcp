import { replayCandles } from '../../src/core/analysis.js';

const r = await replayCandles(null, { amount: 500 });
const sigs = r.signals_all || [];
const v120 = sigs.filter(s => s.result_120 != null);

console.log(`Validated at 120s: ${v120.length}  CALL=${v120.filter(s=>s.direction==='CALL').length}  PUT=${v120.filter(s=>s.direction==='PUT').length}`);

// ── Stat primitives ─────────────────────────────────────────────────────────

function pointBiserial(vals, outs) {
    const n = vals.length;
    if (n < 10) return null;
    const y = outs.map(o => o === 'WIN' ? 1 : 0);
    const meanY = y.reduce((a,b)=>a+b,0)/n;
    const stdY  = Math.sqrt(y.reduce((a,b)=>a+(b-meanY)**2,0)/(n-1));
    if (stdY === 0) return null;
    const nWin = y.filter(v=>v===1).length, nLoss = n - nWin;
    if (nWin===0||nLoss===0) return null;
    const mW = vals.filter((_,i)=>y[i]===1).reduce((a,b)=>a+b,0)/nWin;
    const mL = vals.filter((_,i)=>y[i]===0).reduce((a,b)=>a+b,0)/nLoss;
    const stdX = Math.sqrt(vals.reduce((a,b)=>a+(b-vals.reduce((s,v)=>s+v,0)/n)**2,0)/(n-1));
    return { r: parseFloat(((mW-mL)/stdY * Math.sqrt(nWin*nLoss/(n*n))).toFixed(4)), mW: parseFloat(mW.toFixed(2)), mL: parseFloat(mL.toFixed(2)), n };
}

function tStat(vals, outs) {
    const win  = vals.filter((_,i)=>outs[i]==='WIN');
    const loss = vals.filter((_,i)=>outs[i]==='LOSS');
    if (win.length<5||loss.length<5) return null;
    const mW=win.reduce((a,b)=>a+b,0)/win.length;
    const mL=loss.reduce((a,b)=>a+b,0)/loss.length;
    const vW=win.reduce((a,b)=>a+(b-mW)**2,0)/(win.length-1);
    const vL=loss.reduce((a,b)=>a+(b-mL)**2,0)/(loss.length-1);
    const se=Math.sqrt(vW/win.length+vL/loss.length);
    if(se===0) return null;
    return parseFloat(((mW-mL)/se).toFixed(3));
}

// Normal CDF for p-values
function normalCDF(z) {
    const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
    const sign=z<0?-1:1,x=Math.abs(z)/Math.SQRT2,t=1/(1+p*x);
    return 0.5*(1+sign*(1-((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x)));
}
function pFromT(t, df) {
    if (df > 30) return parseFloat((2*(1-normalCDF(Math.abs(t)))).toFixed(4));
    return null;
}

// Chi-square 2x2
function chi2x2(tp,fp,fn,tn) {
    const n=tp+fp+fn+tn; if(n===0) return null;
    const r1=tp+fp,r2=fn+tn,c1=tp+fn,c2=fp+tn;
    if(!r1||!r2||!c1||!c2) return null;
    const exp=(a,b)=>a*b/n;
    const chi=((tp-exp(r1,c1))**2/exp(r1,c1))+((fp-exp(r1,c2))**2/exp(r1,c2))+
              ((fn-exp(r2,c1))**2/exp(r2,c1))+((tn-exp(r2,c2))**2/exp(r2,c2));
    const phi=Math.sqrt(chi/n)*Math.sign(tp/(tp+fp)-(tp+fn)/n);
    const p=parseFloat((1-normalCDF(Math.sqrt(chi))).toFixed(4));
    return { chi:parseFloat(chi.toFixed(3)), phi:parseFloat(phi.toFixed(3)), p };
}

// ── Feature extraction ──────────────────────────────────────────────────────

function feat(s) {
    const h = Math.floor((s.signalTs % 86400) / 3600);
    return {
        stcValue:      s.stcValue,
        rsi:           s.rsi,
        k:             s.k,
        d:             s.d,
        bbBps:         s.bbBps,
        maTrendBps:    s.maTrendBps,
        stcDepth:      s.direction==='CALL' ? 25-(s.stcValue??25) : (s.stcValue??75)-75,
        rsiExtreme:    s.direction==='CALL' ? 30-(s.rsi??30)      : (s.rsi??70)-70,
        kdSpread:      s.k!=null&&s.d!=null ? Math.abs(s.k-s.d)  : null,
        rsiPeak10:     s.rsi_peak_10,
        rsiTrough10:   s.rsi_trough_10,
        kBarsAbove65:  s.k_bars_above_65,
        kBarsBelow35:  s.k_bars_below_35,
        bbExpanding:   s.bb_expanding,
        maGapFlat:     s.ma_gap_trend==='flat',
        maGapNarrow:   s.ma_gap_trend==='narrowing',
        maGapWideUp:   s.ma_gap_trend==='widening_up',
        maGapWideDown: s.ma_gap_trend==='widening_down',
        isH7_12:       h>=7&&h<=12,
        isBadHour:     h>=14&&h<=15,
        hour:          h,
    };
}

// ── 1. Point-biserial — all signals, all continuous features ────────────────
console.log('\n\n=== POINT-BISERIAL CORRELATIONS (all signals, 120s) ===');
console.log('Feature              r_pb    mWin   mLoss   t-stat   p(2-tail)  sig');
console.log('─'.repeat(72));

const contFeats = [
    'stcValue','rsi','k','d','bbBps','maTrendBps',
    'stcDepth','rsiExtreme','kdSpread','rsiPeak10','rsiTrough10','kBarsAbove65','kBarsBelow35',
];
const allRows = [];

for (const f of contFeats) {
    const pairs = v120.filter(s=>feat(s)[f]!=null).map(s=>[feat(s)[f],s.result_120]);
    if (pairs.length<15) continue;
    const pb = pointBiserial(pairs.map(p=>p[0]),pairs.map(p=>p[1]));
    if (!pb) continue;
    const t  = tStat(pairs.map(p=>p[0]),pairs.map(p=>p[1]));
    const p  = t!=null ? pFromT(t,pairs.length-2) : null;
    const sig = p!=null ? (p<0.01?'***':p<0.05?'** ':p<0.10?'*  ':'   ') : '   ';
    allRows.push({f, pb, t, p, sig, n:pairs.length});
}
allRows.sort((a,b)=>Math.abs(b.pb.r)-Math.abs(a.pb.r));
for (const x of allRows) {
    const pStr = x.p!=null?x.p.toFixed(4):'N/A';
    console.log(`${x.f.padEnd(20)} ${x.pb.r>=0?'+':''}${x.pb.r.toFixed(4)}  ${String(x.pb.mW).padStart(6)}  ${String(x.pb.mL).padStart(6)}  ${x.t!=null?x.t.toFixed(3).padStart(7):'    N/A'}   ${pStr}  ${x.sig}`);
}

// ── 2. Chi-square: binary features ─────────────────────────────────────────
console.log('\n\n=== CHI-SQUARE: BINARY FEATURES (all signals, 120s) ===');
console.log('Feature              phi    chi²   p-val  n(T)  wr_T    wr_F    sig');
console.log('─'.repeat(72));

const binFeats = ['bbExpanding','maGapFlat','maGapNarrow','maGapWideUp','maGapWideDown','isH7_12','isBadHour'];
const chiRows = [];
for (const f of binFeats) {
    const sub = v120.filter(s=>feat(s)[f]!=null);
    const tW=sub.filter(s=>feat(s)[f]===true &&s.result_120==='WIN').length;
    const tL=sub.filter(s=>feat(s)[f]===true &&s.result_120==='LOSS').length;
    const fW=sub.filter(s=>feat(s)[f]===false&&s.result_120==='WIN').length;
    const fL=sub.filter(s=>feat(s)[f]===false&&s.result_120==='LOSS').length;
    const nT=tW+tL, nF=fW+fL;
    if(nT<10||nF<10) continue;
    const cs=chi2x2(tW,tL,fW,fL);
    if(!cs) continue;
    const sig=cs.p<0.01?'***':cs.p<0.05?'** ':cs.p<0.10?'*  ':'   ';
    chiRows.push({f,cs,nT,wrT:nT>0?(tW/nT*100).toFixed(1)+'%':'N/A',wrF:nF>0?(fW/nF*100).toFixed(1)+'%':'N/A',sig});
}
chiRows.sort((a,b)=>Math.abs(b.cs.phi)-Math.abs(a.cs.phi));
for (const c of chiRows) {
    console.log(`${c.f.padEnd(20)} ${c.cs.phi>=0?'+':''}${c.cs.phi.toFixed(3)}  ${c.cs.chi.toFixed(2).padStart(6)}  ${c.cs.p.toFixed(4)}  ${String(c.nT).padStart(4)}  ${c.wrT.padEnd(7)} ${c.wrF.padEnd(7)} ${c.sig}`);
}

// ── 3. Direction-specific correlations ─────────────────────────────────────
for (const dir of ['CALL','PUT']) {
    const sub = v120.filter(s=>s.direction===dir);
    console.log(`\n\n=== CORRELATIONS — ${dir} ONLY (n=${sub.length}) ===`);
    console.log('Feature              r_pb    mWin   mLoss   t-stat   p(2-tail)  sig');
    console.log('─'.repeat(72));
    const rows=[];
    for (const f of contFeats) {
        const pairs=sub.filter(s=>feat(s)[f]!=null).map(s=>[feat(s)[f],s.result_120]);
        if(pairs.length<10) continue;
        const pb=pointBiserial(pairs.map(p=>p[0]),pairs.map(p=>p[1]));
        if(!pb) continue;
        const t=tStat(pairs.map(p=>p[0]),pairs.map(p=>p[1]));
        const p=t!=null?pFromT(t,pairs.length-2):null;
        const sig=p!=null?(p<0.01?'***':p<0.05?'** ':p<0.10?'*  ':'   '):'   ';
        rows.push({f,pb,t,p,sig});
    }
    rows.sort((a,b)=>Math.abs(b.pb.r)-Math.abs(a.pb.r));
    for (const x of rows) {
        const pStr=x.p!=null?x.p.toFixed(4):'N/A';
        console.log(`${x.f.padEnd(20)} ${x.pb.r>=0?'+':''}${x.pb.r.toFixed(4)}  ${String(x.pb.mW).padStart(6)}  ${String(x.pb.mL).padStart(6)}  ${x.t!=null?x.t.toFixed(3).padStart(7):'    N/A'}   ${pStr}  ${x.sig}`);
    }
}

// ── 4. 2-way interaction: feature combinations that matter ─────────────────
console.log('\n\n=== 2-WAY INTERACTIONS (PUT 120s, top combinations) ===');
const putSigs = v120.filter(s=>s.direction==='PUT');
const interactions = [
    { a:'stcValue>=90',  af: s=>s.stcValue>=90,  b:'rsi>70',   bf: s=>s.rsi>70   },
    { a:'stcValue>=90',  af: s=>s.stcValue>=90,  b:'bbExpand', bf: s=>s.bb_expanding===true },
    { a:'rsi>70',        af: s=>s.rsi>70,        b:'kdSpread>5',bf:s=>s.k!=null&&s.d!=null&&Math.abs(s.k-s.d)>5 },
    { a:'rsi>70',        af: s=>s.rsi>70,        b:'bbExpand', bf: s=>s.bb_expanding===true },
    { a:'stcValue>=95',  af: s=>s.stcValue>=95,  b:'rsi>70',   bf: s=>s.rsi>70   },
    { a:'stcValue>=90',  af: s=>s.stcValue>=90,  b:'maWideUp', bf: s=>s.ma_gap_trend==='widening_up' },
    { a:'k>60',          af: s=>s.k!=null&&s.k>60, b:'rsi>70', bf: s=>s.rsi>70  },
    { a:'h7_12',         af: s=>{ const h=Math.floor((s.signalTs%86400)/3600); return h>=7&&h<=12; }, b:'stcValue>=90', bf:s=>s.stcValue>=90 },
];

console.log('Condition A              Condition B         n(A+B)  wr(A+B)  n(A-B)  wr(A-B)  n(-A+B)  wr(-A+B)');
console.log('─'.repeat(100));
for (const ix of interactions) {
    const ab   = putSigs.filter(s=>ix.af(s)&&ix.bf(s));
    const aNotb= putSigs.filter(s=>ix.af(s)&&!ix.bf(s));
    const notaB= putSigs.filter(s=>!ix.af(s)&&ix.bf(s));
    const wr = arr => arr.length>0 ? (arr.filter(s=>s.result_120==='WIN').length/arr.length*100).toFixed(1)+'%' : 'N/A';
    console.log(`${ix.a.padEnd(24)} ${ix.b.padEnd(19)} ${String(ab.length).padStart(6)}  ${wr(ab).padEnd(8)} ${String(aNotb.length).padStart(6)}  ${wr(aNotb).padEnd(8)} ${String(notaB.length).padStart(7)}  ${wr(notaB)}`);
}

console.log('\n\n=== 2-WAY INTERACTIONS (CALL 120s, top combinations) ===');
const callSigs = v120.filter(s=>s.direction==='CALL');
const callIx = [
    { a:'rsi<30',    af:s=>s.rsi<30,   b:'stcValue<=10',  bf:s=>s.stcValue<=10  },
    { a:'rsi<30',    af:s=>s.rsi<30,   b:'stcValue<=20',  bf:s=>s.stcValue<=20  },
    { a:'rsi<30',    af:s=>s.rsi<30,   b:'bbExpand',      bf:s=>s.bb_expanding===true },
    { a:'rsi<30',    af:s=>s.rsi<30,   b:'k<30',          bf:s=>s.k!=null&&s.k<30 },
    { a:'stcValue<=10', af:s=>s.stcValue<=10, b:'bbExpand',bf:s=>s.bb_expanding===true },
    { a:'stcValue<=10', af:s=>s.stcValue<=10, b:'maFlat',  bf:s=>s.ma_gap_trend==='flat' },
    { a:'rsi<20',    af:s=>s.rsi<20,   b:'bbExpand',      bf:s=>s.bb_expanding===true },
    { a:'h7_12',     af:s=>{ const h=Math.floor((s.signalTs%86400)/3600); return h>=7&&h<=12;}, b:'rsi<30', bf:s=>s.rsi<30 },
];
console.log('Condition A              Condition B         n(A+B)  wr(A+B)  n(A-B)  wr(A-B)  n(-A+B)  wr(-A+B)');
console.log('─'.repeat(100));
for (const ix of callIx) {
    const ab    = callSigs.filter(s=>ix.af(s)&&ix.bf(s));
    const aNotb = callSigs.filter(s=>ix.af(s)&&!ix.bf(s));
    const notaB = callSigs.filter(s=>!ix.af(s)&&ix.bf(s));
    const wr = arr => arr.length>0 ? (arr.filter(s=>s.result_120==='WIN').length/arr.length*100).toFixed(1)+'%' : 'N/A';
    console.log(`${ix.a.padEnd(24)} ${ix.b.padEnd(19)} ${String(ab.length).padStart(6)}  ${wr(ab).padEnd(8)} ${String(aNotb.length).padStart(6)}  ${wr(aNotb).padEnd(8)} ${String(notaB.length).padStart(7)}  ${wr(notaB)}`);
}
