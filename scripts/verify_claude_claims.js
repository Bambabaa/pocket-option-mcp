import sqlite3pkg from 'sqlite3';
const sqlite3 = sqlite3pkg.verbose();
import { promisify } from 'util';

const DBS = [
  ['v2_13-15', 'data/trading_data_v2_13-15.db'],
  ['V3_16', 'data/trading_data_V3_16.db'],
  ['V3_17', 'data/trading_data_V3_17.db'],
  ['current', 'data/trading_data.db'],
];

async function runAudit() {
  console.log('--- Multi-DB Statistical Verification Audit ---');

  for (const [name, path] of DBS) {
    console.log(`\nAnalyzing DB: ${name} (${path})...`);
    const db = new sqlite3.Database(path);
    const all = promisify(db.all.bind(db));

    try {
      // 1. Loss Concentration
      const lossRows = await all(`
        SELECT asset, SUM(profit_loss) as net_pnl, COUNT(*) as trades,
               SUM(CASE WHEN result='LOSS' THEN profit_loss ELSE 0 END) as gross_loss
        FROM trades_ordered
        WHERE result IN ('WIN', 'LOSS')
        GROUP BY asset
        ORDER BY gross_loss ASC
      `);
      
      const totalGrossLoss = lossRows.reduce((s, r) => s + r.gross_loss, 0);
      const worst5Loss = lossRows.slice(0, 5).reduce((s, r) => s + r.gross_loss, 0);
      const worst10Loss = lossRows.slice(0, 10).reduce((s, r) => s + r.gross_loss, 0);
      
      console.log(`  Loss Concentration:`);
      console.log(`    Total Gross Loss: $${totalGrossLoss.toFixed(0)}`);
      console.log(`    Worst 5 Assets:   $${worst5Loss.toFixed(0)} (${(worst5Loss/totalGrossLoss*100).toFixed(1)}% of loss)`);
      console.log(`    Worst 10 Assets:  $${worst10Loss.toFixed(0)} (${(worst10Loss/totalGrossLoss*100).toFixed(1)}% of loss)`);
      console.log(`    Top Bleeders:     ${lossRows.slice(0, 5).map(r => r.asset).join(', ')}`);

      // 2. Pattern Performance
      const patternRows = await all(`
        SELECT s.direction, s.reasons, t.result, t.profit_loss
        FROM trades_ordered t
        JOIN signals s ON s.id = t.signal_id
        WHERE t.result IN ('WIN', 'LOSS')
      `);

      const patterns = {};
      patternRows.forEach(r => {
        let p = 'UNKNOWN';
        if (r.reasons.includes('Reversal')) p = r.direction + '_REVERSAL';
        else if (r.reasons.includes('TREND')) p = r.direction + '_CONTINUATION';
        
        if (!patterns[p]) patterns[p] = { wins: 0, total: 0, pnl: 0 };
        patterns[p].total++;
        if (r.result === 'WIN') patterns[p].wins++;
        patterns[p].pnl += r.profit_loss;
      });

      console.log(`  Pattern Performance:`);
      Object.entries(patterns).forEach(([p, s]) => {
        const wr = (s.wins/s.total*100).toFixed(1);
        console.log(`    ${p.padEnd(18)}: n=${String(s.total).padEnd(3)} WR=${wr}% P/L=$${s.pnl.toFixed(0)}`);
      });

      // 3. Specific Filter Variants (Verification of Claude's "Quality Win" claim)
      // We'll join with indicators to get BB bps at signal time
      const filterRows = await all(`
        SELECT s.direction, s.reasons, t.result, t.profit_loss,
               (i.bb_upper - i.bb_lower) / i.bb_middle * 10000 as bb_bps
        FROM trades_ordered t
        JOIN signals s ON s.id = t.signal_id
        JOIN indicators i ON i.asset = t.asset 
             AND i.timestamp >= t.entry_timestamp - 60 
             AND i.timestamp <= t.entry_timestamp + 60
        WHERE t.result IN ('WIN', 'LOSS')
      `);

      console.log(`  Filter Stability Verification (CALL_CONTINUATION):`);
      const callUT = filterRows.filter(r => r.reasons.includes('UP TREND'));
      
      const variants = [
        { label: 'Baseline (no extra filters)', fn: r => true },
        { label: 'Current (K>=85 + bbW<=30)', fn: r => {
            const kMatch = r.reasons.match(/K ([0-9.]+)/);
            const k = kMatch ? parseFloat(kMatch[1]) : 0;
            return k >= 85 && r.bb_bps <= 30;
        }},
        { label: 'Proposed (K>=85 only)', fn: r => {
            const kMatch = r.reasons.match(/K ([0-9.]+)/);
            return kMatch && parseFloat(kMatch[1]) >= 85;
        }}
      ];

      variants.forEach(v => {
        const sub = callUT.filter(v.fn);
        const wins = sub.filter(r => r.result === 'WIN').length;
        const wr = sub.length ? (wins/sub.length*100).toFixed(1) : 'N/A';
        const pnl = sub.reduce((s, r) => s + r.profit_loss, 0);
        console.log(`    ${v.label.padEnd(25)}: n=${String(sub.length).padEnd(3)} WR=${wr}% P/L=$${pnl.toFixed(0)}`);
      });

    } catch (err) {
      console.error(`  Error analyzing ${name}: ${err.message}`);
    } finally {
      db.close();
    }
  }
}

runAudit();
