// inspect-agent-db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DB_PATH = path.join(__dirname, '../../agent/data/agent.db');
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.log('Error:', err.message); process.exit(1); }
});
db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
  if (err) { console.log('err:', err.message); return; }
  console.log('=== TABLES ===');
  const tables = rows.map(r => r.name);
  console.log(tables.join('\n'));

  let done = 0;
  tables.forEach(tbl => {
    db.all(`SELECT * FROM ${tbl} LIMIT 2`, (err2, sample) => {
      if (!err2 && sample && sample.length > 0) {
        console.log(`\n=== ${tbl} sample ===`);
        console.log(JSON.stringify(sample[0], null, 2));
      }
      db.get(`SELECT COUNT(*) as cnt FROM ${tbl}`, (err3, r) => {
        console.log(`  ${tbl}: ${r ? r.cnt : '?'} rows`);
        done++;
        if (done === tables.length) db.close();
      });
    });
  });
});
