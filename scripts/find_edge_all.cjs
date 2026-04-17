// find_edge_all.cjs — exhaustive condition analysis for all 4 patterns
const Database = require('better-sqlite3');
const Indicators = require('../bot/indicators.js');
const db = new Database('data/trading_data.db', { readonly: true });
const assets = db.prepare('SELECT DISTINCT asset FROM candles GROUP BY asset HAVING COUNT(*) >= 80').all().map(r => r.asset);
const AMOUNT = 500, PAYOUT = 0.92;

function getSignals() {
  const sigs = [];
  for (const asset of assets) {
    const rows = db.prepare('SELECT timestamp, open, close, high, low FROM candles WHERE asset=? ORDER BY timestamp ASC').all(asset);
    const candles = rows.map(r => [r.timestamp, r.open, r.close, r.high, r.low]);
    const ind = new Indicators();
    for (let i = 55; i < candles.length - 1; i++) {
      const result = ind.calculateAll(asset, candles.slice(Math.max(0, i - 59), i + 1), {});
      if (!result) continue;
      const sigObj = { buy: false, sell: false, reasons: [], direction: null };
      ind._generateSignalsKTVideo2(result, {}, sigObj);
      if (!sigObj.buy && !sigObj.sell) continue;
      const sc = candles[i], nc = candles[i + 1];
      const entry = sc[2], exit = nc[2], dir = sigObj.direction;
      const outcome = dir === 'CALL' ? (exit > entry ? 'WIN' : 'LOSS') : (exit < entry ? 'WIN' : 'LOSS');
      const pl = outcome === 'WIN' ? AMOUNT * PAYOUT : -AMOUNT;
      const reasons = sigObj.reasons[0] || '';
      const bkt = result.bollingerKT;
      const bbW   = bkt ? (bkt.upper - bkt.lower) / bkt.middle * 10000 : 999;
      const bbMid = bkt ? bkt.middle : null;
      const rsi   = result.rsi_5 !== undefined ? result.rsi_5 : null;
      const maTrend = (result.ma1 && result.ma3) ? (result.ma1 - result.ma3) / result.ma3 * 10000 : 0;
      const priceVsMid = bbMid ? (entry - bbMid) / bbMid * 10000 : null;

      const kDropM   = reasons.match(/K crash ([0-9.]+)pts/);
      const kPrevM   = reasons.match(/K crash [0-9.]+pts \(([0-9.]+)->/);
      const kCurrM   = reasons.match(/K crash [0-9.]+pts \([0-9.]+->([0-9.]+)\)/);
      const rsiFromM = reasons.match(/RSI [0-9.]+ \(from ([0-9.]+)/);
      const velM     = reasons.match(/vel=(-?[0-9.]+)/);
      const hourM    = reasons.match(/UTC ([0-9]+)/);
      const kM       = reasons.match(/K ([0-9.]+) \(>30/);
      const dM       = reasons.match(/D=([0-9.]+)/);

      sigs.push({
        asset, outcome, pl, bbW, rsi, dir, maTrend, priceVsMid,
        hour:    hourM    ? parseInt(hourM[1])      : null,
        kDrop:   kDropM   ? parseFloat(kDropM[1])   : null,
        kPrev:   kPrevM   ? parseFloat(kPrevM[1])   : null,
        kCurr:   kCurrM   ? parseFloat(kCurrM[1])   : null,
        rsiFrom: rsiFromM ? parseFloat(rsiFromM[1]) : null,
        vel:     velM     ? parseFloat(velM[1])     : null,
        stochK:  kM       ? parseFloat(kM[1])       : null,
        stochD:  dM       ? parseFloat(dM[1])       : null,
        isKCrash: reasons.includes('K crash'),
        isPutOB:  reasons.includes('OVERBOUGHT'),
        isCallUT: reasons.includes('UP TREND') && dir === 'CALL',
        isPutDT:  reasons.includes('DOWN TREND') && dir === 'PUT',
      });
    }
  }
  return sigs;
}

function stats(arr) {
  const w = arr.filter(s => s.outcome === 'WIN').length;
  const n = arr.length;
  const pl = arr.reduce((s, x) => s + x.pl, 0);
  return { n, wr: n ? (100 * w / n).toFixed(1) : '-', pl: pl.toFixed(0) };
}

function show(label, arr, base, minN) {
  minN = minN || 5;
  const s = stats(arr);
  if (s.n < minN) return;
  const wrNum = parseFloat(s.wr);
  const baseWR = parseFloat(stats(base).wr);
  const delta = (wrNum - baseWR).toFixed(1);
  const mark = wrNum >= 60 ? ' ◄◄' : (wrNum >= 55 ? ' ◄' : (wrNum <= 40 ? ' ✗' : ''));
  console.log('    ' + label.padEnd(42) + 'n=' + String(s.n).padEnd(5) + ' WR=' + s.wr + '%  PL=$' + s.pl + '  (' + (delta >= 0 ? '+' : '') + delta + 'pp)' + mark);
}

console.log('Loading signals...');
const all    = getSignals();
const kCrash = all.filter(s => s.isKCrash);
const putOB  = all.filter(s => s.isPutOB);
const callUT = all.filter(s => s.isCallUT);
const putDT  = all.filter(s => s.isPutDT);

const dateRange = (() => {
  const d = db.prepare("SELECT date(MIN(timestamp),'unixepoch') as lo, date(MAX(timestamp),'unixepoch') as hi FROM candles").get();
  return d.lo === d.hi ? d.lo : d.lo + ' to ' + d.hi;
})();

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  BEST CONDITIONS BY PATTERN  |  ' + dateRange + '  |  ' + assets.length + ' assets       ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════
// PATTERN 1: CALL K-CRASH REVERSAL
// ═══════════════════════════════════════════════════════════
const kcs = stats(kCrash);
console.log('\n══ 1. CALL K-CRASH REVERSAL  (baseline: n=' + kcs.n + ' WR=' + kcs.wr + '% PL=$' + kcs.pl + ') ══\n');

console.log('  ── K Drop magnitude ──');
[[15,20],[20,25],[25,30],[30,35],[35,99]].forEach(([lo,hi]) => {
  show('kDrop ['+lo+','+hi+')', kCrash.filter(s => s.kDrop !== null && s.kDrop >= lo && s.kDrop < hi), kCrash, 3);
});

console.log('  ── K_prev (was high = bigger crash) ──');
[[40,50],[50,60],[60,70],[70,80],[80,999]].forEach(([lo,hi]) => {
  show('kPrev ['+lo+','+hi+')', kCrash.filter(s => s.kPrev !== null && s.kPrev >= lo && s.kPrev < hi), kCrash, 3);
});

console.log('  ── K_curr (landing zone) ──');
[[0,10],[10,20],[20,25],[25,30],[30,999]].forEach(([lo,hi]) => {
  show('kCurr ['+lo+','+hi+')', kCrash.filter(s => s.kCurr !== null && s.kCurr >= lo && s.kCurr < hi), kCrash, 3);
});

console.log('  ── RSI at signal ──');
[[0,15],[15,20],[20,25],[25,30],[30,40],[40,50]].forEach(([lo,hi]) => {
  show('RSI ['+lo+','+hi+')', kCrash.filter(s => s.rsi !== null && s.rsi >= lo && s.rsi < hi), kCrash, 3);
});

console.log('  ── BB width ──');
[[0,10],[10,20],[20,30],[30,40],[40,60],[60,999]].forEach(([lo,hi]) => {
  show('bbW ['+lo+','+hi+'bps)', kCrash.filter(s => s.bbW >= lo && s.bbW < hi), kCrash, 3);
});

console.log('  ── Price vs BB mid ──');
[[-30,-10],[-10,0],[0,10],[10,30],[30,999]].forEach(([lo,hi]) => {
  show('priceVsMid ['+lo+','+hi+'bps)', kCrash.filter(s => s.priceVsMid !== null && s.priceVsMid >= lo && s.priceVsMid < hi), kCrash, 3);
});

console.log('  ── Hour (UTC) ──');
for (let h = 0; h <= 23; h++) {
  show('hour='+h, kCrash.filter(s => s.hour === h), kCrash, 4);
}

console.log('  ── Top combos ──');
[
  ['kDrop>=25 + rsi<20',          s => s.kDrop >= 25 && s.rsi !== null && s.rsi < 20],
  ['kDrop>=25 + rsi<30',          s => s.kDrop >= 25 && s.rsi !== null && s.rsi < 30],
  ['kDrop>=25 + rsi<40 + bbW>=30',s => s.kDrop >= 25 && s.rsi !== null && s.rsi < 40 && s.bbW >= 30],
  ['kDrop>=25 + bbW>=30',         s => s.kDrop >= 25 && s.bbW >= 30],
  ['kDrop>=25 + bbW>=50',         s => s.kDrop >= 25 && s.bbW >= 50],
  ['kPrev>=60 + kDrop>=20',       s => s.kPrev !== null && s.kPrev >= 60 && s.kDrop !== null && s.kDrop >= 20],
  ['kPrev>=60 + rsi<30',          s => s.kPrev !== null && s.kPrev >= 60 && s.rsi !== null && s.rsi < 30],
  ['kCurr<20 + kDrop>=20',        s => s.kCurr !== null && s.kCurr < 20 && s.kDrop !== null && s.kDrop >= 20],
  ['kCurr<20 + bbW>=30',          s => s.kCurr !== null && s.kCurr < 20 && s.bbW >= 30],
  ['bbW>=50 + rsi<30',            s => s.bbW >= 50 && s.rsi !== null && s.rsi < 30],
  ['bbW[20,50) + rsi<25',         s => s.bbW >= 20 && s.bbW < 50 && s.rsi !== null && s.rsi < 25],
  ['hour18-20 + kDrop>=20',       s => (s.hour >= 18 && s.hour <= 20) && s.kDrop !== null && s.kDrop >= 20],
].forEach(([label, fn]) => show(label, kCrash.filter(fn), kCrash, 3));

// ═══════════════════════════════════════════════════════════
// PATTERN 2: PUT OVERBOUGHT REVERSAL
// ═══════════════════════════════════════════════════════════
const pos = stats(putOB);
console.log('\n══ 2. PUT OVERBOUGHT REVERSAL  (baseline: n=' + pos.n + ' WR=' + pos.wr + '% PL=$' + pos.pl + ') ══\n');

console.log('  ── Prior RSI (rsiFrom) ──');
[[65,70],[70,75],[75,78],[78,80],[80,82],[82,85],[85,999]].forEach(([lo,hi]) => {
  show('rsiFrom ['+lo+','+hi+')', putOB.filter(s => s.rsiFrom !== null && s.rsiFrom >= lo && s.rsiFrom < hi), putOB, 3);
});

console.log('  ── Current RSI ──');
[[30,40],[40,50],[50,60],[60,70]].forEach(([lo,hi]) => {
  show('RSI ['+lo+','+hi+')', putOB.filter(s => s.rsi !== null && s.rsi >= lo && s.rsi < hi), putOB, 3);
});

console.log('  ── RSI velocity ──');
[[-999,-20],[-20,-15],[-15,-12],[-12,-10],[-10,-8],[-8,-5],[-5,0]].forEach(([lo,hi]) => {
  show('vel ['+lo+','+hi+')', putOB.filter(s => s.vel !== null && s.vel >= lo && s.vel < hi), putOB, 3);
});

console.log('  ── Stoch D ──');
[[70,75],[75,80],[80,85],[85,90],[90,999]].forEach(([lo,hi]) => {
  show('stochD ['+lo+','+hi+')', putOB.filter(s => s.stochD !== null && s.stochD >= lo && s.stochD < hi), putOB, 3);
});

console.log('  ── BB width ──');
[[0,20],[20,30],[30,50],[50,999]].forEach(([lo,hi]) => {
  show('bbW ['+lo+','+hi+'bps)', putOB.filter(s => s.bbW >= lo && s.bbW < hi), putOB, 3);
});

console.log('  ── Hour (UTC) ──');
for (let h = 0; h <= 23; h++) {
  show('hour='+h, putOB.filter(s => s.hour === h), putOB, 3);
}

console.log('  ── Top combos ──');
[
  ['rsiFrom>=80 + vel<-12',          s => s.rsiFrom !== null && s.rsiFrom >= 80 && s.vel !== null && s.vel < -12],
  ['rsiFrom>=80 + vel>-15 + vel<-10',s => s.rsiFrom !== null && s.rsiFrom >= 80 && s.vel !== null && s.vel > -15 && s.vel < -10],
  ['rsiFrom>=78 + vel<-10',          s => s.rsiFrom !== null && s.rsiFrom >= 78 && s.vel !== null && s.vel < -10],
  ['rsiFrom>=75 + vel[-15,-10)',     s => s.rsiFrom !== null && s.rsiFrom >= 75 && s.vel !== null && s.vel >= -15 && s.vel < -10],
  ['rsiFrom>=80 + bbW>=30',          s => s.rsiFrom !== null && s.rsiFrom >= 80 && s.bbW >= 30],
  ['vel[-15,-10) + bbW>=30',         s => s.vel !== null && s.vel >= -15 && s.vel < -10 && s.bbW >= 30],
  ['vel[-15,-10) + rsi[40,60)',      s => s.vel !== null && s.vel >= -15 && s.vel < -10 && s.rsi !== null && s.rsi >= 40 && s.rsi < 60],
  ['rsiFrom[80,85) + vel<-10',       s => s.rsiFrom !== null && s.rsiFrom >= 80 && s.rsiFrom < 85 && s.vel !== null && s.vel < -10],
].forEach(([label, fn]) => show(label, putOB.filter(fn), putOB, 3));

// ═══════════════════════════════════════════════════════════
// PATTERN 3: PUT DOWN TREND (continuation)
// ═══════════════════════════════════════════════════════════
const pds = stats(putDT);
console.log('\n══ 3. PUT DOWN TREND  (baseline: n=' + pds.n + ' WR=' + pds.wr + '% PL=$' + pds.pl + ') ══\n');

console.log('  ── BB width ──');
[[0,5],[5,10],[10,15],[15,20],[20,25],[25,30],[30,40],[40,60],[60,999]].forEach(([lo,hi]) => {
  show('bbW ['+lo+','+hi+'bps)', putDT.filter(s => s.bbW >= lo && s.bbW < hi), putDT, 3);
});

console.log('  ── RSI at signal ──');
[[0,20],[20,30],[30,40],[40,50],[50,60],[60,999]].forEach(([lo,hi]) => {
  show('RSI ['+lo+','+hi+')', putDT.filter(s => s.rsi !== null && s.rsi >= lo && s.rsi < hi), putDT, 3);
});

console.log('  ── Price vs BB mid ──');
[[-50,-20],[-20,-10],[-10,-5],[-5,0],[0,5],[5,10],[10,30]].forEach(([lo,hi]) => {
  show('priceVsMid ['+lo+','+hi+'bps)', putDT.filter(s => s.priceVsMid !== null && s.priceVsMid >= lo && s.priceVsMid < hi), putDT, 3);
});

console.log('  ── MA trend ──');
[[-20,-10],[-10,-5],[-5,-2],[-2,0],[0,5],[5,15]].forEach(([lo,hi]) => {
  show('maTrend ['+lo+','+hi+')', putDT.filter(s => s.maTrend >= lo && s.maTrend < hi), putDT, 3);
});

console.log('  ── Stoch K ──');
[[0,20],[20,40],[40,55],[55,70],[70,999]].forEach(([lo,hi]) => {
  show('stochK ['+lo+','+hi+')', putDT.filter(s => s.stochK !== null && s.stochK >= lo && s.stochK < hi), putDT, 3);
});

console.log('  ── Hour (UTC) ──');
for (let h = 0; h <= 23; h++) {
  show('hour='+h, putDT.filter(s => s.hour === h), putDT, 5);
}

console.log('  ── Top combos ──');
[
  ['bbW>=30 + rsi<=40',                 s => s.bbW >= 30 && s.rsi !== null && s.rsi <= 40],
  ['bbW>=30 + rsi<=30',                 s => s.bbW >= 30 && s.rsi !== null && s.rsi <= 30],
  ['bbW>=50 + rsi<=40',                 s => s.bbW >= 50 && s.rsi !== null && s.rsi <= 40],
  ['bbW>=30 + rsi<=40 + priceVsMid<0',  s => s.bbW >= 30 && s.rsi !== null && s.rsi <= 40 && s.priceVsMid !== null && s.priceVsMid < 0],
  ['bbW>=30 + stochK<40',               s => s.bbW >= 30 && s.stochK !== null && s.stochK < 40],
  ['bbW>=30 + stochK<55',               s => s.bbW >= 30 && s.stochK !== null && s.stochK < 55],
  ['bbW[30,60) + rsi[20,40)',           s => s.bbW >= 30 && s.bbW < 60 && s.rsi !== null && s.rsi >= 20 && s.rsi < 40],
  ['bbW>=50 + stochK<40',               s => s.bbW >= 50 && s.stochK !== null && s.stochK < 40],
  ['hour22 + bbW>=30',                  s => s.hour === 22 && s.bbW >= 30],
  ['bbW>=30 + maTrend[-5,-1)',           s => s.bbW >= 30 && s.maTrend >= -5 && s.maTrend < -1],
].forEach(([label, fn]) => show(label, putDT.filter(fn), putDT, 3));

// ═══════════════════════════════════════════════════════════
// PATTERN 4: CALL UP TREND (continuation)
// ═══════════════════════════════════════════════════════════
const cuts = stats(callUT);
console.log('\n══ 4. CALL UP TREND  (baseline: n=' + cuts.n + ' WR=' + cuts.wr + '% PL=$' + cuts.pl + ') ══\n');

if (callUT.length === 0) {
  console.log('  No CALL UP TREND signals in this dataset.');
} else {
  console.log('  ── BB width ──');
  [[0,10],[10,20],[20,30],[30,50],[50,999]].forEach(([lo,hi]) => {
    show('bbW ['+lo+','+hi+'bps)', callUT.filter(s => s.bbW >= lo && s.bbW < hi), callUT, 3);
  });

  console.log('  ── RSI ──');
  [[50,55],[55,60],[60,65],[65,70],[70,80],[80,999]].forEach(([lo,hi]) => {
    show('RSI ['+lo+','+hi+')', callUT.filter(s => s.rsi !== null && s.rsi >= lo && s.rsi < hi), callUT, 3);
  });

  console.log('  ── Stoch K ──');
  [[30,45],[45,60],[60,70],[70,80],[80,90],[90,100]].forEach(([lo,hi]) => {
    show('stochK ['+lo+','+hi+')', callUT.filter(s => s.stochK !== null && s.stochK >= lo && s.stochK < hi), callUT, 3);
  });

  console.log('  ── By asset ──');
  const byA = {};
  callUT.forEach(s => { if (!byA[s.asset]) byA[s.asset] = []; byA[s.asset].push(s); });
  Object.entries(byA)
    .map(([a, arr]) => Object.assign({ a }, stats(arr)))
    .filter(r => r.n >= 3)
    .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr))
    .forEach(r => {
      const tag = parseFloat(r.wr) >= 60 ? ' ◄◄' : (parseFloat(r.wr) <= 40 ? ' ✗' : '');
      console.log('    ' + r.a.padEnd(22) + ' n=' + String(r.n).padEnd(4) + ' WR=' + r.wr + '% PL=$' + r.pl + tag);
    });
}

// ═══════════════════════════════════════════════════════════
// COMBINED BEST CONDITIONS SUMMARY
// ═══════════════════════════════════════════════════════════
console.log('\n══ BEST CONDITIONS SUMMARY — RANKED BY WR ══\n');
const allCombos = [
  // PUT OB
  ['PUT OB  | rsiFrom[80,85)+vel<-10',   putOB.filter(s => s.rsiFrom >= 80 && s.rsiFrom < 85 && s.vel !== null && s.vel < -10)],
  ['PUT OB  | vel[-15,-12)',              putOB.filter(s => s.vel !== null && s.vel >= -15 && s.vel < -12)],
  ['PUT OB  | rsiFrom>=80+bbW>=30',      putOB.filter(s => s.rsiFrom >= 80 && s.bbW >= 30)],
  ['PUT OB  | rsiFrom[75,80)+vel<-12',   putOB.filter(s => s.rsiFrom >= 75 && s.rsiFrom < 80 && s.vel !== null && s.vel < -12)],
  // K-Crash
  ['K-CRASH | kDrop>=25+rsi<20',         kCrash.filter(s => s.kDrop >= 25 && s.rsi !== null && s.rsi < 20)],
  ['K-CRASH | kCurr<20+kDrop>=20',       kCrash.filter(s => s.kCurr !== null && s.kCurr < 20 && s.kDrop !== null && s.kDrop >= 20)],
  ['K-CRASH | kPrev>=60+kDrop>=20',      kCrash.filter(s => s.kPrev !== null && s.kPrev >= 60 && s.kDrop !== null && s.kDrop >= 20)],
  ['K-CRASH | bbW>=50+rsi<30',           kCrash.filter(s => s.bbW >= 50 && s.rsi !== null && s.rsi < 30)],
  // PUT DT
  ['PUT DT  | bbW>=30+rsi<=40',          putDT.filter(s => s.bbW >= 30 && s.rsi !== null && s.rsi <= 40)],
  ['PUT DT  | bbW>=50+rsi<=40',          putDT.filter(s => s.bbW >= 50 && s.rsi !== null && s.rsi <= 40)],
  ['PUT DT  | bbW>=30+stochK<40',        putDT.filter(s => s.bbW >= 30 && s.stochK !== null && s.stochK < 40)],
  ['PUT DT  | bbW>=50',                  putDT.filter(s => s.bbW >= 50)],
  ['PUT DT  | bbW[5,10)',                putDT.filter(s => s.bbW >= 5 && s.bbW < 10)],
  // CALL UT
  ['CALL UT | (see asset breakdown)',    callUT],
].map(([label, arr]) => Object.assign({ label }, stats(arr)))
  .filter(r => r.n >= 5)
  .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));

console.log('  Condition                                     n       WR        P&L');
allCombos.forEach(r => {
  const mark = parseFloat(r.wr) >= 60 ? ' ◄◄ STRONG' : (parseFloat(r.wr) >= 55 ? ' ◄ EDGE' : '');
  console.log('  ' + r.label.padEnd(46) + String(r.n).padEnd(8) + (r.wr + '%').padEnd(10) + '$' + r.pl + mark);
});

console.log('');
db.close();
