const Database = require('better-sqlite3');
const Indicators = require('../bot/indicators.js');
const dbPath = process.argv[2] || 'data/trading_data.db';
const db = new Database(dbPath, { readonly: true });
const assets = db.prepare('SELECT DISTINCT asset FROM candles GROUP BY asset HAVING COUNT(*) >= 80').all().map(r => r.asset);
const AMOUNT = 500, PAYOUT = 0.92;
// NOTE: No static asset allowlists or blocklists.
// Asset volatility fluctuates over time — any hardcoded list becomes stale.
// Use po_asset_volatility + po_auto_block_sweep for dynamic, data-driven filtering.

function getSignals() {
  const sigs = [];
  for (const asset of assets) {
    const rows = db.prepare('SELECT timestamp, open, close, high, low FROM candles WHERE asset=? ORDER BY timestamp ASC').all(asset);
    const candles = rows.map(r => [r.timestamp, r.open, r.close, r.high, r.low]);
    const ind = new Indicators();
    for (let i = 55; i < candles.length - 2; i++) {
      const result = ind.calculateAll(asset, candles.slice(Math.max(0, i - 59), i + 1), {});
      if (!result) continue;
      const sigObj = { buy: false, sell: false, reasons: [], direction: null };
      ind._generateSignalsKTVideo2(result, {}, sigObj);
      if (!sigObj.buy && !sigObj.sell) continue;
      if (i + 2 >= candles.length) continue; // need 2 bars ahead for 120s expiry
      const sc = candles[i], nc = candles[i + 2]; // 120s expiry = 2 bars forward
      const entry = sc[2], exit = nc[2], dir = sigObj.direction;
      const outcome = dir === 'CALL' ? (exit > entry ? 'WIN' : 'LOSS') : (exit < entry ? 'WIN' : 'LOSS');
      const pl = outcome === 'WIN' ? AMOUNT * PAYOUT : -AMOUNT;
      const reasons = sigObj.reasons[0] || '';
      const bbW = result.bollingerKT
        ? (result.bollingerKT.upper - result.bollingerKT.lower) / result.bollingerKT.middle * 10000
        : 999;
      const rsi = result.rsi_5 !== undefined ? result.rsi_5 : null;
      const kDropM = reasons.match(/K crash ([0-9.]+)pts/);
      const rsiFromM = reasons.match(/RSI [0-9.]+ \(from ([0-9.]+)/);
      const velM = reasons.match(/vel=(-?[0-9.]+)/);
      const hourM = reasons.match(/UTC ([0-9]+)/);
      const kM = reasons.match(/K ([0-9.]+) \(>30/);
      const isLeaf = reasons.includes('Leaf');
      sigs.push({
        asset, outcome, pl, bbW, rsi, dir,
        hour: hourM ? parseInt(hourM[1]) : null,
        kDrop: kDropM ? parseFloat(kDropM[1]) : null,
        rsiFrom: rsiFromM ? parseFloat(rsiFromM[1]) : null,
        vel: velM ? parseFloat(velM[1]) : null,
        stochK: kM ? parseFloat(kM[1]) : null,
        isKCrash: reasons.includes('OVERSOLD') && !isLeaf,
        isPutOB:  reasons.includes('OVERBOUGHT') && !reasons.includes('L65'),
        isCallUT: reasons.includes('UP TREND') && dir === 'CALL' && !isLeaf,
        isPutDT:  reasons.includes('DOWN TREND') && dir === 'PUT' && !reasons.includes('L41'),
        isL16: reasons.includes('L16 Leaf'),
        isL41: reasons.includes('L41 Leaf'),
        isL65: reasons.includes('L65 Leaf'),
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

function pr(label, arr, pad) {
  const s = stats(arr);
  pad = pad || 38;
  return '  ' + label.padEnd(pad) + String(s.n).padEnd(7) + (s.wr + '%').padEnd(9) + '$' + s.pl;
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log('Running replay on ' + assets.length + ' assets...');
const all = getSignals();
const kCrash = all.filter(s => s.isKCrash);
const putOB = all.filter(s => s.isPutOB);
const callUT = all.filter(s => s.isCallUT);
const putDT = all.filter(s => s.isPutDT);
const l16 = all.filter(s => s.isL16);
const l41 = all.filter(s => s.isL41);
const l65 = all.filter(s => s.isL65);

const dateRange = (() => {
  const dates = db.prepare("SELECT date(MIN(timestamp),'unixepoch') as lo, date(MAX(timestamp),'unixepoch') as hi FROM candles").get();
  return dates.lo === dates.hi ? dates.lo : dates.lo + ' to ' + dates.hi;
})();

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  FULL CANDLE REPLAY  |  ' + dateRange + '  |  ' + assets.length + ' assets          ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

// ── Pattern summary
console.log('── PATTERN SUMMARY ─────────────────────────────────────────────────');
console.log('  Pattern                              n       WR        P&L');
console.log(pr('ALL SIGNALS', all));
console.log(pr('CALL Reversal (K-Crash)', kCrash));
console.log(pr('PUT Reversal (OB)', putOB));
console.log(pr('CALL Up Trend', callUT));
console.log(pr('PUT Down Trend', putDT));
console.log(pr('L16 CALL (ML Leaf)', l16));
console.log(pr('L41 PUT  (ML Leaf)', l41));
console.log(pr('L65 PUT  (ML Leaf)', l65));

// ── CALL Reversal
console.log('\n── CALL REVERSAL: GATE BREAKDOWN ───────────────────────────────────');
console.log('  K Drop:');
[[0, 20], [20, 25], [25, 30], [30, 35], [35, 99]].forEach(([lo, hi]) => {
  const f = kCrash.filter(s => s.kDrop !== null && s.kDrop >= lo && s.kDrop < hi);
  const s = stats(f);
  console.log('    kDrop [' + lo + ',' + hi + '): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
console.log('  RSI:');
[[0, 20], [20, 30], [30, 40], [40, 50]].forEach(([lo, hi]) => {
  const f = kCrash.filter(s => s.rsi !== null && s.rsi >= lo && s.rsi < hi);
  const s = stats(f);
  console.log('    RSI [' + lo + ',' + hi + '): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
console.log('  BB width:');
[[0, 10], [10, 20], [20, 30], [30, 50], [50, 999]].forEach(([lo, hi]) => {
  const f = kCrash.filter(s => s.bbW >= lo && s.bbW < hi);
  const s = stats(f);
  console.log('    bbW [' + lo + ',' + hi + 'bps): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
const recKC = kCrash.filter(s => s.kDrop !== null && s.kDrop >= 25 && s.rsi !== null && s.rsi < 40 && s.bbW >= 30);
console.log('  >> Recommended (kDrop>=25 + rsi<40 + bbW>=30): n=' + recKC.length + ' WR=' + stats(recKC).wr + '% PL=$' + stats(recKC).pl);

// ── PUT OB
console.log('\n── PUT OB: GATE BREAKDOWN ──────────────────────────────────────────');
console.log('  Prior RSI (rsiFrom):');
[[0, 75], [75, 80], [80, 85], [85, 100]].forEach(([lo, hi]) => {
  const f = putOB.filter(s => s.rsiFrom !== null && s.rsiFrom >= lo && s.rsiFrom < hi);
  const s = stats(f);
  console.log('    rsiFrom [' + lo + ',' + hi + '): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
console.log('  Velocity:');
[[-999, -15], [-15, -12], [-12, -10], [-10, -5], [-5, 0]].forEach(([lo, hi]) => {
  const f = putOB.filter(s => s.vel !== null && s.vel >= lo && s.vel < hi);
  const s = stats(f);
  console.log('    vel [' + lo + ',' + hi + '): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
console.log('  BB width:');
[[0, 10], [10, 20], [20, 30], [30, 999]].forEach(([lo, hi]) => {
  const f = putOB.filter(s => s.bbW >= lo && s.bbW < hi);
  const s = stats(f);
  console.log('    bbW [' + lo + ',' + hi + 'bps): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
const recPO = putOB.filter(s => s.rsiFrom !== null && s.rsiFrom >= 80 && s.bbW >= 10);
console.log('  >> Recommended (rsiFrom>=80 + bbW>=10): n=' + recPO.length + ' WR=' + stats(recPO).wr + '% PL=$' + stats(recPO).pl);

// ── PUT Down Trend
console.log('\n── PUT DOWN TREND: GATE BREAKDOWN ──────────────────────────────────');
[[0, 5], [5, 10], [10, 15], [15, 20], [20, 30], [30, 50], [50, 999]].forEach(([lo, hi]) => {
  const f = putDT.filter(s => s.bbW >= lo && s.bbW < hi);
  const s = stats(f);
  console.log('    bbW [' + lo + ',' + hi + 'bps): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
});
const recPD20 = putDT.filter(s => s.bbW >= 20);
const recPD30 = putDT.filter(s => s.bbW >= 30);
const recPD30r = putDT.filter(s => s.bbW >= 30 && s.rsi !== null && s.rsi <= 40);
console.log('  >> bbW>=20:              n=' + recPD20.length + ' WR=' + stats(recPD20).wr + '% PL=$' + stats(recPD20).pl);
console.log('  >> bbW>=30:              n=' + recPD30.length + ' WR=' + stats(recPD30).wr + '% PL=$' + stats(recPD30).pl);
console.log('  >> bbW>=30 + rsi<=40:    n=' + recPD30r.length + ' WR=' + stats(recPD30r).wr + '% PL=$' + stats(recPD30r).pl);

// ── Call Up Trend
// NOTE: CALL UP TREND is currently disabled in the live bot (commented out in indicators.js).
// Breakdown shown for reference only. No static asset list — filter by BB width like all other patterns.
console.log('\n── CALL UP TREND: GATE BREAKDOWN ───────────────────────────────────');
if (callUT.length === 0) {
  console.log('  No CALL UP TREND signals in this dataset. (Pattern is disabled in live bot.)');
} else {
  console.log('  BB width:');
  [[0, 10], [10, 20], [20, 30], [30, 999]].forEach(([lo, hi]) => {
    const f = callUT.filter(s => s.bbW >= lo && s.bbW < hi);
    const s = stats(f);
    console.log('    bbW [' + lo + ',' + hi + 'bps): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
  });
  console.log('  Stoch K:');
  [[30, 50], [50, 70], [70, 90], [90, 100]].forEach(([lo, hi]) => {
    const f = callUT.filter(s => s.stochK !== null && s.stochK >= lo && s.stochK < hi);
    const s = stats(f);
    console.log('    K [' + lo + ',' + hi + '): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
  });
}

// ── ML Leaf breakdown
console.log('\n── ML LEAF BREAKDOWN ───────────────────────────────────────────────');
console.log('  Leaf   Dir   n       WR        P&L');
[['L16', l16, 'CALL'], ['L41', l41, 'PUT'], ['L65', l65, 'PUT']].forEach(([name, arr, dir]) => {
  const s = stats(arr);
  console.log('  ' + name.padEnd(7) + dir.padEnd(6) + String(s.n).padEnd(8) + (s.wr + '%').padEnd(10) + '$' + s.pl);
});

console.log('\n  BB width by leaf:');
[['L16', l16], ['L41', l41], ['L65', l65]].forEach(([name, arr]) => {
  if (arr.length === 0) { console.log('  ' + name + ': no signals'); return; }
  [[0, 20], [20, 30], [30, 50], [50, 100], [100, 999]].forEach(([lo, hi]) => {
    const f = arr.filter(s => s.bbW >= lo && s.bbW < hi);
    if (f.length === 0) return;
    const s = stats(f);
    console.log('    ' + name + ' bbW [' + lo + ',' + hi + 'bps): n=' + s.n + ' WR=' + s.wr + '% PL=$' + s.pl);
  });
});

console.log('\n  Hour breakdown by leaf:');
[['L16', l16], ['L41', l41], ['L65', l65]].forEach(([name, arr]) => {
  if (arr.length === 0) { console.log('  ' + name + ': no signals'); return; }
  const byHour = {};
  arr.forEach(s => { if (s.hour != null) { byHour[s.hour] = byHour[s.hour] || []; byHour[s.hour].push(s); } });
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
  const parts = hours.map(h => {
    const s = stats(byHour[h]);
    return 'UTC' + h + ': n=' + s.n + ' ' + s.wr + '%';
  });
  console.log('  ' + name + ': ' + parts.join(' | '));
});

console.log('\n  Top assets by leaf (min 3 signals):');
[['L16', l16], ['L41', l41], ['L65', l65]].forEach(([name, arr]) => {
  if (arr.length === 0) { console.log('  ' + name + ': no signals'); return; }
  const byAssetL = {};
  arr.forEach(s => { byAssetL[s.asset] = byAssetL[s.asset] || []; byAssetL[s.asset].push(s); });
  const ranked = Object.entries(byAssetL)
    .map(([a, a2]) => Object.assign({ a }, stats(a2)))
    .filter(r => r.n >= 3)
    .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr))
    .slice(0, 5);
  if (ranked.length === 0) { console.log('  ' + name + ': no asset with n>=3'); return; }
  console.log('  ' + name + ': ' + ranked.map(r => r.a + ' ' + r.wr + '% n=' + r.n).join(' | '));
});

// ── Recommended combined
// CALL UP TREND: use BB >= 20 bps gate, same as other patterns — no static asset list.
const recCU = callUT.filter(s => s.bbW >= 20);
const recAll = [...recKC, ...recPO, ...recCU, ...recPD20, ...l16, ...l41, ...l65];
const recAllNoLeaf = [...recKC, ...recPO, ...recCU, ...recPD20];
const sBase = stats(all);
const sRec = stats(recAll);
const sRecNoLeaf = stats(recAllNoLeaf);
const delta = parseInt(sRec.pl) - parseInt(sBase.pl);
const deltaNoLeaf = parseInt(sRecNoLeaf.pl) - parseInt(sBase.pl);

console.log('\n── BASELINE vs RECOMMENDED GATES ───────────────────────────────────');
console.log('  Config                              n       WR        P&L       Delta');
console.log(pr('Baseline (all signals)', all, 36) + '  —');
console.log(pr('Recommended excl. leaves', recAllNoLeaf, 36) + '  +$' + deltaNoLeaf);
console.log(pr('Recommended incl. leaves', recAll, 36) + '  +$' + delta);

// Tighter PutDT variant
const recAllTight = [...recKC, ...recPO, ...recCU, ...recPD30r, ...l16, ...l41, ...l65];
const sRecTight = stats(recAllTight);
const deltaTight = parseInt(sRecTight.pl) - parseInt(sBase.pl);
console.log(pr('Tighter PutDT + leaves', recAllTight, 36) + '  +$' + deltaTight);

// ── Asset leaderboard
console.log('\n── ASSET LEADERBOARD (all patterns, min 5 signals) ─────────────────');
console.log('  Asset                  n       WR        P&L');
const byAsset = {};
all.forEach(s => {
  if (!byAsset[s.asset]) byAsset[s.asset] = [];
  byAsset[s.asset].push(s);
});
const ranked = Object.entries(byAsset)
  .map(([a, arr]) => Object.assign({ a }, stats(arr)))
  .filter(r => r.n >= 5)
  .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));

ranked.slice(0, 15).forEach(r => {
  const tag = parseFloat(r.wr) >= 60 ? ' ✓' : '';
  console.log('  ' + r.a.padEnd(22) + String(r.n).padEnd(8) + (r.wr + '%').padEnd(10) + '$' + r.pl + tag);
});
console.log('  ...');
ranked.slice(-8).forEach(r => {
  const tag = parseFloat(r.wr) < 40 ? ' ✗' : '';
  console.log('  ' + r.a.padEnd(22) + String(r.n).padEnd(8) + (r.wr + '%').padEnd(10) + '$' + r.pl + tag);
});

// ── Hour breakdown
console.log('\n── HOUR-BY-HOUR (UTC) ──────────────────────────────────────────────');
console.log('  Hour   All                  PutDT              CallRev');
for (let h = 0; h <= 23; h++) {
  const hs = all.filter(s => s.hour === h);
  if (hs.length === 0) continue;
  const hpd = hs.filter(s => s.isPutDT);
  const hkc = hs.filter(s => s.isKCrash);
  const sa = stats(hs), sp = stats(hpd), sk = stats(hkc);
  console.log('  ' + String(h).padStart(2) + ':00   n=' + String(sa.n).padEnd(4) + ' WR=' + String(sa.wr + '%').padEnd(7) + ' $' + String(sa.pl).padEnd(9) +
    '  n=' + String(sp.n).padEnd(4) + ' WR=' + String(sp.wr + '%').padEnd(7) +
    '  n=' + String(sk.n).padEnd(4) + ' WR=' + sk.wr + '%');
}

console.log('');
db.close();
