const fs = require('fs');
const lines = fs.readFileSync('data/paper_reversal_leaves_live_v2.csv', 'utf8').replace(/\r/g,'').trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const vals = l.split(',');
  const obj = {};
  headers.forEach((h, i) => obj[h] = vals[i]);
  return obj;
});

function stat(arr) {
  const n = arr.length;
  if (!n) return 'n=0   WR=-%    PL=$0       ';
  const w = arr.filter(r => r.win_2m === '1').length;
  const pl = arr.reduce((s,r) => s + parseFloat(r.pnl_2m||0), 0);
  const wr = (w/n*100).toFixed(1);
  const bep = parseFloat(wr) >= 57 ? '✓' : parseFloat(wr) >= 52.1 ? '~' : '✗';
  return ('n='+n).padEnd(7) + ('WR='+wr+'%').padEnd(10) + ('PL=$'+pl.toFixed(0)).padEnd(12) + bep;
}

const byLeaf = {};
rows.forEach(r => { if (!byLeaf[r.leaf_id]) byLeaf[r.leaf_id] = []; byLeaf[r.leaf_id].push(r); });

function printSweep(title, bands) {
  console.log('\n' + '='.repeat(80));
  console.log('FEATURE: ' + title);
  console.log('='.repeat(80));
  console.log('  Band                      L16                              L41                              L65                              ALL');
  console.log('  ' + '-'.repeat(140));
  bands.forEach(([label, fn]) => {
    const res = ['L16','L41','L65','ALL'].map(leaf => {
      const arr = leaf === 'ALL' ? rows : (byLeaf[leaf] || []);
      return stat(arr.filter(fn));
    });
    console.log('  ' + label.padEnd(26) + res[0].padEnd(33) + res[1].padEnd(33) + res[2].padEnd(33) + res[3]);
  });
}

const v = (r, f) => parseFloat(r[f]);
const h = r => new Date(r.timestamp_utc).getUTCHours();

// 1. MA TREND BPS
printSweep('ma_trend_bps', [
  ['< -20',              r => v(r,'ma_trend_bps') < -20],
  ['[-20, -10)',         r => v(r,'ma_trend_bps') >= -20 && v(r,'ma_trend_bps') < -10],
  ['[-10, -5)',          r => v(r,'ma_trend_bps') >= -10 && v(r,'ma_trend_bps') < -5],
  ['[-5,  0)',           r => v(r,'ma_trend_bps') >= -5  && v(r,'ma_trend_bps') < 0],
  ['[0,   3)',           r => v(r,'ma_trend_bps') >= 0   && v(r,'ma_trend_bps') < 3],
  ['[3,   5)',           r => v(r,'ma_trend_bps') >= 3   && v(r,'ma_trend_bps') < 5],
  ['[5,  10)',           r => v(r,'ma_trend_bps') >= 5   && v(r,'ma_trend_bps') < 10],
  ['[10, 20)',           r => v(r,'ma_trend_bps') >= 10  && v(r,'ma_trend_bps') < 20],
  ['>= 20',             r => v(r,'ma_trend_bps') >= 20],
  ['--- excl [0,10)',    r => v(r,'ma_trend_bps') < 0   || v(r,'ma_trend_bps') >= 10],
  ['--- excl [3,10)',    r => v(r,'ma_trend_bps') < 3   || v(r,'ma_trend_bps') >= 10],
  ['--- excl [0,5)',     r => v(r,'ma_trend_bps') < 0   || v(r,'ma_trend_bps') >= 5],
  ['--- only < 0',       r => v(r,'ma_trend_bps') < 0],
  ['--- only < 0 or >10',r => v(r,'ma_trend_bps') < 0  || v(r,'ma_trend_bps') > 10],
]);

// 2. BB WIDTH BPS
printSweep('bb_width_bps', [
  ['< 20',              r => v(r,'bb_width_bps') < 20],
  ['[20, 30)',          r => v(r,'bb_width_bps') >= 20  && v(r,'bb_width_bps') < 30],
  ['[30, 40)',          r => v(r,'bb_width_bps') >= 30  && v(r,'bb_width_bps') < 40],
  ['[40, 50)',          r => v(r,'bb_width_bps') >= 40  && v(r,'bb_width_bps') < 50],
  ['[50, 60)',          r => v(r,'bb_width_bps') >= 50  && v(r,'bb_width_bps') < 60],
  ['[60, 80)',          r => v(r,'bb_width_bps') >= 60  && v(r,'bb_width_bps') < 80],
  ['[80, 100)',         r => v(r,'bb_width_bps') >= 80  && v(r,'bb_width_bps') < 100],
  ['[100,150)',         r => v(r,'bb_width_bps') >= 100 && v(r,'bb_width_bps') < 150],
  ['>= 150',           r => v(r,'bb_width_bps') >= 150],
  ['--- >= 50',         r => v(r,'bb_width_bps') >= 50],
  ['--- >= 60',         r => v(r,'bb_width_bps') >= 60],
  ['--- >= 80',         r => v(r,'bb_width_bps') >= 80],
  ['--- >= 100',        r => v(r,'bb_width_bps') >= 100],
  ['--- excl [30,60)',  r => v(r,'bb_width_bps') < 30  || v(r,'bb_width_bps') >= 60],
  ['--- excl [20,60)',  r => v(r,'bb_width_bps') < 20  || v(r,'bb_width_bps') >= 60],
]);

// 3. STOCH KD DIFF
printSweep('stoch_kd_diff', [
  ['< -30',             r => v(r,'stoch_kd_diff') < -30],
  ['[-30,-20)',         r => v(r,'stoch_kd_diff') >= -30 && v(r,'stoch_kd_diff') < -20],
  ['[-20,-10)',         r => v(r,'stoch_kd_diff') >= -20 && v(r,'stoch_kd_diff') < -10],
  ['[-10,  0)',         r => v(r,'stoch_kd_diff') >= -10 && v(r,'stoch_kd_diff') < 0],
  ['[0,   10)',         r => v(r,'stoch_kd_diff') >= 0   && v(r,'stoch_kd_diff') < 10],
  ['[10,  20)',         r => v(r,'stoch_kd_diff') >= 10  && v(r,'stoch_kd_diff') < 20],
  ['[20,  25)',         r => v(r,'stoch_kd_diff') >= 20  && v(r,'stoch_kd_diff') < 25],
  ['[25,  30)',         r => v(r,'stoch_kd_diff') >= 25  && v(r,'stoch_kd_diff') < 30],
  ['[30,  40)',         r => v(r,'stoch_kd_diff') >= 30  && v(r,'stoch_kd_diff') < 40],
  ['>= 40',            r => v(r,'stoch_kd_diff') >= 40],
  ['--- >= 28',         r => v(r,'stoch_kd_diff') >= 28],
  ['--- >= 30',         r => v(r,'stoch_kd_diff') >= 30],
  ['--- >= 35',         r => v(r,'stoch_kd_diff') >= 35],
  ['--- excl [0,25)',   r => v(r,'stoch_kd_diff') < 0   || v(r,'stoch_kd_diff') >= 25],
  ['--- excl [0,30)',   r => v(r,'stoch_kd_diff') < 0   || v(r,'stoch_kd_diff') >= 30],
]);

// 4. SCHAFF VALUE
printSweep('schaff_value (non-null only)', [
  ['[0,   5)',          r => r.schaff_value && v(r,'schaff_value') >= 0  && v(r,'schaff_value') < 5],
  ['[5,  15)',          r => r.schaff_value && v(r,'schaff_value') >= 5  && v(r,'schaff_value') < 15],
  ['[15, 25)',          r => r.schaff_value && v(r,'schaff_value') >= 15 && v(r,'schaff_value') < 25],
  ['[25, 50)',          r => r.schaff_value && v(r,'schaff_value') >= 25 && v(r,'schaff_value') < 50],
  ['[50, 75)',          r => r.schaff_value && v(r,'schaff_value') >= 50 && v(r,'schaff_value') < 75],
  ['[75, 85)',          r => r.schaff_value && v(r,'schaff_value') >= 75 && v(r,'schaff_value') < 85],
  ['[85, 99)',          r => r.schaff_value && v(r,'schaff_value') >= 85 && v(r,'schaff_value') < 99],
  ['>= 99',            r => r.schaff_value && v(r,'schaff_value') >= 99],
  ['--- < 75',          r => r.schaff_value && v(r,'schaff_value') < 75],
  ['--- < 85',          r => r.schaff_value && v(r,'schaff_value') < 85],
  ['--- [5, 75)',        r => r.schaff_value && v(r,'schaff_value') >= 5  && v(r,'schaff_value') < 75],
  ['--- [5, 85)',        r => r.schaff_value && v(r,'schaff_value') >= 5  && v(r,'schaff_value') < 85],
  ['--- [25,75)',        r => r.schaff_value && v(r,'schaff_value') >= 25 && v(r,'schaff_value') < 75],
  ['--- [50,75)',        r => r.schaff_value && v(r,'schaff_value') >= 50 && v(r,'schaff_value') < 75],
]);

// 5. HOUR UTC
printSweep('hour_utc', [
  ['UTC 4',            r => h(r) === 4],
  ['UTC 5',            r => h(r) === 5],
  ['UTC 6',            r => h(r) === 6],
  ['UTC 7',            r => h(r) === 7],
  ['UTC 8',            r => h(r) === 8],
  ['UTC 9',            r => h(r) === 9],
  ['UTC 10',           r => h(r) === 10],
  ['UTC 11',           r => h(r) === 11],
  ['UTC 12',           r => h(r) === 12],
  ['UTC 13',           r => h(r) === 13],
  ['UTC 14',           r => h(r) === 14],
  ['UTC 15',           r => h(r) === 15],
  ['--- excl 15',      r => h(r) !== 15],
  ['--- excl 11,13,15',r => ![11,13,15].includes(h(r))],
  ['--- excl 10-15',   r => h(r) < 10],
  ['--- only 4-7',     r => h(r) >= 4 && h(r) <= 7],
  ['--- only 14',      r => h(r) === 14],
]);

// 6. COMBINED: ma_trend excl [0,10) AND bb_width excl [30,60) AND schaff < 85 AND excl UTC 15
printSweep('COMBO: excl ma[0,10) + excl bbW[30,60) + schaff<85 + excl UTC15', [
  ['all 4 filters',    r => (v(r,'ma_trend_bps') < 0 || v(r,'ma_trend_bps') >= 10) &&
                            (v(r,'bb_width_bps') < 30 || v(r,'bb_width_bps') >= 60) &&
                            r.schaff_value && v(r,'schaff_value') < 85 &&
                            h(r) !== 15],
  ['ma + bbW only',    r => (v(r,'ma_trend_bps') < 0 || v(r,'ma_trend_bps') >= 10) &&
                            (v(r,'bb_width_bps') < 30 || v(r,'bb_width_bps') >= 60)],
  ['ma + UTC15 only',  r => (v(r,'ma_trend_bps') < 0 || v(r,'ma_trend_bps') >= 10) && h(r) !== 15],
  ['bbW + UTC15 only', r => (v(r,'bb_width_bps') < 30 || v(r,'bb_width_bps') >= 60) && h(r) !== 15],
  ['schaff<85 + UTC15',r => r.schaff_value && v(r,'schaff_value') < 85 && h(r) !== 15],
  ['ma+bbW+UTC15',     r => (v(r,'ma_trend_bps') < 0 || v(r,'ma_trend_bps') >= 10) &&
                            (v(r,'bb_width_bps') < 30 || v(r,'bb_width_bps') >= 60) &&
                            h(r) !== 15],
]);
