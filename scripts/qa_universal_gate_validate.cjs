// Per-DB validation of universal asset-quality gate.
// For each DB: compute per-asset range_cov, ma_chop, tick_autocorr from its own
// prices/candles/indicators. Apply gate to that DB's signal_outcomes. Measure
// WR / PF / P/L before vs after, per DB and per pattern.

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v2_13-15', 'data/trading_data_v2_13-15.db'],
  ['V3_16',    'data/trading_data_V3_16.db'],
  ['V3_17',    'data/trading_data_V3_17.db'],
  ['V4_17',    'data/trading_data_V4_17.db'],
  ['current',  'data/trading_data.db'],
];

const GATE = {
  range_cov_max:    0.326,
  ma_chop_max:      0.085,
  tick_autocorr_min: 0.0,
};

const open = p => new Promise((res, rej) => {
  const db = new sqlite3.Database(p, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(db));
});
const all = (db, q, p = []) => new Promise((res, rej) =>
  db.all(q, p, (e, rows) => e ? rej(e) : res(rows)));

const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const stdev = a => { if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
const cov = a => { const m=mean(a); return m!==0 ? stdev(a)/Math.abs(m) : 0; };

const autocorr1 = xs => {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  let num=0, den=0;
  for (let i=1;i<xs.length;i++) num += (xs[i]-m)*(xs[i-1]-m);
  for (let i=0;i<xs.length;i++) den += (xs[i]-m)*(xs[i]-m);
  return den>0 ? num/den : 0;
};

const parsePattern = r => {
  if (!r) return null;
  if (r.includes('OVERSOLD') && r.includes('Reversal')) return 'CALL_REV';
  if (r.includes('OVERBOUGHT') && r.includes('Reversal')) return 'PUT_REV';
  if (r.includes('UP TREND')) return 'CALL_UT';
  if (r.includes('DOWN TREND')) return 'PUT_DT';
  return null;
};

const wilson = (w,n) => {
  if (!n) return [0,0];
  const p=w/n, z=1.96, z2=z*z;
  const c=(p+z2/(2*n))/(1+z2/n);
  const h=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/(1+z2/n);
  return [100*(c-h), 100*(c+h)];
};

const summarize = rows => {
  const n = rows.length;
  const w = rows.filter(r=>r.result==='WIN').length;
  const pnl = rows.reduce((s,r)=>s+(r.profit_loss||0),0);
  const gw = rows.filter(r=>(r.profit_loss||0)>0).reduce((s,r)=>s+r.profit_loss,0);
  const gl = Math.abs(rows.filter(r=>(r.profit_loss||0)<0).reduce((s,r)=>s+r.profit_loss,0));
  const pf = gl>0 ? gw/gl : (gw>0?999:0);
  return { n, w, wr: n?100*w/n:0, pnl, pf };
};

(async () => {
  const dbSummary = [];
  const patternSummary = {}; // pat -> { before:[], after:[] }
  let totalBefore = { n:0, w:0, pnl:0 };
  let totalAfter  = { n:0, w:0, pnl:0 };
  let totalRemoved = { n:0, w:0, pnl:0 };

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const db = await open(abs);
    const tbls = (await all(db, `SELECT name FROM sqlite_master WHERE type='table'`)).map(t=>t.name);
    if (!tbls.includes('signal_outcomes')) { db.close(); continue; }

    // Assets in this DB
    const outs = await all(db, `SELECT o.asset, o.result, o.profit_loss, s.reasons
                                FROM signal_outcomes o JOIN signals s ON s.id=o.signal_id
                                WHERE o.result IN ('WIN','LOSS')`);
    const assets = [...new Set(outs.map(r=>r.asset))];

    const traits = {};
    for (const a of assets) {
      const ticks = await all(db, `SELECT timestamp, price FROM prices WHERE asset=? ORDER BY timestamp LIMIT 20000`, [a]);
      const cnd   = await all(db, `SELECT open,high,low,close FROM candles WHERE asset=? ORDER BY timestamp LIMIT 2000`, [a]);
      const ind   = await all(db, `SELECT ma1, ma3 FROM indicators WHERE asset=? ORDER BY timestamp LIMIT 2000`, [a]);

      if (ticks.length < 100 || cnd.length < 100 || ind.length < 100) {
        traits[a] = null; continue;
      }
      const dprices = [];
      for (let i=1;i<ticks.length;i++) if (ticks[i-1].price>0) dprices.push((ticks[i].price-ticks[i-1].price)/ticks[i-1].price);
      const ranges = cnd.map(c=>c.high-c.low).filter(x=>x>0);
      let flips=0, denom=0;
      for (let i=1;i<ind.length;i++) {
        if (ind[i].ma1!=null && ind[i].ma3!=null && ind[i-1].ma1!=null && ind[i-1].ma3!=null) {
          denom++;
          const cur = Math.sign(ind[i].ma1-ind[i].ma3);
          const prev = Math.sign(ind[i-1].ma1-ind[i-1].ma3);
          if (cur !== prev && cur !==0 && prev!==0) flips++;
        }
      }
      traits[a] = {
        range_cov: cov(ranges),
        ma_chop: denom ? flips/denom : 0,
        tick_autocorr: autocorr1(dprices),
      };
    }

    // Apply gate
    const passes = t => t && t.range_cov <= GATE.range_cov_max;
    const before = outs;
    const after  = outs.filter(r => passes(traits[r.asset]));
    const removed = outs.filter(r => !passes(traits[r.asset]));

    const b = summarize(before), a = summarize(after), rm = summarize(removed);
    const [bLo,bHi] = wilson(b.w, b.n);
    const [aLo,aHi] = wilson(a.w, a.n);

    console.log(`\n═══ ${tag} ═══`);
    console.log(`  BEFORE  n=${b.n}  WR=${b.wr.toFixed(1)}%  PF=${b.pf.toFixed(2)}  P/L=$${b.pnl.toFixed(0)}  CI=[${bLo.toFixed(1)},${bHi.toFixed(1)}]`);
    console.log(`  AFTER   n=${a.n}  WR=${a.wr.toFixed(1)}%  PF=${a.pf.toFixed(2)}  P/L=$${a.pnl.toFixed(0)}  CI=[${aLo.toFixed(1)},${aHi.toFixed(1)}]`);
    console.log(`  REMOVED n=${rm.n}  WR=${rm.wr.toFixed(1)}%  PF=${rm.pf.toFixed(2)}  P/L=$${rm.pnl.toFixed(0)}   ← prevented`);
    console.log(`  Δ WR = ${(a.wr-b.wr).toFixed(1)}pp   Δ PF = ${(a.pf-b.pf).toFixed(2)}   avoided loss ≈ ${(-rm.pnl).toFixed(0)}`);

    dbSummary.push({ tag, before: b, after: a, removed: rm });

    // Per-pattern roll-up
    for (const r of outs) {
      const pat = parsePattern(r.reasons);
      if (!pat) continue;
      if (!patternSummary[pat]) patternSummary[pat] = { before: [], after: [] };
      patternSummary[pat].before.push(r);
      if (passes(traits[r.asset])) patternSummary[pat].after.push(r);
    }

    totalBefore.n += b.n; totalBefore.w += b.w; totalBefore.pnl += b.pnl;
    totalAfter.n  += a.n; totalAfter.w  += a.w; totalAfter.pnl  += a.pnl;
    totalRemoved.n += rm.n; totalRemoved.w += rm.w; totalRemoved.pnl += rm.pnl;

    db.close();
  }

  console.log(`\n═══ AGGREGATE ═══`);
  console.log(`BEFORE  n=${totalBefore.n}  WR=${(100*totalBefore.w/totalBefore.n).toFixed(1)}%  P/L=$${totalBefore.pnl.toFixed(0)}`);
  console.log(`AFTER   n=${totalAfter.n}  WR=${(100*totalAfter.w/totalAfter.n).toFixed(1)}%  P/L=$${totalAfter.pnl.toFixed(0)}`);
  console.log(`REMOVED n=${totalRemoved.n}  WR=${(100*totalRemoved.w/totalRemoved.n).toFixed(1)}%  P/L=$${totalRemoved.pnl.toFixed(0)}`);
  console.log(`Δ WR = ${(100*totalAfter.w/totalAfter.n - 100*totalBefore.w/totalBefore.n).toFixed(1)}pp`);
  console.log(`Avoided loss = ${(-totalRemoved.pnl).toFixed(0)}`);

  console.log(`\n═══ PER-PATTERN IMPACT ═══`);
  for (const [pat, d] of Object.entries(patternSummary)) {
    const b = summarize(d.before), a = summarize(d.after);
    console.log(`  ${pat.padEnd(10)}  BEFORE n=${b.n} WR=${b.wr.toFixed(1)}% PF=${b.pf.toFixed(2)} P/L=$${b.pnl.toFixed(0)}   AFTER n=${a.n} WR=${a.wr.toFixed(1)}% PF=${a.pf.toFixed(2)} P/L=$${a.pnl.toFixed(0)}   Δ WR=${(a.wr-b.wr).toFixed(1)}pp`);
  }

  // Emit JSON gate spec
  const spec = {
    name: "universal_asset_quality_filter",
    conditions: [
      { trait: "range_cov",      operator: "<=", value: GATE.range_cov_max },
      { trait: "ma_chop",        operator: "<=", value: GATE.ma_chop_max },
      { trait: "tick_autocorr",  operator: ">=", value: GATE.tick_autocorr_min },
    ],
    action: "block_signal",
    window: { ticks: 20000, candles: 2000, indicators: 2000 },
    validated_dbs: dbSummary.map(d => d.tag),
    aggregate_impact: {
      before: { n: totalBefore.n, wr_pct: +(100*totalBefore.w/totalBefore.n).toFixed(1), pnl: +totalBefore.pnl.toFixed(0) },
      after:  { n: totalAfter.n,  wr_pct: +(100*totalAfter.w/totalAfter.n).toFixed(1),   pnl: +totalAfter.pnl.toFixed(0) },
      avoided_loss: +(-totalRemoved.pnl).toFixed(0),
      wr_improvement_pp: +(100*totalAfter.w/totalAfter.n - 100*totalBefore.w/totalBefore.n).toFixed(1),
    },
  };
  console.log(`\n═══ JSON SPEC ═══`);
  console.log(JSON.stringify(spec, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
