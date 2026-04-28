// Gate Conservativeness Analysis - Which gate filters most signals?
const fs = require('fs');
const Database = require('better-sqlite3');

const db = new Database('data/trading_data.db', { readonly: true });

// Fetch all bars with indicators
const rows = db.prepare(`
  SELECT i.asset, i.timestamp, i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
         i.bb_upper, i.bb_middle, i.bb_lower, i.ma1, i.ma3, i.schaff_value
  FROM indicators i
  WHERE i.rsi_5 IS NOT NULL AND i.stochastic_k_v2 IS NOT NULL 
    AND i.bb_upper IS NOT NULL AND i.schaff_value IS NOT NULL
  ORDER BY i.asset, i.timestamp
`).all();

console.log(`\n=== GATE CONSERVATIVENESS ANALYSIS ===`);
console.log(`Total bars analyzed: ${rows.length}\n`);

// Build per-asset history
const byAsset = {};
for (const r of rows) {
  if (!byAsset[r.asset]) byAsset[r.asset] = [];
  byAsset[r.asset].push(r);
}

// Compute lookback for each bar
function computeLookback(assetRows, idx) {
  const history = assetRows.slice(Math.max(0, idx - 10), idx);
  const rsiVals = history.map(r => r.rsi_5).filter(v => v != null);
  return {
    rsiPeak10: rsiVals.length > 0 ? Math.max(...rsiVals) : null,
    rsiTrough10: rsiVals.length > 0 ? Math.min(...rsiVals) : null,
  };
}

// Count how many bars pass each gate level
const gateStats = {
  call: {
    stc_bot: 0,      // STC <= 25
    stc_paper: 0,    // STC <= 20
    rsi_bot: 0,      // RSI < 30
    rsi_paper: 0,    // RSI < 20
    k_bot: 0,        // K < 50
    k_paper: 0,      // K < 35
    retracement: 0,  // rsiTrough10 < 15
    all_bot: 0,
    all_paper: 0,
  },
  put: {
    stc_bot: 0,      // STC >= 90
    stc_paper: 0,    // STC >= 75
    rsi_bot: 0,      // RSI > 70
    rsi_paper: 0,    // RSI > 70 (same)
    k_bot: 0,        // K > 50
    k_paper: 0,      // K > 65
    retracement: 0,  // 80 < rsiPeak10 < 95
    all_bot: 0,
    all_paper: 0,
  }
};

for (const [asset, assetRows] of Object.entries(byAsset)) {
  for (let idx = 1; idx < assetRows.length; idx++) {
    const r = assetRows[idx];
    const rPrev = assetRows[idx - 1];
    const lookback = computeLookback(assetRows, idx);
    
    const stc = r.schaff_value;
    const stcPrev = rPrev.schaff_value;
    const rsi = r.rsi_5;
    const k = r.stochastic_k_v2;
    const d = r.stochastic_d_v2;
    
    if (!stc || !stcPrev || !rsi || !k || !d) continue;
    
    const bbBps = r.bb_middle ? (r.bb_upper - r.bb_lower) / r.bb_middle * 10000 : null;
    if (!bbBps || bbBps < 10) continue;
    
    // ── CALL gates ────────────────────────────────────────────────────────
    if (stc > stcPrev && k > d) {  // Rising STC + K>D (bullish cross)
      if (stc <= 25) gateStats.call.stc_bot++;
      if (stc <= 20) gateStats.call.stc_paper++;
      if (rsi < 30) gateStats.call.rsi_bot++;
      if (rsi < 20) gateStats.call.rsi_paper++;
      if (k < 50) gateStats.call.k_bot++;
      if (k < 35) gateStats.call.k_paper++;
      if (lookback.rsiTrough10 != null && lookback.rsiTrough10 < 15) {
        gateStats.call.retracement++;
      }
      
      // Bot full gates
      if (stc <= 25 && rsi < 30 && k < 50 && bbBps >= 10) {
        gateStats.call.all_bot++;
      }
      
      // Paper full gates
      if (stc <= 20 && rsi < 20 && k < 35 && bbBps >= 10 &&
          lookback.rsiTrough10 != null && lookback.rsiTrough10 < 15) {
        gateStats.call.all_paper++;
      }
    }
    
    // ── PUT gates ─────────────────────────────────────────────────────────
    if (stc < stcPrev && k < d) {  // Falling STC + K<D (bearish cross)
      if (stc >= 90) gateStats.put.stc_bot++;
      if (stc >= 75) gateStats.put.stc_paper++;
      if (rsi > 70) {
        gateStats.put.rsi_bot++;
        gateStats.put.rsi_paper++;
      }
      if (k > 50) gateStats.put.k_bot++;
      if (k > 65) gateStats.put.k_paper++;
      if (lookback.rsiPeak10 != null && 
          lookback.rsiPeak10 > 80 && lookback.rsiPeak10 < 95) {
        gateStats.put.retracement++;
      }
      
      // Bot full gates
      if (stc >= 90 && rsi > 70 && k > 50 && bbBps >= 10) {
        gateStats.put.all_bot++;
      }
      
      // Paper full gates
      if (stc >= 75 && rsi > 70 && k > 65 && bbBps >= 10 &&
          lookback.rsiPeak10 != null && 
          lookback.rsiPeak10 > 80 && lookback.rsiPeak10 < 95) {
        gateStats.put.all_paper++;
      }
    }
  }
}

console.log('[ CALL Gates - How Many Bars Pass Each? ]\n');
console.log('Gate                     | Bars Passing | % of Total');
console.log('------------------------ | ------------ | ----------');
console.log(`STC <= 25 (bot)          | ${gateStats.call.stc_bot.toString().padEnd(12)} | ${(gateStats.call.stc_bot/rows.length*100).toFixed(3)}%`);
console.log(`STC <= 20 (paper) 🔒     | ${gateStats.call.stc_paper.toString().padEnd(12)} | ${(gateStats.call.stc_paper/rows.length*100).toFixed(3)}%`);
console.log(`RSI < 30 (bot)           | ${gateStats.call.rsi_bot.toString().padEnd(12)} | ${(gateStats.call.rsi_bot/rows.length*100).toFixed(3)}%`);
console.log(`RSI < 20 (paper) 🔒      | ${gateStats.call.rsi_paper.toString().padEnd(12)} | ${(gateStats.call.rsi_paper/rows.length*100).toFixed(3)}%`);
console.log(`K < 50 (bot)             | ${gateStats.call.k_bot.toString().padEnd(12)} | ${(gateStats.call.k_bot/rows.length*100).toFixed(3)}%`);
console.log(`K < 35 (paper) 🔒        | ${gateStats.call.k_paper.toString().padEnd(12)} | ${(gateStats.call.k_paper/rows.length*100).toFixed(3)}%`);
console.log(`rsiTrough < 15 🔒🔒      | ${gateStats.call.retracement.toString().padEnd(12)} | ${(gateStats.call.retracement/rows.length*100).toFixed(3)}%`);
console.log(`------------------------ | ------------ | ----------`);
console.log(`ALL BOT GATES            | ${gateStats.call.all_bot.toString().padEnd(12)} | ${(gateStats.call.all_bot/rows.length*100).toFixed(3)}%`);
console.log(`ALL PAPER GATES          | ${gateStats.call.all_paper.toString().padEnd(12)} | ${(gateStats.call.all_paper/rows.length*100).toFixed(3)}%`);

console.log('\n[ PUT Gates - How Many Bars Pass Each? ]\n');
console.log('Gate                     | Bars Passing | % of Total');
console.log('------------------------ | ------------ | ----------');
console.log(`STC >= 90 (bot)          | ${gateStats.put.stc_bot.toString().padEnd(12)} | ${(gateStats.put.stc_bot/rows.length*100).toFixed(3)}%`);
console.log(`STC >= 75 (paper) 🔒     | ${gateStats.put.stc_paper.toString().padEnd(12)} | ${(gateStats.put.stc_paper/rows.length*100).toFixed(3)}%`);
console.log(`RSI > 70 (both)          | ${gateStats.put.rsi_bot.toString().padEnd(12)} | ${(gateStats.put.rsi_bot/rows.length*100).toFixed(3)}%`);
console.log(`K > 50 (bot)             | ${gateStats.put.k_bot.toString().padEnd(12)} | ${(gateStats.put.k_bot/rows.length*100).toFixed(3)}%`);
console.log(`K > 65 (paper) 🔒        | ${gateStats.put.k_paper.toString().padEnd(12)} | ${(gateStats.put.k_paper/rows.length*100).toFixed(3)}%`);
console.log(`80<rsiPeak<95 🔒🔒       | ${gateStats.put.retracement.toString().padEnd(12)} | ${(gateStats.put.retracement/rows.length*100).toFixed(3)}%`);
console.log(`------------------------ | ------------ | ----------`);
console.log(`ALL BOT GATES            | ${gateStats.put.all_bot.toString().padEnd(12)} | ${(gateStats.put.all_bot/rows.length*100).toFixed(3)}%`);
console.log(`ALL PAPER GATES          | ${gateStats.put.all_paper.toString().padEnd(12)} | ${(gateStats.put.all_paper/rows.length*100).toFixed(3)}%`);

console.log('\n=== MOST RESTRICTIVE GATES ===\n');

const callReduction = (1 - gateStats.call.all_paper / gateStats.call.all_bot) * 100;
const putReduction = (1 - gateStats.put.all_paper / gateStats.put.all_bot) * 100;

console.log(`CALL: Paper fires ${callReduction.toFixed(0)}% FEWER signals than bot`);
console.log(`  → rsiTrough10 < 15 is the PRIMARY filter`);
console.log(`  → Only ${gateStats.call.retracement} bars (${(gateStats.call.retracement/rows.length*100).toFixed(2)}%) had deep prior selloff`);

console.log(`\nPUT: Paper fires ${putReduction.toFixed(0)}% FEWER signals than bot`);
console.log(`  → 80 < rsiPeak10 < 95 is the PRIMARY filter`);
console.log(`  → Only ${gateStats.put.retracement} bars (${(gateStats.put.retracement/rows.length*100).toFixed(2)}%) in sweet spot`);

console.log('\n🔒🔒 = MOST CONSERVATIVE GATES (retracement validation)\n');
