// Asset Quality Validation Report
// Analyzes all assets and validates good/bad classification
// Usage: node scripts/validate_asset_quality.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║           ASSET QUALITY VALIDATION REPORT                 ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Load replay signals CSV
const lines = fs.readFileSync('data/replay_signals.csv', 'utf-8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  header.forEach((h, i) => obj[h] = vals[i]);
  return obj;
});

console.log(`Total signals: ${rows.length}\n`);

// ═══ 1. GROUP BY ASSET ════════════════════════════════════════════════════════
console.log('[ 1. GROUPING SIGNALS BY ASSET ]\n');

const assetGroups = {};

rows.forEach(r => {
  if (!assetGroups[r.asset]) {
    assetGroups[r.asset] = {
      signals: [],
      wins: 0,
      losses: 0,
      callWins: 0,
      callLoss: 0,
      putWins: 0,
      putLoss: 0,
      stcDeltas: [],
      bbWidths: []
    };
  }
  
  const group = assetGroups[r.asset];
  group.signals.push(r);
  
  const win = r.r120 === 'WIN';
  if (win) group.wins++;
  else group.losses++;
  
  if (r.dir === 'CALL') {
    if (win) group.callWins++;
    else group.callLoss++;
  } else {
    if (win) group.putWins++;
    else group.putLoss++;
  }
  
  group.stcDeltas.push(Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)));
  group.bbWidths.push(parseFloat(r.bb_bps));
});

const assets = Object.keys(assetGroups).sort();
console.log(`Total assets: ${assets.length}\n`);

// ═══ 2. CALCULATE PER-ASSET STATS ════════════════════════════════════════════
console.log('[ 2. CALCULATING PER-ASSET STATISTICS ]\n');

const assetStats = assets.map(asset => {
  const g = assetGroups[asset];
  const total = g.wins + g.losses;
  const wr = total > 0 ? (g.wins / total * 100) : 0;
  
  const callTotal = g.callWins + g.callLoss;
  const callWr = callTotal > 0 ? (g.callWins / callTotal * 100) : 0;
  
  const putTotal = g.putWins + g.putLoss;
  const putWr = putTotal > 0 ? (g.putWins / putTotal * 100) : 0;
  
  const avgStcDelta = g.stcDeltas.reduce((a, b) => a + b, 0) / g.stcDeltas.length;
  const avgBbWidth = g.bbWidths.reduce((a, b) => a + b, 0) / g.bbWidths.length;
  
  return {
    asset,
    total,
    wins: g.wins,
    losses: g.losses,
    wr,
    callTotal,
    callWr,
    putTotal,
    putWr,
    avgStcDelta,
    avgBbWidth
  };
});

// Sort by WR descending
assetStats.sort((a, b) => b.wr - a.wr);

console.log('Asset              | Signals | Wins | Loss | WR     | CALL WR | PUT WR  | Avg STC Δ | Avg BB bps');
console.log('-------------------|---------|------|------|--------|---------|---------|-----------|------------');

assetStats.forEach(s => {
  const wrColor = s.wr >= 60 ? '✅' : s.wr >= 50 ? '⚠️ ' : '❌';
  console.log(
    `${s.asset.padEnd(18)} | ${s.total.toString().padStart(7)} | ${s.wins.toString().padStart(4)} | ${s.losses.toString().padStart(4)} | ${s.wr.toFixed(1).padStart(5)}% ${wrColor} | ${s.callWr.toFixed(1).padStart(6)}% | ${s.putWr.toFixed(1).padStart(6)}% | ${s.avgStcDelta.toFixed(2).padStart(9)} | ${s.avgBbWidth.toFixed(1).padStart(10)}`
  );
});

// ═══ 3. CLASSIFY ASSETS ══════════════════════════════════════════════════════
console.log('\n[ 3. ASSET CLASSIFICATION ]\n');

const excellent = assetStats.filter(s => s.wr >= 70 && s.total >= 3);
const good = assetStats.filter(s => s.wr >= 60 && s.wr < 70 && s.total >= 3);
const marginal = assetStats.filter(s => s.wr >= 50 && s.wr < 60 && s.total >= 3);
const poor = assetStats.filter(s => s.wr >= 40 && s.wr < 50 && s.total >= 3);
const bad = assetStats.filter(s => s.wr < 40 && s.total >= 3);
const lowSample = assetStats.filter(s => s.total < 3);

console.log('Classification (min 3 signals):');
console.log(`  ✅ EXCELLENT (≥70% WR): ${excellent.length} assets`);
console.log(`  ✅ GOOD (60-69% WR):    ${good.length} assets`);
console.log(`  ⚠️  MARGINAL (50-59%):  ${marginal.length} assets`);
console.log(`  ❌ POOR (40-49%):       ${poor.length} assets`);
console.log(`  ❌ BAD (<40%):          ${bad.length} assets`);
console.log(`  ⏸️  LOW SAMPLE (<3):    ${lowSample.length} assets\n`);

// ═══ 4. DETAILED BREAKDOWN ═══════════════════════════════════════════════════
console.log('[ 4. EXCELLENT ASSETS (≥70% WR) ]\n');

if (excellent.length > 0) {
  excellent.forEach(s => {
    console.log(`  ${s.asset.padEnd(20)} ${s.wr.toFixed(1).padStart(5)}% WR  (${s.wins}W/${s.losses}L, n=${s.total})`);
    console.log(`    CALL: ${s.callWr.toFixed(1)}% (${s.callTotal}), PUT: ${s.putWr.toFixed(1)}% (${s.putTotal})`);
    console.log(`    Avg STC Δ: ${s.avgStcDelta.toFixed(2)}, Avg BB: ${s.avgBbWidth.toFixed(1)} bps\n`);
  });
} else {
  console.log('  None\n');
}

console.log('[ 5. GOOD ASSETS (60-69% WR) ]\n');

if (good.length > 0) {
  good.forEach(s => {
    console.log(`  ${s.asset.padEnd(20)} ${s.wr.toFixed(1).padStart(5)}% WR  (${s.wins}W/${s.losses}L, n=${s.total})`);
    console.log(`    CALL: ${s.callWr.toFixed(1)}% (${s.callTotal}), PUT: ${s.putWr.toFixed(1)}% (${s.putTotal})`);
    console.log(`    Avg STC Δ: ${s.avgStcDelta.toFixed(2)}, Avg BB: ${s.avgBbWidth.toFixed(1)} bps\n`);
  });
} else {
  console.log('  None\n');
}

console.log('[ 6. MARGINAL ASSETS (50-59% WR) ]\n');

if (marginal.length > 0) {
  marginal.forEach(s => {
    console.log(`  ${s.asset.padEnd(20)} ${s.wr.toFixed(1).padStart(5)}% WR  (${s.wins}W/${s.losses}L, n=${s.total})`);
    console.log(`    CALL: ${s.callWr.toFixed(1)}% (${s.callTotal}), PUT: ${s.putWr.toFixed(1)}% (${s.putTotal})`);
    console.log(`    Avg STC Δ: ${s.avgStcDelta.toFixed(2)}, Avg BB: ${s.avgBbWidth.toFixed(1)} bps\n`);
  });
} else {
  console.log('  None\n');
}

console.log('[ 7. POOR ASSETS (40-49% WR) ]\n');

if (poor.length > 0) {
  poor.forEach(s => {
    console.log(`  ${s.asset.padEnd(20)} ${s.wr.toFixed(1).padStart(5)}% WR  (${s.wins}W/${s.losses}L, n=${s.total})`);
    console.log(`    CALL: ${s.callWr.toFixed(1)}% (${s.callTotal}), PUT: ${s.putWr.toFixed(1)}% (${s.putTotal})`);
    console.log(`    Avg STC Δ: ${s.avgStcDelta.toFixed(2)}, Avg BB: ${s.avgBbWidth.toFixed(1)} bps\n`);
  });
} else {
  console.log('  None\n');
}

console.log('[ 8. BAD ASSETS (<40% WR) — BLOCK CANDIDATES ]\n');

if (bad.length > 0) {
  bad.forEach(s => {
    console.log(`  ❌ ${s.asset.padEnd(20)} ${s.wr.toFixed(1).padStart(5)}% WR  (${s.wins}W/${s.losses}L, n=${s.total})`);
    console.log(`     CALL: ${s.callWr.toFixed(1)}% (${s.callTotal}), PUT: ${s.putWr.toFixed(1)}% (${s.putTotal})`);
    console.log(`     Avg STC Δ: ${s.avgStcDelta.toFixed(2)}, Avg BB: ${s.avgBbWidth.toFixed(1)} bps`);
    console.log(`     → RECOMMENDATION: BLOCK\n`);
  });
} else {
  console.log('  None\n');
}

// ═══ 5. FEATURE COMPARISON: GOOD vs BAD ══════════════════════════════════════
console.log('[ 9. FEATURE COMPARISON: GOOD vs BAD ASSETS ]\n');

const goodAssets = [...excellent, ...good];
const badAssets = [...poor, ...bad];

if (goodAssets.length > 0 && badAssets.length > 0) {
  const goodAvgStc = goodAssets.reduce((sum, s) => sum + s.avgStcDelta, 0) / goodAssets.length;
  const badAvgStc = badAssets.reduce((sum, s) => sum + s.avgStcDelta, 0) / badAssets.length;
  
  const goodAvgBb = goodAssets.reduce((sum, s) => sum + s.avgBbWidth, 0) / goodAssets.length;
  const badAvgBb = badAssets.reduce((sum, s) => sum + s.avgBbWidth, 0) / badAssets.length;
  
  const goodAvgWr = goodAssets.reduce((sum, s) => sum + s.wr, 0) / goodAssets.length;
  const badAvgWr = badAssets.reduce((sum, s) => sum + s.wr, 0) / badAssets.length;
  
  console.log('Feature          | Good Assets (≥60%) | Bad Assets (<50%) | Difference');
  console.log('-----------------|--------------------|--------------------|------------');
  console.log(`Win Rate         | ${goodAvgWr.toFixed(1).padStart(17)}% | ${badAvgWr.toFixed(1).padStart(17)}% | ${(goodAvgWr - badAvgWr).toFixed(1).padStart(9)}%`);
  console.log(`Avg STC Delta    | ${goodAvgStc.toFixed(2).padStart(18)} | ${badAvgStc.toFixed(2).padStart(18)} | ${(goodAvgStc - badAvgStc).toFixed(2).padStart(10)}`);
  console.log(`Avg BB Width bps | ${goodAvgBb.toFixed(1).padStart(18)} | ${badAvgBb.toFixed(1).padStart(18)} | ${(goodAvgBb - badAvgBb).toFixed(1).padStart(10)}`);
}

// ═══ 6. EXPORT BLOCKLIST ═════════════════════════════════════════════════════
console.log('\n[ 10. RECOMMENDED BLOCKLIST ]\n');

const blockList = bad.map(s => s.asset);

console.log('Assets to block (WR < 40%, n ≥ 3):\n');

if (blockList.length > 0) {
  console.log('const BLOCKED_ASSETS = new Set([');
  blockList.forEach((asset, i) => {
    const comma = i < blockList.length - 1 ? ',' : '';
    console.log(`    '${asset}'${comma}`);
  });
  console.log(']);');
  
  console.log(`\nTotal: ${blockList.length} assets`);
  
  // Calculate impact
  const blockSignals = bad.reduce((sum, s) => sum + s.total, 0);
  const remainSignals = rows.length - blockSignals;
  const blockWins = bad.reduce((sum, s) => sum + s.wins, 0);
  const remainWins = assetStats.reduce((sum, s) => sum + s.wins, 0) - blockWins;
  
  const beforeWr = (assetStats.reduce((sum, s) => sum + s.wins, 0) / rows.length * 100);
  const afterWr = (remainWins / remainSignals * 100);
  
  console.log(`\nImpact:`);
  console.log(`  Before: ${rows.length} signals, ${beforeWr.toFixed(1)}% WR`);
  console.log(`  After:  ${remainSignals} signals (-${blockSignals}), ${afterWr.toFixed(1)}% WR (+${(afterWr - beforeWr).toFixed(1)}%)`);
} else {
  console.log('✅ No assets meet blocking criteria (<40% WR)\n');
}

// ═══ SUMMARY ══════════════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                    VALIDATION SUMMARY                      ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('Asset Quality Distribution:');
console.log(`  ✅ Excellent (≥70%): ${excellent.length} assets, ${excellent.reduce((s, a) => s + a.total, 0)} signals`);
console.log(`  ✅ Good (60-69%):    ${good.length} assets, ${good.reduce((s, a) => s + a.total, 0)} signals`);
console.log(`  ⚠️  Marginal (50-59%): ${marginal.length} assets, ${marginal.reduce((s, a) => s + a.total, 0)} signals`);
console.log(`  ❌ Poor (40-49%):    ${poor.length} assets, ${poor.reduce((s, a) => s + a.total, 0)} signals`);
console.log(`  ❌ BAD (<40%):       ${bad.length} assets, ${bad.reduce((s, a) => s + a.total, 0)} signals → BLOCK THESE`);

console.log('\nConclusion:');
if (bad.length > 0 || poor.length > 0) {
  const blockSignals = [...bad, ...poor].reduce((sum, s) => sum + s.total, 0);
  const remainSignals = rows.length - blockSignals;
  const blockWins = [...bad, ...poor].reduce((sum, s) => sum + s.wins, 0);
  const remainWins = assetStats.reduce((sum, s) => sum + s.wins, 0) - blockWins;
  
  const beforeWr = (assetStats.reduce((sum, s) => sum + s.wins, 0) / rows.length * 100);
  const afterWr = (remainWins / remainSignals * 100);
  
  console.log(`  → Block ${bad.length + poor.length} assets with <50% WR`);
  console.log(`  → Expected WR improvement: ${(afterWr - beforeWr).toFixed(1)}%`);
  console.log(`  → Trade frequency: -${(blockSignals / rows.length * 100).toFixed(0)}%`);
} else {
  console.log('  ✅ No assets require blocking');
}

console.log('');
