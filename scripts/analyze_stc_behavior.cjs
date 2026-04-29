// STC Behavior Analysis - Previous vs Current
// Analyzes STC transitions and their impact on win rates
// Usage: node scripts/analyze_stc_behavior.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║         STC BEHAVIOR ANALYSIS - PREV vs CURRENT           ║');
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

// ═══ 1. STC TRANSITION PATTERNS ══════════════════════════════════════════════
console.log('[ 1. STC TRANSITION PATTERNS (120s) ]\n');
console.log('Direction | From Zone    | To Zone      | Count | WR     | Avg Δ');
console.log('----------|--------------|--------------|-------|--------|-------');

function getZone(stc) {
  if (stc <= 20) return '0-20';
  if (stc <= 30) return '20-30';
  if (stc <= 50) return '30-50';
  if (stc <= 70) return '50-70';
  if (stc <= 90) return '70-90';
  return '90-100';
}

const transitions = {};
rows.forEach(r => {
  const stcPrev = parseFloat(r.stc_prev);
  const stc = parseFloat(r.stc);
  const dir = r.dir;
  const delta = stc - stcPrev;
  
  const fromZone = getZone(stcPrev);
  const toZone = getZone(stc);
  const key = `${dir}|${fromZone}|${toZone}`;
  
  if (!transitions[key]) {
    transitions[key] = { dir, fromZone, toZone, count: 0, wins: 0, deltas: [] };
  }
  
  transitions[key].count++;
  if (r.r120 === 'WIN') transitions[key].wins++;
  transitions[key].deltas.push(delta);
});

Object.values(transitions)
  .sort((a, b) => b.count - a.count)
  .forEach(t => {
    const wr = (t.wins / t.count * 100).toFixed(0);
    const avgDelta = (t.deltas.reduce((s, d) => s + d, 0) / t.deltas.length).toFixed(1);
    console.log(
      `${t.dir.padEnd(9)} | ${t.fromZone.padEnd(12)} | ${t.toZone.padEnd(12)} | ${t.count.toString().padEnd(5)} | ${wr.padEnd(6)}% | ${avgDelta.padStart(6)}`
    );
  });

// ═══ 2. STC DELTA (MOMENTUM) ANALYSIS ═══════════════════════════════════════
console.log('\n[ 2. STC MOMENTUM (Delta = Current - Previous) ]\n');
console.log('Direction | Delta Range  | Count | WR     | Avg Delta');
console.log('----------|--------------|-------|--------|----------');

const deltaRanges = {
  'CALL': {
    '0-5':   [],
    '5-10':  [],
    '10-20': [],
    '20+':   []
  },
  'PUT': {
    '0 to -5':    [],
    '-5 to -10':  [],
    '-10 to -20': [],
    '-20+':       []
  }
};

rows.forEach(r => {
  const delta = parseFloat(r.stc) - parseFloat(r.stc_prev);
  const dir = r.dir;
  
  if (dir === 'CALL') {
    if (delta <= 5) deltaRanges.CALL['0-5'].push(r);
    else if (delta <= 10) deltaRanges.CALL['5-10'].push(r);
    else if (delta <= 20) deltaRanges.CALL['10-20'].push(r);
    else deltaRanges.CALL['20+'].push(r);
  } else {
    const absDelta = Math.abs(delta);
    if (absDelta <= 5) deltaRanges.PUT['0 to -5'].push(r);
    else if (absDelta <= 10) deltaRanges.PUT['-5 to -10'].push(r);
    else if (absDelta <= 20) deltaRanges.PUT['-10 to -20'].push(r);
    else deltaRanges.PUT['-20+'].push(r);
  }
});

for (const [dir, ranges] of Object.entries(deltaRanges)) {
  for (const [range, sigs] of Object.entries(ranges)) {
    if (sigs.length === 0) continue;
    const wins = sigs.filter(s => s.r120 === 'WIN').length;
    const wr = (wins / sigs.length * 100).toFixed(0);
    const deltas = sigs.map(s => parseFloat(s.stc) - parseFloat(s.stc_prev));
    const avgDelta = (deltas.reduce((s, d) => s + d, 0) / deltas.length).toFixed(1);
    
    console.log(
      `${dir.padEnd(9)} | ${range.padEnd(12)} | ${sigs.length.toString().padEnd(5)} | ${wr.padEnd(6)}% | ${avgDelta.padStart(9)}`
    );
  }
}

// ═══ 3. EXTREME TRANSITIONS (BOUNCE ANALYSIS) ═══════════════════════════════
console.log('\n[ 3. EXTREME STC TRANSITIONS ]\n');
console.log('Type              | Count | WR     | Avg Prev | Avg Curr | Description');
console.log('------------------|-------|--------|----------|----------|------------');

const extremes = {
  'Deep Floor (<10)': rows.filter(r => r.dir === 'CALL' && parseFloat(r.stc_prev) < 10),
  'Shallow Floor (10-25)': rows.filter(r => r.dir === 'CALL' && parseFloat(r.stc_prev) >= 10 && parseFloat(r.stc_prev) <= 25),
  'Deep Ceiling (>90)': rows.filter(r => r.dir === 'PUT' && parseFloat(r.stc_prev) > 90),
  'Shallow Ceiling (75-90)': rows.filter(r => r.dir === 'PUT' && parseFloat(r.stc_prev) >= 75 && parseFloat(r.stc_prev) <= 90),
};

for (const [type, sigs] of Object.entries(extremes)) {
  if (sigs.length === 0) continue;
  const wins = sigs.filter(s => s.r120 === 'WIN').length;
  const wr = (wins / sigs.length * 100).toFixed(0);
  const avgPrev = (sigs.reduce((s, r) => s + parseFloat(r.stc_prev), 0) / sigs.length).toFixed(1);
  const avgCurr = (sigs.reduce((s, r) => s + parseFloat(r.stc), 0) / sigs.length).toFixed(1);
  
  const desc = type.includes('Floor') ? 'Bouncing from bottom' : 'Rolling from top';
  
  console.log(
    `${type.padEnd(17)} | ${sigs.length.toString().padEnd(5)} | ${wr.padEnd(6)}% | ${avgPrev.padStart(8)} | ${avgCurr.padStart(8)} | ${desc}`
  );
}

// ═══ 4. CALL vs PUT STC POSITIONING ═════════════════════════════════════════
console.log('\n[ 4. CALL vs PUT - STC POSITIONING ]\n');

const callStats = rows.filter(r => r.dir === 'CALL');
const putStats = rows.filter(r => r.dir === 'PUT');

console.log('Metric            | CALL          | PUT');
console.log('------------------|---------------|---------------');

const callAvgPrev = (callStats.reduce((s, r) => s + parseFloat(r.stc_prev), 0) / callStats.length).toFixed(1);
const callAvgCurr = (callStats.reduce((s, r) => s + parseFloat(r.stc), 0) / callStats.length).toFixed(1);
const putAvgPrev = (putStats.reduce((s, r) => s + parseFloat(r.stc_prev), 0) / putStats.length).toFixed(1);
const putAvgCurr = (putStats.reduce((s, r) => s + parseFloat(r.stc), 0) / putStats.length).toFixed(1);

const callAvgDelta = (callStats.reduce((s, r) => s + (parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / callStats.length).toFixed(1);
const putAvgDelta = (putStats.reduce((s, r) => s + (parseFloat(r.stc) - parseFloat(r.stc_prev)), 0) / putStats.length).toFixed(1);

const callMinPrev = Math.min(...callStats.map(r => parseFloat(r.stc_prev))).toFixed(1);
const callMaxPrev = Math.max(...callStats.map(r => parseFloat(r.stc_prev))).toFixed(1);
const putMinPrev = Math.min(...putStats.map(r => parseFloat(r.stc_prev))).toFixed(1);
const putMaxPrev = Math.max(...putStats.map(r => parseFloat(r.stc_prev))).toFixed(1);

const callWins = callStats.filter(r => r.r120 === 'WIN').length;
const putWins = putStats.filter(r => r.r120 === 'WIN').length;
const callWr = (callWins / callStats.length * 100).toFixed(1);
const putWr = (putWins / putStats.length * 100).toFixed(1);

console.log(`Avg STC Prev      | ${callAvgPrev.padStart(13)} | ${putAvgPrev.padStart(13)}`);
console.log(`Avg STC Current   | ${callAvgCurr.padStart(13)} | ${putAvgCurr.padStart(13)}`);
console.log(`Avg Delta         | +${callAvgDelta.padStart(12)} | ${putAvgDelta.padStart(13)}`);
console.log(`Range (Prev)      | ${callMinPrev}-${callMaxPrev}     | ${putMinPrev}-${putMaxPrev}`);
console.log(`Win Rate (120s)   | ${callWr}%         | ${putWr}%`);
console.log(`Signals           | ${callStats.length.toString().padStart(13)} | ${putStats.length.toString().padStart(13)}`);

// ═══ 5. HIGH-CONFIDENCE PATTERNS ════════════════════════════════════════════
console.log('\n[ 5. HIGH-CONFIDENCE STC PATTERNS (≥60% WR, min 5 signals) ]\n');
console.log('Pattern                                  | Count | WR     | Avg P/L');
console.log('-----------------------------------------|-------|--------|--------');

const patterns = [
  {
    name: 'CALL: STC prev ≤15, rising >5',
    sigs: rows.filter(r => r.dir === 'CALL' && parseFloat(r.stc_prev) <= 15 && (parseFloat(r.stc) - parseFloat(r.stc_prev)) > 5)
  },
  {
    name: 'CALL: STC prev 15-25, rising >10',
    sigs: rows.filter(r => r.dir === 'CALL' && parseFloat(r.stc_prev) >= 15 && parseFloat(r.stc_prev) <= 25 && (parseFloat(r.stc) - parseFloat(r.stc_prev)) > 10)
  },
  {
    name: 'PUT: STC prev ≥90, falling >5',
    sigs: rows.filter(r => r.dir === 'PUT' && parseFloat(r.stc_prev) >= 90 && (parseFloat(r.stc_prev) - parseFloat(r.stc)) > 5)
  },
  {
    name: 'PUT: STC prev 75-90, falling >10',
    sigs: rows.filter(r => r.dir === 'PUT' && parseFloat(r.stc_prev) >= 75 && parseFloat(r.stc_prev) < 90 && (parseFloat(r.stc_prev) - parseFloat(r.stc)) > 10)
  },
  {
    name: 'CALL: Strong bounce (delta >15)',
    sigs: rows.filter(r => r.dir === 'CALL' && (parseFloat(r.stc) - parseFloat(r.stc_prev)) > 15)
  },
  {
    name: 'PUT: Strong rollover (delta <-15)',
    sigs: rows.filter(r => r.dir === 'PUT' && (parseFloat(r.stc) - parseFloat(r.stc_prev)) < -15)
  }
];

patterns.forEach(p => {
  if (p.sigs.length < 5) return;
  const wins = p.sigs.filter(s => s.r120 === 'WIN').length;
  const wr = (wins / p.sigs.length * 100).toFixed(0);
  const avgPl = (p.sigs.reduce((s, r) => s + parseFloat(r.pl120), 0) / p.sigs.length).toFixed(0);
  
  if (wins / p.sigs.length >= 0.6) {
    console.log(
      `${p.name.padEnd(40)} | ${p.sigs.length.toString().padEnd(5)} | ${wr.padEnd(6)}% | $${avgPl.padStart(6)}`
    );
  }
});

// ═══ SUMMARY ═════════════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                        KEY FINDINGS                        ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const callStrongBounce = rows.filter(r => r.dir === 'CALL' && (parseFloat(r.stc) - parseFloat(r.stc_prev)) > 15);
const callStrongWr = callStrongBounce.filter(r => r.r120 === 'WIN').length / callStrongBounce.length * 100;

const putStrongRoll = rows.filter(r => r.dir === 'PUT' && (parseFloat(r.stc) - parseFloat(r.stc_prev)) < -15);
const putStrongWr = putStrongRoll.length > 0 ? putStrongRoll.filter(r => r.r120 === 'WIN').length / putStrongRoll.length * 100 : 0;

console.log('1. STC MOMENTUM MATTERS:');
console.log(`   • CALL with delta >15: ${callStrongBounce.length} signals, ${callStrongWr.toFixed(0)}% WR`);
console.log(`   • PUT with delta <-15: ${putStrongRoll.length} signals, ${putStrongRoll.length > 0 ? putStrongWr.toFixed(0) : 'N/A'}% WR`);

console.log('\n2. EXTREME POSITIONING:');
console.log(`   • CALL avg prev STC: ${callAvgPrev} (floor zone)`);
console.log(`   • PUT avg prev STC: ${putAvgPrev} (ceiling zone)`);

console.log('\n3. TYPICAL TRANSITIONS:');
console.log('   • Most CALL signals: from 0-20 zone, rising to 20-30 zone');
console.log('   • Most PUT signals: from 90-100 zone, falling to 70-90 zone');

console.log('');
