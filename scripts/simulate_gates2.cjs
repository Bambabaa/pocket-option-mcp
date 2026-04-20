// po_simulate — full candle-based baseline vs modified gate comparison
// Uses Indicators class directly (same as bot) on raw candle history

const Database = require('better-sqlite3');
const Indicators = require('../bot/indicators.js');

const db = new Database('data/trading_data.db', { readonly: true });
const assets = db.prepare('SELECT DISTINCT asset FROM candles GROUP BY asset HAVING COUNT(*) >= 80').all().map(r => r.asset);

const AMOUNT = 500;
const PAYOUT = 0.92;

// ─── Gate sets ───────────────────────────────────────────────────────────────

const SCENARIOS = [
    {
        label: 'BASELINE (current bot)',
        call_k_crash_min: 25,
        call_rsi_max: 40,
        bar_bb_bps_min: 10,
        // PUT gates unchanged
        put_rsi_from_min: 0,   // no gate
        put_rsi_vel_max: -12,  // velocity must be > -12 (current)
    },
    {
        label: 'MOD-1: CALL RSI < 20',
        call_k_crash_min: 25,
        call_rsi_max: 20,      // TIGHTENED
        bar_bb_bps_min: 10,
        put_rsi_from_min: 0,
        put_rsi_vel_max: -12,
    },
    {
        label: 'MOD-2: BB >= 20bps all patterns',
        call_k_crash_min: 25,
        call_rsi_max: 40,
        bar_bb_bps_min: 20,    // RAISED
        put_rsi_from_min: 0,
        put_rsi_vel_max: -12,
    },
    {
        label: 'MOD-3: PUT rsiFrom > 80',
        call_k_crash_min: 25,
        call_rsi_max: 40,
        bar_bb_bps_min: 10,
        put_rsi_from_min: 80,  // NEW gate
        put_rsi_vel_max: -12,
    },
    {
        label: 'MOD-FULL: All changes combined',
        call_k_crash_min: 25,
        call_rsi_max: 20,      // CALL RSI tightened
        bar_bb_bps_min: 20,    // BB raised
        put_rsi_from_min: 80,  // PUT rsiFrom gate
        put_rsi_vel_max: -12,
    },
];

// ─── Replay engine ────────────────────────────────────────────────────────────

function replay(scenario) {
    const sigs = { call: [], put: [], callUT: [], putDT: [] };

    for (const asset of assets) {
        const rows = db.prepare('SELECT timestamp, open, close, high, low FROM candles WHERE asset=? ORDER BY timestamp ASC').all(asset);
        const candles = rows.map(r => [r.timestamp, r.open, r.close, r.high, r.low]);
        const ind = new Indicators();

        for (let i = 55; i < candles.length - 1; i++) {
            const result = ind.calculateAll(asset, candles.slice(Math.max(0, i - 59), i + 1), {});
            if (!result) continue;

            const sigObj = { buy: false, sell: false, reasons: [], direction: null };
            ind._generateSignalsKTVideo2(result, {}, sigObj);
            if (!sigObj.buy && !sigObj.sell) continue;

            const signalCandle = candles[i];
            const nextCandle = candles[i + 1];
            const entry = signalCandle[2];
            const exit = nextCandle[2];
            const dir = sigObj.direction;
            const baseOutcome = dir === 'CALL'
                ? (exit > entry ? 'WIN' : 'LOSS')
                : (exit < entry ? 'WIN' : 'LOSS');

            const reasons = sigObj.reasons[0] || '';
            const bbW = result.bollingerKT && result.bollingerKT.upper && result.bollingerKT.middle
                ? (result.bollingerKT.upper - result.bollingerKT.lower) / result.bollingerKT.middle * 10000
                : 999;

            // Parsed values from reasons string
            const kDropM = reasons.match(/K crash ([0-9.]+)pts/);
            const rsiM = reasons.match(/RSI ([0-9.]+)/);
            const rsiFromM = reasons.match(/RSI [0-9.]+ \(from ([0-9.]+)/);

            const kDrop = kDropM ? parseFloat(kDropM[1]) : null;
            const rsi = rsiM ? parseFloat(rsiM[1]) : null;
            const rsiFrom = rsiFromM ? parseFloat(rsiFromM[1]) : null;

            const isKCrash = reasons.includes('K crash');
            const isPutOB = reasons.includes('OVERBOUGHT');
            const isCallUT = reasons.includes('UP TREND');
            const isPutDT = reasons.includes('DOWN TREND');

            // Apply scenario gates
            let pass = true;

            // BB gate (applies to all patterns)
            if (scenario.bar_bb_bps_min > 0 && bbW < scenario.bar_bb_bps_min) pass = false;

            // CALL Reversal specific gates
            if (pass && isKCrash) {
                if (kDrop !== null && kDrop < scenario.call_k_crash_min) pass = false;
                if (rsi !== null && rsi >= scenario.call_rsi_max) pass = false;
            }

            // PUT Overbought specific gates
            if (pass && isPutOB) {
                if (scenario.put_rsi_from_min > 0 && (rsiFrom === null || rsiFrom < scenario.put_rsi_from_min)) pass = false;
            }

            if (!pass) continue;

            const pl = baseOutcome === 'WIN' ? AMOUNT * PAYOUT : -AMOUNT;
            const entry_ = { asset, outcome: baseOutcome, pl };

            if (isKCrash) sigs.call.push(entry_);
            else if (isPutOB) sigs.put.push(entry_);
            else if (isCallUT) sigs.callUT.push(entry_);
            else if (isPutDT) sigs.putDT.push(entry_);
        }
    }
    return sigs;
}

function summarize(arr) {
    const wins = arr.filter(s => s.outcome === 'WIN').length;
    const losses = arr.filter(s => s.outcome === 'LOSS').length;
    const total = wins + losses;
    const pl = arr.reduce((s, x) => s + x.pl, 0);
    return { total, wins, losses, wr: total ? (100 * wins / total).toFixed(1) : '—', pl: pl.toFixed(0) };
}

// ─── Run all scenarios ────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║          po_simulate — GATE COMPARISON (candle replay)              ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

const results = [];
for (const scenario of SCENARIOS) {
    process.stdout.write('  Running: ' + scenario.label + '...');
    const sigs = replay(scenario);
    const cC = summarize(sigs.call);
    const cP = summarize(sigs.put);
    const cUT = summarize(sigs.callUT);
    const cDT = summarize(sigs.putDT);
    const allValid = sigs.call.concat(sigs.put, sigs.callUT, sigs.putDT);
    const tot = summarize(allValid);
    results.push({ scenario, cC, cP, cUT, cDT, tot });
    console.log(' done (' + allValid.length + ' signals)');
}

console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Pattern: CALL OVERSOLD REVERSAL');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Scenario                          n     WR       P&L');
for (const r of results) {
    console.log('  ' + r.scenario.label.padEnd(34) + String(r.cC.total).padEnd(6) + (r.cC.wr + '%').padEnd(9) + '$' + r.cC.pl);
}

console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Pattern: PUT OVERBOUGHT REVERSAL');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Scenario                          n     WR       P&L');
for (const r of results) {
    console.log('  ' + r.scenario.label.padEnd(34) + String(r.cP.total).padEnd(6) + (r.cP.wr + '%').padEnd(9) + '$' + r.cP.pl);
}

console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Pattern: CALL UP TREND (continuation)');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Scenario                          n     WR       P&L');
for (const r of results) {
    console.log('  ' + r.scenario.label.padEnd(34) + String(r.cUT.total).padEnd(6) + (r.cUT.wr + '%').padEnd(9) + '$' + r.cUT.pl);
}

console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Pattern: PUT DOWN TREND (continuation)');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  Scenario                          n     WR       P&L');
for (const r of results) {
    console.log('  ' + r.scenario.label.padEnd(34) + String(r.cDT.total).padEnd(6) + (r.cDT.wr + '%').padEnd(9) + '$' + r.cDT.pl);
}

console.log('');
console.log('═════════════════════════════════════════════════════════════════════');
console.log('  COMBINED ALL PATTERNS');
console.log('═════════════════════════════════════════════════════════════════════');
console.log('  Scenario                          n     WR       P&L');
for (const r of results) {
    const marker = r.scenario.label.includes('FULL') ? ' ◄ RECOMMENDED' : '';
    console.log('  ' + r.scenario.label.padEnd(34) + String(r.tot.total).padEnd(6) + (r.tot.wr + '%').padEnd(9) + '$' + r.tot.pl + marker);
}

// Asset breakdown for MOD-FULL
console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('  MOD-FULL: TOP ASSETS (min 3 signals)');
console.log('─────────────────────────────────────────────────────────────────────');
const fullResult = results.find(r => r.scenario.label.includes('FULL'));
if (fullResult) {
    const allSigs = [...fullResult.scenario._sigs_call || []];
    // Re-run to get per-asset breakdown
    const fullSigs = replay(SCENARIOS[4]);
    const allFull = [...fullSigs.call, ...fullSigs.put, ...fullSigs.callUT, ...fullSigs.putDT];
    const byAssetMap = {};
    for (const s of allFull) {
        if (!byAssetMap[s.asset]) byAssetMap[s.asset] = { w: 0, l: 0 };
        if (s.outcome === 'WIN') byAssetMap[s.asset].w++;
        else byAssetMap[s.asset].l++;
    }
    const ranked = Object.entries(byAssetMap)
        .map(([a, v]) => ({ a, n: v.w + v.l, wr: v.w + v.l > 0 ? (100 * v.w / (v.w + v.l)).toFixed(1) : '0' }))
        .filter(r => r.n >= 3)
        .sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));
    console.log('  Asset              n     WR');
    ranked.forEach(r => {
        const tag = parseFloat(r.wr) >= 60 ? ' ✓' : parseFloat(r.wr) < 40 ? ' ✗ BLOCK' : '';
        console.log('  ' + r.a.padEnd(18) + String(r.n).padEnd(6) + r.wr + '%' + tag);
    });
}

console.log('');
db.close();
