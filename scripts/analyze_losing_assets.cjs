// Deep Dive into Losing Assets
// Analyzes the 8 losing assets to understand why they fail
// Usage: node scripts/analyze_losing_assets.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║         DEEP DIVE: LOSING ASSETS ANALYSIS                 ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Load CSV
const lines = fs.readFileSync('data/replay_signals.csv', 'utf-8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  header.forEach((h, i) => obj[h] = vals[i]);
  return obj;
});

// The 8 losing assets identified
const losingAssets = [
  'EURUSD_otc',
  'LBPUSD_otc',
  'EURJPY_otc',
  'KESUSD_otc',
  'GBPJPY_otc',
  'TNDUSD_otc',
  'MADUSD_otc',
  'GBPUSD_otc'
];

const losingSignals = rows.filter(r => losingAssets.includes(r.asset));

console.log(`Total losing asset signals: ${losingSignals.length}`);
console.log(`Losing assets: ${losingAssets.length}\n`);

// ═══ 1. INDIVIDUAL ASSET BREAKDOWN ═══════════════════════════════════════════
console.log('[ 1. DETAILED BREAKDOWN PER LOSING ASSET ]\n');

losingAssets.forEach(asset => {
  const sigs = rows.filter(r => r.asset === asset);
  if (sigs.length === 0) return;
  
  console.log(`\n━━━ ${asset} ━━━`);
  console.log(`Total: ${sigs.length} | Wins: ${sigs.filter(s => s.r120 === 'WIN').length} | Losses: ${sigs.filter(s => s.r120 === 'LOSS').length}`);
  console.log(`P/L: $${sigs.reduce((sum, s) => sum + parseFloat(s.pl120), 0)}`);
  
  console.log('\nSignal Details:');
  console.log('Date       | Time     | Dir  | STC→Curr | Δ     | RSI  | K→D  | BB(bps) | Result');
  console.log('-----------|----------|------|----------|-------|------|------|---------|-------');
  
  sigs.forEach(s => {
    const date = s.date || new Date(parseInt(s.timestamp) * 1000).toISOString().split('T')[0];
    const time = new Date(parseInt(s.timestamp) * 1000).toISOString().split('T')[1].slice(0, 5);
    const stcPrev = parseFloat(s.stc_prev).toFixed(1);
    const stc = parseFloat(s.stc).toFixed(1);
    const delta = (parseFloat(s.stc) - parseFloat(s.stc_prev)).toFixed(1);
    const rsi = parseFloat(s.rsi).toFixed(0);
    const k = parseFloat(s.k).toFixed(0);
    const d = parseFloat(s.d).toFixed(0);
    const bbBps = parseFloat(s.bb_bps).toFixed(0);
    const result = s.r120 === 'WIN' ? '✅ WIN' : '❌ LOSS';
    
    console.log(
      `${date} | ${time} | ${s.dir.padEnd(4)} | ${stcPrev}→${stc.padEnd(4)} | ${delta.padStart(5)} | ${rsi.padEnd(4)} | ${k}→${d.padEnd(2)} | ${bbBps.padEnd(7)} | ${result}`
    );
  });
  
  // Common characteristics
  const avgDelta = sigs.reduce((sum, s) => sum + Math.abs(parseFloat(s.stc) - parseFloat(s.stc_prev)), 0) / sigs.length;
  const avgBbBps = sigs.reduce((sum, s) => sum + parseFloat(s.bb_bps), 0) / sigs.length;
  const avgRsi = sigs.reduce((sum, s) => sum + parseFloat(s.rsi), 0) / sigs.length;
  
  console.log('\nCharacteristics:');
  console.log(`  Avg STC Delta:  ${avgDelta.toFixed(1)} ${avgDelta < 5 ? '⚠️ WEAK' : ''}`);
  console.log(`  Avg BB Width:   ${avgBbBps.toFixed(0)} bps ${avgBbBps < 20 ? '⚠️ TIGHT' : ''}`);
  console.log(`  Avg RSI:        ${avgRsi.toFixed(0)}`);
  
  // Check if it's a specific direction problem
  const calls = sigs.filter(s => s.dir === 'CALL');
  const puts = sigs.filter(s => s.dir === 'PUT');
  if (calls.length > 0 && puts.length === 0) {
    console.log(`  ⚠️  ONLY CALL signals - no PUT data`);
  } else if (puts.length > 0 && calls.length === 0) {
    console.log(`  ⚠️  ONLY PUT signals - no CALL data`);
  } else if (calls.length > 0 && puts.length > 0) {
    const callWr = calls.filter(s => s.r120 === 'WIN').length / calls.length * 100;
    const putWr = puts.filter(s => s.r120 === 'WIN').length / puts.length * 100;
    console.log(`  CALL: ${callWr.toFixed(0)}% (${calls.length}) | PUT: ${putWr.toFixed(0)}% (${puts.length})`);
    if (Math.abs(callWr - putWr) > 50) {
      console.log(`  ⚠️  SEVERE DIRECTIONAL BIAS`);
    }
  }
});

// ═══ 2. COMMON PATTERNS IN LOSING ASSETS ═════════════════════════════════════
console.log('\n\n[ 2. COMMON PATTERNS ACROSS ALL LOSING ASSETS ]\n');

console.log('Metric                  | Losers Avg | Winners Avg | Gap');
console.log('------------------------|------------|-------------|-----');

const winningSignals = rows.filter(r => !losingAssets.includes(r.asset));

const metrics = [
  {
    name: 'STC Delta (abs)',
    loser: losingSignals.reduce((s, r) => s + Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / losingSignals.length,
    winner: winningSignals.reduce((s, r) => s + Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / winningSignals.length
  },
  {
    name: 'BB Width (bps)',
    loser: losingSignals.reduce((s, r) => s + parseFloat(r.bb_bps), 0) / losingSignals.length,
    winner: winningSignals.reduce((s, r) => s + parseFloat(r.bb_bps), 0) / winningSignals.length
  },
  {
    name: 'RSI',
    loser: losingSignals.reduce((s, r) => s + parseFloat(r.rsi), 0) / losingSignals.length,
    winner: winningSignals.reduce((s, r) => s + parseFloat(r.rsi), 0) / winningSignals.length
  },
  {
    name: 'Stoch K',
    loser: losingSignals.reduce((s, r) => s + parseFloat(r.k), 0) / losingSignals.length,
    winner: winningSignals.reduce((s, r) => s + parseFloat(r.k), 0) / winningSignals.length
  },
  {
    name: 'STC (current)',
    loser: losingSignals.reduce((s, r) => s + parseFloat(r.stc), 0) / losingSignals.length,
    winner: winningSignals.reduce((s, r) => s + parseFloat(r.stc), 0) / winningSignals.length
  }
];

metrics.forEach(m => {
  const gap = Math.abs(m.loser - m.winner);
  const pct = (gap / m.winner * 100).toFixed(0);
  console.log(
    `${m.name.padEnd(23)} | ${m.loser.toFixed(1).padStart(10)} | ${m.winner.toFixed(1).padStart(11)} | ${gap.toFixed(1)} (${pct}%)`
  );
});

// ═══ 3. GATE FAILURES ═════════════════════════════════════════════════════════
console.log('\n[ 3. WHICH GATES ARE PASSING BUT SHOULDN\'T? ]\n');

console.log('Asset          | Weak Δ | Tight BB | Mid RSI | Issue');
console.log('---------------|--------|----------|---------|------');

losingAssets.forEach(asset => {
  const sigs = rows.filter(r => r.asset === asset);
  if (sigs.length === 0) return;
  
  const weakDelta = sigs.filter(s => Math.abs(parseFloat(s.stc) - parseFloat(s.stc_prev)) < 5).length;
  const tightBb = sigs.filter(s => parseFloat(s.bb_bps) < 15).length;
  const midRsi = sigs.filter(s => {
    const rsi = parseFloat(s.rsi);
    return rsi > 35 && rsi < 65; // Neither extreme
  }).length;
  
  const issues = [];
  if (weakDelta / sigs.length >= 0.5) issues.push('Weak momentum');
  if (tightBb / sigs.length >= 0.5) issues.push('Tight BB');
  if (midRsi / sigs.length >= 0.5) issues.push('Mid RSI');
  
  console.log(
    `${asset.padEnd(14)} | ${weakDelta}/${sigs.length}    | ${tightBb}/${sigs.length}       | ${midRsi}/${sigs.length}      | ${issues.join(', ') || 'Other'}`
  );
});

// ═══ 4. TIMING ANALYSIS ═══════════════════════════════════════════════════════
console.log('\n[ 4. WHEN DO LOSING ASSETS SIGNAL? ]\n');

const losersByHour = {};
losingSignals.forEach(s => {
  const hour = new Date(parseInt(s.timestamp) * 1000).getUTCHours();
  if (!losersByHour[hour]) losersByHour[hour] = 0;
  losersByHour[hour]++;
});

console.log('Hour (UTC) | Losing Signals | Total Signals | % of Hour');
console.log('-----------|----------------|---------------|----------');

for (let hour = 0; hour < 24; hour++) {
  const loserCount = losersByHour[hour] || 0;
  const totalCount = rows.filter(r => new Date(parseInt(r.timestamp) * 1000).getUTCHours() === hour).length;
  if (totalCount === 0) continue;
  const pct = (loserCount / totalCount * 100).toFixed(0);
  if (loserCount > 0) {
    console.log(
      `${hour.toString().padStart(2)}         | ${loserCount.toString().padEnd(14)} | ${totalCount.toString().padEnd(13)} | ${pct}%`
    );
  }
}

// ═══ 5. DATABASE DISTRIBUTION ═════════════════════════════════════════════════
console.log('\n[ 5. WHICH DATABASES HAVE LOSING ASSETS? ]\n');

const byDb = {};
losingSignals.forEach(s => {
  if (!byDb[s.db]) byDb[s.db] = { total: 0, assets: new Set() };
  byDb[s.db].total++;
  byDb[s.db].assets.add(s.asset);
});

console.log('Database       | Signals | Unique Assets');
console.log('---------------|---------|---------------');

Object.keys(byDb).sort().forEach(db => {
  console.log(
    `${db.padEnd(14)} | ${byDb[db].total.toString().padEnd(7)} | ${byDb[db].assets.size}`
  );
});

// ═══ RECOMMENDATIONS ══════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                      KEY INSIGHTS                          ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Find the most common issue
const weakDeltaCount = losingSignals.filter(s => Math.abs(parseFloat(s.stc) - parseFloat(s.stc_prev)) < 5).length;
const tightBbCount = losingSignals.filter(s => parseFloat(s.bb_bps) < 15).length;

console.log('1. PRIMARY FAILURE MODE:');
console.log(`   ${weakDeltaCount}/${losingSignals.length} (${(weakDeltaCount/losingSignals.length*100).toFixed(0)}%) have weak STC momentum (Δ < 5)`);
console.log(`   ${tightBbCount}/${losingSignals.length} (${(tightBbCount/losingSignals.length*100).toFixed(0)}%) have tight BB (< 15 bps)`);

const avgDeltaLoser = losingSignals.reduce((s, r) => s + Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / losingSignals.length;
const avgDeltaWinner = winningSignals.reduce((s, r) => s + Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / winningSignals.length;

console.log(`\n   Losers avg Δ: ${avgDeltaLoser.toFixed(1)}`);
console.log(`   Winners avg Δ: ${avgDeltaWinner.toFixed(1)}`);
console.log(`   Gap: ${(avgDeltaWinner - avgDeltaLoser).toFixed(1)} (${((avgDeltaWinner - avgDeltaLoser) / avgDeltaWinner * 100).toFixed(0)}% difference)`);

console.log('\n2. ASSETS TO PERMANENTLY BLOCK:');
const zeroWinAssets = losingAssets.filter(a => {
  const sigs = rows.filter(r => r.asset === a);
  return sigs.filter(s => s.r120 === 'WIN').length === 0;
});
console.log(`   ${zeroWinAssets.length} assets with 0% WR:`);
zeroWinAssets.forEach(a => console.log(`   • ${a}`));

console.log('\n3. POTENTIAL RESCUE (if sample size increases):');
const smallSampleLosers = losingAssets.filter(a => {
  const sigs = rows.filter(r => r.asset === a);
  return sigs.length <= 2 && sigs.filter(s => s.r120 === 'WIN').length === 0;
});
if (smallSampleLosers.length > 0) {
  console.log(`   ${smallSampleLosers.length} assets with ≤2 signals (may improve with more data):`);
  smallSampleLosers.forEach(a => console.log(`   • ${a}`));
} else {
  console.log('   None - all losers have sufficient sample size');
}

console.log('\n4. COMBINED FILTER IMPACT:');
const wouldBeBlocked = rows.filter(r => {
  const delta = Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev));
  return delta < 5 || parseFloat(r.bb_bps) < 15;
}).length;

console.log(`   If we add: (STC Δ ≥ 5 AND BB ≥ 15 bps)`);
console.log(`   Would block: ${wouldBeBlocked}/${rows.length} signals (${(wouldBeBlocked/rows.length*100).toFixed(0)}%)`);
console.log(`   Of blocked: ${losingSignals.filter(r => Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)) < 5 || parseFloat(r.bb_bps) < 15).length}/${losingSignals.length} are losing assets`);

console.log('\n✅ RECOMMENDATION: BLOCK THE 8 ASSETS (not add filters)');
console.log('   Reason: Asset-specific issues, not systemic gate problems\n');
