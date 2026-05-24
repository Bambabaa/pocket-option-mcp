'use strict';
// Phase 0 Round 2 — Option (c)
// Run R.2 on new gate candidates against the FULL R1 training corpus
// (all R1 data, both folds, treated as training for Round 2).
//
// Usage:
//   node agent/research/phase0_r2_newgates.cjs
//
// Gate definitions: edit the NEW_GATES array below, then run.
// Each gate that passes R.2 is pre-registered and logged for test_r2 validation.
// Any survivors are added to phase0_r2_newgates_survivors.csv.
//
// Methodology:
//   - Scan ALL R1 bars (timestamp <= R2_CUTOFF) for new gate conditions
//   - Apply 3-bar independence per (asset, gate, direction)
//   - Compute win_5m / win_10m / win_15m (tie = LOSS)
//   - Wilson 95% CI, binomial p-value vs H0: WR <= 0.5405
//   - BH FDR=0.05 across all (gate × expiry) cells
//   - No minimum n stop — low_n flagged but not a stop condition

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const RESEARCH_DB     = path.join(__dirname, '..', 'data', 'phase0_research.db');
const RESULTS_CSV     = path.join(__dirname, 'phase0_r2_newgates_results.csv');
const SURVIVORS_CSV   = path.join(__dirname, 'phase0_r2_newgates_survivors.csv');
const LOG_PATH        = path.join(__dirname, '..', 'phase0_log.md');

const R2_CUTOFF  = 1779511200; // all R1 bars have timestamp <= this
const PERIOD     = 300;
const INDEP_BARS = 3;
const ATR_WINDOW = 100;
const BREAK_EVEN = 0.5405;
const FDR        = 0.05;
const Z_95       = 1.959963984540054;

// ────────────────────────────────────────────────────────────────────────────
// NEW_GATES — add your candidates here
// Format: { name, dir, cols, fn }
//   name:  unique string identifier
//   dir:   'CALL' or 'PUT'
//   cols:  indicator columns that must be non-null for gate to evaluate
//   fn:    (row) => boolean
//
// Columns available from indicators table:
//   stc_value, stc_delta, rsi_14, stoch_k, stoch_d, stoch_prev_d,
//   macd_line, macd_signal, macd_histogram, bb_upper, bb_middle, bb_lower,
//   bb_width_bps, keltner_upper, keltner_middle, keltner_lower,
//   adx, plus_di, minus_di, cci_20, williams_r, atr_14,
//   psar_value, psar_trend, psar_is_bullish,
//   sma_10, sma_20, sma_50, ema_12, ema_26
// Derived (computed inline): atr_pct, sma_alignment_bear, sma_alignment_bull
// ────────────────────────────────────────────────────────────────────────────
const NEW_GATES = [
    // ── Example gates — replace or extend ──────────────────────────────────
    // Uncomment and fill in real candidates when you have them.

    // {
    //     name: 'my_call_gate',
    //     dir:  'CALL',
    //     cols: ['rsi_14', 'stoch_k'],
    //     fn:   r => r.rsi_14 < 35 && r.stoch_k < 25,
    // },
    // {
    //     name: 'my_put_gate',
    //     dir:  'PUT',
    //     cols: ['rsi_14', 'macd_histogram', 'bb_width_bps'],
    //     fn:   r => r.rsi_14 > 65 && r.macd_histogram < 0 && r.bb_width_bps > 20,
    // },
];
// ────────────────────────────────────────────────────────────────────────────

if (NEW_GATES.length === 0) {
    console.log('No new gates defined. Edit NEW_GATES array in phase0_r2_newgates.cjs and re-run.');
    process.exit(0);
}

// ── Stats ────────────────────────────────────────────────────────────────────
function erf(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign=x<0?-1:1,ax=Math.abs(x),t=1/(1+p*ax);
    return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax));
}
function normalCDF(z) { return 0.5*(1+erf(z/Math.SQRT2)); }
function wilsonCI(k,n) {
    if (!n) return {lower:0,upper:1};
    const ph=k/n,z2=Z_95*Z_95,d=1+z2/n,c=(ph+z2/(2*n))/d,m=Z_95*Math.sqrt(ph*(1-ph)/n+z2/(4*n*n))/d;
    return {lower:Math.max(0,c-m),upper:Math.min(1,c+m)};
}
function binomP(k,n,p0) {
    if (!n) return 1;
    const mean=n*p0,sd=Math.sqrt(n*p0*(1-p0));
    if (!sd) return k>mean?0:1;
    return 1-normalCDF((k-0.5-mean)/sd);
}
function bh(pvals, alpha=FDR) {
    const m=pvals.length;
    const idx=pvals.map((p,i)=>({p,i})).sort((a,b)=>a.p-b.p);
    const q=new Array(m); let min=1;
    for (let r=m;r>=1;r--) { const v=Math.min(1,idx[r-1].p*m/r); min=Math.min(min,v); q[r-1]=min; }
    return pvals.map((_,i)=>{ const rank=idx.findIndex(x=>x.i===i); return {adj:q[rank],rejected:q[rank]<=alpha}; });
}
function csvEscape(v) { const s=String(v??''); return (s.includes(',')||s.includes('"'))?'"'+s.replace(/"/g,'""')+'"':s; }
function writeCsv(fp, cols, rows) {
    const lines=[cols.join(','),...rows.map(r=>cols.map(c=>csvEscape(r[c])).join(','))];
    fs.writeFileSync(fp, lines.join('\n')+'\n', 'utf8');
}

function gateFires(gate, r) {
    for (const c of gate.cols) { const v=r[c]; if (v===null||v===undefined||Number.isNaN(v)) return false; }
    return gate.fn(r);
}

function main() {
    if (!fs.existsSync(RESEARCH_DB)) { console.error('ERROR: phase0_research.db not found'); process.exit(1); }
    const db = new Database(RESEARCH_DB, {readonly:true});
    db.pragma('journal_mode = WAL');

    const assets = db.prepare(`SELECT DISTINCT asset FROM candles WHERE timestamp <= ? ORDER BY asset`).all(R2_CUTOFF).map(r=>r.asset);
    console.log(`Running R.2 (Round 2 training corpus) on ${NEW_GATES.length} new gate(s) across ${assets.length} assets`);

    const loadRows = db.prepare(`
        SELECT c.timestamp, c.close, i.stc_value, i.stc_delta, i.rsi_14, i.stoch_k, i.stoch_d, i.stoch_prev_d,
               i.macd_line, i.macd_signal, i.macd_histogram, i.bb_upper, i.bb_middle, i.bb_lower, i.bb_width_bps,
               i.keltner_upper, i.keltner_middle, i.keltner_lower, i.adx, i.plus_di, i.minus_di,
               i.cci_20, i.williams_r, i.atr_14, i.psar_value, i.psar_trend, i.psar_is_bullish,
               i.sma_10, i.sma_20, i.sma_50, i.ema_12, i.ema_26
        FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        WHERE c.asset=? AND c.timestamp <= ?
        ORDER BY c.timestamp ASC
    `);
    const loadCloses = db.prepare(`SELECT timestamp, close FROM candles WHERE asset=? AND timestamp<=? ORDER BY timestamp ASC`);

    // Accumulate signals per (gate, expiry)
    // Structure: Map<gateKey, { n, k5, k10, k15, signals }>
    const gateStats = new Map();
    for (const g of NEW_GATES) {
        gateStats.set(g.name+'|'+g.dir, {name:g.name,dir:g.dir,n_train:0,k5:0,k10:0,k15:0});
    }

    for (const asset of assets) {
        const rows = loadRows.all(asset, R2_CUTOFF);
        if (!rows.length) continue;
        const closeByTs = new Map();
        for (const c of loadCloses.all(asset, R2_CUTOFF)) closeByTs.set(c.timestamp, c.close);

        // Compute atr_pct inline
        const atrBuf = [];
        for (const r of rows) {
            if (r.atr_14!=null) { atrBuf.push(r.atr_14); if (atrBuf.length>ATR_WINDOW) atrBuf.shift(); }
            r.atr_pct = (atrBuf.length===ATR_WINDOW && r.atr_14!=null) ? atrBuf.filter(v=>v<r.atr_14).length/ATR_WINDOW : null;
            r.sma_alignment_bear = (r.sma_10!=null&&r.sma_20!=null&&r.sma_50!=null) ? (r.sma_10<r.sma_20&&r.sma_20<r.sma_50?1:0) : null;
            r.sma_alignment_bull = (r.sma_10!=null&&r.sma_20!=null&&r.sma_50!=null) ? (r.sma_10>r.sma_20&&r.sma_20>r.sma_50?1:0) : null;
        }

        for (const gate of NEW_GATES) {
            const key = gate.name+'|'+gate.dir;
            let lastFire = null;
            for (const r of rows) {
                if (!gateFires(gate, r)) continue;
                if (lastFire!==null && r.timestamp < lastFire+INDEP_BARS*PERIOD) continue;
                lastFire = r.timestamp;
                const entry=r.close;
                const e5=closeByTs.get(r.timestamp+300)??null, e10=closeByTs.get(r.timestamp+600)??null, e15=closeByTs.get(r.timestamp+900)??null;
                const s = gateStats.get(key);
                s.n_train++;
                if (e5!==null)  { if (gate.dir==='CALL'?e5>entry:e5<entry)  s.k5++;  }
                if (e10!==null) { if (gate.dir==='CALL'?e10>entry:e10<entry) s.k10++; }
                if (e15!==null) { if (gate.dir==='CALL'?e15>entry:e15<entry) s.k15++; }
            }
        }
    }

    // Build cells (gate × expiry = 3 per gate)
    const expiries = [{exp:'5m',kField:'k5'},{exp:'10m',kField:'k10'},{exp:'15m',kField:'k15'}];
    const cells = [];
    for (const [, stat] of gateStats) {
        for (const {exp, kField} of expiries) {
            const n=stat.n_train, k=stat[kField];
            const wr=n>0?k/n:null;
            const ci=n>0?wilsonCI(k,n):{lower:null,upper:null};
            const pv=n>0?binomP(k,n,BREAK_EVEN):1;
            cells.push({gate:stat.name,direction:stat.dir,expiry:exp,n,k,wr,ci_lower:ci.lower,ci_upper:ci.upper,p_value:pv,low_n:n<50,caution_n:n>=50&&n<100,clears_floor:ci.lower!=null&&ci.lower>BREAK_EVEN,bh_adj:null,bh_passed:null,passes:null});
        }
    }

    // BH correction across all cells
    const pvs = cells.map(c=>c.p_value);
    const bhRes = bh(pvs);
    for (let i=0;i<cells.length;i++) {
        cells[i].bh_adj  = bhRes[i].adj;
        cells[i].bh_passed = bhRes[i].rejected;
        cells[i].passes = !cells[i].low_n && cells[i].clears_floor && cells[i].bh_passed;
    }

    // Print
    console.log(`\nR.2 results (Round 2 training corpus, vs WR<=0.5405, BH FDR=${FDR}):`);
    console.log('gate'.padEnd(26)+'dir'.padEnd(5)+'exp'.padEnd(5)+'n'.padStart(7)+'wr'.padStart(8)+'ci_low'.padStart(9)+'bh_p'.padStart(11)+'  flags');
    console.log('-'.repeat(80));

    const sorted = [...cells].sort((a,b)=>(b.wr??0)-(a.wr??0));
    let passCount=0;
    for (const c of sorted) {
        const flags=[];
        if (c.low_n) flags.push('low_n');
        else if (c.caution_n) flags.push('caution_n');
        if (!c.clears_floor) flags.push('below_floor');
        if (c.bh_passed===false&&c.clears_floor&&!c.low_n) flags.push('bh_failed');
        if (c.passes) { flags.push('PASS'); passCount++; }
        console.log(c.gate.padEnd(26)+c.direction.padEnd(5)+c.expiry.padEnd(5)+String(c.n).padStart(7)+(c.wr!=null?(c.wr*100).toFixed(2)+'%':'n/a').padStart(8)+(c.ci_lower!=null?(c.ci_lower*100).toFixed(2)+'%':'n/a').padStart(9)+(c.bh_adj!=null?c.bh_adj.toExponential(2):'n/a').padStart(11)+'  '+flags.join(' '));
    }
    console.log(`\n${passCount} cell(s) passed all criteria.`);

    const fmt = c=>({...c,wr:c.wr!=null?c.wr.toFixed(6):'',ci_lower:c.ci_lower!=null?c.ci_lower.toFixed(6):'',ci_upper:c.ci_upper!=null?c.ci_upper.toFixed(6):'',p_value:c.p_value.toExponential(4),bh_adj:c.bh_adj!=null?c.bh_adj.toExponential(4):'',bh_passed:c.bh_passed?'TRUE':'FALSE',low_n:c.low_n?'TRUE':'FALSE',caution_n:c.caution_n?'TRUE':'FALSE',clears_floor:c.clears_floor?'TRUE':'FALSE',passes:c.passes?'TRUE':'FALSE'});
    const cols=['gate','direction','expiry','n','k','wr','ci_lower','ci_upper','p_value','bh_adj','bh_passed','low_n','caution_n','clears_floor','passes'];
    writeCsv(RESULTS_CSV, cols, cells.map(fmt));
    writeCsv(SURVIVORS_CSV, cols, cells.filter(c=>c.passes).map(fmt));
    console.log(`\nWrote ${cells.length} rows → ${RESULTS_CSV}`);
    console.log(`Wrote ${passCount} survivors → ${SURVIVORS_CSV}`);

    // Pre-registration note for survivors
    const survivors = cells.filter(c=>c.passes);
    if (survivors.length>0) {
        console.log(`\nPRE-REGISTRATION: The following gates passed R.2 and are eligible for test_r2 validation.`);
        console.log(`Add them to phase0_r2_sync.cjs GATE array and re-run to capture test_r2 signals.`);
        for (const s of survivors) console.log(`  ${s.gate} | ${s.direction} | ${s.expiry} | WR=${s.wr!=null?(s.wr*100).toFixed(2)+'%':'n/a'} | ci_lower=${s.ci_lower!=null?(s.ci_lower*100).toFixed(2)+'%':'n/a'}`);
    }

    const today=new Date().toISOString().slice(0,10);
    fs.appendFileSync(LOG_PATH, `\n### Round 2 — R.2 new gates (${today})\n- Gates tested: ${NEW_GATES.length}\n- Cells: ${cells.length}\n- Passed: ${passCount}\n- Survivors: ${survivors.map(s=>s.gate+' '+s.direction+' '+s.expiry).join(', ')||'none'}\n---\n`, 'utf8');
    db.close();
}
main();
