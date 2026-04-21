// Phase 7: hunt gates that SHOULD be added.
// Among signals that currently fire (all live gates pass), some lose. For
// each candidate NEW gate, measure:
//   - losing signals it would block
//   - winning signals it would mistakenly block (collateral)
//   - net P/L change if added
//
// Candidate gates (from QA2 + classic microstructure):
//   kd_delta_drop     : (stochK-stochD) - (k_1-d_1)   (K-D spread collapse velocity)
//   candle_efficiency : |close-open| / (high-low)    (conviction ratio)
//   bbw_expand        : (bbw - bbw_1)/bbw_1          (volatility opening up)
//   body_pct_atr      : |close-open| / ATR14         (body vs volatility)
//   rsi_accel         : (rsi-rsi_1) - (rsi_1-rsi_2)  (RSI 2nd derivative)
//   wick_rejection    : PUT: upper_wick/body; CALL: lower_wick/body

const Database = require('better-sqlite3');
const Indicators = require('../bot/indicators.js');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v2_13-15', 'data/trading_data_v2_13-15.db'],
  ['V3_16',    'data/trading_data_V3_16.db'],
  ['V3_17',    'data/trading_data_V3_17.db'],
  ['V4_17',    'data/trading_data_V4_17.db'],
  ['current',  'data/trading_data.db'],
];
const AMOUNT = 500, PAYOUT = 0.92;

// Live-gate definition per pattern (matches bot/indicators.js strict branches).
function firesLive(pat, g) {
  switch (pat) {
    case 'PUT_REV':
      return g.isRed && g.rsiWasOverbought1 && g.rsiWasOverbought2 && g.notFastDrop &&
             g.rsiFalling && g.rsiIn_38_70 && g.rsiExcl_55_65 && g.velInBand_m15_m8 &&
             g.kExitingOB_strict && g.dLaggingHigh_75 && g.kBelowD_m3 && g.closeAboveMid &&
             g.bbw_50 && g.rsiAllHigh_3 && g.stochAllOB_3 && g.noEarlyBullishCross;
    case 'CALL_REV':
      return g.rsi_below_80 && g.kFlashCrash_25 && g.kOversold_25_30 && g.kWasMid_50 &&
             g.rsi_below_30 && g.priceNearLowerBB && g.bbw_10 &&
             g.rsiAllLow_45 && g.crashRecent_3to4 && g.noPrematureCross;
    case 'CALL_UT':
      return g.isGreen && g.ma6BelowMa14 && g.ma6Rising && g.rsi_above_50 && g.rsiRising &&
             g.stochK_above_30 && g.kRising && g.gapShrinking && g.ma14FlatOrRising &&
             g.stochAbove30_3bar && g.stochRecovering && g.noBearishCross &&
             g.stochK_ge_85 && g.rsi_not_60_70;
    case 'PUT_DT':
      return g.isRed && g.bbw_30 && g.ma6AboveMa14 && g.ma6Falling && g.priceBelowMa14 &&
             g.rsi_1_above_50 && g.rsiFalling && g.rsi_below_55 && g.stochK_below_70 && g.kFalling &&
             g.gapShrinking && g.ma14FlatOrFalling && g.stochBelow70_3bar &&
             g.stochResumingDown && g.noBullishCross;
  }
}

function collect(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const assets = db.prepare('SELECT DISTINCT asset FROM candles GROUP BY asset HAVING COUNT(*) >= 80').all().map(r => r.asset);
  const fired = [];

  for (const asset of assets) {
    const rows = db.prepare('SELECT timestamp, open, close, high, low FROM candles WHERE asset=? ORDER BY timestamp ASC').all(asset);
    const candles = rows.map(r => [r.timestamp, r.open, r.close, r.high, r.low]);
    const ind = new Indicators();

    const bbwHist = []; // for bbw_expand lag

    for (let i = 55; i < candles.length - 1; i++) {
      const result = ind.calculateAll(asset, candles.slice(Math.max(0, i - 59), i + 1), {});
      if (!result) { bbwHist.push(null); continue; }
      const closePrice = result.currentPrice ?? (result.lastCandle && result.lastCandle[2]);
      const ma6 = result.ma6, ma14 = result.ma14, rsi = result.rsi_5;
      if (ma6 == null || ma14 == null || rsi == null || !result.lastCandle) { bbwHist.push(null); continue; }
      const history = result.v2History || [];
      if (history.length < 3) { bbwHist.push(null); continue; }
      const rsi_1 = history[0].rsi_5, rsi_2 = history[1].rsi_5, rsi_3 = history[2].rsi_5;
      const k_1 = history[0].stochastic_k, k_2 = history[1].stochastic_k, k_3 = history[2].stochastic_k;
      const d_1 = history[0].stochastic_d, d_2 = history[1].stochastic_d;
      const stochK = result.stochastic_k, stochD = result.stochastic_d;
      if ([rsi_1,rsi_2,rsi_3,k_1,k_2,k_3,d_1,d_2,stochK,stochD].some(x=>x==null)) { bbwHist.push(null); continue; }
      const bb = result.bollingerKT;
      if (!bb || bb.upper==null || bb.lower==null || bb.middle==null) { bbwHist.push(null); continue; }
      const bbWidthBps = (bb.upper-bb.lower)/bb.middle*10000;
      bbwHist.push(bbWidthBps);

      const rsiVelocity = rsi - rsi_1, rsiFalling = rsi<rsi_1, rsiRising = rsi>rsi_1;
      const kFalling = stochK<k_1, kRising = stochK>k_1;
      const ma6Rising = history[0].ma6!=null ? ma6>history[0].ma6 : false;
      const ma6Falling = history[0].ma6!=null ? ma6<history[0].ma6 : false;
      const lastC = result.lastCandle;
      const [ , o, c, h, l] = lastC;
      const isGreen = c>o, isRed = c<o;
      const closeAboveMid = closePrice >= bb.middle;
      const priceNearLowerBB = closePrice <= bb.lower + (bb.upper-bb.lower)*0.15;

      // ATR14 on last 14 bars
      const atrBars = candles.slice(Math.max(0,i-13), i+1);
      let atr = 0, atrN=0;
      for (let j=1;j<atrBars.length;j++) {
        const [ ,oj,cj,hj,lj] = atrBars[j];
        const pc = atrBars[j-1][2];
        const tr = Math.max(hj-lj, Math.abs(hj-pc), Math.abs(lj-pc));
        atr += tr; atrN++;
      }
      atr = atrN ? atr/atrN : 0;

      // Candidate new gates
      const candleRange = h - l;
      const body = Math.abs(c - o);
      const upperWick = h - Math.max(o,c);
      const lowerWick = Math.min(o,c) - l;
      const kd_delta = (stochK-stochD) - (k_1-d_1);
      const candle_efficiency = candleRange>0 ? body/candleRange : 0;
      const bbw_1 = bbwHist.length>=2 ? bbwHist[bbwHist.length-2] : bbWidthBps;
      const bbw_expand = (bbw_1 && bbw_1>0) ? (bbWidthBps-bbw_1)/bbw_1 : 0;
      const body_pct_atr = atr>0 ? body/atr : 0;
      const rsi_accel = (rsi-rsi_1) - (rsi_1-rsi_2);
      const upper_wick_ratio = body>0 ? upperWick/body : (upperWick>0 ? 99 : 0);
      const lower_wick_ratio = body>0 ? lowerWick/body : (lowerWick>0 ? 99 : 0);

      const sc = candles[i], nc = candles[i+1];
      const entry = sc[2], exit = nc[2];
      const winCall = exit>entry, winPut = exit<entry;

      const newFeats = { kd_delta, candle_efficiency, bbw_expand, body_pct_atr, rsi_accel, upper_wick_ratio, lower_wick_ratio };

      // Gate evaluation per pattern (same as ablation file)
      // PUT_REV
      {
        const g = {
          isRed, rsiWasOverbought1: rsi_1>70, rsiWasOverbought2: rsi_2>=80,
          notFastDrop: !(rsi_1>=75 && rsi_1<80),
          rsiFalling, rsiIn_38_70: rsi>=38 && rsi<70, rsiExcl_55_65: !(rsi>=55 && rsi<65),
          velInBand_m15_m8: rsiVelocity>=-15 && rsiVelocity<=-8,
          kExitingOB_strict: k_1>65 && kFalling && stochK>=55 && stochK<80,
          dLaggingHigh_75: stochD>=75, kBelowD_m3: (stochK-stochD)<-3,
          closeAboveMid, bbw_50: bbWidthBps>=50,
          rsiAllHigh_3: rsi_1>70 && rsi_2>70 && rsi_3>70,
          stochAllOB_3: k_1>65 && k_2>65 && k_3>65,
          noEarlyBullishCross: !(k_1<d_1 && k_2>=d_2),
        };
        if (firesLive('PUT_REV', g)) {
          const win = winPut;
          fired.push({ pattern:'PUT_REV', asset, win, pl: win?AMOUNT*PAYOUT:-AMOUNT, ...newFeats });
        }
      }
      // CALL_REV
      {
        const kCrash = k_1 - stochK;
        const g = {
          rsi_below_80: rsi<80, kFlashCrash_25: kCrash>=25,
          kOversold_25_30: stochK>=25 && stochK<30, kWasMid_50: k_1>=50,
          rsi_below_30: rsi<30, priceNearLowerBB, bbw_10: bbWidthBps>=10,
          rsiAllLow_45: rsi<45 && rsi_1<45 && rsi_2<45 && rsi_3<45,
          crashRecent_3to4: k_1>=50||k_2>=50||k_3>=50,
          noPrematureCross: !(k_1>d_1 && k_2<=d_2),
        };
        if (firesLive('CALL_REV', g)) {
          const win = winCall;
          fired.push({ pattern:'CALL_REV', asset, win, pl: win?AMOUNT*PAYOUT:-AMOUNT, ...newFeats });
        }
      }
      // CALL_UT
      {
        const ma6BelowMa14 = ma6<ma14;
        const gap0 = Math.abs(ma6-ma14);
        const gap3 = Math.abs((history[2].ma6??ma6)-(history[2].ma14??ma14));
        const ma14_3 = history[2].ma14??ma14;
        const g = {
          isGreen, ma6BelowMa14, ma6Rising, rsi_above_50: rsi>50, rsiRising,
          stochK_above_30: stochK>30, kRising,
          gapShrinking: gap0<gap3, ma14FlatOrRising: ma14>=ma14_3,
          stochAbove30_3bar: stochK>30 && k_1>30 && k_2>30 && k_3>30,
          stochRecovering: stochK>k_2, noBearishCross: !(k_1>d_1 && stochK<=stochD),
          stochK_ge_85: stochK>=85, rsi_not_60_70: !(rsi>=60 && rsi<70),
        };
        if (firesLive('CALL_UT', g)) {
          const win = winCall;
          fired.push({ pattern:'CALL_UT', asset, win, pl: win?AMOUNT*PAYOUT:-AMOUNT, ...newFeats });
        }
      }
      // PUT_DT
      {
        const ma6AboveMa14 = ma6>ma14;
        const gap0 = Math.abs(ma6-ma14);
        const gap3 = Math.abs((history[2].ma6??ma6)-(history[2].ma14??ma14));
        const ma14_3 = history[2].ma14??ma14;
        const g = {
          isRed, bbw_30: bbWidthBps>=30, ma6AboveMa14, ma6Falling,
          priceBelowMa14: closePrice<ma14,
          rsi_1_above_50: rsi_1>50, rsiFalling, rsi_below_55: rsi<55,
          stochK_below_70: stochK<70, kFalling,
          gapShrinking: gap0<gap3, ma14FlatOrFalling: ma14<=ma14_3,
          stochBelow70_3bar: stochK<70 && k_1<70 && k_2<70 && k_3<70,
          stochResumingDown: stochK<k_2, noBullishCross: !(k_1<d_1 && stochK>=stochD),
        };
        if (firesLive('PUT_DT', g)) {
          const win = winPut;
          fired.push({ pattern:'PUT_DT', asset, win, pl: win?AMOUNT*PAYOUT:-AMOUNT, ...newFeats });
        }
      }
    }
  }
  db.close();
  return fired;
}

const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const stdev = a => { if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
const cohensD = (a,b) => {
  if (a.length<2||b.length<2) return 0;
  const sp = Math.sqrt(((a.length-1)*stdev(a)**2 + (b.length-1)*stdev(b)**2) / (a.length+b.length-2));
  return sp>0 ? (mean(a)-mean(b))/sp : 0;
};

function evalCandidateGate(fires, feature, direction, thresholds) {
  // direction: 'lt' means gate passes when value >= threshold (so we BLOCK when value < threshold)
  //            'gt' means gate passes when value <= threshold (block when value > threshold)
  // We want to add a block rule. For each threshold, count wins/losses blocked.
  const rows = [];
  for (const thr of thresholds) {
    let blockedW=0, blockedL=0, keptW=0, keptL=0, keptPL=0, blockedPL=0;
    for (const f of fires) {
      const v = f[feature];
      if (!isFinite(v)) { if(f.win)keptW++;else keptL++; keptPL+=f.pl; continue; }
      const block = direction==='lt' ? v < thr : v > thr;
      if (block) { if(f.win)blockedW++; else blockedL++; blockedPL += f.pl; }
      else       { if(f.win)keptW++;    else keptL++;    keptPL    += f.pl; }
    }
    const keptN = keptW+keptL;
    const keptWR = keptN ? 100*keptW/keptN : 0;
    rows.push({ thr, blockedW, blockedL, keptW, keptL, keptWR, keptPL, avoided: -blockedPL });
  }
  return rows;
}

(async () => {
  console.log('Replaying 5 DBs to collect firing signals + synthetic features...');
  const all = [];
  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const t0 = Date.now();
    const fires = collect(abs);
    fires.forEach(f => f.db = tag);
    all.push(...fires);
    console.log(`  ${tag}: ${fires.length} firing signals   [${((Date.now()-t0)/1000).toFixed(1)}s]`);
  }

  console.log(`\n═══ Total firing signals (live-gate pass): ${all.length} ═══`);

  for (const pat of ['PUT_REV','CALL_REV','CALL_UT','PUT_DT']) {
    const fires = all.filter(x => x.pattern===pat);
    const w = fires.filter(x=>x.win).length, l = fires.length-w;
    const pl = fires.reduce((s,x)=>s+x.pl,0);
    if (fires.length===0) { console.log(`\n━━━ ${pat}: no signals fire live. skip. ━━━`); continue; }
    console.log(`\n━━━━━━━ ${pat}  n=${fires.length}  WR=${(100*w/fires.length).toFixed(1)}%  P/L=$${pl.toFixed(0)} ━━━━━━━`);

    // Cohen's d per new feature: win-vs-loss distribution
    const feats = ['kd_delta','candle_efficiency','bbw_expand','body_pct_atr','rsi_accel','upper_wick_ratio','lower_wick_ratio'];
    console.log(`\n  Feature separation (wins vs losses, Cohen's d):`);
    const dRows = feats.map(f => {
      const wins = fires.filter(x=>x.win).map(x=>x[f]).filter(isFinite);
      const loss = fires.filter(x=>!x.win).map(x=>x[f]).filter(isFinite);
      return { f, wMu: mean(wins), lMu: mean(loss), d: cohensD(wins, loss) };
    }).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));
    for (const r of dRows) {
      console.log(`    ${r.f.padEnd(20)} win μ=${r.wMu.toFixed(3).padStart(7)}  loss μ=${r.lMu.toFixed(3).padStart(7)}  d=${r.d.toFixed(2)}`);
    }

    // For the top-3 features, try candidate thresholds
    console.log(`\n  Candidate gates — threshold sweep:`);
    const sweeps = {
      kd_delta:           { dir:'gt', thr:[-10,-7,-5,-3,-1, 0] }, // block if rising (kd_delta > thr)
      candle_efficiency:  { dir:'gt', thr:[0.3,0.4,0.5,0.55,0.6,0.7] }, // block if high (decisive candle in wrong direction)
      bbw_expand:         { dir:'lt', thr:[-0.05,0,0.02,0.05,0.1,0.2] }, // block if contracting
      body_pct_atr:       { dir:'gt', thr:[0.3,0.5,0.7,1.0,1.3] },
      rsi_accel:          { dir:'gt', thr:[-5,-2,0,2,5] },
      upper_wick_ratio:   { dir:'lt', thr:[0.3,0.5,1.0,2.0] },
      lower_wick_ratio:   { dir:'lt', thr:[0.3,0.5,1.0,2.0] },
    };
    for (const { f, d } of dRows.slice(0,4)) {
      if (Math.abs(d) < 0.1) continue;
      const { dir, thr } = sweeps[f];
      // Flip direction if losses have higher mean: block high values
      const lossMu = dRows.find(x=>x.f===f).lMu;
      const winMu  = dRows.find(x=>x.f===f).wMu;
      const blockDir = lossMu > winMu ? 'gt' : 'lt';
      const rows = evalCandidateGate(fires, f, blockDir, thr);
      console.log(`\n    ADD ${f} ${blockDir==='gt'?'<=':'>='} X  (block when ${blockDir==='gt'?'>':'<'} X):`);
      console.log(`      ${'thr'.padStart(6)}  blockedW/L  keptN  keptWR   ΔP/L(avoid)`);
      for (const r of rows) {
        console.log(`      ${String(r.thr).padStart(6)}   ${String(r.blockedW).padStart(3)}/${String(r.blockedL).padStart(3)}     ${String(r.keptW+r.keptL).padStart(4)}  ${r.keptWR.toFixed(1).padStart(5)}%   $${r.avoided.toFixed(0).padStart(6)}`);
      }
    }
  }
})();
