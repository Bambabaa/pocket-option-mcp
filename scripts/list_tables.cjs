const Database = require('better-sqlite3');
const db = new Database('C:/Users/M2S30/Documents/GitHub/pocket-option-mcp/data/trading_data.db', {readonly: true});
const tables = db.prepare('SELECT name FROM sqlite_master WHERE type="table"').all();
console.log(tables.map(t => t.name).join('\n'));
db.close();
