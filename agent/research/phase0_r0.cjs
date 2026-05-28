'use strict';
// Phase 0 Round 3 — R.0 feature engineering.
// Builds derived_features table keyed by (asset, timestamp) in phase0_research.db.
// All features are causal (no use of close[t+1] anywhere).
//
//   node agent/research/phase0_r0.cjs

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/phase0_research.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const log = (m) => console.log(`[r0] ${m}`);

// ---- session label, UTC-5 fixed (no DST), per Round 3 prompt -----------------
function session(ts) {
    const h = new Date((ts - 5 * 3600) * 1000).getUTCHours();
    if (h >= 17 || h < 2) return 'Asian';
    if (h >= 2 && h < 8) return 'European';
    if (h >= 8 && h < 17) return 'American';
    return 'Off-hours';
}

function emaSeries(closes, period) {
    const k = 2 / (period + 1);
    const out = new Array(closes.length).fill(null);
    let prev = null;
    for (let i = 0; i < closes.length; i++) {
        prev = prev == null ? closes[i] : closes[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return null;
    const idx = (sortedAsc.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// ---- schema -----------------------------------------------------------------
db.exec(`
DROP TABLE IF EXISTS derived_features;
CREATE TABLE derived_features (
    asset       TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    range_atr   REAL, body_atr REAL, upwick_atr REAL, dnwick_atr REAL,
    is_bull_bar INTEGER,
    ret_1 REAL, ret_3 REAL, ret_6 REAL, ret_12 REAL,
    dist_sma20 REAL, dist_ema20 REAL, dist_ema50 REAL,
    hh INTEGER, hl INTEGER, lh INTEGER, ll INTEGER,
    range_pos REAL, zone TEXT,
    sweep_low INTEGER, sweep_high INTEGER,
    bull_ob INTEGER, bear_ob INTEGER,
    bos_up INTEGER, bos_down INTEGER,
    displacement INTEGER,
    vol_regime TEXT,
    session TEXT,
    PRIMARY KEY (asset, timestamp)
);
`);

const insert = db.prepare(`
INSERT INTO derived_features (
    asset, timestamp, range_atr, body_atr, upwick_atr, dnwick_atr, is_bull_bar,
    ret_1, ret_3, ret_6, ret_12, dist_sma20, dist_ema20, dist_ema50,
    hh, hl, lh, ll, range_pos, zone,
    sweep_low, sweep_high, bull_ob, bear_ob, bos_up, bos_down, displacement,
    vol_regime, session
) VALUES (
    @asset, @timestamp, @range_atr, @body_atr, @upwick_atr, @dnwick_atr, @is_bull_bar,
    @ret_1, @ret_3, @ret_6, @ret_12, @dist_sma20, @dist_ema20, @dist_ema50,
    @hh, @hl, @lh, @ll, @range_pos, @zone,
    @sweep_low, @sweep_high, @bull_ob, @bear_ob, @bos_up, @bos_down, @displacement,
    @vol_regime, @session
)`);

const assets = db.prepare('SELECT DISTINCT asset FROM candles ORDER BY asset').all().map(r => r.asset);
const PIVOT = 4;          // 4-bar lookback each side
const ZONE_WIN = 50;      // rolling range position window
const VOL_WIN = 200;      // rolling vol-regime window

const writeAll = db.transaction((rows) => { for (const r of rows) insert.run(r); });

let total = 0;
for (const asset of assets) {
    // join candles + indicators(atr_14, sma_20) ordered chronologically
    const bars = db.prepare(`
        SELECT c.timestamp ts, c.open, c.high, c.low, c.close,
               i.atr_14, i.sma_20
        FROM candles c
        JOIN indicators i ON i.asset = c.asset AND i.timestamp = c.timestamp
        WHERE c.asset = ?
        ORDER BY c.timestamp ASC
    `).all(asset);

    const n = bars.length;
    const closes = bars.map(b => b.close);
    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);

    // confirmed pivots: at bar i, confirm pivot at i-PIVOT using window [i-2*PIVOT, i]
    let lastPH = null, prevPH = null, lastPL = null, prevPL = null;
    const rows = [];

    for (let i = 0; i < n; i++) {
        const b = bars[i];
        const atr = b.atr_14;
        const range = b.high - b.low;
        const body = Math.abs(b.close - b.open);
        const upwick = b.high - Math.max(b.open, b.close);
        const dnwick = Math.min(b.open, b.close) - b.low;
        const isBull = b.close > b.open ? 1 : 0;

        // confirm pivot at center = i - PIVOT
        if (i >= 2 * PIVOT) {
            const c = i - PIVOT;
            let maxH = -Infinity, minL = Infinity;
            for (let j = i - 2 * PIVOT; j <= i; j++) {
                if (bars[j].high > maxH) maxH = bars[j].high;
                if (bars[j].low < minL) minL = bars[j].low;
            }
            if (bars[c].high === maxH) { prevPH = lastPH; lastPH = bars[c].high; }
            if (bars[c].low === minL)  { prevPL = lastPL; lastPL = bars[c].low; }
        }

        const hh = (lastPH != null && prevPH != null && lastPH > prevPH) ? 1 : 0;
        const hl = (lastPL != null && prevPL != null && lastPL > prevPL) ? 1 : 0;
        const lh = (lastPH != null && prevPH != null && lastPH < prevPH) ? 1 : 0;
        const ll = (lastPL != null && prevPL != null && lastPL < prevPL) ? 1 : 0;

        // SMC zone: rolling 50-bar range position
        let range_pos = null, zone = null;
        if (i >= ZONE_WIN - 1) {
            let lo = Infinity, hi = -Infinity;
            for (let j = i - ZONE_WIN + 1; j <= i; j++) {
                if (bars[j].low < lo) lo = bars[j].low;
                if (bars[j].high > hi) hi = bars[j].high;
            }
            if (hi > lo) {
                range_pos = (b.close - lo) / (hi - lo);
                zone = range_pos > 0.65 ? 'PREMIUM' : range_pos < 0.35 ? 'DISCOUNT' : 'EQUILIBRIUM';
            }
        }

        // SMC behavioral flags (use pivots confirmed as-of bar i)
        const sweep_low  = (lastPL != null && b.low  < lastPL && b.close > lastPL) ? 1 : 0;
        const sweep_high = (lastPH != null && b.high > lastPH && b.close < lastPH) ? 1 : 0;

        let bull_ob = 0, bear_ob = 0;
        if (i >= 3) {
            const net = (b.close - bars[i-3].close); // == sum of last 3 close deltas
            const prevBull = bars[i-1].close > bars[i-1].open ? 1 : 0;
            if (isBull === 1 && prevBull === 0 && b.close > bars[i-1].high && net > 0) bull_ob = 1;
            if (isBull === 0 && prevBull === 1 && b.close < bars[i-1].low  && net < 0) bear_ob = 1;
        }

        let bos_up = 0, bos_down = 0;
        if (i >= 1 && lastPH != null) bos_up   = (b.close > lastPH && bars[i-1].close <= lastPH) ? 1 : 0;
        if (i >= 1 && lastPL != null) bos_down = (b.close < lastPL && bars[i-1].close >= lastPL) ? 1 : 0;

        const range_atr  = atr > 0 ? range  / atr : null;
        const body_atr   = atr > 0 ? body   / atr : null;
        const upwick_atr = atr > 0 ? upwick / atr : null;
        const dnwick_atr = atr > 0 ? dnwick / atr : null;
        const displacement = (range_atr != null && range_atr > 2.0 && (body_atr / range_atr) > 0.7) ? 1 : 0;

        // multi-horizon log returns
        const ret = (h) => (i >= h && closes[i-h] > 0) ? Math.log(closes[i] / closes[i-h]) : null;

        // MA distances (ATR units)
        const dist = (ma) => (atr > 0 && ma != null) ? (b.close - ma) / atr : null;

        // vol_regime: rolling 200-bar terciles of atr_14
        let vol_regime = null;
        if (i >= VOL_WIN - 1) {
            const win = [];
            for (let j = i - VOL_WIN + 1; j <= i; j++) if (bars[j].atr_14 != null) win.push(bars[j].atr_14);
            win.sort((a, b) => a - b);
            const p33 = percentile(win, 0.33), p66 = percentile(win, 0.66);
            vol_regime = atr < p33 ? 'LOW' : atr > p66 ? 'HIGH' : 'MED';
        }

        rows.push({
            asset, timestamp: b.ts,
            range_atr, body_atr, upwick_atr, dnwick_atr, is_bull_bar: isBull,
            ret_1: ret(1), ret_3: ret(3), ret_6: ret(6), ret_12: ret(12),
            dist_sma20: dist(b.sma_20), dist_ema20: dist(ema20[i]), dist_ema50: dist(ema50[i]),
            hh, hl, lh, ll, range_pos, zone,
            sweep_low, sweep_high, bull_ob, bear_ob, bos_up, bos_down, displacement,
            vol_regime, session: session(b.ts),
        });
    }
    writeAll(rows);
    total += rows.length;
    log(`${asset}: ${rows.length} feature rows`);
}
log(`total feature rows: ${total}`);

// ---- sanity checks ----------------------------------------------------------
log('--- sanity checks ---');
const med = (col) => db.prepare(`SELECT ${col} v FROM derived_features WHERE ${col} IS NOT NULL ORDER BY ${col}`).all().map(r => r.v);
function median(arr){ if(!arr.length) return null; const m=Math.floor(arr.length/2); return arr.length%2? arr[m] : (arr[m-1]+arr[m])/2; }

const checks = [];
const rangeMed = median(med('range_atr'));
const bodyMed  = median(med('body_atr'));
checks.push(['range_atr median ~1.0', rangeMed, rangeMed > 0.5 && rangeMed < 1.5]);
checks.push(['body_atr median ~0.5', bodyMed, bodyMed > 0.25 && bodyMed < 0.75]);

// additive identity: upwick+dnwick+body ≈ range
const addErr = db.prepare(`
    SELECT AVG(ABS((upwick_atr+dnwick_atr+body_atr) - range_atr)) e
    FROM derived_features WHERE range_atr IS NOT NULL`).get().e;
checks.push(['|(up+dn+body) - range| mean ~0', addErr, addErr < 1e-6]);

const tot = db.prepare('SELECT COUNT(*) n FROM derived_features').get().n;
for (const f of ['hh','hl','lh','ll']) {
    const c = db.prepare(`SELECT SUM(${f}) s FROM derived_features`).get().s;
    const pct = c / tot * 100;
    checks.push([`${f} fire rate ~25-35%`, pct.toFixed(1)+'%', pct >= 15 && pct <= 45]);
}
for (const f of ['sweep_low','sweep_high']) {
    const c = db.prepare(`SELECT SUM(${f}) s FROM derived_features`).get().s;
    const pct = c / tot * 100;
    checks.push([`${f} rate ~1-3%`, pct.toFixed(2)+'%', pct >= 0.3 && pct <= 6]);
}
const dispPct = db.prepare('SELECT SUM(displacement) s FROM derived_features').get().s / tot * 100;
checks.push(['displacement ~1-2%', dispPct.toFixed(2)+'%', dispPct >= 0.3 && dispPct <= 4]);

const volRows = db.prepare(`SELECT vol_regime v, COUNT(*) c FROM derived_features WHERE vol_regime IS NOT NULL GROUP BY vol_regime`).all();
const volTot = volRows.reduce((a,r)=>a+r.c,0);
for (const r of volRows) {
    const pct = r.c/volTot*100;
    checks.push([`vol_regime ${r.v} ~33%`, pct.toFixed(1)+'%', pct >= 20 && pct <= 46]);
}
const sessRows = db.prepare(`SELECT session s, COUNT(*) c FROM derived_features GROUP BY session ORDER BY c DESC`).all();

let fails = 0;
for (const [name, val, ok] of checks) {
    if (!ok) fails++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(34)} = ${val}`);
}
console.log('  session distribution:');
for (const r of sessRows) console.log(`     ${r.s.padEnd(12)} ${(r.c/tot*100).toFixed(1)}%  (n=${r.c})`);
log(fails === 0 ? 'ALL SANITY CHECKS PASSED' : `${fails} sanity check(s) FAILED — investigate before R.1`);

db.close();
