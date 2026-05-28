'use strict';
// Phase 0 Round 2 — Option (b)
// Sync new bars from agent.db + populate test_r2 signals. No check output.
// Run this when you want to update phase0_research.db without seeing results yet.
// Run phase0_r3_continuous.cjs separately when ready to check.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const RESEARCH_DB = path.join(__dirname, '..', 'data', 'phase0_research.db');
const AGENT_DB    = path.join(__dirname, '..', 'data', 'agent.db');
const LOG_PATH    = path.join(__dirname, '..', 'phase0_log.md');

const R2_CUTOFF  = 1779511200; // 2026-05-23 04:40:00 UTC
const PERIOD     = 300;
const INDEP_BARS = 3;
const ATR_WINDOW = 100;

const GATE = {
    name: 'di_oversold_bounce',
    dir:  'CALL',
    cols: ['plus_di','minus_di','cci_20','bb_width_bps'],
    fn:   r => (r.plus_di - r.minus_di) < -25.6
            && r.cci_20 < -65
            && r.bb_width_bps >= 13.7
            && r.bb_width_bps <= 37.7,
};

function nyHour(ts)  { return ((Math.floor(ts/3600)-5)%24+24)%24; }
function sessionFor(ts) {
    const h = nyHour(ts);
    if (h>=19||h<=2) return 'Asian';
    if (h>=3&&h<=7)  return 'European';
    if (h>=8&&h<=17) return 'American';
    return 'Off-hours';
}
function gateFires(r) {
    for (const c of GATE.cols) {
        const v = r[c];
        if (v===null||v===undefined||Number.isNaN(v)) return false;
    }
    return GATE.fn(r);
}

function main() {
    if (!fs.existsSync(RESEARCH_DB)) { console.error('ERROR: phase0_research.db not found'); process.exit(1); }

    const db = new Database(RESEARCH_DB);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // ── Sync ──
    console.log('── Sync new bars ────────────────────────────────────────────');
    const before    = db.prepare('SELECT COUNT(*) AS n FROM candles').get().n;
    const beforeInd = db.prepare('SELECT COUNT(*) AS n FROM indicators').get().n;

    if (fs.existsSync(AGENT_DB)) {
        db.exec(`ATTACH DATABASE '${AGENT_DB.replace(/\\/g,"/")}' AS live`);
        const ca = db.prepare(`INSERT OR IGNORE INTO main.candles (asset,timestamp,open,high,low,close) SELECT asset,timestamp,open,high,low,close FROM live.candles WHERE timestamp > ?`).run(R2_CUTOFF).changes;
        const ia = db.prepare(`INSERT OR IGNORE INTO main.indicators SELECT * FROM live.indicators WHERE timestamp > ?`).run(R2_CUTOFF).changes;
        db.exec('DETACH DATABASE live');
        console.log(`  candles:    +${ca} new (total ${before+ca})`);
        console.log(`  indicators: +${ia} new (total ${beforeInd+ia})`);
    } else {
        console.log('  agent.db not found — skipping sync');
    }

    // ── Populate test_r2 ──
    console.log('\n── Populate test_r2 signals ─────────────────────────────────');
    db.prepare(`DELETE FROM backtest_signals WHERE fold = 'test_r2'`).run();

    const r1LastFires = new Map();
    for (const r of db.prepare(`SELECT asset, MAX(bar_ts) AS ts FROM backtest_signals WHERE gate=? AND direction=? AND fold != 'test_r2' GROUP BY asset`).all(GATE.name, GATE.dir)) {
        r1LastFires.set(r.asset, r.ts);
    }

    const assets = db.prepare(`SELECT DISTINCT asset FROM candles WHERE timestamp > ? ORDER BY asset`).all(R2_CUTOFF).map(r=>r.asset);

    const loadRows = db.prepare(`
        SELECT c.timestamp, c.close, i.plus_di, i.minus_di, i.cci_20, i.bb_width_bps, i.atr_14, i.sma_10, i.sma_20, i.sma_50
        FROM candles c JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        WHERE c.asset=? AND c.timestamp > ? ORDER BY c.timestamp ASC
    `);
    const loadCloses = db.prepare(`SELECT timestamp, close FROM candles WHERE asset=? ORDER BY timestamp ASC`);
    const ins = db.prepare(`INSERT OR IGNORE INTO backtest_signals (asset,bar_ts,gate,direction,fold,session,entry_close,exit_5m,exit_10m,exit_15m,win_5m,win_10m,win_15m) VALUES (?,?,?,?,'test_r2',?,?,?,?,?,?,?,?)`);
    const batch = db.transaction(rows => { for (const r of rows) ins.run(r.asset,r.bar_ts,GATE.name,GATE.dir,r.session,r.entry_close,r.exit_5m,r.exit_10m,r.exit_15m,r.win_5m,r.win_10m,r.win_15m); });

    let fires=0, inserted=0;
    for (const asset of assets) {
        const closeByTs = new Map();
        for (const c of loadCloses.all(asset)) closeByTs.set(c.timestamp, c.close);
        const rows = loadRows.all(asset, R2_CUTOFF);
        if (!rows.length) continue;

        const firstTs = rows[0].timestamp;
        const histAtr = db.prepare(`SELECT atr_14 FROM indicators WHERE asset=? AND timestamp<? AND atr_14 IS NOT NULL ORDER BY timestamp DESC LIMIT ?`).all(asset, firstTs, ATR_WINDOW).map(r=>r.atr_14).reverse();
        const win = [...histAtr];

        let lastFire = r1LastFires.get(asset) ?? null;
        const toIns = [];
        for (const r of rows) {
            if (r.atr_14!=null) { win.push(r.atr_14); if (win.length>ATR_WINDOW) win.shift(); }
            r.atr_pct = (win.length===ATR_WINDOW && r.atr_14!=null) ? win.filter(v=>v<r.atr_14).length/ATR_WINDOW : null;
            if (!gateFires(r)) continue;
            fires++;
            if (lastFire!==null && r.timestamp < lastFire+INDEP_BARS*PERIOD) continue;
            lastFire = r.timestamp;
            const entry=r.close, e5=closeByTs.get(r.timestamp+300)??null, e10=closeByTs.get(r.timestamp+600)??null, e15=closeByTs.get(r.timestamp+900)??null;
            const win_fn = exit => exit===null?null:(exit>entry?1:0);
            toIns.push({asset,bar_ts:r.timestamp,session:sessionFor(r.timestamp),entry_close:entry,exit_5m:e5,exit_10m:e10,exit_15m:e15,win_5m:win_fn(e5),win_10m:win_fn(e10),win_15m:win_fn(e15)});
        }
        if (toIns.length) { batch(toIns); inserted+=toIns.length; }
    }

    console.log(`  Fires (pre-independence): ${fires}`);
    console.log(`  Inserted (test_r2):       ${inserted}`);
    console.log(`  Rejected by rule:         ${fires-inserted}`);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM backtest_signals WHERE gate=? AND direction=? AND fold='test_r2'`).get(GATE.name,GATE.dir).n;
    console.log(`\n  test_r2 total so far: ${total} signals for ${GATE.name} ${GATE.dir}`);
    console.log(`  Run phase0_r3_continuous.cjs to see the current check result.`);

    const today = new Date().toISOString().slice(0,10);
    fs.appendFileSync(LOG_PATH, `\n### Round 2 — Sync only (${today})\n- Candles/indicators synced from agent.db (timestamp > ${R2_CUTOFF})\n- test_r2 signals: ${total} for ${GATE.name} ${GATE.dir}\n---\n`, 'utf8');

    db.close();
}
main();
