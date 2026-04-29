// Multi-Database Strategy Validator
// Runs paper gates + condition.txt on ALL database files found
// Aggregates results into single unified report
// Usage: node scripts/multi_db_validator.cjs

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = 'data';
const OUTPUT_DIR = 'data/reports';
const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 5, 10];

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── FIND ALL DATABASE FILES ──────────────────────────────────────────────────
const dbFiles = fs.readdirSync(DATA_DIR)
  .filter(f => f.endsWith('.db') && f.includes('trading'))
  .map(f => path.join(DATA_DIR, f));

if (dbFiles.length === 0) {
  console.error('No trading database files found in', DATA_DIR);
  process.exit(1);
}

console.log(`\n=== MULTI-DATABASE VALIDATOR ===`);
console.log(`Found ${dbFiles.length} database(s):\n`);
dbFiles.forEach((f, i) => console.log(`  ${i + 1}. ${path.basename(f)}`));
console.log('');

// ─── STRATEGY DEFINITIONS ─────────────────────────────────────────────────────

const STRATEGIES = {
  PAPER_CALL: {
    name: 'PAPER_CALL',
    check: (c, hist) => {
      if (!c.stc || !c.stcPrev || !c.rsi || !c.k || !c.d) return false;
      return (
        c.stc <= 20 &&
        c.stc > c.stcPrev &&
        c.rsi < 20 &&
        c.k > c.d && c.k < 35 &&
        c.bbWidthBps >= 10 &&
        hist.rsiTrough10 != null && hist.rsiTrough10 < 15 &&
        c.maTrendBps > -20
      );
    }
  },
  PAPER_PUT: {
    name: 'PAPER_PUT',
    check: (c, hist) => {
      if (!c.stc || !c.stcPrev || !c.rsi || !c.k || !c.d) return false;
      return (
        c.stc >= 75 &&
        c.stc < c.stcPrev &&
        c.rsi > 70 &&
        c.k < c.d && c.k > 65 &&
        c.bbWidthBps >= 10 &&
        hist.rsiPeak10 != null && hist.rsiPeak10 > 80 && hist.rsiPeak10 < 95 &&
        c.maTrendBps < 20
      );
    }
  },
  CONDITION_CALL: {
    name: 'CONDITION_CALL',
    check: (c, hist) => {
      if (!c.stc || !c.stcPrev || !c.k || !c.d) return false;
      const bullCross = c.kPrev <= c.dPrev && c.k > c.d;
      return (
        c.stc <= 30 &&
        c.stc > c.stcPrev &&
        hist.rsiMin5 != null && hist.rsiMin5 <= 35 &&
        bullCross &&
        c.bbWidthBps >= 10
      );
    }
  },
  CONDITION_PUT: {
    name: 'CONDITION_PUT',
    check: (c, hist) => {
      if (!c.stc || !c.stcPrev || !c.k || !c.d) return false;
      const bearCross = c.kPrev >= c.dPrev && c.k < c.d;
      return (
        c.stc >= 70 &&
        c.stc < c.stcPrev &&
        hist.rsiMax5 != null && hist.rsiMax5 >= 65 &&
        bearCross &&
        c.bbWidthBps >= 10
      );
    }
  }
};

// ─── PROCESS SINGLE DATABASE ──────────────────────────────────────────────────

function processDatabase(dbPath) {
  console.log(`\n[ Processing ${path.basename(dbPath)} ]`);
  
  const db = new Database(dbPath, { readonly: true });
  
  // Check table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const hasIndicators = tables.some(t => t.name === 'indicators');
  const hasCandles = tables.some(t => t.name === 'candles');
  
  if (!hasIndicators || !hasCandles) {
    console.log('  ⚠️  Missing required tables (indicators/candles)');
    db.close();
    return null;
  }
  
  // Fetch all data
  const rows = db.prepare(`
    SELECT
      i.asset, i.timestamp,
      c.close,
      i.rsi_5, i.stochastic_k_v2, i.stochastic_d_v2,
      i.bb_upper, i.bb_middle, i.bb_lower,
      i.ma1, i.ma3,
      i.schaff_value
    FROM indicators i
    JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
    WHERE i.rsi_5 IS NOT NULL
      AND i.stochastic_k_v2 IS NOT NULL
      AND i.bb_upper IS NOT NULL
      AND i.schaff_value IS NOT NULL
    ORDER BY i.asset, i.timestamp ASC
  `).all();
  
  console.log(`  Loaded ${rows.length} bars`);
  
  if (rows.length === 0) {
    db.close();
    return null;
  }
  
  // Index prices
  const closeByKey = new Map();
  for (const r of rows) {
    closeByKey.set(r.asset + '|' + r.timestamp, r.close);
  }
  
  // Build per-asset history
  const byAsset = {};
  for (const r of rows) {
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
  }
  
  // Compute features & check strategies
  const signals = [];
  
  for (const [asset, assetRows] of Object.entries(byAsset)) {
    for (let idx = 10; idx < assetRows.length; idx++) {
      const curr = assetRows[idx];
      const prev = assetRows[idx - 1];
      
      // Build context
      const bbWidthBps = curr.bb_middle ? 
        (curr.bb_upper - curr.bb_lower) / curr.bb_middle * 10000 : null;
      const maTrendBps = (curr.ma1 && curr.ma3 && curr.ma3) ? 
        (curr.ma1 - curr.ma3) / curr.ma3 * 10000 : null;
      
      if (!bbWidthBps || bbWidthBps < 10) continue;
      
      // Lookback features
      const history = assetRows.slice(Math.max(0, idx - 10), idx);
      const rsiVals10 = [
        ...history.map(r => r.rsi_5),
        curr.rsi_5
      ].filter(v => v != null);
      const rsiVals5 = [
        ...history.slice(-4).map(r => r.rsi_5),
        curr.rsi_5
      ].filter(v => v != null);
      
      const hist = {
        rsiPeak10: rsiVals10.length > 0 ? Math.max(...rsiVals10) : null,
        rsiTrough10: rsiVals10.length > 0 ? Math.min(...rsiVals10) : null,
        rsiMax5: rsiVals5.length > 0 ? Math.max(...rsiVals5) : null,
        rsiMin5: rsiVals5.length > 0 ? Math.min(...rsiVals5) : null,
      };
      
      const c = {
        stc: curr.schaff_value,
        stcPrev: prev.schaff_value,
        rsi: curr.rsi_5,
        k: curr.stochastic_k_v2,
        d: curr.stochastic_d_v2,
        kPrev: prev.stochastic_k_v2,
        dPrev: prev.stochastic_d_v2,
        bbWidthBps,
        maTrendBps,
      };
      
      // Check each strategy
      for (const [key, strat] of Object.entries(STRATEGIES)) {
        if (!strat.check(c, hist)) continue;
        
        const direction = key.includes('CALL') ? 'CALL' : 'PUT';
        
        // Calculate exits
        const exits = {};
        for (const exp of EXPIRIES) {
          const exitTs = curr.timestamp + exp * 60;
          const exit = closeByKey.get(curr.asset + '|' + exitTs);
          if (exit) {
            const win = direction === 'CALL' ? exit > curr.close : exit < curr.close;
            exits[exp + 'm'] = win ? 1 : 0;
          }
        }
        
        signals.push({
          db: path.basename(dbPath),
          timestamp: curr.timestamp,
          asset: curr.asset,
          strategy: strat.name,
          direction,
          ...exits
        });
      }
    }
  }
  
  console.log(`  Generated ${signals.length} signals`);
  db.close();
  
  return { dbFile: path.basename(dbPath), signals, totalBars: rows.length };
}

// ─── PROCESS ALL DATABASES ────────────────────────────────────────────────────

const allResults = [];
const aggregated = {};

for (const stratKey of Object.keys(STRATEGIES)) {
  aggregated[stratKey] = {};
  for (const exp of EXPIRIES) {
    aggregated[stratKey][exp + 'm'] = { wins: 0, total: 0 };
  }
}

for (const dbPath of dbFiles) {
  const result = processDatabase(dbPath);
  if (result) {
    allResults.push(result);
    
    // Aggregate stats
    for (const sig of result.signals) {
      const stratKey = sig.strategy;
      for (const exp of EXPIRIES) {
        const key = exp + 'm';
        if (sig[key] !== undefined) {
          aggregated[stratKey][key].total++;
          if (sig[key] === 1) aggregated[stratKey][key].wins++;
        }
      }
    }
  }
}

// ─── GENERATE UNIFIED REPORT ──────────────────────────────────────────────────

console.log(`\n\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║            UNIFIED MULTI-DATABASE REPORT                   ║`);
console.log(`╚════════════════════════════════════════════════════════════╝\n`);

console.log(`Databases processed: ${allResults.length}`);
console.log(`Total signals: ${allResults.reduce((sum, r) => sum + r.signals.length, 0)}\n`);

console.log(`[ AGGREGATED WIN RATES - ALL DATABASES COMBINED ]\n`);
console.log(`Strategy         | 1m      | 2m      | 3m      | 5m      | 10m     | Best`);
console.log(`---------------- | ------- | ------- | ------- | ------- | ------- | ----`);

for (const [stratKey, expData] of Object.entries(aggregated)) {
  const row = [stratKey.padEnd(16)];
  let bestWr = 0, bestExp = null;
  
  for (const exp of EXPIRIES) {
    const key = exp + 'm';
    const t = expData[key].total;
    const w = expData[key].wins;
    const wr = t > 0 ? w / t : 0;
    const wrStr = t > 0 ? `${w}/${t} ${(wr*100).toFixed(0)}%` : '-';
    row.push(wrStr.padEnd(7));
    
    if (wr > bestWr) { bestWr = wr; bestExp = key; }
  }
  
  row.push(`${bestExp} ${(bestWr*100).toFixed(0)}%`);
  console.log(row.join(' | '));
}

console.log(`\n[ PER-DATABASE BREAKDOWN ]\n`);

for (const result of allResults) {
  console.log(`${result.dbFile}:`);
  console.log(`  Total bars: ${result.totalBars}`);
  console.log(`  Signals: ${result.signals.length}`);
  
  const byStrat = {};
  for (const sig of result.signals) {
    if (!byStrat[sig.strategy]) byStrat[sig.strategy] = 0;
    byStrat[sig.strategy]++;
  }
  
  for (const [strat, count] of Object.entries(byStrat)) {
    console.log(`    ${strat}: ${count}`);
  }
  console.log('');
}

// ─── SAVE DETAILED CSV ────────────────────────────────────────────────────────

const csvPath = path.join(OUTPUT_DIR, `unified_report_${Date.now()}.csv`);
const header = ['db', 'timestamp', 'asset', 'strategy', 'direction'];
for (const exp of EXPIRIES) header.push('win_' + exp + 'm');

const lines = [header.join(',')];
for (const result of allResults) {
  for (const sig of result.signals) {
    const row = [
      sig.db,
      new Date(sig.timestamp * 1000).toISOString(),
      sig.asset,
      sig.strategy,
      sig.direction
    ];
    for (const exp of EXPIRIES) {
      row.push(sig[exp + 'm'] !== undefined ? sig[exp + 'm'] : '');
    }
    lines.push(row.join(','));
  }
}

fs.writeFileSync(csvPath, lines.join('\n'));
console.log(`\n✅ Detailed report saved: ${csvPath}\n`);

// ─── RECOMMENDATIONS ──────────────────────────────────────────────────────────

console.log(`[ RECOMMENDATIONS ]\n`);

for (const [stratKey, expData] of Object.entries(aggregated)) {
  const best = Object.entries(expData)
    .filter(([, d]) => d.total > 0)
    .map(([exp, d]) => ({ exp, wr: d.wins / d.total, wins: d.wins, total: d.total }))
    .sort((a, b) => b.wr - a.wr)[0];
  
  if (best && best.wr >= 0.55) {
    console.log(`✅ ${stratKey}: ${best.exp} = ${(best.wr*100).toFixed(1)}% (${best.wins}/${best.total})`);
  } else if (best) {
    console.log(`⚠️  ${stratKey}: Best = ${best.exp} ${(best.wr*100).toFixed(1)}% (${best.wins}/${best.total}) - marginal`);
  } else {
    console.log(`❌ ${stratKey}: No viable expiry found`);
  }
}

console.log('');
