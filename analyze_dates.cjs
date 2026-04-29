const fs = require('fs');
const lines = fs.readFileSync('data/replay_signals.csv', 'utf8').trim().split('\n');
const headers = lines[0].split(',').map(s => s.trim());
const r60Idx = headers.indexOf('r60');
const r120Idx = headers.indexOf('r120');
const dateIdx = headers.indexOf('date');

const byDate = {};
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  if (p.length < headers.length) continue;
  const dateStr = p[dateIdx].substring(0, 10);
  const r60 = p[r60Idx];
  const r120 = p[r120Idx];
  
  if (!byDate[dateStr]) {
    byDate[dateStr] = { t60: 0, w60: 0, t120: 0, w120: 0 };
  }
  
  if (r60 === 'WIN' || r60 === 'LOSS') {
    byDate[dateStr].t60++;
    if (r60 === 'WIN') byDate[dateStr].w60++;
  }
  
  if (r120 === 'WIN' || r120 === 'LOSS') {
    byDate[dateStr].t120++;
    if (r120 === 'WIN') byDate[dateStr].w120++;
  }
}

console.log('Date       | 1-Min Expiry (WR)      | 2-Min Expiry (WR)');
console.log('-----------|------------------------|------------------------');
let totT60 = 0, totW60 = 0, totT120 = 0, totW120 = 0;
const dates = Object.keys(byDate).sort();
for (const d of dates) {
  if (!d) continue;
  const v = byDate[d];
  totT60 += v.t60; totW60 += v.w60;
  totT120 += v.t120; totW120 += v.w120;
  const wr60 = v.t60 > 0 ? (v.w60 / v.t60 * 100).toFixed(1) + '%' : 'N/A';
  const str60 = v.w60 + '/' + v.t60 + ' (' + wr60 + ')';
  
  const wr120 = v.t120 > 0 ? (v.w120 / v.t120 * 100).toFixed(1) + '%' : 'N/A';
  const str120 = v.w120 + '/' + v.t120 + ' (' + wr120 + ')';
  
  console.log(d.padEnd(10) + ' | ' + str60.padEnd(22) + ' | ' + str120);
}
console.log('-----------|------------------------|------------------------');
const fWr60 = totT60 > 0 ? (totW60 / totT60 * 100).toFixed(1) + '%' : 'N/A';
const fWr120 = totT120 > 0 ? (totW120 / totT120 * 100).toFixed(1) + '%' : 'N/A';
console.log('TOTAL      | ' + (totW60+'/'+totT60+' ('+fWr60+')').padEnd(22) + ' | ' + (totW120+'/'+totT120+' ('+fWr120+')'));
