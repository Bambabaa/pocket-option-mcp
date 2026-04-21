// Replay combined PUT_REV rule: bbw>=30 & vel<-12 & RSI in [60,70) & K-D<-7
// Across all 6 DBs. Compare to current live (bbw>=50).

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v1',         'data/trading_data_v1.db'],
  ['v2_13-15',   'data/trading_data_v2_13-15.db'],
  ['V3_16',      'data/trading_data_V3_16.db'],
  ['V3_17',      'data/trading_data_V3_17.db'],
  ['V4_17',      'data/trading_data_V4_17.db'],
  ['current',    'data/trading_data.db'],
];

const open = p => new Promise((res, rej) => {
  const db = new sqlite3.Database(p, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(db));
});
const all = (db, q, p = []) => new Promise((res, rej) =>
  db.all(q, p, (e, rows) => e ? rej(e) : res(rows)));

const parseNum = (re, s) => { const m = s && s.match(re); return m ? parseFloat(m[1]) : null; };
const parsePattern = r => {
  if (!r) return null;
  if (r.includes('OVERSOLD') && r.includes('Reversal'))   return 'CALL_REV';
  if (r.includes('OVERBOUGHT') && r.includes('Reversal')) return 'PUT_REV';
  if (r.includes('UP TREND'))                              return 'CALL_UT';
  if (r.includes('DOWN TREND'))                            return 'PUT_DT';
  return null;
};

const stats = rows => {
  const n = rows.length;
  const wins = rows.filter(r => r.result === 'WIN').length;
  const pnl = rows.reduce((s, r) => s + (r.profit_loss || 0), 0);
  const gw = rows.filter(r => (r.profit_loss || 0) > 0).reduce((s, r) => s + r.profit_loss, 0);
  const gl = Math.abs(rows.filter(r => (r.profit_loss || 0) < 0).reduce((s, r) => s + r.profit_loss, 0));
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 999 : 0);
  return { n, wins, wr: n ? (100 * wins / n) : 0, pnl, pf };
};

const wilson = (w, n) => {
  if (!n) return [0, 0];
  const p = w / n, z = 1.96, z2 = z*z;
  const c = (p + z2/(2*n)) / (1 + z2/n);
  const h = z * Math.sqrt((p*(1-p) + z2/(4*n)) / n) / (1 + z2/n);
  return [100*(c-h), 100*(c+h)];
};

const fmt = s => `n=${String(s.n).padStart(3)} WR=${s.wr.toFixed(1).padStart(5)}% PF=${s.pf.toFixed(2).padStart(5)} P/L=$${s.pnl.toFixed(0).padStart(6)}`;

(async () => {
  // Rules
  const RULES = {
    'baseline_all_PUT_REV':      r => true,
    'current_live_bbw>=50':      r => r.bbw >= 50,
    'proposed_bbw>=30':          r => r.bbw >= 30,
    'combo_bbw30+vel':           r => r.bbw >= 30 && r.vel < -12,
    'combo_bbw30+vel+RSI':       r => r.bbw >= 30 && r.vel < -12 && r.rsi >= 60 && r.rsi < 70,
    'combo_FULL (bbw30+vel+RSI+KD<-7)': r => r.bbw >= 30 && r.vel < -12 && r.rsi >= 60 && r.rsi < 70 && r.kd < -7,
    'combo_FULL_KD<-3':          r => r.bbw >= 30 && r.vel < -12 && r.rsi >= 60 && r.rsi < 70 && r.kd < -3,
  };

  const agg = {}; // rule -> array of per-db stats
  for (const k of Object.keys(RULES)) agg[k] = [];

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) { console.error(`SKIP ${tag}`); continue; }
    const db = await open(abs);
    const tbls = await all(db, `SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tbls.map(t => t.name);
    if (!names.includes('signal_outcomes')) { console.error(`SKIP ${tag}: no signal_outcomes`); db.close(); continue; }

    const rows = await all(db,
      `SELECT s.reasons, o.result, o.profit_loss
       FROM signal_outcomes o JOIN signals s ON s.id = o.signal_id
       WHERE o.result IN ('WIN','LOSS')`);
    const pr = rows.map(r => ({
      ...r,
      pat: parsePattern(r.reasons),
      rsi: parseNum(/RSI ([0-9.]+)/, r.reasons),
      vel: parseNum(/vel=(-?[0-9.]+)/, r.reasons),
      kd:  parseNum(/K-D (-?[0-9.]+)/, r.reasons),
      bbw: parseNum(/BB ([0-9.]+)bps/, r.reasons),
    })).filter(r => r.pat === 'PUT_REV' && r.bbw != null && r.vel != null && r.rsi != null && r.kd != null);

    console.log(`\n═══ ${tag} — PUT_REV parseable n=${pr.length} ═══`);
    for (const [name, fn] of Object.entries(RULES)) {
      const sub = pr.filter(fn);
      const s = stats(sub);
      const [lo, hi] = wilson(s.wins, s.n);
      console.log(`  ${name.padEnd(40)} ${fmt(s)} CI=[${lo.toFixed(1)},${hi.toFixed(1)}]`);
      agg[name].push({ tag, ...s, lo, hi });
    }
    db.close();
  }

  // Aggregate
  console.log(`\n═══ AGGREGATE (sum across DBs) ═══`);
  console.log(`${'rule'.padEnd(42)} ${'n'.padStart(4)} ${'wins'.padStart(4)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'P/L'.padStart(9)}  DBs≥50%WR`);
  for (const [name, arr] of Object.entries(agg)) {
    const n = arr.reduce((s,a)=>s+a.n, 0);
    const w = arr.reduce((s,a)=>s+a.wins, 0);
    const pnl = arr.reduce((s,a)=>s+a.pnl, 0);
    const win50 = arr.filter(a => a.n >= 5 && a.wr >= 50).length;
    const totalN = arr.filter(a => a.n >= 5).length;
    // combined PF
    // (skip exact PF across DBs; use avg)
    const avgPF = arr.filter(a=>a.n>0).reduce((s,a)=>s+a.pf,0) / Math.max(1, arr.filter(a=>a.n>0).length);
    console.log(`${name.padEnd(42)} ${String(n).padStart(4)} ${String(w).padStart(4)} ${(100*w/Math.max(1,n)).toFixed(1).padStart(5)}% ${avgPF.toFixed(2).padStart(6)} $${pnl.toFixed(0).padStart(7)}  ${win50}/${totalN}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
