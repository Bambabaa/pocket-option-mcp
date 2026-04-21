// QA audit — docs/qa.md all 8 phases across all 6 DBs.
// Parses reasons string to identify pattern + pulls contextual fields.

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

const parsePattern = r => {
  if (!r) return null;
  if (r.includes('OVERSOLD') && r.includes('Reversal'))   return 'CALL_REV';
  if (r.includes('OVERBOUGHT') && r.includes('Reversal')) return 'PUT_REV';
  if (r.includes('UP TREND'))                              return 'CALL_UT';
  if (r.includes('DOWN TREND'))                            return 'PUT_DT';
  return null;
};

const parseNum = (re, s) => { const m = s && s.match(re); return m ? parseFloat(m[1]) : null; };

// Parse out BB/RSI/K/D/vel/KD metrics from reasons text
const parseMetrics = r => {
  if (!r) return {};
  return {
    rsi:   parseNum(/RSI ([0-9.]+)/, r),
    rsi_1: parseNum(/from ([0-9.]+)/, r),
    vel:   parseNum(/vel=(-?[0-9.]+)/, r),
    stochK: parseNum(/(?:K|Stoch K) ([0-9.]+)/, r),
    stochD: parseNum(/D ([0-9.]+) \(>=\d/, r),
    kd:     parseNum(/K-D (-?[0-9.]+)/, r),
    bbw:    parseNum(/BB ([0-9.]+)bps/, r),
    kcrash: parseNum(/K crash ([0-9.]+)pts/, r),
    utcHour: parseNum(/UTC ([0-9]+)/, r),
  };
};

// WR / profit factor
const stats = rows => {
  const n = rows.length;
  const wins = rows.filter(r => r.result === 'WIN').length;
  const losses = rows.filter(r => r.result === 'LOSS').length;
  const pnl = rows.reduce((s, r) => s + (r.profit_loss || 0), 0);
  const grossWin = rows.filter(r => (r.profit_loss || 0) > 0).reduce((s, r) => s + r.profit_loss, 0);
  const grossLoss = Math.abs(rows.filter(r => (r.profit_loss || 0) < 0).reduce((s, r) => s + r.profit_loss, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  return { n, wins, losses, wr: n ? (100 * wins / n) : 0, pnl, pf };
};

const fmt = s => `n=${s.n.toString().padStart(4)} WR=${s.wr.toFixed(1).padStart(5)}% PF=${s.pf.toFixed(2).padStart(5)} P/L=$${s.pnl.toFixed(0).padStart(6)}`;

const wilson = (wins, n) => {
  if (!n) return [0, 0];
  const p = wins / n, z = 1.96, z2 = z*z;
  const center = (p + z2/(2*n)) / (1 + z2/n);
  const h = z * Math.sqrt((p*(1-p) + z2/(4*n)) / n) / (1 + z2/n);
  return [100*(center-h), 100*(center+h)];
};

(async () => {
  const results = {};

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) { console.error(`SKIP ${tag}: ${dbp}`); continue; }
    const db = await open(abs);

    const tbls = await all(db, `SELECT name FROM sqlite_master WHERE type='table'`);
    const names = new Set(tbls.map(t => t.name));
    if (!names.has('signals') || !names.has('signal_outcomes')) {
      console.error(`SKIP ${tag}: missing signals/signal_outcomes`); db.close(); continue;
    }

    // Join signals ↔ outcomes ↔ indicators ↔ candle open
    const rows = await all(db, `
      SELECT s.asset, s.timestamp, s.direction, s.reasons,
             o.result, o.profit_loss, o.entry_price, o.exit_price,
             i.ma1, i.ma3, i.rsi_5, i.bb_upper, i.bb_middle, i.bb_lower,
             i.stochastic_k_v2 AS k, i.stochastic_d_v2 AS d,
             c.open AS c_open, c.close AS c_close, c.high AS c_high, c.low AS c_low
      FROM signals s
      LEFT JOIN signal_outcomes o ON o.asset=s.asset AND o.signal_timestamp=s.timestamp
      LEFT JOIN indicators i ON i.asset=s.asset AND i.timestamp=s.timestamp
      LEFT JOIN candles c ON c.asset=s.asset AND c.timestamp=s.timestamp
      WHERE o.result IS NOT NULL
    `);

    for (const r of rows) {
      r.pattern = parsePattern(r.reasons);
      r.metrics = parseMetrics(r.reasons);
      r.hour = r.timestamp ? new Date(r.timestamp * 1000).getUTCHours() : null;
      r.bbw_calc = (r.bb_upper && r.bb_lower && r.bb_middle)
        ? 10000 * (r.bb_upper - r.bb_lower) / r.bb_middle : null;
    }
    results[tag] = rows;
    db.close();
    console.error(`Loaded ${tag}: ${rows.length} rows with outcomes`);
  }

  // Aggregate all rows across all DBs
  const ALL = Object.entries(results).flatMap(([tag, rs]) => rs.map(r => ({ ...r, db: tag })));

  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 1 — SIGNAL CORPUS OVERVIEW (per DB, per pattern)');
  console.log('════════════════════════════════════════════════════════════════════');

  const patterns = ['CALL_REV', 'PUT_REV', 'CALL_UT', 'PUT_DT', null];
  const header = 'DB           | ' + patterns.map(p => (p || 'OTHER').padEnd(11)).join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [tag, rs] of Object.entries(results)) {
    const line = [tag.padEnd(12)];
    for (const p of patterns) {
      const f = rs.filter(r => r.pattern === p);
      const s = stats(f);
      line.push(`${s.n.toString().padStart(4)}/${s.wr.toFixed(0).padStart(2)}%`);
    }
    console.log(line.join(' | '));
  }

  console.log('\n== POOLED (all DBs) ==');
  for (const p of patterns.filter(x => x)) {
    const f = ALL.filter(r => r.pattern === p);
    const s = stats(f);
    const [lo, hi] = wilson(s.wins, s.n);
    console.log(`${p.padEnd(9)} ${fmt(s)} CI95[${lo.toFixed(1)},${hi.toFixed(1)}]`);
  }

  // PHASE 2 — PUT Reversal grid search
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 2 — PUT REVERSAL GRID (pooled across all DBs, PF focus)');
  console.log('════════════════════════════════════════════════════════════════════');
  const putRev = ALL.filter(r => r.pattern === 'PUT_REV');
  console.log(`Baseline PUT_REV pooled: ${fmt(stats(putRev))}`);

  console.log('\n-- BB width cliff --');
  [[0,10],[10,20],[20,30],[30,50],[50,70],[70,100],[100,200],[200,9999]].forEach(([lo,hi]) => {
    const f = putRev.filter(r => r.metrics.bbw != null && r.metrics.bbw >= lo && r.metrics.bbw < hi);
    if (f.length) console.log(`  BBW [${lo},${hi}) ${fmt(stats(f))}`);
  });

  console.log('\n-- RSI entry band --');
  [[35,38],[38,45],[45,50],[50,55],[55,60],[60,65],[65,70]].forEach(([lo,hi]) => {
    const f = putRev.filter(r => r.metrics.rsi != null && r.metrics.rsi >= lo && r.metrics.rsi < hi);
    if (f.length) console.log(`  RSI [${lo},${hi}) ${fmt(stats(f))}`);
  });

  console.log('\n-- RSI velocity --');
  [[-30,-20],[-20,-15],[-15,-12],[-12,-10],[-10,-8],[-8,-5],[-5,0]].forEach(([lo,hi]) => {
    const f = putRev.filter(r => r.metrics.vel != null && r.metrics.vel >= lo && r.metrics.vel < hi);
    if (f.length) console.log(`  vel [${lo},${hi}) ${fmt(stats(f))}`);
  });

  console.log('\n-- K-D spread --');
  [[-30,-10],[-10,-7],[-7,-5],[-5,-3],[-3,0]].forEach(([lo,hi]) => {
    const f = putRev.filter(r => r.metrics.kd != null && r.metrics.kd >= lo && r.metrics.kd < hi);
    if (f.length) console.log(`  K-D [${lo},${hi}) ${fmt(stats(f))}`);
  });

  console.log('\n-- Top combos (bbw × vel) PF-ranked --');
  const combos = [];
  [[30,50],[50,70],[70,100],[100,200],[200,9999],[50,9999],[30,9999]].forEach(([bl,bh]) => {
    [[-30,-15],[-20,-15],[-15,-12],[-15,-10],[-20,-10],[-15,-8]].forEach(([vl,vh]) => {
      const f = putRev.filter(r => r.metrics.bbw != null && r.metrics.bbw >= bl && r.metrics.bbw < bh &&
                                     r.metrics.vel != null && r.metrics.vel >= vl && r.metrics.vel < vh);
      if (f.length >= 5) combos.push({ label: `bbw[${bl},${bh}) × vel[${vl},${vh})`, s: stats(f) });
    });
  });
  combos.sort((a,b) => b.s.pf - a.s.pf).slice(0,15).forEach(c =>
    console.log(`  ${c.label.padEnd(38)} ${fmt(c.s)}`));

  console.log('\n-- NEW gate candidate: bbw>=30 & vel[-30,-12) & RSI[60,70) --');
  const newGate = putRev.filter(r =>
    r.metrics.bbw != null && r.metrics.bbw >= 30 &&
    r.metrics.vel != null && r.metrics.vel >= -30 && r.metrics.vel < -12 &&
    r.metrics.rsi != null && r.metrics.rsi >= 60 && r.metrics.rsi < 70);
  console.log(`  ${fmt(stats(newGate))}`);
  const newGateLoose = putRev.filter(r =>
    r.metrics.bbw != null && r.metrics.bbw >= 30 &&
    r.metrics.vel != null && r.metrics.vel >= -30 && r.metrics.vel < -12);
  console.log(`  loose (no RSI cut) ${fmt(stats(newGateLoose))}`);

  // PHASE 3 — Asset profiling per pattern
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 3 — ASSET PROFILING (pooled, min n=20 for CALL_UT/PUT_REV, n=50 else)');
  console.log('════════════════════════════════════════════════════════════════════');
  for (const pat of ['PUT_REV','CALL_REV','CALL_UT','PUT_DT']) {
    console.log(`\n-- ${pat} --`);
    const rows = ALL.filter(r => r.pattern === pat);
    const byA = {};
    rows.forEach(r => { (byA[r.asset] ||= []).push(r); });
    const minN = (pat === 'PUT_REV') ? 5 : (pat === 'CALL_UT' ? 10 : 15);
    const green = [], yellow = [], red = [];
    Object.entries(byA).forEach(([asset, rs]) => {
      if (rs.length < minN) return;
      const s = stats(rs);
      const entry = `${asset.padEnd(14)} ${fmt(s)}`;
      if (s.wr >= 70) green.push(entry);
      else if (s.wr >= 55) yellow.push(entry);
      else red.push(entry);
    });
    if (green.length) { console.log(' GREEN (>=70% WR)'); green.forEach(e => console.log('  ' + e)); }
    if (yellow.length) { console.log(' YELLOW (55-70% WR)'); yellow.slice(0, 8).forEach(e => console.log('  ' + e)); if (yellow.length > 8) console.log(`  ...and ${yellow.length-8} more`); }
    if (red.length) { console.log(' RED (<55% WR)'); red.forEach(e => console.log('  ' + e)); }
  }

  // PHASE 4 — Trend context (uses MA3 as proxy for MA14 since MA50 not computed; use price vs BB mid + rsi range)
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 4 — TREND CONTEXT (PUT_REV): classify by price/MA14 + recent RSI range');
  console.log('════════════════════════════════════════════════════════════════════');
  const pr = ALL.filter(r => r.pattern === 'PUT_REV' && r.ma3 != null && r.c_close != null);
  const ctx = { ROCKET: [], DRIFT: [], CHOP: [], DOWN: [] };
  pr.forEach(r => {
    const aboveMa14 = r.c_close > r.ma3;
    const rsiNow = r.metrics.rsi ?? r.rsi_5;
    if (aboveMa14 && rsiNow > 55) ctx.ROCKET.push(r);
    else if (aboveMa14) ctx.DRIFT.push(r);
    else if (rsiNow < 45) ctx.DOWN.push(r);
    else ctx.CHOP.push(r);
  });
  Object.entries(ctx).forEach(([k, rs]) => console.log(`  ${k.padEnd(8)} ${fmt(stats(rs))}`));

  // PHASE 5 — Ablation on PUT_REV
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 5 — ABLATION (PUT_REV): drop each gate, measure WR drop');
  console.log('════════════════════════════════════════════════════════════════════');
  const base = stats(putRev);
  console.log(`BASELINE (as-fired)                         ${fmt(base)}`);
  // "Without BB≥50" = look at rows with bbw<50 vs ≥50 to see lift
  const bbKill  = stats(putRev.filter(r => r.metrics.bbw != null && r.metrics.bbw < 50));
  const bbSafe  = stats(putRev.filter(r => r.metrics.bbw != null && r.metrics.bbw >= 50));
  console.log(`  - bbw<50 subset  (sacred-rule test)       ${fmt(bbKill)}`);
  console.log(`  - bbw>=50 subset                          ${fmt(bbSafe)}`);
  const velOut  = stats(putRev.filter(r => r.metrics.vel != null && !(r.metrics.vel >= -15 && r.metrics.vel <= -8)));
  const velIn   = stats(putRev.filter(r => r.metrics.vel != null && r.metrics.vel >= -15 && r.metrics.vel <= -8));
  console.log(`  - vel OUT of [-15,-8]                     ${fmt(velOut)}`);
  console.log(`  - vel IN  [-15,-8]                        ${fmt(velIn)}`);
  const kdOut   = stats(putRev.filter(r => r.metrics.kd != null && r.metrics.kd >= -3));
  const kdIn    = stats(putRev.filter(r => r.metrics.kd != null && r.metrics.kd < -3));
  console.log(`  - K-D >= -3                               ${fmt(kdOut)}`);
  console.log(`  - K-D <  -3                               ${fmt(kdIn)}`);
  const rsiExcl = stats(putRev.filter(r => r.metrics.rsi != null && r.metrics.rsi >= 55 && r.metrics.rsi < 65));
  console.log(`  - RSI in [55,65) (excluded zone)          ${fmt(rsiExcl)}`);

  // PHASE 6 — Confluence: PUT_REV and PUT_DT on same (asset, ±2 min)
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 6 — CONFLUENCE: PUT_REV ↔ PUT_DT near-simultaneous (±120s)');
  console.log('════════════════════════════════════════════════════════════════════');
  const putDt = ALL.filter(r => r.pattern === 'PUT_DT');
  const dtIdx = new Map();
  putDt.forEach(r => {
    const key = `${r.db}|${r.asset}`;
    (dtIdx.get(key) || dtIdx.set(key, []).get(key)).push(r.timestamp);
  });
  let confluent = [];
  putRev.forEach(r => {
    const arr = dtIdx.get(`${r.db}|${r.asset}`);
    if (arr && arr.some(t => Math.abs(t - r.timestamp) <= 120)) confluent.push(r);
  });
  const nonConf = putRev.filter(r => !confluent.includes(r));
  console.log(`  Confluence (PUT_REV within 2min of PUT_DT) ${fmt(stats(confluent))}`);
  console.log(`  No confluence (PUT_REV solo)               ${fmt(stats(nonConf))}`);

  // Civil war: PUT_REV within 2min of CALL_* on same asset
  const callAny = ALL.filter(r => r.pattern === 'CALL_REV' || r.pattern === 'CALL_UT');
  const callIdx = new Map();
  callAny.forEach(r => {
    const key = `${r.db}|${r.asset}`;
    (callIdx.get(key) || callIdx.set(key, []).get(key)).push(r.timestamp);
  });
  let civilWar = [];
  putRev.forEach(r => {
    const arr = callIdx.get(`${r.db}|${r.asset}`);
    if (arr && arr.some(t => Math.abs(t - r.timestamp) <= 120)) civilWar.push(r);
  });
  console.log(`  Civil war (PUT_REV within 2min of CALL_*)  ${fmt(stats(civilWar))}`);

  // PHASE 7 — Hourly
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 7 — HOURLY (UTC) — PUT_REV');
  console.log('════════════════════════════════════════════════════════════════════');
  for (let h = 0; h <= 23; h++) {
    const f = putRev.filter(r => r.hour === h);
    if (f.length >= 3) console.log(`  ${String(h).padStart(2,'0')}:00  ${fmt(stats(f))}`);
  }
  console.log('  Sessions pooled:');
  const sessions = { 'ASIA (00-08)': [0,8], 'LONDON (08-13)': [8,13], 'OVERLAP (13-16)': [13,16], 'NY (16-21)': [16,21], 'LATE (21-24)': [21,24] };
  for (const [name,[lo,hi]] of Object.entries(sessions)) {
    const f = putRev.filter(r => r.hour >= lo && r.hour < hi);
    console.log(`  ${name.padEnd(18)} ${fmt(stats(f))}`);
  }

  // PHASE 8 - OOS: last 10% of each pattern
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 8 — OUT-OF-SAMPLE: current DB only, last 10% by time per pattern');
  console.log('════════════════════════════════════════════════════════════════════');
  const cur = results['current'] || [];
  ['PUT_REV','CALL_REV','CALL_UT','PUT_DT'].forEach(p => {
    const sorted = cur.filter(r => r.pattern === p).sort((a,b) => a.timestamp - b.timestamp);
    const oos = sorted.slice(Math.floor(sorted.length * 0.9));
    const is  = sorted.slice(0, Math.floor(sorted.length * 0.9));
    console.log(`  ${p.padEnd(9)} in-sample ${fmt(stats(is))}  | OOS ${fmt(stats(oos))}`);
  });

})().catch(e => { console.error(e); process.exit(1); });
