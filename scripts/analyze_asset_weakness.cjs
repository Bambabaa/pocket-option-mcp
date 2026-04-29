// Asset Weakness Analysis - Find problematic assets
// Analyzes per-asset performance to identify losers
// Usage: node scripts/analyze_asset_weakness.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║           ASSET WEAKNESS ANALYSIS                         ║');
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

console.log(`Total signals analyzed: ${rows.length}\n`);

// ═══ 1. PER-ASSET PERFORMANCE ════════════════════════════════════════════════
console.log('[ 1. ASSET PERFORMANCE RANKING (120s) ]\n');
console.log('Asset          | Total | Wins | WR     | P/L    | CALL WR | PUT WR  | Verdict');
console.log('---------------|-------|------|--------|--------|---------|---------|--------');

const byAsset = {};
rows.forEach(r => {
  if (!byAsset[r.asset]) {
    byAsset[r.asset] = { 
      total: 0, wins: 0, pl: 0,
      calls: [], puts: []
    };
  }
  byAsset[r.asset].total++;
  if (r.r120 === 'WIN') byAsset[r.asset].wins++;
  byAsset[r.asset].pl += parseFloat(r.pl120);
  
  if (r.dir === 'CALL') byAsset[r.asset].calls.push(r);
  else byAsset[r.asset].puts.push(r);
});

const assetStats = Object.entries(byAsset)
  .map(([asset, data]) => {
    const callWr = data.calls.length > 0 ? 
      (data.calls.filter(r => r.r120 === 'WIN').length / data.calls.length * 100).toFixed(0) : 'N/A';
    const putWr = data.puts.length > 0 ?
      (data.puts.filter(r => r.r120 === 'WIN').length / data.puts.length * 100).toFixed(0) : 'N/A';
    
    const wr = (data.wins / data.total * 100).toFixed(0);
    const verdict = 
      data.wins === 0 ? '❌ BLOCK' :
      parseFloat(wr) < 40 ? '⚠️ AVOID' :
      parseFloat(wr) < 50 ? '⚠️ WATCH' :
      parseFloat(wr) >= 70 ? '✅ ELITE' :
      parseFloat(wr) >= 60 ? '✅ GOOD' : '⚠️ OK';
    
    return {
      asset, 
      total: data.total, 
      wins: data.wins, 
      wr: parseFloat(wr),
      pl: data.pl,
      callWr,
      putWr,
      verdict
    };
  })
  .sort((a, b) => a.wr - b.wr);

assetStats.forEach(a => {
  console.log(
    `${a.asset.padEnd(14)} | ${a.total.toString().padEnd(5)} | ${a.wins.toString().padEnd(4)} | ${a.wr.toFixed(0).padEnd(6)}% | $${a.pl.toString().padStart(5)} | ${a.callWr.padEnd(7)} | ${a.putWr.padEnd(7)} | ${a.verdict}`
  );
});

// ═══ 2. WORST PERFORMING ASSETS ══════════════════════════════════════════════
console.log('\n[ 2. ASSETS TO BLOCK (0% WR or <40% with min 3 signals) ]\n');

const blocklist = assetStats.filter(a => a.wins === 0 || (a.wr < 40 && a.total >= 3));

if (blocklist.length > 0) {
  console.log('Asset          | Signals | WR     | P/L    | Why Block');
  console.log('---------------|---------|--------|--------|----------');
  
  blocklist.forEach(a => {
    const reason = a.wins === 0 ? 'Zero wins' : 'Consistently losing';
    console.log(
      `${a.asset.padEnd(14)} | ${a.total.toString().padEnd(7)} | ${a.wr.toFixed(0).padEnd(6)}% | $${a.pl.toString().padStart(5)} | ${reason}`
    );
  });
  
  console.log(`\nTotal assets to block: ${blocklist.length}`);
} else {
  console.log('✅ No assets meet block criteria');
}

// ═══ 3. DIRECTIONAL BIAS ISSUES ═════════════════════════════════════════════
console.log('\n[ 3. DIRECTIONAL BIAS PROBLEMS ]\n');
console.log('Asset          | CALL    | PUT     | Issue');
console.log('---------------|---------|---------|------');

assetStats.forEach(a => {
  const callData = byAsset[a.asset].calls;
  const putData = byAsset[a.asset].puts;
  
  if (callData.length === 0 && putData.length === 0) return;
  
  const callWr = callData.length > 0 ? 
    callData.filter(r => r.r120 === 'WIN').length / callData.length * 100 : null;
  const putWr = putData.length > 0 ?
    putData.filter(r => r.r120 === 'WIN').length / putData.length * 100 : null;
  
  let issue = null;
  
  // One direction failing badly
  if (callWr !== null && callWr === 0 && callData.length >= 2) {
    issue = 'CALL always loses';
  } else if (putWr !== null && putWr === 0 && putData.length >= 2) {
    issue = 'PUT always loses';
  } else if (callWr !== null && putWr !== null && Math.abs(callWr - putWr) > 50) {
    issue = callWr > putWr ? 'Heavily CALL-biased' : 'Heavily PUT-biased';
  }
  
  if (issue) {
    const callStr = callWr !== null ? `${callWr.toFixed(0)}% (${callData.length})` : 'N/A';
    const putStr = putWr !== null ? `${putWr.toFixed(0)}% (${putData.length})` : 'N/A';
    console.log(
      `${a.asset.padEnd(14)} | ${callStr.padEnd(7)} | ${putStr.padEnd(7)} | ${issue}`
    );
  }
});

// ═══ 4. SAMPLE SIZE ANALYSIS ═════════════════════════════════════════════════
console.log('\n[ 4. SAMPLE SIZE RELIABILITY ]\n');

console.log('Category           | Count | Avg WR | Reliable?');
console.log('-------------------|-------|--------|----------');

const sampleGroups = {
  '1 signal': assetStats.filter(a => a.total === 1),
  '2 signals': assetStats.filter(a => a.total === 2),
  '3-5 signals': assetStats.filter(a => a.total >= 3 && a.total <= 5),
  '6+ signals': assetStats.filter(a => a.total >= 6)
};

for (const [group, assets] of Object.entries(sampleGroups)) {
  if (assets.length === 0) continue;
  const avgWr = assets.reduce((sum, a) => sum + a.wr, 0) / assets.length;
  const reliable = group === '6+ signals' ? '✅ Yes' : 
                   group === '3-5 signals' ? '⚠️ Maybe' : '❌ No';
  console.log(
    `${group.padEnd(18)} | ${assets.length.toString().padEnd(5)} | ${avgWr.toFixed(1).padEnd(6)}% | ${reliable}`
  );
}

// ═══ 5. ASSET CORRELATION WITH STC BEHAVIOR ══════════════════════════════════
console.log('\n[ 5. ASSETS WITH POOR STC BEHAVIOR ]\n');
console.log('Asset          | Avg Δ STC | Weak Bounces | Problem');
console.log('---------------|-----------|--------------|--------');

Object.entries(byAsset).forEach(([asset, data]) => {
  const allSigs = [...data.calls, ...data.puts];
  const deltas = allSigs.map(r => Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)));
  const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  
  const weakBounces = deltas.filter(d => d < 5).length;
  const weakPct = (weakBounces / deltas.length * 100).toFixed(0);
  
  // Flag if weak momentum is common
  if (weakPct >= 50 && data.total >= 3) {
    const problem = `${weakPct}% weak momentum`;
    console.log(
      `${asset.padEnd(14)} | ${avgDelta.toFixed(1).padEnd(9)} | ${weakBounces}/${deltas.length}       | ${problem}`
    );
  }
});

// ═══ 6. WIN/LOSS STREAKS PER ASSET ═══════════════════════════════════════════
console.log('\n[ 6. CONSISTENCY ANALYSIS (min 3 signals) ]\n');
console.log('Asset          | Max Win | Max Loss | Consistency');
console.log('---------------|---------|----------|------------');

Object.entries(byAsset)
  .filter(([, data]) => data.total >= 3)
  .forEach(([asset, data]) => {
    const allSigs = [...data.calls, ...data.puts]
      .sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    
    let maxWin = 0, maxLoss = 0;
    let currWin = 0, currLoss = 0;
    
    allSigs.forEach(s => {
      if (s.r120 === 'WIN') {
        currWin++;
        currLoss = 0;
        maxWin = Math.max(maxWin, currWin);
      } else {
        currLoss++;
        currWin = 0;
        maxLoss = Math.max(maxLoss, currLoss);
      }
    });
    
    const consistency = 
      maxLoss >= 3 ? '❌ Volatile' :
      maxWin >= 3 && maxLoss <= 1 ? '✅ Stable' : '⚠️ Mixed';
    
    console.log(
      `${asset.padEnd(14)} | ${maxWin.toString().padEnd(7)} | ${maxLoss.toString().padEnd(8)} | ${consistency}`
    );
  });

// ═══ RECOMMENDATIONS ══════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                    RECOMMENDATIONS                         ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const toBlock = blocklist.map(a => a.asset);
const watchList = assetStats.filter(a => a.wr >= 40 && a.wr < 50 && a.total >= 3).map(a => a.asset);
const elite = assetStats.filter(a => a.wr >= 70 && a.total >= 3).map(a => a.asset);

console.log('1. BLOCK THESE ASSETS:');
if (toBlock.length > 0) {
  toBlock.forEach(a => console.log(`   • ${a}`));
  console.log(`   Total: ${toBlock.length} assets`);
} else {
  console.log('   ✅ None - all assets have some edge');
}

console.log('\n2. WATCH LIST (40-50% WR):');
if (watchList.length > 0) {
  watchList.forEach(a => console.log(`   • ${a}`));
  console.log(`   Action: Reduce position size or require extra confirmation`);
} else {
  console.log('   ✅ None');
}

console.log('\n3. FOCUS ON ELITE ASSETS (≥70% WR):');
if (elite.length > 0) {
  elite.forEach(a => {
    const stats = assetStats.find(s => s.asset === a);
    console.log(`   • ${a}: ${stats.wr}% (${stats.total} signals)`);
  });
  console.log(`   Action: Prioritize these for live trading`);
} else {
  console.log('   ⚠️  No elite assets found - strategy needs improvement');
}

// Calculate impact of blocking bad assets
const afterBlock = rows.filter(r => !toBlock.includes(r.asset));
const afterWins = afterBlock.filter(r => r.r120 === 'WIN').length;
const afterWr = afterBlock.length > 0 ? (afterWins / afterBlock.length * 100).toFixed(1) : 0;
const afterPl = afterBlock.reduce((sum, r) => sum + parseFloat(r.pl120), 0);

const baseWr = (rows.filter(r => r.r120 === 'WIN').length / rows.length * 100).toFixed(1);
const basePl = rows.reduce((sum, r) => sum + parseFloat(r.pl120), 0);

console.log('\n4. IMPACT OF BLOCKING BAD ASSETS:');
console.log(`   Before: ${rows.length} signals, ${baseWr}% WR, $${basePl}`);
console.log(`   After:  ${afterBlock.length} signals, ${afterWr}% WR, $${afterPl}`);
console.log(`   Change: ${((afterWr - baseWr)).toFixed(1)}% WR improvement`);

if (parseFloat(afterWr) > parseFloat(baseWr)) {
  console.log(`   ✅ RECOMMENDED: Block ${toBlock.length} assets`);
} else {
  console.log(`   ⚠️  Blocking doesn't improve WR - keep all assets`);
}

console.log('');
