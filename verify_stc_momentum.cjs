const fs = require('fs');
const lines = fs.readFileSync('data/replay_signals.csv', 'utf8').trim().split('\n');
const headers = lines[0].split(',').map(s => s.trim());

const sigs = [];
for (let i = 1; i < lines.length; i++) {
  const p = lines[i].split(',');
  if (p.length < headers.length) continue;
  const row = {};
  headers.forEach((h, j) => row[h] = p[j]);
  sigs.push(row);
}

const calls = sigs.filter(s => s.dir === 'CALL' && (s.r120 === 'WIN' || s.r120 === 'LOSS'));
let cStrong = { t: 0, w: 0 };
let cWeak = { t: 0, w: 0 };
let cShallow = { t: 0, w: 0 };
let cDeep = { t: 0, w: 0 };

calls.forEach(s => {
  const stc = parseFloat(s.stc);
  const prev = parseFloat(s.stc_prev);
  const delta = stc - prev;
  const win = s.r120 === 'WIN';
  
  if (delta > 15) { cStrong.t++; if(win) cStrong.w++; }
  else if (delta >= 0 && delta <= 5) { cWeak.t++; if(win) cWeak.w++; }
  
  if (prev >= 10 && prev <= 25) { cShallow.t++; if(win) cShallow.w++; }
  if (prev < 10) { cDeep.t++; if(win) cDeep.w++; }
});

const puts = sigs.filter(s => s.dir === 'PUT' && (s.r120 === 'WIN' || s.r120 === 'LOSS'));
let pStrong = { t: 0, w: 0 };
let pWeak = { t: 0, w: 0 };
let pShallow = { t: 0, w: 0 };
let pDeep = { t: 0, w: 0 };

puts.forEach(s => {
  const stc = parseFloat(s.stc);
  const prev = parseFloat(s.stc_prev);
  const delta = stc - prev;
  const win = s.r120 === 'WIN';
  
  if (delta < -15) { pStrong.t++; if(win) pStrong.w++; }
  else if (delta <= 0 && delta >= -5) { pWeak.t++; if(win) pWeak.w++; }
  
  if (prev >= 75 && prev <= 90) { pShallow.t++; if(win) pShallow.w++; }
  if (prev > 90) { pDeep.t++; if(win) pDeep.w++; }
});

console.log('--- CALL ---');
console.log('Strong bounce (delta > 15): ' + cStrong.w + '/' + cStrong.t + ' (' + (cStrong.t ? (cStrong.w/cStrong.t*100).toFixed(1) : 0) + '%)');
console.log('Weak bounce (delta 0-5): ' + cWeak.w + '/' + cWeak.t + ' (' + (cWeak.t ? (cWeak.w/cWeak.t*100).toFixed(1) : 0) + '%)');
console.log('Shallow floor (prev 10-25): ' + cShallow.w + '/' + cShallow.t + ' (' + (cShallow.t ? (cShallow.w/cShallow.t*100).toFixed(1) : 0) + '%)');
console.log('Deep floor (prev < 10): ' + cDeep.w + '/' + cDeep.t + ' (' + (cDeep.t ? (cDeep.w/cDeep.t*100).toFixed(1) : 0) + '%)');

console.log('\n--- PUT ---');
console.log('Strong rollover (delta < -15): ' + pStrong.w + '/' + pStrong.t + ' (' + (pStrong.t ? (pStrong.w/pStrong.t*100).toFixed(1) : 0) + '%)');
console.log('Weak rollover (delta -5-0): ' + pWeak.w + '/' + pWeak.t + ' (' + (pWeak.t ? (pWeak.w/pWeak.t*100).toFixed(1) : 0) + '%)');
console.log('Shallow ceiling (prev 75-90): ' + pShallow.w + '/' + pShallow.t + ' (' + (pShallow.t ? (pShallow.w/pShallow.t*100).toFixed(1) : 0) + '%)');
console.log('Deep ceiling (prev > 90): ' + pDeep.w + '/' + pDeep.t + ' (' + (pDeep.t ? (pDeep.w/pDeep.t*100).toFixed(1) : 0) + '%)');
