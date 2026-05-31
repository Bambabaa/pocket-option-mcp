import sqlite3Module from 'sqlite3';
import fs from 'fs';

const sqlite3 = sqlite3Module.verbose();

const db = new sqlite3.Database('data/agent.db', (err) => {
  if (err) {
    console.error('DB Error:', err);
    process.exit(1);
  }

  // Query to merge candles with indicators for EURUSD only
  const query = `
    SELECT
      c.asset,
      c.timestamp,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
      i.bb_upper,
      i.bb_middle,
      i.bb_lower,
      i.bb_width_bps,
      i.stc_value,
      i.stc_signal,
      i.stc_prev,
      i.stc_delta,
      i.stoch_k,
      i.stoch_d,
      i.cci_20
    FROM candles c
    LEFT JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
    WHERE c.asset = 'EURUSD'
    ORDER BY c.timestamp ASC
  `;

  db.all(query, (err, rows) => {
    if (err) {
      console.error('Query Error:', err);
      db.close();
      process.exit(1);
    }

    if (!rows || rows.length === 0) {
      console.log('No EURUSD data found');
      db.close();
      process.exit(0);
    }

    console.log(`Found ${rows.length} EURUSD candles with indicators`);

    // Convert timestamp to readable date
    const data = rows.map(row => ({
      ...row,
      date: new Date(row.timestamp * 1000).toISOString()
    }));

    // Write CSV
    const csv = convertToCSV(data);
    const outputPath = 'data/eurusd-agent-candles-indicators.csv';

    fs.writeFileSync(outputPath, csv, 'utf-8');
    console.log(`✓ Exported to ${outputPath}`);
    console.log(`Rows: ${data.length}, Columns: ${Object.keys(data[0]).length}`);

    db.close();
  });
});

function convertToCSV(data) {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');

  const csvRows = data.map(row => {
    return headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'string' && value.includes(',')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  });

  return [csvHeaders, ...csvRows].join('\n');
}
