// STC Momentum Filter Simulator
// Compares current gates vs improved momentum-based gates
// Usage: node scripts/simulate_momentum_filters.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║         STC MOMENTUM FILTER SIMULATION                    ║');
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

console.log(`Total signals in replay: ${rows.length}\n`);

// ═══ CURRENT GATES (BASELINE) ════════════════════════════════════════════════
function currentGates(row) {
  const dir = row.dir;
  const stc = parseFloat(row.stc);
  const stcPrev = parseFloat(row.stc_prev);
  
  if (dir === 'CALL') {
    // Current CALL: prevSTC ≤ 25, STC < 75, rising
    return stcPrev <= 25 && stc < 75 && stc > stcPrev;
  } else {
    // Current PUT: prevSTC ≥ 75, STC > 25, falling
    return stcPrev >= 75 && stc > 25 && stc < stcPrev;
  }
}

// ═══ IMPROVED GATES (MOMENTUM FILTERS) ═══════════════════════════════════════
function improvedGates(row) {
  const dir = row.dir;
  const stc = parseFloat(row.stc);
  const stcPrev = parseFloat(row.stc_prev);
  const delta = stc - stcPrev;
  
  if (dir === 'CALL') {
    // Improved CALL: prevSTC ≤ 25, STC < 75, rising >10
    return stcPrev <= 25 && stc < 75 && delta > 10;
  } else {
    // Improved PUT: (75 ≤ prevSTC < 90) OR (prevSTC ≥ 90 AND falling >10)
    const shallowCeiling = stcPrev >= 75 && stcPrev < 90 && delta < 0;
    const deepWithMomentum = stcPrev >= 90 && delta < -10;
    return stc > 25 && (shallowCeiling || deepWithMomentum);
  }
}

// ═══ ALTERNATIVE: AGGRESSIVE MOMENTUM FILTER ═════════════════════════════════
function aggressiveGates(row) {
  const dir = row.dir;
  const stc = parseFloat(row.stc);
  const stcPrev = parseFloat(row.stc_prev);
  const delta = stc - stcPrev;
  
  if (dir === 'CALL') {
    // Aggressive CALL: prevSTC ≤ 25, rising >15 (strongest bounces only)
    return stcPrev <= 25 && stc < 75 && delta > 15;
  } else {
    // Aggressive PUT: prevSTC 75-90 OR deep with strong rollover (>15)
    const shallowCeiling = stcPrev >= 75 && stcPrev < 90 && delta < 0;
    const deepWithStrongRoll = stcPrev >= 90 && delta < -15;
    return stc > 25 && (shallowCeiling || deepWithStrongRoll);
  }
}

// ═══ RUN SIMULATIONS ══════════════════════════════════════════════════════════
const simulations = {
  'CURRENT (baseline)': { filter: currentGates, signals: [] },
  'IMPROVED (momentum Δ>10)': { filter: improvedGates, signals: [] },
  'AGGRESSIVE (momentum Δ>15)': { filter: aggressiveGates, signals: [] }
};

// Filter signals through each gate set
rows.forEach(row => {
  for (const [name, sim] of Object.entries(simulations)) {
    if (sim.filter(row)) {
      sim.signals.push(row);
    }
  }
});

// ═══ RESULTS COMPARISON ═══════════════════════════════════════════════════════
console.log('[ SIMULATION RESULTS - 120s EXPIRY ]\n');
console.log('Strategy                    | Signals | Wins | WR     | P/L     | Δ Signals | Δ WR');
console.log('----------------------------|---------|------|--------|---------|-----------|-------');

const baseline = simulations['CURRENT (baseline)'];
const baselineWins = baseline.signals.filter(s => s.r120 === 'WIN').length;
const baselineWr = baseline.signals.length > 0 ? baselineWins / baseline.signals.length : 0;
const baselinePl = baseline.signals.reduce((sum, s) => sum + parseFloat(s.pl120), 0);

for (const [name, sim] of Object.entries(simulations)) {
  const wins = sim.signals.filter(s => s.r120 === 'WIN').length;
  const total = sim.signals.length;
  const wr = total > 0 ? wins / total : 0;
  const pl = sim.signals.reduce((sum, s) => sum + parseFloat(s.pl120), 0);
  
  const deltaSigs = total - baseline.signals.length;
  const deltaWr = ((wr - baselineWr) * 100).toFixed(1);
  const deltaSigStr = deltaSigs >= 0 ? `+${deltaSigs}` : deltaSigs.toString();
  const deltaWrStr = deltaWr >= 0 ? `+${deltaWr}%` : `${deltaWr}%`;
  
  console.log(
    `${name.padEnd(27)} | ${total.toString().padEnd(7)} | ${wins.toString().padEnd(4)} | ${(wr*100).toFixed(1).padEnd(6)}% | $${pl.toString().padStart(6)} | ${deltaSigStr.padEnd(9)} | ${deltaWrStr.padEnd(6)}`
  );
}

// ═══ BREAKDOWN BY DIRECTION ═══════════════════════════════════════════════════
console.log('\n[ BREAKDOWN BY DIRECTION ]\n');

for (const [name, sim] of Object.entries(simulations)) {
  console.log(`${name}:`);
  
  const calls = sim.signals.filter(s => s.dir === 'CALL');
  const puts = sim.signals.filter(s => s.dir === 'PUT');
  
  const callWins = calls.filter(s => s.r120 === 'WIN').length;
  const putWins = puts.filter(s => s.r120 === 'WIN').length;
  
  const callWr = calls.length > 0 ? (callWins / calls.length * 100).toFixed(1) : '0.0';
  const putWr = puts.length > 0 ? (putWins / puts.length * 100).toFixed(1) : '0.0';
  
  const callPl = calls.reduce((sum, s) => sum + parseFloat(s.pl120), 0);
  const putPl = puts.reduce((sum, s) => sum + parseFloat(s.pl120), 0);
  
  console.log(`  CALL: ${callWins}/${calls.length} = ${callWr}% ($${callPl})`);
  console.log(`  PUT:  ${putWins}/${puts.length} = ${putWr}% ($${putPl})`);
  console.log('');
}

// ═══ MOMENTUM DISTRIBUTION ANALYSIS ═══════════════════════════════════════════
console.log('[ MOMENTUM DISTRIBUTION IN IMPROVED STRATEGY ]\n');

const improved = simulations['IMPROVED (momentum Δ>10)'];

console.log('CALL Momentum Ranges:');
const callDeltas = improved.signals.filter(s => s.dir === 'CALL').map(s => ({
  delta: parseFloat(s.stc) - parseFloat(s.stc_prev),
  win: s.r120 === 'WIN'
}));

const callRanges = {
  '10-15': callDeltas.filter(d => d.delta >= 10 && d.delta < 15),
  '15-20': callDeltas.filter(d => d.delta >= 15 && d.delta < 20),
  '20+':   callDeltas.filter(d => d.delta >= 20)
};

for (const [range, deltas] of Object.entries(callRanges)) {
  if (deltas.length === 0) continue;
  const wins = deltas.filter(d => d.win).length;
  const wr = (wins / deltas.length * 100).toFixed(0);
  console.log(`  Δ ${range}: ${wins}/${deltas.length} = ${wr}%`);
}

console.log('\nPUT Momentum Ranges:');
const putDeltas = improved.signals.filter(s => s.dir === 'PUT').map(s => ({
  delta: parseFloat(s.stc) - parseFloat(s.stc_prev),
  stcPrev: parseFloat(s.stc_prev),
  win: s.r120 === 'WIN'
}));

const putShallow = putDeltas.filter(d => d.stcPrev >= 75 && d.stcPrev < 90);
const putDeep = putDeltas.filter(d => d.stcPrev >= 90);

const shallowWins = putShallow.filter(d => d.win).length;
const deepWins = putDeep.filter(d => d.win).length;

console.log(`  Shallow (75-90): ${shallowWins}/${putShallow.length} = ${(shallowWins/putShallow.length*100).toFixed(0)}%`);
console.log(`  Deep (90+, Δ<-10): ${deepWins}/${putDeep.length} = ${putDeep.length > 0 ? (deepWins/putDeep.length*100).toFixed(0) : 'N/A'}%`);

// ═══ SIGNAL QUALITY ANALYSIS ══════════════════════════════════════════════════
console.log('\n[ SIGNAL QUALITY COMPARISON ]\n');

console.log('Metric                  | Current | Improved | Aggressive');
console.log('------------------------|---------|----------|------------');

for (const metric of ['Total Signals', 'CALL Signals', 'PUT Signals', 'Avg P/L per Signal', 'Win Streak Potential']) {
  const curr = simulations['CURRENT (baseline)'];
  const impr = simulations['IMPROVED (momentum Δ>10)'];
  const aggr = simulations['AGGRESSIVE (momentum Δ>15)'];
  
  let currVal, imprVal, aggrVal;
  
  if (metric === 'Total Signals') {
    currVal = curr.signals.length;
    imprVal = impr.signals.length;
    aggrVal = aggr.signals.length;
  } else if (metric === 'CALL Signals') {
    currVal = curr.signals.filter(s => s.dir === 'CALL').length;
    imprVal = impr.signals.filter(s => s.dir === 'CALL').length;
    aggrVal = aggr.signals.filter(s => s.dir === 'CALL').length;
  } else if (metric === 'PUT Signals') {
    currVal = curr.signals.filter(s => s.dir === 'PUT').length;
    imprVal = impr.signals.filter(s => s.dir === 'PUT').length;
    aggrVal = aggr.signals.filter(s => s.dir === 'PUT').length;
  } else if (metric === 'Avg P/L per Signal') {
    currVal = curr.signals.length > 0 ? Math.round(curr.signals.reduce((s, r) => s + parseFloat(r.pl120), 0) / curr.signals.length) : 0;
    imprVal = impr.signals.length > 0 ? Math.round(impr.signals.reduce((s, r) => s + parseFloat(r.pl120), 0) / impr.signals.length) : 0;
    aggrVal = aggr.signals.length > 0 ? Math.round(aggr.signals.reduce((s, r) => s + parseFloat(r.pl120), 0) / aggr.signals.length) : 0;
    currVal = '$' + currVal;
    imprVal = '$' + imprVal;
    aggrVal = '$' + aggrVal;
  } else if (metric === 'Win Streak Potential') {
    // Max consecutive wins
    const maxStreak = (sigs) => {
      let max = 0, curr = 0;
      sigs.forEach(s => {
        if (s.r120 === 'WIN') { curr++; max = Math.max(max, curr); }
        else curr = 0;
      });
      return max;
    };
    currVal = maxStreak(curr.signals);
    imprVal = maxStreak(impr.signals);
    aggrVal = maxStreak(aggr.signals);
  }
  
  console.log(`${metric.padEnd(23)} | ${String(currVal).padStart(7)} | ${String(imprVal).padStart(8)} | ${String(aggrVal).padStart(10)}`);
}

// ═══ RECOMMENDATIONS ══════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                      RECOMMENDATION                        ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const improvedStats = simulations['IMPROVED (momentum Δ>10)'];
const improvedWr = improvedStats.signals.length > 0 ? 
  improvedStats.signals.filter(s => s.r120 === 'WIN').length / improvedStats.signals.length * 100 : 0;

const aggressiveStats = simulations['AGGRESSIVE (momentum Δ>15)'];
const aggressiveWr = aggressiveStats.signals.length > 0 ?
  aggressiveStats.signals.filter(s => s.r120 === 'WIN').length / aggressiveStats.signals.length * 100 : 0;

if (improvedWr > baselineWr * 100 && improvedStats.signals.length >= 30) {
  console.log(`✅ IMPLEMENT: IMPROVED STRATEGY (momentum Δ>10)`);
  console.log(`   Win Rate:  ${baselineWr.toFixed(1)}% → ${improvedWr.toFixed(1)}% (+${(improvedWr - baselineWr * 100).toFixed(1)}%)`);
  console.log(`   Signals:   ${baseline.signals.length} → ${improvedStats.signals.length} (${((improvedStats.signals.length - baseline.signals.length) / baseline.signals.length * 100).toFixed(0)}%)`);
  console.log(`   P/L:       $${baselinePl} → $${improvedStats.signals.reduce((s, r) => s + parseFloat(r.pl120), 0)}`);
  console.log(`   Verdict:   Better WR with reasonable signal count`);
} else if (aggressiveWr > baselineWr * 100) {
  console.log(`⚠️  CONSIDER: AGGRESSIVE STRATEGY (momentum Δ>15)`);
  console.log(`   Win Rate:  ${baselineWr.toFixed(1)}% → ${aggressiveWr.toFixed(1)}% (+${(aggressiveWr - baselineWr * 100).toFixed(1)}%)`);
  console.log(`   Signals:   ${baseline.signals.length} → ${aggressiveStats.signals.length} (${((aggressiveStats.signals.length - baseline.signals.length) / baseline.signals.length * 100).toFixed(0)}%)`);
  console.log(`   Trade-off: Highest WR but fewer signals - may reduce daily opportunities`);
} else {
  console.log(`⚠️  KEEP CURRENT: Momentum filters don't improve performance enough`);
  console.log(`   Consider testing other filter combinations`);
}

console.log('');
