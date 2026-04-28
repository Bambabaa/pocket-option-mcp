// Gate Correlation Analysis: Compare bot vs paper strategy performance
// Reads gate_comparison.csv and produces statistical correlation report
// Usage: node scripts/analyze_gate_correlation.cjs

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

console.log('\n=== GATE CORRELATION ANALYSIS ===\n');
console.log(`Total signals: ${rows.length}`);

const strategies = ['BOT_CALL', 'BOT_PUT', 'PAPER_CALL', 'PAPER_PUT'];
const expiries = ['1m', '2m', '3m', '5m', '10m'];

// ── Win Rate by Strategy × Expiry ────────────────────────────────────────────
console.log('\n[ Win Rates by Strategy × Expiry ]');
console.log('Strategy      | 1m    | 2m    | 3m    | 5m    | 10m   | Best');
console.log('------------- | ----- | ----- | ----- | ----- | ----- | ----');

const stats = {};
for (const strat of strategies) {
  const sigs = rows.filter(r => r.signal === strat);
  if (sigs.length === 0) continue;
  
  stats[strat] = {};
  let bestWr = 0, bestExp = null;
  
  const row = [strat.padEnd(13)];
  for (const exp of expiries) {
    const wins = sigs.filter(s => s[`win_${exp}`] === '1').length;
    const total = sigs.filter(s => s[`win_${exp}`] !== '').length;
    const wr = total > 0 ? wins / total : 0;
    stats[strat][exp] = { wins, total, wr };
    
    if (wr > bestWr) { bestWr = wr; bestExp = exp; }
    
    const wrStr = total > 0 ? `${(wr*100).toFixed(0)}%`.padEnd(5) : '-    ';
    row.push(wrStr);
  }
  row.push(`${bestExp} ${(bestWr*100).toFixed(0)}%`);
  console.log(row.join(' | '));
}

// ── Signal Overlap ────────────────────────────────────────────────────────────
console.log('\n[ Signal Overlap Between Bot & Paper ]');
const botCallSigs = rows.filter(r => r.signal === 'BOT_CALL');
const paperCallSigs = rows.filter(r => r.signal === 'PAPER_CALL');
const botPutSigs = rows.filter(r => r.signal === 'BOT_PUT');
const paperPutSigs = rows.filter(r => r.signal === 'PAPER_PUT');

const callOverlap = botCallSigs.filter(b => 
  paperCallSigs.some(p => p.timestamp_utc === b.timestamp_utc && p.asset === b.asset)
);
const putOverlap = botPutSigs.filter(b =>
  paperPutSigs.some(p => p.timestamp_utc === b.timestamp_utc && p.asset === b.asset)
);

console.log(`CALL: ${callOverlap.length}/${botCallSigs.length} bot signals matched paper (${(callOverlap.length/botCallSigs.length*100).toFixed(0)}%)`);
console.log(`PUT:  ${putOverlap.length}/${botPutSigs.length} bot signals matched paper (${(putOverlap.length/botPutSigs.length*100).toFixed(0)}%)`);

// ── Paper-Only Signals (what bot missed) ─────────────────────────────────────
console.log('\n[ Paper-Only Signals (bot missed) ]');
const paperOnlyCall = paperCallSigs.filter(p =>
  !botCallSigs.some(b => b.timestamp_utc === p.timestamp_utc && b.asset === p.asset)
);
const paperOnlyPut = paperPutSigs.filter(p =>
  !botPutSigs.some(b => b.timestamp_utc === p.timestamp_utc && b.asset === p.asset)
);

console.log(`CALL: ${paperOnlyCall.length} signals bot missed`);
if (paperOnlyCall.length > 0) {
  const wr5m = paperOnlyCall.filter(s => s.win_5m === '1').length / paperOnlyCall.filter(s => s.win_5m !== '').length;
  console.log(`  5m WR on missed: ${(wr5m*100).toFixed(0)}% (${paperOnlyCall.filter(s=>s.win_5m==='1').length}/${paperOnlyCall.filter(s=>s.win_5m!=='').length})`);
}

console.log(`PUT:  ${paperOnlyPut.length} signals bot missed`);
if (paperOnlyPut.length > 0) {
  const wr5m = paperOnlyPut.filter(s => s.win_5m === '1').length / paperOnlyPut.filter(s => s.win_5m !== '').length;
  console.log(`  5m WR on missed: ${(wr5m*100).toFixed(0)}% (${paperOnlyPut.filter(s=>s.win_5m==='1').length}/${paperOnlyPut.filter(s=>s.win_5m!=='').length})`);
}

// ── Bot-Only Signals (false positives) ───────────────────────────────────────
console.log('\n[ Bot-Only Signals (paper rejected) ]');
const botOnlyCall = botCallSigs.filter(b =>
  !paperCallSigs.some(p => p.timestamp_utc === b.timestamp_utc && p.asset === b.asset)
);
const botOnlyPut = botPutSigs.filter(b =>
  !paperPutSigs.some(p => p.timestamp_utc === b.timestamp_utc && p.asset === b.asset)
);

console.log(`CALL: ${botOnlyCall.length} signals paper rejected`);
if (botOnlyCall.length > 0) {
  const wr5m = botOnlyCall.filter(s => s.win_5m === '1').length / botOnlyCall.filter(s => s.win_5m !== '').length;
  console.log(`  5m WR on rejected: ${(wr5m*100).toFixed(0)}% (${botOnlyCall.filter(s=>s.win_5m==='1').length}/${botOnlyCall.filter(s=>s.win_5m!=='').length})`);
}

console.log(`PUT:  ${botOnlyPut.length} signals paper rejected`);
if (botOnlyPut.length > 0) {
  const wr5m = botOnlyPut.filter(s => s.win_5m === '1').length / botOnlyPut.filter(s => s.win_5m !== '').length;
  console.log(`  5m WR on rejected: ${(wr5m*100).toFixed(0)}% (${botOnlyPut.filter(s=>s.win_5m==='1').length}/${botOnlyPut.filter(s=>s.win_5m!=='').length})`);
}

// ── Key Findings ──────────────────────────────────────────────────────────────
console.log('\n=== KEY FINDINGS ===\n');

const botCallWr5m = stats.BOT_CALL?.['5m']?.wr || 0;
const botPutWr5m = stats.BOT_PUT?.['5m']?.wr || 0;
const paperCallWr5m = stats.PAPER_CALL?.['5m']?.wr || 0;
const paperPutWr5m = stats.PAPER_PUT?.['5m']?.wr || 0;

console.log(`1. 5m expiry performance:`);
console.log(`   BOT_CALL:   ${(botCallWr5m*100).toFixed(0)}%`);
console.log(`   PAPER_CALL: ${(paperCallWr5m*100).toFixed(0)}% ${paperCallWr5m > botCallWr5m ? '✅ BETTER' : '❌ WORSE'}`);
console.log(`   BOT_PUT:    ${(botPutWr5m*100).toFixed(0)}%`);
console.log(`   PAPER_PUT:  ${(paperPutWr5m*100).toFixed(0)}% ${paperPutWr5m > botPutWr5m ? '✅ BETTER' : '❌ WORSE'}`);

const callImprovement = paperCallWr5m - botCallWr5m;
const putImprovement = paperPutWr5m - botPutWr5m;

console.log(`\n2. Paper strategy improvement:`);
console.log(`   CALL: ${callImprovement >= 0 ? '+' : ''}${(callImprovement*100).toFixed(1)}%`);
console.log(`   PUT:  ${putImprovement >= 0 ? '+' : ''}${(putImprovement*100).toFixed(1)}%`);

console.log(`\n3. Precision trade-off:`);
console.log(`   CALL: Bot fires ${botCallSigs.length}, Paper fires ${paperCallSigs.length} (${paperCallSigs.length - botCallSigs.length > 0 ? '+' : ''}${paperCallSigs.length - botCallSigs.length})`);
console.log(`   PUT:  Bot fires ${botPutSigs.length}, Paper fires ${paperPutSigs.length} (${paperPutSigs.length - botPutSigs.length > 0 ? '+' : ''}${paperPutSigs.length - botPutSigs.length})`);

console.log(`\n4. Recommendation:`);
if (paperCallWr5m > botCallWr5m && paperPutWr5m >= botPutWr5m) {
  console.log('   ✅ APPLY PAPER STRATEGY to bot — better WR with ${paperCallSigs.length + paperPutSigs.length} vs ${botCallSigs.length + botPutSigs.length} signals');
} else if (paperCallWr5m > 0.55 && paperPutWr5m > 0.55) {
  console.log('   ⚠️  PAPER STRATEGY shows edge (>55% WR) but needs more data');
} else {
  console.log('   ❌ PAPER STRATEGY underperforms — keep bot gates or refine further');
}

console.log('\n');
