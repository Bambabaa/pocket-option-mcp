// Statistical Tests: Asset-Specific Analysis
// Tests if blocking bad assets is statistically justified
// Usage: node scripts/test_asset_blocking.cjs

const fs = require('fs');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║      STATISTICAL TEST: ASSET BLOCKING HYPOTHESIS          ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Load normalized CSV
const lines = fs.readFileSync('data/replay_signals_normalized.csv', 'utf-8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  header.forEach((h, i) => obj[h] = vals[i]);
  return obj;
});

console.log(`Total signals: ${rows.length}\n`);

// Define the 8 losing assets
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

// Split into groups
const badAssetSignals = rows.filter(r => losingAssets.includes(r.asset));
const goodAssetSignals = rows.filter(r => !losingAssets.includes(r.asset));

console.log(`Bad assets signals:  ${badAssetSignals.length}`);
console.log(`Good assets signals: ${goodAssetSignals.length}\n`);

// ═══ 1. BINOMIAL TEST: WIN RATE DIFFERENCE ═══════════════════════════════════
console.log('[ 1. BINOMIAL TEST: WIN RATE COMPARISON ]\n');

function binomialTest(successes, trials, p0 = 0.5) {
  const pHat = successes / trials;
  const se = Math.sqrt(p0 * (1 - p0) / trials);
  const z = (pHat - p0) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  
  return { pHat, z, pValue, se };
}

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

const badWins = badAssetSignals.filter(s => s.win === '1').length;
const goodWins = goodAssetSignals.filter(s => s.win === '1').length;

const badWr = badWins / badAssetSignals.length;
const goodWr = goodWins / goodAssetSignals.length;

const badTest = binomialTest(badWins, badAssetSignals.length);
const goodTest = binomialTest(goodWins, goodAssetSignals.length);

console.log('Group         | Signals | Wins | WR     | Z-score | p-value  | Sig');
console.log('--------------|---------|------|--------|---------|----------|-----');

let badSig = badTest.pValue < 0.001 ? '***' : badTest.pValue < 0.01 ? '**' : badTest.pValue < 0.05 ? '*' : 'ns';
let goodSig = goodTest.pValue < 0.001 ? '***' : goodTest.pValue < 0.01 ? '**' : goodTest.pValue < 0.05 ? '*' : 'ns';

console.log(`Bad assets    | ${badAssetSignals.length.toString().padEnd(7)} | ${badWins.toString().padEnd(4)} | ${(badWr * 100).toFixed(1).padEnd(6)}% | ${badTest.z.toFixed(3).padStart(7)} | ${badTest.pValue.toFixed(4).padStart(8)} | ${badSig}`);
console.log(`Good assets   | ${goodAssetSignals.length.toString().padEnd(7)} | ${goodWins.toString().padEnd(4)} | ${(goodWr * 100).toFixed(1).padEnd(6)}% | ${goodTest.z.toFixed(3).padStart(7)} | ${goodTest.pValue.toFixed(4).padStart(8)} | ${goodSig}`);

console.log(`\nDifference: ${((goodWr - badWr) * 100).toFixed(1)}% WR improvement`);

// ═══ 2. TWO-PROPORTION Z-TEST ═════════════════════════════════════════════════
console.log('\n[ 2. TWO-PROPORTION Z-TEST ]\n');

const pooledP = (badWins + goodWins) / (badAssetSignals.length + goodAssetSignals.length);
const se = Math.sqrt(pooledP * (1 - pooledP) * (1/badAssetSignals.length + 1/goodAssetSignals.length));
const z = (badWr - goodWr) / se;
const pValue = 2 * (1 - normalCDF(Math.abs(z)));

console.log(`H0: WR(bad) = WR(good)`);
console.log(`H1: WR(bad) ≠ WR(good)`);
console.log(`\nPooled proportion: ${(pooledP * 100).toFixed(1)}%`);
console.log(`Standard error: ${se.toFixed(4)}`);
console.log(`Z-statistic: ${z.toFixed(3)}`);
console.log(`p-value: ${pValue.toFixed(4)}`);

let twoSig = pValue < 0.001 ? '***' : pValue < 0.01 ? '**' : pValue < 0.05 ? '*' : 'ns';
console.log(`Significance: ${twoSig}`);

if (pValue < 0.05) {
  console.log(`\n✅ REJECT NULL: Bad assets perform SIGNIFICANTLY worse (p < 0.05)`);
} else {
  console.log(`\n⚠️  FAIL TO REJECT NULL: Difference not statistically significant (p ≥ 0.05)`);
}

// ═══ 3. MANN-WHITNEY U TEST (non-parametric) ═════════════════════════════════
console.log('\n[ 3. MANN-WHITNEY U TEST: STC DELTA COMPARISON ]\n');

function mannWhitneyU(arr1, arr2) {
  const combined = [
    ...arr1.map(v => ({ val: v, group: 1 })),
    ...arr2.map(v => ({ val: v, group: 2 }))
  ].sort((a, b) => a.val - b.val);
  
  // Assign ranks
  let rank = 1;
  for (let i = 0; i < combined.length; i++) {
    const ties = combined.filter(c => c.val === combined[i].val);
    const avgRank = (rank + rank + ties.length - 1) / 2;
    ties.forEach(t => t.rank = avgRank);
    rank += ties.length;
    i += ties.length - 1;
  }
  
  const r1 = combined.filter(c => c.group === 1).reduce((sum, c) => sum + c.rank, 0);
  const n1 = arr1.length;
  const n2 = arr2.length;
  
  const u1 = r1 - n1 * (n1 + 1) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  
  // Z-score approximation
  const muU = n1 * n2 / 2;
  const sigmaU = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
  const z = (u - muU) / sigmaU;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  
  return { u, z, pValue, r1, n1, n2 };
}

const badDeltas = badAssetSignals.map(s => parseFloat(s.stc_delta_abs));
const goodDeltas = goodAssetSignals.map(s => parseFloat(s.stc_delta_abs));

const mwTest = mannWhitneyU(badDeltas, goodDeltas);

const badMedian = badDeltas.sort((a, b) => a - b)[Math.floor(badDeltas.length / 2)];
const goodMedian = goodDeltas.sort((a, b) => a - b)[Math.floor(goodDeltas.length / 2)];

console.log('Comparing STC Delta (abs) distributions:\n');
console.log(`Bad assets:  median = ${badMedian.toFixed(2)}`);
console.log(`Good assets: median = ${goodMedian.toFixed(2)}`);
console.log(`\nU-statistic: ${mwTest.u.toFixed(0)}`);
console.log(`Z-score: ${mwTest.z.toFixed(3)}`);
console.log(`p-value: ${mwTest.pValue.toFixed(4)}`);

let mwSig = mwTest.pValue < 0.001 ? '***' : mwTest.pValue < 0.01 ? '**' : mwTest.pValue < 0.05 ? '*' : 'ns';
console.log(`Significance: ${mwSig}`);

if (mwTest.pValue < 0.05) {
  console.log(`\n✅ Bad assets have SIGNIFICANTLY lower STC momentum (p < 0.05)`);
} else {
  console.log(`\n⚠️  No significant difference in STC momentum distributions`);
}

// ═══ 4. EFFECT SIZE: COHEN'S H ═══════════════════════════════════════════════
console.log('\n[ 4. EFFECT SIZE: COHEN\'S H ]\n');

const phi1 = 2 * Math.asin(Math.sqrt(badWr));
const phi2 = 2 * Math.asin(Math.sqrt(goodWr));
const cohensH = phi2 - phi1;

console.log(`Bad assets WR: ${(badWr * 100).toFixed(1)}%`);
console.log(`Good assets WR: ${(goodWr * 100).toFixed(1)}%`);
console.log(`Cohen's h: ${cohensH.toFixed(3)}`);

let effectInterpretation = '';
if (Math.abs(cohensH) < 0.2) effectInterpretation = 'small';
else if (Math.abs(cohensH) < 0.5) effectInterpretation = 'medium';
else effectInterpretation = 'large';

console.log(`Effect size: ${effectInterpretation}`);

// ═══ 5. POWER ANALYSIS ════════════════════════════════════════════════════════
console.log('\n[ 5. POWER ANALYSIS ]\n');

// Observed effect
const observedEffect = Math.abs(badWr - goodWr);

console.log(`Observed effect: ${(observedEffect * 100).toFixed(1)}% WR difference`);
console.log(`Sample sizes: n1=${badAssetSignals.length}, n2=${goodAssetSignals.length}`);
console.log(`\nTo detect this effect with 80% power (α=0.05):`);

// Required sample size (rough approximation)
const z_alpha = 1.96;
const z_beta = 0.84;
const p1 = badWr;
const p2 = goodWr;
const p_avg = (p1 + p2) / 2;

const nRequired = Math.ceil(
  Math.pow(z_alpha + z_beta, 2) * 2 * p_avg * (1 - p_avg) / Math.pow(p2 - p1, 2)
);

console.log(`  Required sample size per group: ~${nRequired}`);
console.log(`  Current bad assets: ${badAssetSignals.length} ${badAssetSignals.length >= nRequired ? '✅' : '❌'}`);
console.log(`  Current good assets: ${goodAssetSignals.length} ${goodAssetSignals.length >= nRequired ? '✅' : '❌'}`);

// ═══ SUMMARY ══════════════════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                    STATISTICAL VERDICT                     ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('HYPOTHESIS: Blocking 8 bad assets improves performance\n');

console.log('Test Results:');
console.log(`  1. Win rate difference: ${((goodWr - badWr) * 100).toFixed(1)}%`);
console.log(`  2. Two-proportion test: p=${pValue.toFixed(4)} ${twoSig}`);
console.log(`  3. Effect size (Cohen's h): ${cohensH.toFixed(3)} (${effectInterpretation})`);
console.log(`  4. Mann-Whitney U (STC Δ): p=${mwTest.pValue.toFixed(4)} ${mwSig}`);

console.log('\nConclusion:');

if (pValue < 0.05 && Math.abs(cohensH) >= 0.2) {
  console.log('  ✅ STRONG EVIDENCE: Asset blocking is statistically justified');
  console.log('     • Significant WR difference (p < 0.05)');
  console.log('     • Meaningful effect size');
  console.log('     • RECOMMENDATION: Implement asset blocklist');
} else if (pValue < 0.10 || Math.abs(cohensH) >= 0.2) {
  console.log('  ⚠️  MODERATE EVIDENCE: Asset blocking shows promise');
  console.log('     • Suggestive evidence (p < 0.10 or medium effect)');
  console.log('     • RECOMMENDATION: Implement with monitoring');
} else {
  console.log('  ❌ WEAK EVIDENCE: Asset blocking not statistically justified');
  console.log('     • Small sample size (n=82)');
  console.log('     • Effect too small or not significant');
  console.log('     • RECOMMENDATION: Collect more data before blocking');
}

console.log('\nPractical Considerations:');
console.log(`  • Removing ${badAssetSignals.length} signals = -${(badAssetSignals.length / rows.length * 100).toFixed(0)}% trade frequency`);
console.log(`  • Expected WR: ${(badWr * 100).toFixed(1)}% → ${(goodWr * 100).toFixed(1)}%`);
console.log(`  • Risk of false positive: ${(pValue * 100).toFixed(1)}%`);

console.log('');
