'use strict';
// Phase 0 Round 2 — Sync + Signal Capture + Continuous Check
//
// Does three things in sequence:
//   1. Sync: copy new candles + indicators from agent.db into phase0_research.db
//            for rows with timestamp > R2_CUTOFF
//   2. Populate: run di_oversold_bounce gate on new bars → backtest_signals (fold='test_r2')
//                3-bar independence rule carries over from R1 last fires per asset
//   3. Check: run continuous R.3 check on test_r2 signals
//             Output in the prescribed Round 2 format

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const RESEARCH_DB = path.join(__dirname, '..', 'data', 'phase0_research.db');
const AGENT_DB    = path.join(__dirname, '..', 'data', 'agent.db');
const LOG_PATH    = path.join(__dirname, '..', 'phase0_log.md');

// Round 2 cutoff = max(timestamp) in phase0_research.db at Round 1 completion
const R2_CUTOFF = 1779511200; // 2026-05-23 04:40:00 UTC
const CUTOFF_DT = '2026-05-23 04:40:00 UTC';

const PERIOD      = 300;
const INDEP_BARS  = 3;     // 15-minute minimum gap
const ATR_WINDOW  = 100;
const BREAK_EVEN  = 0.5405;
const Z_95        = 1.959963984540054;

// Pre-registered gate (no tuning, no threshold changes)
const GATE = {
    name: 'di_oversold_bounce',
    dir:  'CALL',
    cols: ['plus_di', 'minus_di', 'cci_20', 'bb_width_bps'],
    fn:   r => (r.plus_di - r.minus_di) < -25.6
            && r.cci_20 < -65
            && r.bb_width_bps >= 13.7
            && r.bb_width_bps <= 37.7,
};

// ── Stats ────────────────────────────────────────────────────────────────────
function erf(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign=x<0?-1:1, ax=Math.abs(x), t=1/(1+p*ax);
    return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax));
}
function normalCDF(z) { return 0.5*(1+erf(z/Math.SQRT2)); }
function wilsonCI(k, n) {
    if (n===0) return {lower:0,upper:1};
    const p=k/n, z2=Z_95*Z_95, d=1+z2/n;
    const c=(p+z2/(2*n))/d;
    const m=Z_95*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/d;
    return {lower:Math.max(0,c-m), upper:Math.min(1,c+m)};
}
function binomP(k, n, p0) {
    if (n===0) return 1;
    const mean=n*p0, sd=Math.sqrt(n*p0*(1-p0));
    if (sd===0) return k>mean?0:1;
    return 1-normalCDF((k-0.5-mean)/sd);
}

function gateFires(r) {
    for (const c of GATE.cols) {
        const v = r[c];
        if (v===null||v===undefined||Number.isNaN(v)) return false;
    }
    return GATE.fn(r);
}

// ── Step 1: Sync new bars ────────────────────────────────────────────────────
function syncNewBars(db, agentPath) {
    console.log('\n── STEP 1: Sync new bars from agent.db ──────────────────────');
    if (!fs.existsSync(agentPath)) {
        console.log('  agent.db not found — skipping sync');
        return {candlesAdded:0, indicatorsAdded:0};
    }

    const before = db.prepare('SELECT COUNT(*) AS n FROM candles').get().n;
    const beforeInd = db.prepare('SELECT COUNT(*) AS n FROM indicators').get().n;

    db.exec(`ATTACH DATABASE '${agentPath.replace(/\\/g,"/")}' AS live`);

    const candlesAdded = db.prepare(`
        INSERT OR IGNORE INTO main.candles (asset, timestamp, open, high, low, close)
        SELECT asset, timestamp, open, high, low, close
        FROM live.candles
        WHERE timestamp > ?
    `).run(R2_CUTOFF).changes;

    const indicatorsAdded = db.prepare(`
        INSERT OR IGNORE INTO main.indicators
        SELECT * FROM live.indicators WHERE timestamp > ?
    `).run(R2_CUTOFF).changes;

    db.exec('DETACH DATABASE live');

    const after    = db.prepare('SELECT COUNT(*) AS n FROM candles').get().n;
    const afterInd = db.prepare('SELECT COUNT(*) AS n FROM indicators').get().n;

    console.log(`  candles:    ${before} → ${after} (+${candlesAdded} new)`);
    console.log(`  indicators: ${beforeInd} → ${afterInd} (+${indicatorsAdded} new)`);
    return {candlesAdded, indicatorsAdded};
}

// ── Step 2: Populate test_r2 signals ────────────────────────────────────────
function populateTestR2(db) {
    console.log('\n── STEP 2: Populate test_r2 signals ────────────────────────');

    // Remove stale test_r2 rows to allow idempotent re-runs
    const removed = db.prepare(`
        DELETE FROM backtest_signals WHERE fold = 'test_r2'
    `).run().changes;
    if (removed > 0) console.log(`  Cleared ${removed} stale test_r2 rows`);

    // Carry-over: last R1 fire per asset (for 3-bar independence at R1/R2 boundary)
    const r1LastFires = new Map();
    const lastFireRows = db.prepare(`
        SELECT asset, MAX(bar_ts) AS last_ts
        FROM backtest_signals
        WHERE gate = ? AND direction = ? AND fold != 'test_r2'
        GROUP BY asset
    `).all(GATE.name, GATE.dir);
    for (const r of lastFireRows) r1LastFires.set(r.asset, r.last_ts);
    console.log(`  Loaded R1 last-fire timestamps for ${r1LastFires.size} assets`);

    const assets = db.prepare(`
        SELECT DISTINCT asset FROM candles WHERE timestamp > ? ORDER BY asset
    `).all(R2_CUTOFF).map(r => r.asset);
    console.log(`  Assets with new bars: ${assets.length}`);

    const loadIndicatorRows = db.prepare(`
        SELECT c.timestamp, c.close,
               i.plus_di, i.minus_di, i.cci_20, i.bb_width_bps,
               i.atr_14, i.sma_10, i.sma_20, i.sma_50
        FROM candles c
        JOIN indicators i ON c.asset=i.asset AND c.timestamp=i.timestamp
        WHERE c.asset = ? AND c.timestamp > ?
        ORDER BY c.timestamp ASC
    `);

    const loadAllCloses = db.prepare(`
        SELECT timestamp, close FROM candles WHERE asset = ? ORDER BY timestamp ASC
    `);

    const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO backtest_signals
            (asset, bar_ts, gate, direction, fold, session,
             entry_close, exit_5m, exit_10m, exit_15m, win_5m, win_10m, win_15m)
        VALUES (?, ?, ?, ?, 'test_r2', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((rows) => {
        for (const r of rows) insertStmt.run(
            r.asset, r.bar_ts, GATE.name, GATE.dir, r.session,
            r.entry_close, r.exit_5m, r.exit_10m, r.exit_15m,
            r.win_5m, r.win_10m, r.win_15m
        );
    });

    function nyHour(ts) { return ((Math.floor(ts/3600)-5)%24+24)%24; }
    function sessionFor(ts) {
        const h = nyHour(ts);
        if (h>=19||h<=2) return 'Asian';
        if (h>=3&&h<=7) return 'European';
        if (h>=8&&h<=17) return 'American';
        return 'Off-hours';
    }

    let totalFires = 0, totalInserted = 0;

    for (const asset of assets) {
        // Load ALL closes (including bars before R2_CUTOFF) for forward-close lookup
        const allCloses = loadAllCloses.all(asset);
        const closeByTs = new Map();
        for (const c of allCloses) closeByTs.set(c.timestamp, c.close);

        // Load only new indicator rows for this asset
        const rows = loadIndicatorRows.all(asset, R2_CUTOFF);
        if (rows.length === 0) continue;

        // Compute atr_pct inline (needs full history including R1 rows for the lookback window)
        // Load atr_14 history up to ATR_WINDOW bars before the first new row
        const firstNewTs = rows[0].timestamp;
        const histAtr = db.prepare(`
            SELECT atr_14 FROM indicators
            WHERE asset = ? AND timestamp < ? AND atr_14 IS NOT NULL
            ORDER BY timestamp DESC LIMIT ?
        `).all(asset, firstNewTs, ATR_WINDOW).map(r => r.atr_14).reverse();

        // Extend histAtr with new rows as we process them (rolling window)
        const atrWindow = [...histAtr];

        // Independence carry-over from R1
        let lastFireTs = r1LastFires.get(asset) ?? null;

        const toInsert = [];

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];

            // Maintain rolling atr window
            if (r.atr_14 != null) atrWindow.push(r.atr_14);
            if (atrWindow.length > ATR_WINDOW) atrWindow.shift();

            // Compute atr_pct
            if (atrWindow.length === ATR_WINDOW && r.atr_14 != null) {
                const countBelow = atrWindow.filter(v => v < r.atr_14).length;
                r.atr_pct = countBelow / ATR_WINDOW;
            } else {
                r.atr_pct = null;
            }

            // sma_alignment_bear (not used by this gate but keep consistent)
            r.sma_alignment_bear = (r.sma_10!=null&&r.sma_20!=null&&r.sma_50!=null)
                ? (r.sma_10<r.sma_20&&r.sma_20<r.sma_50?1:0) : null;

            // Gate evaluation
            if (!gateFires(r)) continue;
            totalFires++;

            // 3-bar independence
            if (lastFireTs !== null && r.timestamp < lastFireTs + INDEP_BARS * PERIOD) continue;
            lastFireTs = r.timestamp;

            const entry = r.close;
            const e5  = closeByTs.get(r.timestamp + 300) ?? null;
            const e10 = closeByTs.get(r.timestamp + 600) ?? null;
            const e15 = closeByTs.get(r.timestamp + 900) ?? null;
            const win = (exit) => exit===null ? null : (exit > entry ? 1 : 0);

            toInsert.push({
                asset, bar_ts: r.timestamp,
                session: sessionFor(r.timestamp),
                entry_close: entry,
                exit_5m: e5,  exit_10m: e10,  exit_15m: e15,
                win_5m: win(e5), win_10m: win(e10), win_15m: win(e15),
            });
        }

        if (toInsert.length > 0) {
            insertMany(toInsert);
            totalInserted += toInsert.length;
        }
    }

    console.log(`  Gate fires (pre-independence): ${totalFires}`);
    console.log(`  Signals inserted (test_r2):    ${totalInserted}`);
    console.log(`  Independence rejections:        ${totalFires - totalInserted}`);
    return totalInserted;
}

// ── Step 3: Continuous R.3 check ─────────────────────────────────────────────
function continuousCheck(db) {
    console.log('\n── STEP 3: Continuous R.3 check ────────────────────────────');

    // Training corpus: all R1 signals (fold 0 + fold 1) for this gate
    const trainRow = db.prepare(`
        SELECT COUNT(CASE WHEN win_15m IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN win_15m=1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate=? AND direction=? AND fold IN (0,1)
    `).get(GATE.name, GATE.dir);
    const trainN = trainRow.n || 0;
    const trainK = trainRow.k || 0;
    const trainWR = trainN > 0 ? trainK / trainN : null;

    // Test fold (test_r2)
    const testRow = db.prepare(`
        SELECT COUNT(CASE WHEN win_15m IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN win_15m=1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate=? AND direction=? AND fold='test_r2'
    `).get(GATE.name, GATE.dir);
    const testN = testRow.n || 0;
    const testK = testRow.k || 0;
    const testWR = testN > 0 ? testK / testN : null;

    const ci = testN > 0 ? wilsonCI(testK, testN) : {lower: null, upper: null};
    const pv = testN > 0 ? binomP(testK, testN, BREAK_EVEN) : null;

    // Flags and verdict
    let flag, verdict;
    if (testN < 20) {
        flag = 'low_n';
        verdict = 'INCONCLUSIVE';
    } else if (testN < 50) {
        flag = 'low_n';
        verdict = ci.lower > BREAK_EVEN ? 'PASS' : 'INCONCLUSIVE';
    } else if (testN < 100) {
        flag = 'caution_n';
        verdict = ci.lower > BREAK_EVEN ? 'PASS' : 'FAIL';
    } else {
        flag = 'ok';
        verdict = ci.lower > BREAK_EVEN ? 'PASS' : 'FAIL';
    }

    // Per-asset breakdown (test_r2)
    const assetRows = db.prepare(`
        SELECT asset,
               COUNT(CASE WHEN win_15m IS NOT NULL THEN 1 END) AS n,
               SUM(CASE WHEN win_15m=1 THEN 1 ELSE 0 END) AS k
        FROM backtest_signals
        WHERE gate=? AND direction=? AND fold='test_r2'
        GROUP BY asset
        ORDER BY n DESC
    `).all(GATE.name, GATE.dir);

    // OTC vs non-OTC
    const otcRows    = assetRows.filter(r => r.asset.endsWith('_otc'));
    const nonOtcRows = assetRows.filter(r => !r.asset.endsWith('_otc'));
    const otcN  = otcRows.reduce((s,r)=>s+(r.n||0),0);
    const otcK  = otcRows.reduce((s,r)=>s+(r.k||0),0);
    const nonN  = nonOtcRows.reduce((s,r)=>s+(r.n||0),0);
    const nonK  = nonOtcRows.reduce((s,r)=>s+(r.k||0),0);

    // Next milestone
    const milestones = [20, 30, 50, 85, 100, 150, 200];
    const next = milestones.find(m => m > testN) ?? testN + 50;

    // ── Print output in prescribed format ─────────────────────────────────
    const today = new Date().toISOString().slice(0,10);
    console.log(`\n${'='.repeat(62)}`);
    console.log(`=== di_oversold_bounce CALL 15m — Round 2 check ${today} ===`);
    console.log(`${'='.repeat(62)}`);
    console.log(`Training corpus:  n=${trainN} signals (R1 full dataset), WR=${trainWR!=null?(trainWR*100).toFixed(1)+'%':'n/a'}`);
    console.log(`Test fold (new):  n=${testN} signals since ${CUTOFF_DT}`);
    console.log('');
    console.log('Test fold result:');
    if (testN < 20) {
        console.log(`  WR:       n/a (need n≥20 to report)`);
        console.log(`  CI lower: n/a`);
        console.log(`  CI upper: n/a`);
        console.log(`  p-value:  n/a`);
    } else {
        console.log(`  WR:       ${(testWR*100).toFixed(2)}%`);
        console.log(`  CI lower: ${(ci.lower*100).toFixed(2)}%  (need >54.05% to pass)`);
        console.log(`  CI upper: ${(ci.upper*100).toFixed(2)}%`);
        console.log(`  p-value:  ${pv.toExponential(3)}  (vs H0: WR<=0.5405)`);
    }
    console.log(`  Flag:     ${flag}`);
    console.log(`  Verdict:  ${verdict}`);
    console.log('');
    if (assetRows.length > 0) {
        console.log('Per-asset (test fold):');
        for (const a of assetRows) {
            const wr = a.n>0 ? (a.k/a.n*100).toFixed(1)+'%' : '-';
            const otcTag = a.asset.endsWith('_otc') ? '' : ' [non-OTC]';
            console.log(`  ${a.asset.padEnd(20)} n=${String(a.n).padStart(3)}  WR=${wr}${otcTag}`);
        }
        console.log('');
        console.log('OTC vs non-OTC split (test fold):');
        console.log(`  OTC:      n=${otcN}  WR=${otcN>0?(otcK/otcN*100).toFixed(1)+'%':'n/a'}`);
        console.log(`  non-OTC:  n=${nonN}  WR=${nonN>0?(nonK/nonN*100).toFixed(1)+'%':'n/a'}`);
    } else {
        console.log('Per-asset: no test_r2 signals yet');
    }
    console.log('');
    console.log(`Next check: when n_test reaches ${next}`);
    console.log('='.repeat(62));

    return { trainN, trainK, trainWR, testN, testK, testWR, ci, pv, flag, verdict, next };
}

// ── Append to log ─────────────────────────────────────────────────────────────
function appendLog(result, syncResult) {
    const today = new Date().toISOString().slice(0,10);
    const entry = `
### Round 2 — Sync + Check (${today})

- New candles synced:    ${syncResult.candlesAdded}
- New indicators synced: ${syncResult.indicatorsAdded}
- test_r2 signals:       ${result.testN}

Test fold result (15m expiry):
  WR: ${result.testWR!=null?(result.testWR*100).toFixed(2)+'%':'n/a'}  n=${result.testN}
  CI lower: ${result.ci.lower!=null?(result.ci.lower*100).toFixed(2)+'%':'n/a'}
  Flag: ${result.flag}  Verdict: ${result.verdict}

Next check at n_test = ${result.next}.

---`;
    fs.appendFileSync(LOG_PATH, entry + '\n', 'utf8');
    console.log(`\nAppended to phase0_log.md`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
    if (!fs.existsSync(RESEARCH_DB)) {
        console.error(`ERROR: ${RESEARCH_DB} not found`);
        process.exit(1);
    }
    const db = new Database(RESEARCH_DB);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    const syncResult = syncNewBars(db, AGENT_DB);
    const signalsInserted = populateTestR2(db);
    const result = continuousCheck(db);
    appendLog(result, syncResult);

    db.close();
}

main();
