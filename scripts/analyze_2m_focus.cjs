// 2-Minute Expiry Focus Analysis
// Deep dive into 2m performance to understand gate effectiveness
const fs = require('fs');

const csvPath = 'data/gate_comparison.csv';
const lines = fs.readFileSync(csvPath, 'utf-8').split('\n').filter(l => l.trim());
const header = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const vals = l.split(',');
  const obj = {};
  header.forEach((h, i) => obj[h] = vals[i]);
  return obj;
});

// Filter for 2m signals only
const rows2m = rows.filter(r => r.win_2m !== '');

console.log('\n=== 2-MINUTE EXPIRY DEEP DIVE ===\n');

const strategies = ['BOT_CALL', 'BOT_PUT', 'PAPER_CALL', 'PAPER_PUT'];

console.log('[ Win Rate at 2m ]');
console.log('Strategy      | Wins | Total | WR     | Kelly  ');
console.log('------------- | ---- | ----- | ------ | -------');

const stats = {};
for (const strat of strategies) {
  const sigs = rows2m.filter(r => r.signal === strat);
  if (sigs.length === 0) continue;
  
  const wins = sigs.filter(s => s.win_2m === '1').length;
  const total = sigs.length;
  const wr = wins / total;
  const kelly = wr > 0.52 ? ((wr * 1.92 - 0.08) / 0.92 * 100).toFixed(1) : 0;
  
  stats[strat] = { wins, total, wr, kelly };
  
  const wrColor = wr >= 0.55 ? '✅' : wr >= 0.50 ? '⚠️' : '❌';
  console.log(`${strat.padEnd(13)} | ${wins.toString().padEnd(4)} | ${total.toString().padEnd(5)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${kelly > 0 ? kelly+'%' : 'NONE'} ${wrColor}`);
}

// ── What paper filtered out ──────────────────────────────────────────────────
console.log('\n[ Bot Signals Rejected by Paper (2m) ]');
const botOnly = rows2m.filter(r => 
  (r.signal === 'BOT_CALL' || r.signal === 'BOT_PUT') &&
  !rows2m.some(p => 
    (p.signal === (r.signal === 'BOT_CALL' ? 'PAPER_CALL' : 'PAPER_PUT')) &&
    p.timestamp_utc === r.timestamp_utc && 
    p.asset === r.asset
  )
);

console.log(`Total rejected: ${botOnly.length}`);
if (botOnly.length > 0) {
  const wins = botOnly.filter(r => r.win_2m === '1').length;
  console.log(`WR on rejected: ${(wins/botOnly.length*100).toFixed(0)}% (${wins}/${botOnly.length})`);
  console.log('\nRejected signals:');
  botOnly.forEach(r => {
    const result = r.win_2m === '1' ? 'WIN' : 'LOSS';
    const reason = [];
    
    const rsi = parseFloat(r.rsi_5);
    const stc = parseFloat(r.stc);
    const trough = r.rsi_trough_10 !== '' ? parseFloat(r.rsi_trough_10) : null;
    const peak = r.rsi_peak_10 !== '' ? parseFloat(r.rsi_peak_10) : null;
    
    if (r.signal === 'BOT_CALL') {
      if (stc > 20) reason.push(`STC=${stc.toFixed(0)} > 20`);
      if (rsi >= 20) reason.push(`RSI=${rsi.toFixed(0)} >= 20`);
      if (trough === null || trough >= 15) reason.push(`rsiTrough=${trough?.toFixed(0) || 'null'} >= 15`);
    } else {
      if (stc < 75) reason.push(`STC=${stc.toFixed(0)} < 75`);
      if (peak === null || peak <= 80) reason.push(`rsiPeak=${peak?.toFixed(0) || 'null'} <= 80`);
    }
    
    console.log(`  ${r.timestamp_utc.substr(11,5)} ${r.asset.padEnd(12)} ${r.signal.padEnd(10)} ${result.padEnd(4)} - ${reason.join(', ')}`);
  });
}

// ── What paper added ──────────────────────────────────────────────────────────
console.log('\n[ Paper Signals Bot Missed (2m) ]');
const paperOnly = rows2m.filter(r => 
  (r.signal === 'PAPER_CALL' || r.signal === 'PAPER_PUT') &&
  !rows2m.some(b => 
    (b.signal === (r.signal === 'PAPER_CALL' ? 'BOT_CALL' : 'BOT_PUT')) &&
    b.timestamp_utc === r.timestamp_utc && 
    b.asset === r.asset
  )
);

console.log(`Total added: ${paperOnly.length}`);
if (paperOnly.length > 0) {
  const wins = paperOnly.filter(r => r.win_2m === '1').length;
  console.log(`WR on added: ${(wins/paperOnly.length*100).toFixed(0)}% (${wins}/${paperOnly.length})`);
  console.log('\nAdded signals:');
  paperOnly.forEach(r => {
    const result = r.win_2m === '1' ? 'WIN' : 'LOSS';
    const rsi = parseFloat(r.rsi_5);
    const stc = parseFloat(r.stc);
    const trough = r.rsi_trough_10 !== '' ? parseFloat(r.rsi_trough_10) : null;
    const peak = r.rsi_peak_10 !== '' ? parseFloat(r.rsi_peak_10) : null;
    
    console.log(`  ${r.timestamp_utc.substr(11,5)} ${r.asset.padEnd(12)} ${r.signal.padEnd(11)} ${result.padEnd(4)} RSI=${rsi.toFixed(0)} STC=${stc.toFixed(0)} trough=${trough?.toFixed(0) || 'null'} peak=${peak?.toFixed(0) || 'null'}`);
  });
}

// ── Retracement correlation ───────────────────────────────────────────────────
console.log('\n[ Retracement Depth vs Outcome (2m) ]');
const callSigs = rows2m.filter(r => r.direction === 'CALL' && r.rsi_trough_10 !== '');
const putSigs = rows2m.filter(r => r.direction === 'PUT' && r.rsi_peak_10 !== '');

console.log('\nCALL signals by rsiTrough10:');
const callByTrough = {};
callSigs.forEach(r => {
  const t = parseFloat(r.rsi_trough_10);
  const bucket = t < 5 ? '<5' : t < 10 ? '5-10' : t < 15 ? '10-15' : '>=15';
  if (!callByTrough[bucket]) callByTrough[bucket] = { wins: 0, total: 0 };
  callByTrough[bucket].total++;
  if (r.win_2m === '1') callByTrough[bucket].wins++;
});

Object.entries(callByTrough).sort().forEach(([bucket, data]) => {
  const wr = (data.wins / data.total * 100).toFixed(0);
  console.log(`  ${bucket.padEnd(6)}: ${data.wins}/${data.total} = ${wr}%`);
});

console.log('\nPUT signals by rsiPeak10:');
const putByPeak = {};
putSigs.forEach(r => {
  const p = parseFloat(r.rsi_peak_10);
  const bucket = p < 80 ? '<80' : p < 90 ? '80-90' : p < 95 ? '90-95' : '>=95';
  if (!putByPeak[bucket]) putByPeak[bucket] = { wins: 0, total: 0 };
  putByPeak[bucket].total++;
  if (r.win_2m === '1') putByPeak[bucket].wins++;
});

Object.entries(putByPeak).sort().forEach(([bucket, data]) => {
  const wr = (data.wins / data.total * 100).toFixed(0);
  console.log(`  ${bucket.padEnd(6)}: ${data.wins}/${data.total} = ${wr}%`);
});

// ── Recommendation ────────────────────────────────────────────────────────────
console.log('\n=== 2M EXPIRY RECOMMENDATION ===\n');

const botCallWr = stats.BOT_CALL?.wr || 0;
const botPutWr = stats.BOT_PUT?.wr || 0;
const paperCallWr = stats.PAPER_CALL?.wr || 0;
const paperPutWr = stats.PAPER_PUT?.wr || 0;

console.log(`Current bot at 2m:`);
console.log(`  CALL: ${(botCallWr*100).toFixed(1)}% (${stats.BOT_CALL?.wins || 0}/${stats.BOT_CALL?.total || 0})`);
console.log(`  PUT:  ${(botPutWr*100).toFixed(1)}% (${stats.BOT_PUT?.wins || 0}/${stats.BOT_PUT?.total || 0})`);
console.log(`  Combined: ${(((stats.BOT_CALL?.wins || 0) + (stats.BOT_PUT?.wins || 0)) / ((stats.BOT_CALL?.total || 0) + (stats.BOT_PUT?.total || 0)) * 100).toFixed(1)}%`);

console.log(`\nPaper strategy at 2m:`);
console.log(`  CALL: ${(paperCallWr*100).toFixed(1)}% (${stats.PAPER_CALL?.wins || 0}/${stats.PAPER_CALL?.total || 0})`);
console.log(`  PUT:  ${(paperPutWr*100).toFixed(1)}% (${stats.PAPER_PUT?.wins || 0}/${stats.PAPER_PUT?.total || 0})`);
console.log(`  Combined: ${(((stats.PAPER_CALL?.wins || 0) + (stats.PAPER_PUT?.wins || 0)) / ((stats.PAPER_CALL?.total || 0) + (stats.PAPER_PUT?.total || 0)) * 100).toFixed(1)}%`);

const botCombined = ((stats.BOT_CALL?.wins || 0) + (stats.BOT_PUT?.wins || 0)) / ((stats.BOT_CALL?.total || 0) + (stats.BOT_PUT?.total || 0));
const paperCombined = ((stats.PAPER_CALL?.wins || 0) + (stats.PAPER_PUT?.wins || 0)) / ((stats.PAPER_CALL?.total || 0) + (stats.PAPER_PUT?.total || 0));

console.log(`\nImprovement: ${paperCombined > botCombined ? '+' : ''}${((paperCombined - botCombined)*100).toFixed(1)}%`);

if (paperCombined < 0.50) {
  console.log(`\n❌ Neither strategy viable at 2m (both < 50% WR)`);
  console.log(`   Recommendation: USE 5M EXPIRY instead (Paper shows 60% WR)`);
} else if (paperCombined >= 0.55) {
  console.log(`\n✅ Paper strategy viable at 2m (≥55% WR)`);
  console.log(`   Recommendation: APPLY PAPER GATES with 2m expiry`);
} else {
  console.log(`\n⚠️  Paper strategy marginal at 2m (50-55% WR)`);
  console.log(`   Recommendation: Test with more data or use 5m expiry`);
}

console.log('\n');
