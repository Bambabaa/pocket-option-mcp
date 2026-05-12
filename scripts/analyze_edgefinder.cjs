'use strict';
const fs = require('fs');

const csvPath = process.argv[2] || 'data/edgefinder_ALL.csv';
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const v = l.split(','), o = {};
  header.forEach((h, i) => o[h] = v[i]);
  return o;
});

const byAsset = {};
for (const r of rows) {
  if (!byAsset[r.asset]) byAsset[r.asset] = [];
  byAsset[r.asset].push(r);
}

const summary = [];
for (const [asset, sigs] of Object.entries(byAsset)) {
  const v2 = sigs.filter(r => r.win_2m !== '');
  const w2 = v2.filter(r => r.win_2m === '1');
  const wr = v2.length ? (w2.length / v2.length * 100) : 0;
  const pnl = v2.reduce((s, r) => s + parseFloat(r.pnl_2m || 0), 0);
  summary.push({ asset, n: sigs.length, wr, pnl, valid: v2.length });
}

summary.sort((a, b) => b.wr - a.wr);
console.log('Asset                  | Sigs | Valid | 2m WR  | 2m PnL');
console.log('-'.repeat(60));
summary.forEach(s => {
  const wr = s.valid ? s.wr.toFixed(1) + '%' : 'N/A';
  console.log(s.asset.padEnd(22) + '| ' + String(s.n).padStart(4) + ' | ' + String(s.valid).padStart(5) + ' | ' + wr.padStart(6) + ' | $' + s.pnl.toFixed(0));
});

const v2all = rows.filter(r => r.win_2m !== '');
const w2all = v2all.filter(r => r.win_2m === '1');
const pnlAll = v2all.reduce((s, r) => s + parseFloat(r.pnl_2m || 0), 0);
const wrAll = v2all.length ? (w2all.length / v2all.length * 100).toFixed(1) + '%' : 'N/A';
console.log('-'.repeat(60));
console.log('ALL'.padEnd(22) + '| ' + String(rows.length).padStart(4) + ' | ' + String(v2all.length).padStart(5) + ' | ' + wrAll.padStart(6) + ' | $' + pnlAll.toFixed(0));
