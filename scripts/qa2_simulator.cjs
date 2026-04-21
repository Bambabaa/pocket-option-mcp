// QA2 behavioral simulator — pre-signal DNA extraction, no outcome leakage.
// Node-only. All 9 phases, focused on PUT_REV and PUT_DT (plus corpus-wide Phase 1-3).
//
// Usage: node scripts/qa2_simulator.cjs [min_n_cluster]
// Raw output: docs/_qa2_raw.txt (captured by caller via tee/redirect).

const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v2_13-15',   'data/trading_data_v2_13-15.db'],
  ['V3_16',      'data/trading_data_V3_16.db'],
  ['V3_17',      'data/trading_data_V3_17.db'],
  ['V4_17',      'data/trading_data_V4_17.db'],
  ['current',    'data/trading_data.db'],
];

const open = p => new Promise((res, rej) => {
  const db = new sqlite3.Database(p, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(db));
});
const all = (db, q, p = []) => new Promise((res, rej) => db.all(q, p, (e, rows) => e ? rej(e) : res(rows)));

const parsePattern = r => {
  if (!r) return null;
  if (r.includes('OVERSOLD')   && r.includes('Reversal')) return 'CALL_REV';
  if (r.includes('OVERBOUGHT') && r.includes('Reversal')) return 'PUT_REV';
  if (r.includes('UP TREND'))   return 'CALL_UT';
  if (r.includes('DOWN TREND')) return 'PUT_DT';
  return null;
};

// ──────────────────────────────────────────────────────────────────────
// MATH HELPERS
// ──────────────────────────────────────────────────────────────────────
const mean = xs => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : 0;
const std  = xs => { if (!xs.length) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x-m)*(x-m)))); };
const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p*s.length))]; };
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ──────────────────────────────────────────────────────────────────────
// PHASE 1 — 10-bar pre-signal feature extraction
// ──────────────────────────────────────────────────────────────────────
function extractCandleMorphology(c) {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const dir = c.close > c.open ? 1 : (c.close < c.open ? -1 : 0);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return {
    body, range, dir,
    bodyPct: range > 0 ? body / range : 0,
    exhaustion: body > 0 ? upperWick / body : 0,
    rejection:  body > 0 ? lowerWick / body : 0,
    closePos:   range > 0 ? (c.close - c.low) / range : 0.5,
  };
}

// Build feature vector from 10 bars before + signal bar
function buildFingerprint(candles, indicators) {
  const n = candles.length;
  if (n < 11) return null;
  const morph = candles.map(extractCandleMorphology);

  // ATR(14)-like: mean range of last N bars
  const atr = mean(candles.slice(-14).map(c => c.high - c.low));

  // Streak length (consecutive same dir ending at signal bar t=-1, i.e. last prev bar)
  let streak = 0;
  const lastDir = morph[n-2].dir;
  for (let i = n-2; i >= 0 && morph[i].dir === lastDir && lastDir !== 0; i--) streak++;

  // HH/HL structure last 3 bars
  const hh = candles[n-2].high > candles[n-3].high && candles[n-3].high > candles[n-4].high;
  const ll = candles[n-2].low < candles[n-3].low && candles[n-3].low < candles[n-4].low;

  // Engulfing detection on bar t=-1 vs t=-2
  const engulf = morph[n-2].dir !== 0 && morph[n-3].dir !== 0 && morph[n-2].dir !== morph[n-3].dir &&
                 morph[n-2].body > morph[n-3].body;

  // Inside bar: bar-1 range contained by bar-2
  const inside = candles[n-2].high < candles[n-3].high && candles[n-2].low > candles[n-3].low;

  // NR7 / WR7: bar-1 range vs last 7
  const last7Ranges = candles.slice(n-8, n-1).map(c => c.high - c.low);
  const curRange = candles[n-2].high - candles[n-2].low;
  const nr7 = curRange === Math.min(...last7Ranges);
  const wr7 = curRange === Math.max(...last7Ranges);

  // Indicator trajectories (last 5 bars)
  const rsiSeq = indicators.slice(-5).map(i => i ? i.rsi_5 : null).filter(x => x != null);
  const kSeq   = indicators.slice(-5).map(i => i ? i.stochastic_k_v2 ?? i.stochastic_k : null).filter(x => x != null);
  const dSeq   = indicators.slice(-5).map(i => i ? i.stochastic_d_v2 ?? i.stochastic_d : null).filter(x => x != null);
  const bbwSeq = indicators.slice(-5).map(i => (i && i.bb_upper && i.bb_lower && i.bb_middle)
    ? 10000 * (i.bb_upper - i.bb_lower) / i.bb_middle : null).filter(x => x != null);
  const ma1Seq = indicators.slice(-5).map(i => i ? i.ma1 : null).filter(x => x != null);
  const ma3Seq = indicators.slice(-5).map(i => i ? i.ma3 : null).filter(x => x != null);

  const slope = xs => xs.length >= 2 ? (xs[xs.length-1] - xs[0]) / xs.length : 0;
  const accel = xs => xs.length >= 3 ?
    ((xs[xs.length-1] - xs[xs.length-2]) - (xs[xs.length-2] - xs[xs.length-3])) : 0;

  const rsiNow = rsiSeq[rsiSeq.length-1] ?? 50;
  const kNow   = kSeq[kSeq.length-1] ?? 50;
  const dNow   = dSeq[dSeq.length-1] ?? 50;
  const bbwNow = bbwSeq[bbwSeq.length-1] ?? 0;
  const ma1Now = ma1Seq[ma1Seq.length-1];
  const ma3Now = ma3Seq[ma3Seq.length-1];
  const closeNow = candles[n-1].close;

  // BB %B approximated via ma3 ± bbw/2 (bb_middle = ma3 typically)
  const lastInd = indicators[indicators.length-1];
  const pctB = (lastInd && lastInd.bb_upper != null && lastInd.bb_lower != null && lastInd.bb_upper !== lastInd.bb_lower)
    ? (closeNow - lastInd.bb_lower) / (lastInd.bb_upper - lastInd.bb_lower) : 0.5;

  // MA convergence speed
  const ma1_prev = ma1Seq[ma1Seq.length-2];
  const ma3_prev = ma3Seq[ma3Seq.length-2];
  const gapNow  = (ma1Now != null && ma3Now != null) ? Math.abs(ma1Now - ma3Now) : 0;
  const gapPrev = (ma1_prev != null && ma3_prev != null) ? Math.abs(ma1_prev - ma3_prev) : gapNow;
  const maConv = gapPrev > 0 ? (gapNow - gapPrev) / gapPrev : 0;

  return {
    // morphology (signal bar)
    body_pct_atr: atr > 0 ? morph[n-1].body / atr : 0,
    exhaustion:   morph[n-1].exhaustion,
    rejection:    morph[n-1].rejection,
    dir:          morph[n-1].dir,
    close_pos:    morph[n-1].closePos,
    // sequence
    streak,
    hh: hh ? 1 : 0,
    ll: ll ? 1 : 0,
    engulf: engulf ? 1 : 0,
    inside: inside ? 1 : 0,
    nr7: nr7 ? 1 : 0,
    wr7: wr7 ? 1 : 0,
    // indicator trajectory
    rsi_now: rsiNow,
    rsi_slope: slope(rsiSeq),
    rsi_accel: accel(rsiSeq),
    k_now: kNow,
    k_slope: slope(kSeq),
    k_accel: accel(kSeq),
    kd_spread: kNow - dNow,
    kd_spread_prev: (kSeq.length>=2 && dSeq.length>=2) ? kSeq[kSeq.length-2] - dSeq[dSeq.length-2] : 0,
    bbw_now: bbwNow,
    bbw_expand: bbwSeq.length >= 2 && bbwSeq[0] > 0 ? (bbwNow - bbwSeq[0]) / bbwSeq[0] : 0,
    pctB,
    ma_conv_speed: maConv,
    atr,
  };
}

// ──────────────────────────────────────────────────────────────────────
// K-MEANS (pure JS)
// ──────────────────────────────────────────────────────────────────────
function kmeans(vecs, k, iters = 50) {
  const n = vecs.length, d = vecs[0].length;
  // init: k-means++
  const centroids = [vecs[Math.floor(Math.random() * n)].slice()];
  while (centroids.length < k) {
    const dists = vecs.map(v => Math.min(...centroids.map(c => euclid(v, c)))).map(x => x*x);
    const sum = dists.reduce((a,b) => a+b, 0);
    let r = Math.random() * sum, idx = 0;
    for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { idx = i; break; } }
    centroids.push(vecs[idx].slice());
  }
  let labels = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dd = euclid(vecs[i], centroids[j]);
        if (dd < bd) { bd = dd; best = j; }
      }
      if (labels[i] !== best) changed++;
      labels[i] = best;
    }
    for (let j = 0; j < k; j++) {
      const mem = vecs.filter((_, i) => labels[i] === j);
      if (!mem.length) continue;
      for (let dim = 0; dim < d; dim++) centroids[j][dim] = mem.reduce((s,v) => s+v[dim], 0) / mem.length;
    }
    if (!changed) break;
  }
  return { labels, centroids };
}
function euclid(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const diff = a[i] - b[i]; s += diff*diff; } return s; }

// ──────────────────────────────────────────────────────────────────────
// DECISION TREE (CART, binary splits, max depth)
// ──────────────────────────────────────────────────────────────────────
function gini(labels) {
  const counts = {};
  labels.forEach(l => counts[l] = (counts[l] || 0) + 1);
  const n = labels.length;
  let g = 1;
  for (const c of Object.values(counts)) { const p = c / n; g -= p * p; }
  return g;
}
function buildTree(X, y, featureNames, depth = 0, maxDepth = 5, minSamples = 20) {
  const n = y.length;
  const counts = {};
  y.forEach(l => counts[l] = (counts[l] || 0) + 1);
  const majority = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
  if (depth >= maxDepth || n < minSamples || Object.keys(counts).length === 1) {
    return { leaf: true, prediction: majority, counts, n };
  }
  let bestGain = 0, bestFeat = -1, bestThr = 0, bestLeft = null, bestRight = null;
  const baseGini = gini(y);
  for (let f = 0; f < X[0].length; f++) {
    const vals = X.map(row => row[f]);
    const uniq = [...new Set(vals)].sort((a,b) => a-b);
    if (uniq.length < 2) continue;
    // candidate splits: deciles
    const candidates = [];
    for (let p = 0.1; p < 1; p += 0.1) candidates.push(pct(vals, p));
    for (const thr of [...new Set(candidates)]) {
      const leftIdx = [], rightIdx = [];
      for (let i = 0; i < n; i++) (X[i][f] <= thr ? leftIdx : rightIdx).push(i);
      if (leftIdx.length < minSamples || rightIdx.length < minSamples) continue;
      const gL = gini(leftIdx.map(i => y[i]));
      const gR = gini(rightIdx.map(i => y[i]));
      const gain = baseGini - (leftIdx.length/n) * gL - (rightIdx.length/n) * gR;
      if (gain > bestGain) {
        bestGain = gain; bestFeat = f; bestThr = thr;
        bestLeft = leftIdx; bestRight = rightIdx;
      }
    }
  }
  if (bestFeat < 0 || bestGain < 0.001) return { leaf: true, prediction: majority, counts, n };
  return {
    leaf: false,
    feature: featureNames[bestFeat], featureIdx: bestFeat, threshold: bestThr, gain: bestGain, n,
    left:  buildTree(bestLeft.map(i => X[i]),  bestLeft.map(i => y[i]),  featureNames, depth+1, maxDepth, minSamples),
    right: buildTree(bestRight.map(i => X[i]), bestRight.map(i => y[i]), featureNames, depth+1, maxDepth, minSamples),
  };
}
function predict(tree, x) {
  if (tree.leaf) return tree.prediction;
  return x[tree.featureIdx] <= tree.threshold ? predict(tree.left, x) : predict(tree.right, x);
}
function printTree(node, indent = '') {
  if (node.leaf) { console.log(`${indent}→ ${node.prediction} (n=${node.n}, ${JSON.stringify(node.counts)})`); return; }
  console.log(`${indent}${node.feature} <= ${node.threshold.toFixed(3)}  [n=${node.n}, gain=${node.gain.toFixed(3)}]`);
  printTree(node.left, indent + '  ├─ T: ');
  printTree(node.right, indent + '  └─ F: ');
}

// ──────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────
(async () => {
  const fingerprints = []; // { db, asset, ts, pattern, features, rawCandles, rawInd }

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const db = await open(abs);
    const tbls = new Set((await all(db, `SELECT name FROM sqlite_master WHERE type='table'`)).map(t => t.name));
    if (!tbls.has('signals')) { db.close(); continue; }

    const signals = await all(db, `SELECT asset, timestamp, reasons FROM signals`);
    console.error(`[${tag}] ${signals.length} signals — extracting 10-bar fingerprints`);

    for (const s of signals) {
      const pattern = parsePattern(s.reasons);
      if (!pattern) continue;
      // pull 10 bars before + signal bar = 11 bars; plus 14 bars before for ATR
      const candles = await all(db,
        `SELECT timestamp, open, high, low, close FROM candles
         WHERE asset = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 15`,
        [s.asset, s.timestamp]);
      if (candles.length < 11) continue;
      candles.reverse();
      const tsList = candles.map(c => c.timestamp);
      const inds = await all(db,
        `SELECT timestamp, ma1, ma3, rsi_5, bb_upper, bb_middle, bb_lower,
                stochastic_k, stochastic_d, stochastic_k_v2, stochastic_d_v2
         FROM indicators WHERE asset = ? AND timestamp IN (${tsList.map(() => '?').join(',')})
         ORDER BY timestamp ASC`, [s.asset, ...tsList]);
      // align indicators to candles length (by timestamp map)
      const indMap = new Map(inds.map(i => [i.timestamp, i]));
      const alignedInd = tsList.map(t => indMap.get(t) || null);
      const fp = buildFingerprint(candles.slice(-11), alignedInd.slice(-11));
      if (!fp) continue;
      fingerprints.push({ db: tag, asset: s.asset, ts: s.timestamp, pattern, ...fp });
    }
    db.close();
  }

  console.error(`\nTotal fingerprints: ${fingerprints.length}`);

  const featureNames = [
    'body_pct_atr','exhaustion','rejection','dir','close_pos',
    'streak','hh','ll','engulf','inside','nr7','wr7',
    'rsi_now','rsi_slope','rsi_accel',
    'k_now','k_slope','k_accel','kd_spread','kd_spread_prev',
    'bbw_now','bbw_expand','pctB','ma_conv_speed','atr',
  ];

  // ────────────────────────────────────────────────────────────────
  // PHASE 1 SUMMARY — per-pattern mean / std of each feature
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 1 — PRE-SIGNAL FEATURE FINGERPRINT (per pattern, mean ± std)');
  console.log('════════════════════════════════════════════════════════════════════');
  const patterns = ['PUT_REV','PUT_DT','CALL_REV','CALL_UT'];
  for (const pat of patterns) {
    const rs = fingerprints.filter(f => f.pattern === pat);
    if (!rs.length) continue;
    console.log(`\n${pat} (n=${rs.length})`);
    for (const fn of featureNames) {
      const vals = rs.map(r => r[fn]).filter(v => Number.isFinite(v));
      if (!vals.length) continue;
      console.log(`  ${fn.padEnd(18)} ${mean(vals).toFixed(3).padStart(9)} ± ${std(vals).toFixed(3).padStart(7)}   med=${median(vals).toFixed(3).padStart(8)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // PHASE 2 — K-means clustering (all signals, ignore labels, k=6)
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 2 — K-MEANS CLUSTERING (k=6, features z-scored)');
  console.log('════════════════════════════════════════════════════════════════════');
  // z-score normalize each feature
  const means = {}, stds = {};
  featureNames.forEach(fn => {
    const vals = fingerprints.map(f => f[fn]).filter(v => Number.isFinite(v));
    means[fn] = mean(vals); stds[fn] = std(vals) || 1;
  });
  const vecs = fingerprints.map(f => featureNames.map(fn => (((f[fn] || 0) - means[fn]) / stds[fn])));
  const { labels, centroids } = kmeans(vecs, 6);

  for (let c = 0; c < 6; c++) {
    const mem = fingerprints.filter((_, i) => labels[i] === c);
    if (!mem.length) continue;
    const dom = {};
    mem.forEach(m => dom[m.pattern] = (dom[m.pattern] || 0) + 1);
    const domStr = Object.entries(dom).sort((a,b) => b[1]-a[1]).map(([p,n]) => `${p}:${n}`).join(' ');
    console.log(`\nCLUSTER ${c} (n=${mem.length}) dominant: ${domStr}`);
    // Top 5 distinguishing features (largest |centroid component|)
    const ranked = centroids[c].map((v, i) => ({ f: featureNames[i], z: v })).sort((a,b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 6);
    ranked.forEach(r => console.log(`  ${r.f.padEnd(18)} z=${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)}`));
  }

  // ────────────────────────────────────────────────────────────────
  // PHASE 3 — Distance-to-trigger on PUT_REV across all candles
  // (Score every bar with indicators against PUT_REV gate; see distribution)
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 3 — DISTANCE-TO-TRIGGER (PUT_REV, pooled across all DBs)');
  console.log('════════════════════════════════════════════════════════════════════');
  const scoresAll = [];
  const scoresNearSignal = [];
  const signalSet = new Set(fingerprints.filter(f => f.pattern === 'PUT_REV').map(f => `${f.db}|${f.asset}|${f.ts}`));

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const db = await open(abs);
    const tbls = new Set((await all(db, `SELECT name FROM sqlite_master WHERE type='table'`)).map(t => t.name));
    if (!tbls.has('indicators')) { db.close(); continue; }
    const rows = await all(db, `
      SELECT asset, timestamp, rsi_5, bb_upper, bb_middle, bb_lower,
             stochastic_k_v2 AS k, stochastic_d_v2 AS d,
             LAG(rsi_5) OVER (PARTITION BY asset ORDER BY timestamp) AS rsi_prev,
             LAG(stochastic_k_v2) OVER (PARTITION BY asset ORDER BY timestamp) AS k_prev
      FROM indicators WHERE rsi_5 IS NOT NULL LIMIT 200000
    `);
    for (const r of rows) {
      const bbw = (r.bb_upper && r.bb_lower && r.bb_middle) ? 10000 * (r.bb_upper - r.bb_lower) / r.bb_middle : 0;
      const vel = (r.rsi_5 != null && r.rsi_prev != null) ? r.rsi_5 - r.rsi_prev : 0;
      const kd = (r.k != null && r.d != null) ? r.k - r.d : 0;
      // PUT_REV distance score: 0 = perfect, 5 = all fails
      const sBbw = r.bb_upper ? (bbw >= 30 ? 1 : bbw/30) : 0;
      const sVel = vel < -12 ? 1 : Math.max(0, (-vel)/12);
      const sRsi = (r.rsi_5 >= 60 && r.rsi_5 < 70) ? 1 : 0;
      const sK   = (r.k != null && r.k >= 55 && r.k < 80) ? 1 : 0;
      const sKD  = (kd < -3) ? 1 : 0;
      const score = sBbw + sVel + sRsi + sK + sKD; // 0..5
      scoresAll.push(score);
      if (signalSet.has(`${tag}|${r.asset}|${r.timestamp}`)) scoresNearSignal.push(score);
    }
    db.close();
  }
  console.log(`All bars n=${scoresAll.length}`);
  console.log(`  mean=${mean(scoresAll).toFixed(2)}  median=${median(scoresAll)}  p90=${pct(scoresAll, 0.9)}  p99=${pct(scoresAll, 0.99)}`);
  console.log(`Near actual PUT_REV signals n=${scoresNearSignal.length}`);
  console.log(`  mean=${mean(scoresNearSignal).toFixed(2)}  median=${median(scoresNearSignal)}`);
  console.log(`Bars with perfect score 5/5: ${scoresAll.filter(s => s === 5).length} (${((scoresAll.filter(s => s === 5).length / scoresAll.length)*100).toFixed(3)}%)`);
  console.log(`Bars scoring 4+: ${scoresAll.filter(s => s >= 4).length}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 4 — n-gram sequence mining (direction streak + RSI slope pattern)
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 4 — N-GRAM SEQUENCE MINING (3-bar direction signature)');
  console.log('════════════════════════════════════════════════════════════════════');
  for (const pat of ['PUT_REV','PUT_DT']) {
    const rs = fingerprints.filter(f => f.pattern === pat);
    if (!rs.length) continue;
    console.log(`\n${pat} — direction (t-3, t-2, t-1) distribution`);
    const seqs = {};
    rs.forEach(r => {
      // rebuild 3-bar direction from raw; we don't have it cached per-fingerprint, so use streak + dir at signal
      // Use signal bar direction as proxy for "last bar before signal equivalent"
      const key = `dir=${r.dir} streak=${r.streak}`;
      seqs[key] = (seqs[key] || 0) + 1;
    });
    Object.entries(seqs).sort((a,b) => b[1]-a[1]).slice(0, 10).forEach(([k,v]) =>
      console.log(`  ${k.padEnd(24)} n=${v}`));

    // Morphology n-gram: engulf × inside × nr7 × hh
    const morphs = {};
    rs.forEach(r => {
      const key = `eng=${r.engulf} ins=${r.inside} nr7=${r.nr7} hh=${r.hh} ll=${r.ll}`;
      morphs[key] = (morphs[key] || 0) + 1;
    });
    console.log(`  --- morphology signature top 6 ---`);
    Object.entries(morphs).sort((a,b) => b[1]-a[1]).slice(0, 6).forEach(([k,v]) =>
      console.log(`    ${k.padEnd(40)} n=${v}`));
  }

  // ────────────────────────────────────────────────────────────────
  // PHASE 5 — Synthetic features — compute + rank by separation
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 5 — SYNTHETIC FEATURES (separation vs null hypothesis)');
  console.log('════════════════════════════════════════════════════════════════════');
  const synth = {
    rsi_per_bbw:      f => f.bbw_now > 0 ? f.rsi_now / (f.bbw_now / 100) : 0,
    stoch_mom_div:    f => Math.abs(f.kd_spread) > 0.5 ? f.k_slope / f.kd_spread : 0,
    candle_efficiency: f => f.atr > 0 ? f.body_pct_atr : 0,
    exhaustion_comp:  f => f.exhaustion * (f.rsi_now / 100) * (1 - f.pctB),
    compression:      f => (1 - clip(f.bbw_now / 200, 0, 1)) * (1 - clip(Math.abs(f.ma_conv_speed), 0, 1)),
    rsi_momentum_neg: f => -f.rsi_slope * clip(f.bbw_now / 50, 0, 3),
  };

  // Compare synthetic feature distribution between PUT_REV fingerprints and all others
  for (const [name, fn] of Object.entries(synth)) {
    const tgt = fingerprints.filter(f => f.pattern === 'PUT_REV').map(fn).filter(Number.isFinite);
    const oth = fingerprints.filter(f => f.pattern !== 'PUT_REV').map(fn).filter(Number.isFinite);
    if (!tgt.length || !oth.length) continue;
    // Separation via Cohen's d
    const d = Math.abs(mean(tgt) - mean(oth)) / Math.sqrt((std(tgt)**2 + std(oth)**2) / 2);
    console.log(`  ${name.padEnd(20)}  PUT_REV μ=${mean(tgt).toFixed(3)}  others μ=${mean(oth).toFixed(3)}  Cohen's d=${d.toFixed(3)}`);
  }

  // ────────────────────────────────────────────────────────────────
  // PHASE 6 — "Almost" analysis
  // Find bars that met PUT_REV minimal gate (bbw>=30, vel<-12, RSI[60,70)) but have no signal.
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 6 — "ALMOST" ANALYSIS (bars meeting PUT_REV core gates but no signal)');
  console.log('════════════════════════════════════════════════════════════════════');
  let almostN = 0, almostBbw = [], almostK = [], almostKD = [];
  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const db = await open(abs);
    const sig = new Set((await all(db, `SELECT asset, timestamp FROM signals`)).map(s => `${s.asset}|${s.timestamp}`));
    const rows = await all(db, `
      SELECT asset, timestamp, rsi_5, bb_upper, bb_middle, bb_lower,
             stochastic_k_v2 AS k, stochastic_d_v2 AS d,
             LAG(rsi_5) OVER (PARTITION BY asset ORDER BY timestamp) AS rsi_prev
      FROM indicators WHERE rsi_5 IS NOT NULL LIMIT 200000
    `);
    for (const r of rows) {
      const bbw = (r.bb_upper && r.bb_lower && r.bb_middle) ? 10000 * (r.bb_upper - r.bb_lower) / r.bb_middle : 0;
      const vel = (r.rsi_5 != null && r.rsi_prev != null) ? r.rsi_5 - r.rsi_prev : 0;
      if (bbw >= 30 && vel < -12 && r.rsi_5 >= 60 && r.rsi_5 < 70) {
        if (!sig.has(`${r.asset}|${r.timestamp}`)) {
          almostN++;
          almostBbw.push(bbw);
          if (r.k != null) almostK.push(r.k);
          if (r.k != null && r.d != null) almostKD.push(r.k - r.d);
        }
      }
    }
    db.close();
  }
  const firedPR = fingerprints.filter(f => f.pattern === 'PUT_REV');
  console.log(`Almost-PUT_REV (core gates met, no signal): n=${almostN}`);
  console.log(`  bbw    μ=${mean(almostBbw).toFixed(1)}  vs fired μ=${mean(firedPR.map(f => f.bbw_now)).toFixed(1)}`);
  console.log(`  k      μ=${mean(almostK).toFixed(1)}  vs fired μ=${mean(firedPR.map(f => f.k_now)).toFixed(1)}`);
  console.log(`  kd_spr μ=${mean(almostKD).toFixed(2)} vs fired μ=${mean(firedPR.map(f => f.kd_spread)).toFixed(2)}`);
  console.log(`  (fired PUT_REV n=${firedPR.length})`);
  console.log(`  Inference: the ${almostN / Math.max(1, firedPR.length)}x gap between almost and fired = effect of auxiliary gates (K_prev>65, D≥75, K-D<-3, RSI[-2]≥80, candle red, 3-bar lookback)`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 7 — Lead/lag (feature at t-1, t-2, t-3 vs signal)
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 7 — LEAD/LAG (mean feature per lag, PUT_REV)');
  console.log('════════════════════════════════════════════════════════════════════');
  // Re-pull lead/lag series around PUT_REV signals
  const leadFeatures = { rsi: [], k: [], bbw: [], kd: [] };
  const lagRange = [-5, -4, -3, -2, -1, 0];
  const lagMeans = lagRange.map(() => ({ rsi:[], k:[], bbw:[], kd:[] }));

  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) continue;
    const db = await open(abs);
    const sigs = fingerprints.filter(f => f.pattern === 'PUT_REV' && f.db === tag);
    for (const s of sigs) {
      const rows = await all(db, `
        SELECT timestamp, rsi_5, bb_upper, bb_middle, bb_lower,
               stochastic_k_v2 AS k, stochastic_d_v2 AS d
        FROM indicators WHERE asset = ? AND timestamp <= ?
        ORDER BY timestamp DESC LIMIT 6`, [s.asset, s.ts]);
      if (rows.length < 6) continue;
      rows.reverse();
      rows.forEach((r, i) => {
        const bbw = (r.bb_upper && r.bb_lower && r.bb_middle) ? 10000*(r.bb_upper - r.bb_lower)/r.bb_middle : 0;
        lagMeans[i].rsi.push(r.rsi_5); lagMeans[i].k.push(r.k); lagMeans[i].bbw.push(bbw); lagMeans[i].kd.push(r.k - r.d);
      });
    }
    db.close();
  }
  console.log('  lag   RSI        StochK     BBW       K-D');
  lagRange.forEach((lag, i) => {
    const m = lagMeans[i];
    console.log(`   ${String(lag).padStart(3)}   ${mean(m.rsi).toFixed(1).padStart(5)}      ${mean(m.k).toFixed(1).padStart(5)}      ${mean(m.bbw).toFixed(1).padStart(5)}     ${mean(m.kd).toFixed(2).padStart(6)}`);
  });

  // ────────────────────────────────────────────────────────────────
  // PHASE 8 — ASCII visual signature per cluster (top cluster by PUT_REV density)
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 8 — ASCII VISUAL SIGNATURE (top PUT_REV-dominant cluster)');
  console.log('════════════════════════════════════════════════════════════════════');
  const clusterPRDensity = [];
  for (let c = 0; c < 6; c++) {
    const mem = fingerprints.filter((_, i) => labels[i] === c);
    const pr = mem.filter(m => m.pattern === 'PUT_REV').length;
    clusterPRDensity.push({ c, n: mem.length, pr, density: mem.length ? pr/mem.length : 0 });
  }
  clusterPRDensity.sort((a, b) => b.density - a.density);
  const topC = clusterPRDensity[0];
  console.log(`Top PUT_REV-dominant cluster: #${topC.c}  n=${topC.n}  PUT_REV=${topC.pr}  density=${(topC.density*100).toFixed(1)}%`);
  const topMem = fingerprints.filter((_, i) => labels[i] === topC.c && fingerprints[i].pattern === 'PUT_REV');
  // Rough ASCII: how many green/red in last 3 before signal
  const avgStreak = mean(topMem.map(f => f.streak));
  const avgExh = mean(topMem.map(f => f.exhaustion));
  const avgRej = mean(topMem.map(f => f.rejection));
  const avgBody = mean(topMem.map(f => f.body_pct_atr));
  console.log(`Mean streak before signal: ${avgStreak.toFixed(1)} bars same direction`);
  console.log(`Signal candle: body/ATR=${avgBody.toFixed(2)} exhaustion_wick=${avgExh.toFixed(2)} rejection=${avgRej.toFixed(2)}`);
  console.log('Mental model: extended green run → tall upper wick → red engulfing → PUT_REV trigger');
  console.log(`ASCII:  ▲ ▲ ▲ ▲  |  ┃ (upper wick)  |  ▼ (red close)`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 9 — Decision tree 70/30 split, predict pattern from feature vec
  // ────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('PHASE 9 — DECISION TREE (predict pattern from 25 features, 70/30 split)');
  console.log('════════════════════════════════════════════════════════════════════');
  const shuffled = fingerprints.slice().sort(() => Math.random() - 0.5);
  const cut = Math.floor(shuffled.length * 0.7);
  const trainF = shuffled.slice(0, cut);
  const testF = shuffled.slice(cut);
  const X_train = trainF.map(f => featureNames.map(fn => f[fn] || 0));
  const y_train = trainF.map(f => f.pattern);
  const X_test = testF.map(f => featureNames.map(fn => f[fn] || 0));
  const y_test = testF.map(f => f.pattern);
  const tree = buildTree(X_train, y_train, featureNames, 0, 5, 20);
  const preds = X_test.map(x => predict(tree, x));
  const correct = preds.filter((p, i) => p === y_test[i]).length;
  console.log(`Train n=${X_train.length}  Test n=${X_test.length}  Accuracy=${(100*correct/X_test.length).toFixed(1)}%`);
  const confusion = {};
  preds.forEach((p, i) => { const k = `${y_test[i]}→${p}`; confusion[k] = (confusion[k] || 0) + 1; });
  console.log('Confusion (actual→predicted):');
  Object.entries(confusion).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));
  console.log('\nLearned decision tree:');
  printTree(tree);

})().catch(e => { console.error(e); process.exit(1); });
