import sqlite3pkg from 'sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, '../data/trading_data.db');

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Failed to open DB:', err.message);
    process.exit(1);
  }
});

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) => {
  if (err) {
    console.error('Query error:', err.message);
  } else {
    console.log('Tables in trading_data.db:');
    rows.forEach(row => console.log(' - ' + row.name));
  }
  db.close();
});
