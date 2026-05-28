'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../data/agent.db'), { readonly: true });

const assets = db.prepare(`
  SELECT
    c.asset,
    COUNT(c.timestamp) as candles,
    MIN(datetime(c.timestamp, 'unixepoch')) as oldest,
    MAX(datetime(c.timestamp, 'unixepoch')) as newest,
    COALESCE(i.ind_count, 0) as indicators,
    ROUND(COALESCE(i.ind_count,0)*100.0/COUNT(c.timestamp),1) as ind_pct
  FROM candles c
  LEFT JOIN (
    SELECT asset, COUNT(*) as ind_count FROM indicators WHERE stc_value IS NOT NULL GROUP BY asset
  ) i ON i.asset = c.asset
  GROUP BY c.asset
  ORDER BY c.asset
`).all();

const pad = (s, n) => String(s).padStart(n);
const padl = (s, n) => String(s).padEnd(n);
console.log(padl('Asset',20) + pad('Candles',9) + pad('Indicators',11) + pad('Cov%',6) + '  Oldest → Newest');
console.log('-'.repeat(108));
for (const r of assets) {
    console.log(
        padl(r.asset,20) + pad(r.candles,9) + pad(r.indicators,11) + pad(r.ind_pct,5)+'%' +
        '  ' + r.oldest + ' -> ' + r.newest
    );
}
console.log('-'.repeat(108));
const t  = db.prepare("SELECT COUNT(DISTINCT asset) as a, COUNT(*) as c FROM candles").get();
const ti = db.prepare("SELECT COUNT(*) as n FROM indicators WHERE stc_value IS NOT NULL").get();
console.log(`Total: ${t.a} assets, ${t.c.toLocaleString()} candles, ${ti.n.toLocaleString()} valid indicators`);
db.close();
