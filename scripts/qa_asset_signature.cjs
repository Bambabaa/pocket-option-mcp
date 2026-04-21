// Toxic Asset Signature hunt: find a MEASURABLE trait that separates GREEN (WR>=70%)
// from RED (WR<55%) assets, so we can gate on the trait (not the name).
//
// Phases:
//  1. Bucket assets by PUT_REV+CALL_UT+PUT_DT+CALL_REV pooled WR (n>=10) → GREEN/RED lists
//  2. Compute per-asset traits from prices + candles + indicators:
//       tick_cadence_ms, tick_autocorr_lag1, bbw_cov (stability), bbw_median,
//       candle_range_cov, spread_proxy (tick stddev / price), ma_chop_rate,
//       gap_rate, wick_dominance, stoch_whipsaw_rate, rsi_range
//  3. Cohen's d per trait between GREEN and RED
//  4. Propose a threshold on the top-d trait; simulate gating across all signals

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v2_13-15',   'data/trading_data_v2_13-15.db'],
  ['V3_16',      'data/trading_data_V3_16.db'],
  ['V3_17',      'data/trading_data_V3_17.db'],
  ['V4_17',      'data/trading_data_V4_17.db'],
  ['current',    'data/trading_data.db'],
];

const open = p => new Promise((res, rej) => {
  const db = new sqlite3.Database(p, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(db));
});
const all = (db, q, p = []) => new Promise((res, rej) =>
  db.all(q, p, (e, rows) => e ? rej(e) : res(rows)));

const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const stdev = a => { if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
const median = a => { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const cov = a => { const m=mean(a); return m!==0 ? stdev(a)/Math.abs(m) : 0; };

const cohensD = (a, b) => {
  if (a.length < 2 || b.length < 2) return 0;
  const ma = mean(a), mb = mean(b);
  const sa = stdev(a), sb = stdev(b);
  const sp = Math.sqrt(((a.length-1)*sa*sa + (b.length-1)*sb*sb) / (a.length + b.length - 2));
  return sp > 0 ? (ma - mb) / sp : 0;
};

const autocorr1 = xs => {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  let num = 0, den = 0;
  for (let i = 1; i < xs.length; i++) num += (xs[i]-m)*(xs[i-1]-m);
  for (let i = 0; i < xs.length; i++) den += (xs[i]-m)*(xs[i]-m);
  return den > 0 ? num/den : 0;
};

(async () => {
  // Per-asset pooled signal outcomes + traits across all DBs
  const assetOutcomes = {};  // asset -> {wins, n, pnl}
  const assetTraits = {};    // asset -> array of per-DB traits objects

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) { console.error(`SKIP ${tag}`); continue; }
    const db = await open(abs);
    const tbls = (await all(db, `SELECT name FROM sqlite_master WHERE type='table'`)).map(t=>t.name);
    if (!tbls.includes('signal_outcomes')) { db.close(); continue; }

    // Outcomes per asset
    const outs = await all(db, `SELECT asset, result, profit_loss FROM signal_outcomes WHERE result IN ('WIN','LOSS')`);
    for (const r of outs) {
      const a = r.asset;
      if (!assetOutcomes[a]) assetOutcomes[a] = { wins: 0, n: 0, pnl: 0 };
      assetOutcomes[a].n++;
      if (r.result === 'WIN') assetOutcomes[a].wins++;
      assetOutcomes[a].pnl += r.profit_loss || 0;
    }

    // Per-asset traits from this DB
    const assets = [...new Set(outs.map(r => r.asset))];
    for (const a of assets) {
      // ticks
      const ticks = await all(db, `SELECT timestamp, price FROM prices WHERE asset=? ORDER BY timestamp LIMIT 20000`, [a]);
      if (ticks.length < 100) continue;
      const dts = [];
      const dprices = [];
      for (let i = 1; i < ticks.length; i++) {
        const dt = ticks[i].timestamp - ticks[i-1].timestamp;
        if (dt > 0 && dt < 120) dts.push(dt);
        if (ticks[i-1].price > 0) dprices.push((ticks[i].price - ticks[i-1].price) / ticks[i-1].price);
      }
      const tickCadence = median(dts); // seconds
      const tickAutocorr = autocorr1(dprices);
      const tickStddev = stdev(dprices);

      // candles
      const cnd = await all(db, `SELECT open,high,low,close FROM candles WHERE asset=? ORDER BY timestamp LIMIT 2000`, [a]);
      const ranges = cnd.map(c => c.high - c.low).filter(x => x > 0);
      const rangeCov = cov(ranges);
      // wick dominance: (upperWick + lowerWick) / range
      const wickDom = cnd.length ? mean(cnd.map(c => {
        const rng = c.high - c.low;
        if (rng <= 0) return 0;
        const body = Math.abs(c.close - c.open);
        return 1 - body/rng;
      })) : 0;
      // gap rate: |open_i - close_{i-1}| / prev_range > 0.5
      let gaps = 0, denom = 0;
      for (let i = 1; i < cnd.length; i++) {
        const pr = cnd[i-1].high - cnd[i-1].low;
        if (pr > 0) {
          denom++;
          if (Math.abs(cnd[i].open - cnd[i-1].close) / pr > 0.5) gaps++;
        }
      }
      const gapRate = denom ? gaps/denom : 0;

      // indicators for bbw stability + stoch whipsaw + rsi range
      const ind = await all(db, `SELECT rsi_5, bb_upper, bb_middle, bb_lower, stochastic_k_v2, ma1, ma3 FROM indicators WHERE asset=? ORDER BY timestamp LIMIT 2000`, [a]);
      const bbws = ind.map(r => (r.bb_middle && r.bb_upper!=null && r.bb_lower!=null) ? (r.bb_upper - r.bb_lower)/r.bb_middle*10000 : null).filter(x => x != null && x >= 0);
      const bbwMedian = median(bbws);
      const bbwCov = cov(bbws);
      // ma chop rate: ma1-ma3 sign flips per 100 bars
      let flips = 0, mdenom = 0;
      for (let i = 1; i < ind.length; i++) {
        if (ind[i].ma1 != null && ind[i].ma3 != null && ind[i-1].ma1 != null && ind[i-1].ma3 != null) {
          mdenom++;
          const cur = Math.sign(ind[i].ma1 - ind[i].ma3);
          const prev = Math.sign(ind[i-1].ma1 - ind[i-1].ma3);
          if (cur !== prev && cur !== 0 && prev !== 0) flips++;
        }
      }
      const maChopRate = mdenom ? flips/mdenom : 0;
      // stoch whipsaw: sign of (K - K_prev) flips per 100
      let sflips = 0, sdenom = 0;
      for (let i = 2; i < ind.length; i++) {
        const d1 = ind[i].stochastic_k_v2 - ind[i-1].stochastic_k_v2;
        const d0 = ind[i-1].stochastic_k_v2 - ind[i-2].stochastic_k_v2;
        if (!isNaN(d1) && !isNaN(d0)) {
          sdenom++;
          if (Math.sign(d1) !== Math.sign(d0) && d1 !== 0 && d0 !== 0) sflips++;
        }
      }
      const stochWhipsaw = sdenom ? sflips/sdenom : 0;
      const rsis = ind.map(r=>r.rsi_5).filter(x => x != null);
      const rsiRange = rsis.length ? (Math.max(...rsis) - Math.min(...rsis)) : 0;

      if (!assetTraits[a]) assetTraits[a] = [];
      assetTraits[a].push({
        tick_cadence: tickCadence,
        tick_autocorr: tickAutocorr,
        tick_stddev: tickStddev,
        range_cov: rangeCov,
        wick_dom: wickDom,
        gap_rate: gapRate,
        bbw_median: bbwMedian,
        bbw_cov: bbwCov,
        ma_chop: maChopRate,
        stoch_whipsaw: stochWhipsaw,
        rsi_range: rsiRange,
      });
    }
    db.close();
  }

  // Average traits per asset across DBs
  const assetFinal = {};
  for (const [a, arr] of Object.entries(assetTraits)) {
    const keys = Object.keys(arr[0]);
    const avg = {};
    for (const k of keys) avg[k] = mean(arr.map(x => x[k]).filter(x => isFinite(x)));
    assetFinal[a] = avg;
  }

  // Bucket assets
  const buckets = { GREEN: [], RED: [], GREY: [] };
  for (const [a, o] of Object.entries(assetOutcomes)) {
    if (o.n < 10) continue;
    const wr = o.wins / o.n * 100;
    if (!assetFinal[a]) continue;
    const entry = { asset: a, n: o.n, wr, pnl: o.pnl, ...assetFinal[a] };
    if (wr >= 70) buckets.GREEN.push(entry);
    else if (wr < 55) buckets.RED.push(entry);
    else buckets.GREY.push(entry);
  }

  console.log(`\n═══ BUCKETS (n>=10 signals pooled across 5 DBs) ═══`);
  console.log(`GREEN (WR≥70): ${buckets.GREEN.length}`);
  buckets.GREEN.sort((x,y)=>y.wr-x.wr).forEach(a => console.log(`  ${a.asset.padEnd(18)} n=${String(a.n).padStart(3)} WR=${a.wr.toFixed(1)}% P/L=$${a.pnl.toFixed(0)}`));
  console.log(`\nRED (WR<55): ${buckets.RED.length}`);
  buckets.RED.sort((x,y)=>x.wr-y.wr).forEach(a => console.log(`  ${a.asset.padEnd(18)} n=${String(a.n).padStart(3)} WR=${a.wr.toFixed(1)}% P/L=$${a.pnl.toFixed(0)}`));
  console.log(`\nGREY (55-70): ${buckets.GREY.length} assets`);

  // Cohen's d per trait
  console.log(`\n═══ TRAIT SEPARATION: Cohen's d (GREEN - RED) ═══`);
  console.log(`${'trait'.padEnd(18)} ${'GREEN μ'.padStart(10)} ${'RED μ'.padStart(10)}   d`);
  const traits = ['tick_cadence','tick_autocorr','tick_stddev','range_cov','wick_dom','gap_rate','bbw_median','bbw_cov','ma_chop','stoch_whipsaw','rsi_range'];
  const results = [];
  for (const t of traits) {
    const g = buckets.GREEN.map(x=>x[t]).filter(isFinite);
    const r = buckets.RED.map(x=>x[t]).filter(isFinite);
    const d = cohensD(g, r);
    results.push({ trait: t, gMean: mean(g), rMean: mean(r), d, absD: Math.abs(d) });
  }
  results.sort((a,b)=>b.absD - a.absD);
  for (const r of results) {
    console.log(`${r.trait.padEnd(18)} ${r.gMean.toFixed(4).padStart(10)} ${r.rMean.toFixed(4).padStart(10)}   ${r.d.toFixed(2).padStart(5)}`);
  }

  // Propose universal gate using the top-d trait
  console.log(`\n═══ PROPOSED UNIVERSAL GATE ═══`);
  const top = results[0];
  console.log(`Top trait: ${top.trait}  (|d|=${top.absD.toFixed(2)})`);
  console.log(`GREEN μ=${top.gMean.toFixed(4)}, RED μ=${top.rMean.toFixed(4)}`);
  // threshold = midpoint weighted by variances (simple midpoint first)
  const thr = (top.gMean + top.rMean) / 2;
  const dir = top.gMean > top.rMean ? '>=' : '<=';
  console.log(`Proposed threshold: ${top.trait} ${dir} ${thr.toFixed(4)}`);

  // Simulate: how many RED-asset signals vs GREEN-asset signals would this filter cut?
  let blockedRed=0, blockedGreen=0, blockedGrey=0;
  for (const a of buckets.RED) if ((dir==='>=' ? a[top.trait] < thr : a[top.trait] > thr)) blockedRed += a.n;
  for (const a of buckets.GREEN) if ((dir==='>=' ? a[top.trait] < thr : a[top.trait] > thr)) blockedGreen += a.n;
  for (const a of buckets.GREY) if ((dir==='>=' ? a[top.trait] < thr : a[top.trait] > thr)) blockedGrey += a.n;
  const redN = buckets.RED.reduce((s,a)=>s+a.n,0);
  const greenN = buckets.GREEN.reduce((s,a)=>s+a.n,0);
  const greyN = buckets.GREY.reduce((s,a)=>s+a.n,0);
  console.log(`\nImpact simulation (signals removed if gate applied):`);
  console.log(`  RED blocked:   ${blockedRed}/${redN} (${(100*blockedRed/Math.max(1,redN)).toFixed(1)}%) ← want high`);
  console.log(`  GREEN blocked: ${blockedGreen}/${greenN} (${(100*blockedGreen/Math.max(1,greenN)).toFixed(1)}%) ← want low`);
  console.log(`  GREY blocked:  ${blockedGrey}/${greyN} (${(100*blockedGrey/Math.max(1,greyN)).toFixed(1)}%)`);
})().catch(e => { console.error(e); process.exit(1); });
