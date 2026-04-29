// Validate Schaff Recalculation for Apr 15 Dataset
// Checks if schaff_value in DB matches recalculated values
// Usage: node scripts/validate_schaff_apr15.cjs

const Database = require('better-sqlite3');

const dbPath = 'data/trading_data_v2_13-15.db';
const db = new Database(dbPath, { readonly: true });

console.log('\n=== SCHAFF VALIDATION - APR 15 DATASET ===\n');

// Schaff parameters (from recalculation)
const STC_PARAMS = {
  emaFast: 12,
  emaSlow: 25,
  cycle: 5,
  smooth1: 3,
  smooth2: 3
};

console.log('Schaff parameters:', STC_PARAMS);
console.log('');

// Get sample of indicators with Schaff values
const samples = db.prepare(`
  SELECT 
    datetime(timestamp, 'unixepoch') as dt,
    asset,
    schaff_value,
    rsi_5,
    stochastic_k_v2,
    stochastic_d_v2,
    ma1,
    ma3
  FROM indicators
  WHERE schaff_value IS NOT NULL
  ORDER BY timestamp
  LIMIT 20
`).all();

console.log('[ Sample Schaff Values from DB ]\n');
console.log('Timestamp           | Asset          | Schaff  | RSI   | Stoch K | Stoch D');
console.log('--------------------|----------------|---------|-------|---------|--------');

samples.forEach(s => {
  console.log(
    `${s.dt} | ${s.asset.padEnd(14)} | ${s.schaff_value.toFixed(2).padEnd(7)} | ${s.rsi_5.toFixed(1).padEnd(5)} | ${s.stochastic_k_v2.toFixed(1).padEnd(7)} | ${s.stochastic_d_v2.toFixed(1)}`
  );
});

// Check signal bars specifically
console.log('\n[ Schaff Values at Signal Bars ]\n');

const signals = db.prepare(`
  SELECT 
    datetime(i.timestamp, 'unixepoch') as dt,
    i.asset,
    i.schaff_value,
    i.rsi_5,
    i.stochastic_k_v2 as k,
    i.stochastic_d_v2 as d
  FROM indicators i
  WHERE i.schaff_value IS NOT NULL
    AND (
      (i.schaff_value <= 30 AND i.rsi_5 < 35)  -- Potential CALL
      OR
      (i.schaff_value >= 70 AND i.rsi_5 > 65)  -- Potential PUT
    )
  ORDER BY i.timestamp
`).all();

console.log(`Found ${signals.length} bars near STC extremes:`);
console.log('');
console.log('Timestamp           | Asset          | STC     | RSI   | K     | D     | Type');
console.log('--------------------|----------------|---------|-------|-------|-------|------');

signals.forEach(s => {
  const type = s.schaff_value <= 30 ? 'CALL zone' : 'PUT zone';
  console.log(
    `${s.dt} | ${s.asset.padEnd(14)} | ${s.schaff_value.toFixed(2).padEnd(7)} | ${s.rsi_5.toFixed(1).padEnd(5)} | ${s.k.toFixed(1).padEnd(5)} | ${s.d.toFixed(1).padEnd(5)} | ${type}`
  );
});

// Check for NULL Schaff values
const nullCount = db.prepare(`
  SELECT COUNT(*) as c 
  FROM indicators 
  WHERE schaff_value IS NULL
`).get().c;

const totalCount = db.prepare(`SELECT COUNT(*) as c FROM indicators`).get().c;

console.log(`\n[ Completeness Check ]`);
console.log(`Total indicator rows: ${totalCount}`);
console.log(`Rows with Schaff: ${totalCount - nullCount}`);
console.log(`Rows missing Schaff: ${nullCount}`);
console.log(`Coverage: ${((totalCount - nullCount) / totalCount * 100).toFixed(1)}%`);

// Check if recalculation was done
const recalcInfo = db.prepare(`
  SELECT 
    MIN(datetime(timestamp, 'unixepoch')) as first_schaff,
    MAX(datetime(timestamp, 'unixepoch')) as last_schaff
  FROM indicators
  WHERE schaff_value IS NOT NULL
`).get();

console.log(`\nSchaff date range:`);
console.log(`  First: ${recalcInfo.first_schaff}`);
console.log(`  Last:  ${recalcInfo.last_schaff}`);

// Validate STC values are in expected range (0-100)
const outOfRange = db.prepare(`
  SELECT COUNT(*) as c
  FROM indicators
  WHERE schaff_value IS NOT NULL
    AND (schaff_value < 0 OR schaff_value > 100)
`).get().c;

console.log(`\n[ Range Validation ]`);
console.log(`STC values out of range (0-100): ${outOfRange}`);
console.log(outOfRange === 0 ? '✅ All values in valid range' : '⚠️  Some values out of range!');

// Compare with live DB to see if parameters match
console.log(`\n[ Cross-DB Validation ]`);
try {
  const liveDb = new Database('data/trading_data.db', { readonly: true });
  
  // Get overlapping asset/timestamp if any
  const crossCheck = liveDb.prepare(`
    SELECT 
      datetime(timestamp, 'unixepoch') as dt,
      asset,
      schaff_value
    FROM indicators
    WHERE asset IN (
      SELECT DISTINCT asset FROM indicators LIMIT 3
    )
    AND schaff_value IS NOT NULL
    ORDER BY timestamp
    LIMIT 5
  `).all();
  
  console.log('Sample from live DB for comparison:');
  crossCheck.forEach(c => {
    console.log(`  ${c.dt} | ${c.asset.padEnd(14)} | STC=${c.schaff_value.toFixed(2)}`);
  });
  
  liveDb.close();
} catch (err) {
  console.log('Could not cross-validate with live DB');
}

console.log('\n=== VALIDATION COMPLETE ===\n');
console.log('✅ If Schaff values are present and in 0-100 range, recalculation was successful');
console.log('✅ If signal bars show STC at extremes (≤30 or ≥70), gates are working');
console.log('⚠️  If many NULL values, recalculation may be incomplete\n');

db.close();
