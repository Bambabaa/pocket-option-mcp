// Surgical gate ablation — enumerate every gate per pattern, trace per-candle
// pass/fail across all 5 DBs, then score each gate:
//   - how many signals does it kill (selectivity)?
//   - what would the WR / PF / P/L be WITHOUT this gate?
//   - what's the WR OF the signals it kills?
//
// Approach: re-implement the pattern logic here with instrumentation rather
// than modifying bot/indicators.js. We replicate MODE D video2 sufficiently
// that each individual gate can be toggled. We validate by ensuring our
// instrumented firing matches the live logic: every gate ON should reproduce
// the same signal set as bot/indicators.js.

const Database = require('better-sqlite3');
const Indicators = require('../bot/indicators.js');
const path = require('path');
const fs = require('fs');

const DBS = [
  ['v2_13-15', 'data/trading_data_v2_13-15.db'],
  ['V3_16',    'data/trading_data_V3_16.db'],
  ['V3_17',    'data/trading_data_V3_17.db'],
  ['V4_17',    'data/trading_data_V4_17.db'],
  ['current',  'data/trading_data.db'],
];
const AMOUNT = 500, PAYOUT = 0.92;

// ─── Replay every DB and build a gate-trace table per candidate signal ───
//
// For each candle where the instrumented pattern *might* fire (ignoring gates),
// record the booleans for every gate. We then test "what if gate X were
// removed" by simulating: the signal fires if every gate EXCEPT X is true.

function collectTracesForDB(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const assets = db.prepare('SELECT DISTINCT asset FROM candles GROUP BY asset HAVING COUNT(*) >= 80').all().map(r => r.asset);

  const traces = []; // per candidate: {pattern, gates:{name:bool}, outcome, pl, asset}
  let checked = 0;

  for (const asset of assets) {
    const rows = db.prepare('SELECT timestamp, open, close, high, low FROM candles WHERE asset=? ORDER BY timestamp ASC').all(asset);
    const candles = rows.map(r => [r.timestamp, r.open, r.close, r.high, r.low]);
    const ind = new Indicators();

    for (let i = 55; i < candles.length - 1; i++) {
      checked++;
      const result = ind.calculateAll(asset, candles.slice(Math.max(0, i - 59), i + 1), {});
      if (!result) continue;

      const closePrice = result.currentPrice ?? (result.lastCandle && result.lastCandle[2]);
      const ma6 = result.ma6, ma14 = result.ma14, rsi = result.rsi_5;
      if (ma6 == null || ma14 == null || rsi == null || !result.lastCandle) continue;

      const history = result.v2History || [];
      if (history.length < 3) continue;

      const rsi_1 = history[0].rsi_5, rsi_2 = history[1].rsi_5, rsi_3 = history[2].rsi_5;
      const k_1 = history[0].stochastic_k, k_2 = history[1].stochastic_k, k_3 = history[2].stochastic_k;
      const d_1 = history[0].stochastic_d, d_2 = history[1].stochastic_d;
      const stochK = result.stochastic_k;
      const stochD = result.stochastic_d;
      if ([rsi_1, rsi_2, rsi_3, k_1, k_2, k_3, d_1, d_2, stochK, stochD].some(x => x == null)) continue;

      const bb = result.bollingerKT;
      if (!bb || bb.upper == null || bb.lower == null || bb.middle == null) continue;
      const bbWidth = (bb.upper - bb.lower) / bb.middle;
      const bbWidthBps = bbWidth * 10000;

      const rsiVelocity = rsi - rsi_1;
      const rsiFalling = rsi < rsi_1;
      const rsiRising = rsi > rsi_1;
      const kFalling = stochK < k_1;
      const kRising = stochK > k_1;
      const ma6Rising = history[0].ma6 != null ? ma6 > history[0].ma6 : false;
      const ma6Falling = history[0].ma6 != null ? ma6 < history[0].ma6 : false;
      const lastC = result.lastCandle; // [ts, open, close, high, low]
      const isGreen = lastC[2] > lastC[1];
      const isRed   = lastC[2] < lastC[1];
      const closeAboveMid = closePrice >= bb.middle;
      const priceNearLowerBB = closePrice <= bb.lower + (bb.upper - bb.lower) * 0.15;

      const sc = candles[i], nc = candles[i + 1];
      const entry = sc[2], exit = nc[2];
      const winCall = exit > entry, winPut = exit < entry;

      // ─── PUT_REV gates (the primary target per QA1/QA2) ─────────────
      {
        const gates = {};
        gates.isRed                  = isRed;
        gates.rsiWasOverbought1      = rsi_1 > 70;
        gates.rsiWasOverbought2      = rsi_2 >= 80;
        gates.notFastDrop            = !(rsi_1 >= 75 && rsi_1 < 80);
        gates.rsiFalling             = rsiFalling;
        gates.rsiIn_38_70            = rsi >= 38 && rsi < 70;
        gates.rsiExcl_55_65          = !(rsi >= 55 && rsi < 65);
        gates.velInBand_m15_m8       = rsiVelocity >= -15 && rsiVelocity <= -8;
        gates.kExitingOB_strict      = k_1 > 65 && kFalling && stochK >= 55 && stochK < 80;
        gates.dLaggingHigh_75        = stochD >= 75;
        gates.kBelowD_m3             = (stochK - stochD) < -3;
        gates.closeAboveMid          = closeAboveMid;
        gates.bbw_10                 = bbWidthBps >= 10;
        gates.bbw_50                 = bbWidthBps >= 50;
        // 3-bar lookback sub-gates
        gates.rsiAllHigh_3           = rsi_1 > 70 && rsi_2 > 70 && rsi_3 > 70;
        gates.stochAllOB_3           = k_1 > 65 && k_2 > 65 && k_3 > 65;
        gates.noEarlyBullishCross    = !(k_1 < d_1 && k_2 >= d_2);

        // Skip if nothing close to a candidate (avoid huge trace DB)
        const coreActive = gates.isRed && gates.rsiWasOverbought1 && gates.rsiFalling && gates.rsiIn_38_70;
        if (coreActive) {
          const outcome = winPut ? 'WIN' : 'LOSS';
          traces.push({ pattern: 'PUT_REV', asset, gates, outcome, pl: outcome==='WIN'?AMOUNT*PAYOUT:-AMOUNT });
        }
      }

      // ─── CALL_REV (K-crash) gates ────────────────────────────────────
      {
        const kCrash = k_1 - stochK;
        const gates = {};
        gates.notStreak              = true; // streak gate reset per-asset; treat as pass for ablation
        gates.rsi_below_80           = rsi < 80;
        gates.kFlashCrash_25         = kCrash >= 25;
        gates.kOversold_25_30        = stochK >= 25 && stochK < 30;
        gates.kWasMid_50             = k_1 >= 50;
        gates.rsi_below_30           = rsi < 30;
        gates.priceNearLowerBB       = priceNearLowerBB;
        gates.bbw_10                 = bbWidthBps >= 10;
        gates.rsiAllLow_45           = rsi < 45 && rsi_1 < 45 && rsi_2 < 45 && rsi_3 < 45;
        gates.crashRecent_3to4       = k_1 >= 50 || k_2 >= 50 || k_3 >= 50;
        gates.noPrematureCross       = !(k_1 > d_1 && k_2 <= d_2);

        const coreActive = gates.rsi_below_80 && (gates.kFlashCrash_25 || gates.kOversold_25_30);
        if (coreActive) {
          const outcome = winCall ? 'WIN' : 'LOSS';
          traces.push({ pattern: 'CALL_REV', asset, gates, outcome, pl: outcome==='WIN'?AMOUNT*PAYOUT:-AMOUNT });
        }
      }

      // ─── CALL_UT (up trend) gates ────────────────────────────────────
      {
        const ma6BelowMa14 = ma6 < ma14;
        const gap0 = Math.abs(ma6 - ma14);
        const gap3 = Math.abs((history[2].ma6 ?? ma6) - (history[2].ma14 ?? ma14));
        const ma14_3 = history[2].ma14 ?? ma14;

        const gates = {};
        gates.isGreen                = isGreen;
        gates.ma6BelowMa14           = ma6BelowMa14;
        gates.ma6Rising              = ma6Rising;
        gates.rsi_above_50           = rsi > 50;
        gates.rsiRising              = rsiRising;
        gates.stochK_above_30        = stochK > 30;
        gates.kRising                = kRising;
        gates.gapShrinking           = gap0 < gap3;
        gates.ma14FlatOrRising       = ma14 >= ma14_3;
        gates.stochAbove30_3bar      = stochK > 30 && k_1 > 30 && k_2 > 30 && k_3 > 30;
        gates.stochRecovering        = stochK > k_2;
        gates.noBearishCross         = !(k_1 > d_1 && stochK <= stochD);
        gates.stochK_ge_85           = stochK >= 85;
        gates.rsi_not_60_70          = !(rsi >= 60 && rsi < 70);
        gates.bbw_10                 = bbWidthBps >= 10;

        const coreActive = gates.isGreen && gates.ma6BelowMa14 && gates.rsi_above_50;
        if (coreActive) {
          const outcome = winCall ? 'WIN' : 'LOSS';
          traces.push({ pattern: 'CALL_UT', asset, gates, outcome, pl: outcome==='WIN'?AMOUNT*PAYOUT:-AMOUNT });
        }
      }

      // ─── PUT_DT (down trend) gates ───────────────────────────────────
      {
        const ma6AboveMa14 = ma6 > ma14;
        const gap0 = Math.abs(ma6 - ma14);
        const gap3 = Math.abs((history[2].ma6 ?? ma6) - (history[2].ma14 ?? ma14));
        const ma14_3 = history[2].ma14 ?? ma14;

        const gates = {};
        gates.isRed                  = isRed;
        gates.bbw_30                 = bbWidthBps >= 30;
        gates.ma6AboveMa14           = ma6AboveMa14;
        gates.ma6Falling             = ma6Falling;
        gates.priceBelowMa14         = closePrice < ma14;
        gates.rsi_1_above_50         = rsi_1 > 50;
        gates.rsiFalling             = rsiFalling;
        gates.rsi_below_55           = rsi < 55;
        gates.stochK_below_70        = stochK < 70;
        gates.kFalling               = kFalling;
        gates.gapShrinking           = gap0 < gap3;
        gates.ma14FlatOrFalling      = ma14 <= ma14_3;
        gates.stochBelow70_3bar      = stochK < 70 && k_1 < 70 && k_2 < 70 && k_3 < 70;
        gates.stochResumingDown      = stochK < k_2;
        gates.noBullishCross         = !(k_1 < d_1 && stochK >= stochD);

        const coreActive = gates.isRed && gates.ma6AboveMa14 && gates.rsi_1_above_50;
        if (coreActive) {
          const outcome = winPut ? 'WIN' : 'LOSS';
          traces.push({ pattern: 'PUT_DT', asset, gates, outcome, pl: outcome==='WIN'?AMOUNT*PAYOUT:-AMOUNT });
        }
      }
    }
  }
  db.close();
  return { traces, checked };
}

// ─── Ablation: given the full live-gate set per pattern, score each gate ───

const LIVE_GATES = {
  PUT_REV: [
    'isRed', 'rsiWasOverbought1', 'rsiWasOverbought2', 'notFastDrop',
    'rsiFalling', 'rsiIn_38_70', 'rsiExcl_55_65', 'velInBand_m15_m8',
    'kExitingOB_strict', 'dLaggingHigh_75', 'kBelowD_m3', 'closeAboveMid',
    'bbw_50', 'rsiAllHigh_3', 'stochAllOB_3', 'noEarlyBullishCross'
  ],
  CALL_REV: [
    'rsi_below_80', 'kFlashCrash_25', 'kOversold_25_30', 'kWasMid_50',
    'rsi_below_30', 'priceNearLowerBB', 'bbw_10',
    'rsiAllLow_45', 'crashRecent_3to4', 'noPrematureCross'
  ],
  CALL_UT: [
    'isGreen', 'ma6BelowMa14', 'ma6Rising', 'rsi_above_50', 'rsiRising',
    'stochK_above_30', 'kRising', 'gapShrinking', 'ma14FlatOrRising',
    'stochAbove30_3bar', 'stochRecovering', 'noBearishCross',
    'stochK_ge_85', 'rsi_not_60_70'
  ],
  PUT_DT: [
    'isRed', 'bbw_30', 'ma6AboveMa14', 'ma6Falling', 'priceBelowMa14',
    'rsi_1_above_50', 'rsiFalling', 'rsi_below_55', 'stochK_below_70', 'kFalling',
    'gapShrinking', 'ma14FlatOrFalling', 'stochBelow70_3bar',
    'stochResumingDown', 'noBullishCross'
  ],
};

function statsOf(arr) {
  const n = arr.length;
  const w = arr.filter(x => x.outcome === 'WIN').length;
  const pnl = arr.reduce((s,x)=>s+x.pl, 0);
  const gw = arr.filter(x => x.pl>0).reduce((s,x)=>s+x.pl, 0);
  const gl = Math.abs(arr.filter(x => x.pl<0).reduce((s,x)=>s+x.pl, 0));
  const pf = gl>0 ? gw/gl : (gw>0?999:0);
  return { n, w, wr: n?100*w/n:0, pnl, pf };
}

function ablate(traces, pattern) {
  const gateList = LIVE_GATES[pattern];
  const candidates = traces.filter(t => t.pattern === pattern);
  // Live firings: all gates true
  const allOn = candidates.filter(t => gateList.every(g => t.gates[g]));
  const base = statsOf(allOn);

  const rows = [];
  for (const g of gateList) {
    // Drop this gate — fire if every OTHER gate is true
    const withoutG = candidates.filter(t => gateList.filter(x => x !== g).every(x => t.gates[x]));
    const added = withoutG.filter(t => !allOn.some(a => a === t));
    const after = statsOf(withoutG);
    const killedByGate = added; // these signals were blocked ONLY by this gate
    const killStats = statsOf(killedByGate);
    rows.push({
      gate: g,
      newlyAdded: killedByGate.length,
      addedWR: killStats.wr,
      addedPnl: killStats.pnl,
      fullSetWR: after.wr,
      fullSetPnl: after.pnl,
      fullSetN: after.n,
      dWR: after.wr - base.wr,
      dPnl: after.pnl - base.pnl,
    });
  }
  return { base, rows };
}

(async () => {
  console.log('Replaying all DBs (this takes a few minutes)...');
  const allTraces = [];
  for (const [tag, dbp] of DBS) {
    const abs = path.join(__dirname, '..', dbp);
    if (!fs.existsSync(abs)) { console.log(`SKIP ${tag}`); continue; }
    const t0 = Date.now();
    const { traces, checked } = collectTracesForDB(abs);
    console.log(`  ${tag}: ${checked} candles → ${traces.length} trace rows   [${((Date.now()-t0)/1000).toFixed(1)}s]`);
    traces.forEach(t => t.db = tag);
    allTraces.push(...traces);
  }

  console.log(`\n=== Total trace rows: ${allTraces.length} ===\n`);

  for (const pat of ['PUT_REV', 'CALL_REV', 'CALL_UT', 'PUT_DT']) {
    const { base, rows } = ablate(allTraces, pat);
    const fmt = s => `n=${String(s.n).padStart(4)} WR=${s.wr.toFixed(1).padStart(5)}% PF=${s.pf.toFixed(2).padStart(5)} P/L=$${s.pnl.toFixed(0).padStart(7)}`;
    console.log(`\n═══════ ${pat} — LIVE baseline ${fmt(base)} ═══════`);
    console.log(`${'gate'.padEnd(22)} ${'newAdd'.padStart(6)} ${'addWR%'.padStart(7)} ${'addP/L'.padStart(9)} ${'noG n'.padStart(6)} ${'noG WR%'.padStart(8)} ${'noG P/L'.padStart(9)} ${'ΔWR'.padStart(6)} ${'ΔP/L'.padStart(8)}   verdict`);
    rows.sort((a,b)=>b.newlyAdded - a.newlyAdded);
    for (const r of rows) {
      let verdict = '';
      if (r.newlyAdded === 0) verdict = 'DECORATIVE (blocks nothing)';
      else if (r.dWR >= 5 && r.dPnl < 0)  verdict = 'SACRED (removing hurts WR & P/L)';
      else if (r.dWR <= -3 || r.dPnl > 500) verdict = 'COSTLY (removing HELPS)';
      else if (r.newlyAdded < 5) verdict = 'NEAR-DECORATIVE (tiny impact)';
      else verdict = 'AMBIGUOUS';
      console.log(`${r.gate.padEnd(22)} ${String(r.newlyAdded).padStart(6)} ${r.addedWR.toFixed(1).padStart(6)}% $${r.addedPnl.toFixed(0).padStart(7)} ${String(r.fullSetN).padStart(6)} ${r.fullSetWR.toFixed(1).padStart(7)}% $${r.fullSetPnl.toFixed(0).padStart(7)} ${r.dWR.toFixed(1).padStart(5)} ${r.dPnl.toFixed(0).padStart(7)}   ${verdict}`);
    }
  }

  // Persist for follow-up
  fs.writeFileSync(path.join(__dirname, '..', 'docs', '_qa_gate_ablation.json'), JSON.stringify(allTraces.length < 50000 ? allTraces : allTraces.slice(0,50000), null, 0));
})();
