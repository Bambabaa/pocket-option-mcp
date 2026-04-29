// Normalize CSV and Prepare for Statistical Tests
// Standardizes features, calculates z-scores, and prepares for hypothesis testing
// Usage: node scripts/normalize_and_test.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║      CSV NORMALIZATION & STATISTICAL TESTS                ║');
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

console.log(`Total signals: ${rows.length}\n`);

// ═══ 1. FEATURE EXTRACTION ═══════════════════════════════════════════════════
console.log('[ 1. EXTRACTING FEATURES ]\n');

const features = rows.map(r => ({
  // Outcome
  win: r.r120 === 'WIN' ? 1 : 0,
  
  // Core features
  stc: parseFloat(r.stc),
  stc_prev: parseFloat(r.stc_prev),
  stc_delta: parseFloat(r.stc) - parseFloat(r.stc_prev),
  stc_delta_abs: Math.abs(parseFloat(r.stc) - parseFloat(r.stc_prev)),
  
  rsi: parseFloat(r.rsi),
  k: parseFloat(r.k),
  d: parseFloat(r.d),
  k_d_diff: parseFloat(r.k) - parseFloat(r.d),
  
  bb_bps: parseFloat(r.bb_bps),
  bb_upper: parseFloat(r.bb_upper),
  bb_lower: parseFloat(r.bb_lower),
  bb_middle: parseFloat(r.bb_middle),
  
  // Position relative to BB
  price: parseFloat(r.price),
  bb_position: (parseFloat(r.price) - parseFloat(r.bb_middle)) / 
               (parseFloat(r.bb_upper) - parseFloat(r.bb_lower)),
  
  // Categorical
  dir: r.dir,
  asset: r.asset,
  
  // Meta
  timestamp: parseInt(r.timestamp)
}));

console.log(`Features extracted: ${features.length}`);
console.log('Features: stc, stc_prev, stc_delta, stc_delta_abs, rsi, k, d, k_d_diff, bb_bps, bb_position\n');

// ═══ 2. CALCULATE STATISTICS ═════════════════════════════════════════════════
console.log('[ 2. CALCULATING MEAN & STD DEV ]\n');

const numericFeatures = [
  'stc', 'stc_prev', 'stc_delta', 'stc_delta_abs',
  'rsi', 'k', 'd', 'k_d_diff',
  'bb_bps', 'bb_position'
];

const stats = {};

numericFeatures.forEach(feat => {
  const values = features.map(f => f[feat]).filter(v => !isNaN(v));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  
  stats[feat] = { mean, stdDev, min, max };
});

console.log('Feature            | Mean     | Std Dev  | Min      | Max');
console.log('-------------------|----------|----------|----------|----------');

numericFeatures.forEach(feat => {
  const s = stats[feat];
  console.log(
    `${feat.padEnd(18)} | ${s.mean.toFixed(2).padStart(8)} | ${s.stdDev.toFixed(2).padStart(8)} | ${s.min.toFixed(2).padStart(8)} | ${s.max.toFixed(2).padStart(8)}`
  );
});

// ═══ 3. NORMALIZE FEATURES ═══════════════════════════════════════════════════
console.log('\n[ 3. NORMALIZING FEATURES (Z-SCORES) ]\n');

const normalized = features.map(f => {
  const norm = { ...f };
  
  numericFeatures.forEach(feat => {
    if (stats[feat].stdDev > 0) {
      norm[`${feat}_z`] = (f[feat] - stats[feat].mean) / stats[feat].stdDev;
    } else {
      norm[`${feat}_z`] = 0;
    }
  });
  
  return norm;
});

console.log('Sample normalized values (first 3 signals):');
console.log('\nFeature            | Raw      | Z-Score');
console.log('-------------------|----------|----------');

['stc_delta_abs', 'rsi', 'bb_bps'].forEach(feat => {
  console.log(`\n${feat}:`);
  normalized.slice(0, 3).forEach((n, i) => {
    console.log(
      `  Signal ${i+1}         | ${features[i][feat].toFixed(2).padStart(8)} | ${n[`${feat}_z`].toFixed(3).padStart(8)}`
    );
  });
});

// ═══ 4. T-TEST: WINNERS VS LOSERS ════════════════════════════════════════════
console.log('\n\n[ 4. T-TEST: WINNERS VS LOSERS ]\n');

const winners = normalized.filter(n => n.win === 1);
const losers = normalized.filter(n => n.win === 0);

console.log(`Winners: ${winners.length} | Losers: ${losers.length}\n`);

console.log('Feature            | Winners  | Losers   | Diff     | t-stat   | p-value  | Sig');
console.log('-------------------|----------|----------|----------|----------|----------|-----');

function tTest(arr1, arr2) {
  const mean1 = arr1.reduce((a, b) => a + b, 0) / arr1.length;
  const mean2 = arr2.reduce((a, b) => a + b, 0) / arr2.length;
  
  const var1 = arr1.reduce((sum, v) => sum + Math.pow(v - mean1, 2), 0) / (arr1.length - 1);
  const var2 = arr2.reduce((sum, v) => sum + Math.pow(v - mean2, 2), 0) / (arr2.length - 1);
  
  const pooledVar = ((arr1.length - 1) * var1 + (arr2.length - 1) * var2) / (arr1.length + arr2.length - 2);
  const se = Math.sqrt(pooledVar * (1/arr1.length + 1/arr2.length));
  
  const t = (mean1 - mean2) / se;
  const df = arr1.length + arr2.length - 2;
  
  // Approximate p-value (two-tailed)
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));
  
  return { mean1, mean2, diff: mean1 - mean2, t, pValue, df };
}

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

numericFeatures.forEach(feat => {
  const winVals = winners.map(w => w[feat]).filter(v => !isNaN(v));
  const loseVals = losers.map(l => l[feat]).filter(v => !isNaN(v));
  
  if (winVals.length > 1 && loseVals.length > 1) {
    const test = tTest(winVals, loseVals);
    
    let sig = '';
    if (test.pValue < 0.001) sig = '***';
    else if (test.pValue < 0.01) sig = '**';
    else if (test.pValue < 0.05) sig = '*';
    else sig = 'ns';
    
    console.log(
      `${feat.padEnd(18)} | ${test.mean1.toFixed(2).padStart(8)} | ${test.mean2.toFixed(2).padStart(8)} | ${test.diff.toFixed(2).padStart(8)} | ${test.t.toFixed(3).padStart(8)} | ${test.pValue.toFixed(4).padStart(8)} | ${sig}`
    );
  }
});

console.log('\nSignificance: *** p<0.001, ** p<0.01, * p<0.05, ns = not significant');

// ═══ 5. CHI-SQUARE: CATEGORICAL FEATURES ═════════════════════════════════════
console.log('\n[ 5. CHI-SQUARE TEST: DIRECTION ]\n');

const callWins = normalized.filter(n => n.dir === 'CALL' && n.win === 1).length;
const callLoss = normalized.filter(n => n.dir === 'CALL' && n.win === 0).length;
const putWins = normalized.filter(n => n.dir === 'PUT' && n.win === 1).length;
const putLoss = normalized.filter(n => n.dir === 'PUT' && n.win === 0).length;

const total = callWins + callLoss + putWins + putLoss;
const expectedCallWin = (callWins + callLoss) * (callWins + putWins) / total;
const expectedCallLoss = (callWins + callLoss) * (callLoss + putLoss) / total;
const expectedPutWin = (putWins + putLoss) * (callWins + putWins) / total;
const expectedPutLoss = (putWins + putLoss) * (callLoss + putLoss) / total;

const chiSq = 
  Math.pow(callWins - expectedCallWin, 2) / expectedCallWin +
  Math.pow(callLoss - expectedCallLoss, 2) / expectedCallLoss +
  Math.pow(putWins - expectedPutWin, 2) / expectedPutWin +
  Math.pow(putLoss - expectedPutLoss, 2) / expectedPutLoss;

console.log('Direction | Wins | Losses | Total | WR');
console.log('----------|------|--------|-------|------');
console.log(`CALL      | ${callWins.toString().padEnd(4)} | ${callLoss.toString().padEnd(6)} | ${(callWins + callLoss).toString().padEnd(5)} | ${(callWins / (callWins + callLoss) * 100).toFixed(1)}%`);
console.log(`PUT       | ${putWins.toString().padEnd(4)} | ${putLoss.toString().padEnd(6)} | ${(putWins + putLoss).toString().padEnd(5)} | ${(putWins / (putWins + putLoss) * 100).toFixed(1)}%`);

console.log(`\nChi-square: ${chiSq.toFixed(3)}`);
console.log(`p-value: ${chiSq < 3.841 ? '>0.05 (not significant)' : '<0.05 (significant)'}`);

// ═══ 6. CORRELATION MATRIX ═══════════════════════════════════════════════════
console.log('\n[ 6. CORRELATION WITH WIN OUTCOME ]\n');

console.log('Feature            | Correlation | Sig');
console.log('-------------------|-------------|-----');

numericFeatures.forEach(feat => {
  const values = normalized.map(n => n[feat]).filter(v => !isNaN(v));
  const outcomes = normalized.filter((n, i) => !isNaN(n[feat])).map(n => n.win);
  
  const meanX = values.reduce((a, b) => a + b, 0) / values.length;
  const meanY = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
  
  const cov = values.reduce((sum, x, i) => sum + (x - meanX) * (outcomes[i] - meanY), 0) / values.length;
  const stdX = Math.sqrt(values.reduce((sum, x) => sum + Math.pow(x - meanX, 2), 0) / values.length);
  const stdY = Math.sqrt(outcomes.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0) / outcomes.length);
  
  const corr = cov / (stdX * stdY);
  
  // Approximate significance
  const t = corr * Math.sqrt((values.length - 2) / (1 - corr * corr));
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));
  
  let sig = '';
  if (pValue < 0.001) sig = '***';
  else if (pValue < 0.01) sig = '**';
  else if (pValue < 0.05) sig = '*';
  else sig = 'ns';
  
  console.log(
    `${feat.padEnd(18)} | ${corr.toFixed(4).padStart(11)} | ${sig}`
  );
});

// ═══ 7. SAVE NORMALIZED CSV ══════════════════════════════════════════════════
console.log('\n[ 7. SAVING NORMALIZED CSV ]\n');

const normalizedHeader = [
  'timestamp', 'asset', 'dir', 'win',
  ...numericFeatures,
  ...numericFeatures.map(f => f + '_z')
].join(',');

const normalizedLines = [normalizedHeader];

normalized.forEach(n => {
  const row = [
    n.timestamp,
    n.asset,
    n.dir,
    n.win,
    ...numericFeatures.map(f => n[f].toFixed(4)),
    ...numericFeatures.map(f => n[f + '_z'].toFixed(4))
  ].join(',');
  normalizedLines.push(row);
});

fs.writeFileSync('data/replay_signals_normalized.csv', normalizedLines.join('\n'));

console.log('✅ Saved: data/replay_signals_normalized.csv');
console.log(`   Rows: ${normalized.length}`);
console.log(`   Columns: ${normalizedHeader.split(',').length}`);

// ═══ SUMMARY ══════════════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                    STATISTICAL SUMMARY                     ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('KEY FINDINGS:\n');

// Find most significant features
const testResults = [];
numericFeatures.forEach(feat => {
  const winVals = winners.map(w => w[feat]).filter(v => !isNaN(v));
  const loseVals = losers.map(l => l[feat]).filter(v => !isNaN(v));
  
  if (winVals.length > 1 && loseVals.length > 1) {
    const test = tTest(winVals, loseVals);
    testResults.push({ feat, ...test });
  }
});

const significantFeatures = testResults
  .filter(t => t.pValue < 0.05)
  .sort((a, b) => a.pValue - b.pValue);

if (significantFeatures.length > 0) {
  console.log('SIGNIFICANT FEATURES (p < 0.05):');
  significantFeatures.forEach(t => {
    console.log(`  • ${t.feat}: t=${t.t.toFixed(2)}, p=${t.pValue.toFixed(4)}, diff=${t.diff.toFixed(2)}`);
  });
} else {
  console.log('⚠️  NO FEATURES ARE STATISTICALLY SIGNIFICANT (p < 0.05)');
  console.log('   This suggests:');
  console.log('   1. Sample size may be too small (n=82)');
  console.log('   2. Effect sizes are weak');
  console.log('   3. High variance within groups');
}

console.log('\nNEXT STEPS:');
console.log('  1. Review normalized CSV for outliers');
console.log('  2. Run logistic regression for multi-variate analysis');
console.log('  3. Consider non-parametric tests (Mann-Whitney U)');
console.log('  4. Increase sample size for better statistical power\n');
