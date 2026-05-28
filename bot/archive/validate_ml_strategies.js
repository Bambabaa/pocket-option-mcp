'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  validate_ml_strategies.js  —  ML-only strategy backtest v2
//
//  Dataset:    data/agent.db   (candles + indicators, read-only)
//  Features:   features_ml.js  (53 non-SMC derived features)
//  Strategies: ml_only_router.js #1–#8 (gates adapted for feat.X)
//
//  Key fixes vs. ml_only_router.js direct usage:
//    1. Router uses `ind.X`; ALL computed features (ret_*, range_atr, body_atr,
//       hr_sin, dist_ema_26, dist_sma_20) live on `feat` → gates read feat.X.
//    2. body_atr in features_ml.js was UNSIGNED (abs/atr). Research used SIGNED
//       (close-open)/atr so EDGE_07 gate body_atr <= -1.302 works correctly.
//       features_ml.js now also exports `signed_body_atr` — this file uses it.
//    3. Vol-regime uses per-asset ATR terciles from first 70% of bars
//       (matching the research 70/30 chrono split), not the rolling fallback.
//    4. Null WR: CALL=35.8% (P(UP)), PUT=64.2% (P(flat/DOWN)).  Flat = LOSS.
//    5. Horizon mapping (5m bars): 10m=+2, 15m=+3, 20m=+4 bars.
//
//  Usage:
//    node bot/validate_ml_strategies.js
//    node bot/validate_ml_strategies.js --asset EURUSD
//    node bot/validate_ml_strategies.js --strategy ML_EDGE_03
//    node bot/validate_ml_strategies.js --verbose    (sample signals for debug)
// ════════════════════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path     = require('path');
const { createAssetState, buildMLFeatures, isWarm } = require('./features_ml.js');

const DB_PATH = path.join(__dirname, '../data/agent.db');

// ── CLI args ──────────────────────────────────────────────────────────────
const args           = process.argv.slice(2);
const _assetIdx      = args.indexOf('--asset');
const _stratIdx      = args.indexOf('--strategy');
const filterAsset    = _assetIdx    !== -1 ? args[_assetIdx    + 1] : null;
const filterStrategy = _stratIdx    !== -1 ? args[_stratIdx    + 1] : null;
const verbose        = args.includes('--verbose');

// ── Strategy definitions (from ml_only_router.js; gates read feat.X) ──────
//
// NOTE on EDGE_07: `body_atr_le` gate uses `feat.signed_body_atr` (negative =
// bearish candle). The router's `ind.body_atr <= -1.302` is only reachable if
// body_atr is signed; features_ml.js uses unsigned, so we fix it here.

const STRATEGIES = [
    {
        name: 'ML_EDGE_01', direction: 'CALL', horizon: '15m', barsAhead: 3,
        researchWR: 0.802, researchN: 96,
        walkFwd: { trainWR: 0.862, testWR: 0.677, decay: -0.184 },
        gates: [
            f => f.macd_line      != null && f.macd_line      <= -9.27073e-05,
            f => f.rsi_14         != null && f.rsi_14         >   0.431004,
            f => f.macd_histogram != null && f.macd_histogram <= -0.00741764,
            f => f.rsi_14         != null && f.rsi_14         <=  22.2888,
        ],
    },
    {
        name: 'ML_EDGE_02', direction: 'CALL', horizon: '15m', barsAhead: 3,
        researchWR: 0.786, researchN: 84,
        walkFwd: { trainWR: 0.824, testWR: 0.625, decay: -0.199 },
        gates: [
            f => f.ret_1 != null && f.ret_1 <= -0.000263426,
            f => f.ret_1 != null && f.ret_1 <= -0.000858864,   // tighter threshold
            f => f.ret_6 != null && f.ret_6 >  -0.00149088,
        ],
    },
    {
        name: 'ML_EDGE_03', direction: 'CALL', horizon: '20m', barsAhead: 4,
        researchWR: 0.780, researchN: 1015,
        notes: 'DELETED — calendar overfit (hr_sin ≤ -0.983 primary trigger). Validated WR=51.0% N=502.',
        gates: [],  // gates removed; entry below kept for historical reference only
    },
    {
        name: 'ML_EDGE_04', direction: 'PUT', horizon: '10m', barsAhead: 2,
        researchWR: 0.766, researchN: 29403,
        notes: 'DELETED — degenerate leaf (fires 56% of bars; regime inversion LOW↔HIGH). Validated WR=46.8% N=29177.',
        gates: [],
    },
    {
        name: 'ML_EDGE_05', direction: 'CALL', horizon: '15m', barsAhead: 3,
        researchWR: 0.752, researchN: 906,
        notes: 'DELETED — calendar overfit (same hr_sin gate as EDGE_03). Validated WR=60.3% N=906 but single-slot artefact.',
        gates: [],
    },
    {
        name: 'ML_EDGE_06', direction: 'CALL', horizon: '10m', barsAhead: 2,
        researchWR: 0.747, researchN: 99,
        walkFwd: { trainWR: 0.750, testWR: 0.727, decay: -0.023 },
        notes: 'BRITTLE: spread fragility=0.150; WR drops -24pp under spread perturbation',
        gates: [
            f => f.adx         != null && f.adx         <=  98.9897,
            f => f.dist_ema_26 != null && f.dist_ema_26 >  -0.000304769,
            f => f.minus_di    != null && f.minus_di    >   46.6808,
            f => f.dist_sma_20 != null && f.dist_sma_20 <= -0.000177698,
        ],
    },
    {
        name: 'ML_EDGE_07', direction: 'CALL', horizon: '15m', barsAhead: 3,
        researchWR: 0.747, researchN: 225,
        walkFwd: { trainWR: 0.770, testWR: 0.632, decay: -0.138 },
        notes: 'body_atr gate uses SIGNED (close-open)/atr; features_ml.js uses unsigned — this validator corrects it',
        gates: [
            f => f.range_atr       != null && f.range_atr       >  0.0432135,
            f => f.signed_body_atr != null && f.signed_body_atr <= -1.30231,   // bearish >= 1.3 ATR
            f => f.atr_14          != null && f.atr_14          >  0.000126786,
            f => f.range_atr       != null && f.range_atr       >  2.79401,    // extreme range bar
        ],
    },
    {
        name: 'ML_EDGE_08', direction: 'PUT', horizon: '10m', barsAhead: 2,
        researchWR: 0.737, researchN: 841,
        walkFwd: { trainWR: 0.709, testWR: 0.780, decay: +0.071 },
        notes: 'SALVAGED: ungated WR=45.9% N=839. Gated (regime MED/HIGH + session not Asian) → expected WR 62-65% N≈220.',
        gates: [
            f => f.rsi_14          != null && f.rsi_14          <=  99.9173,
            f => f.macd_line       != null && f.macd_line       >  -9.27073e-05,
            f => f.rsi_14          != null && f.rsi_14          >   61.0254,
            f => f.macd_histogram  != null && f.macd_histogram  <= -2.84941e-06,
            f => (f.regime === 'MED' || f.regime === 'HIGH'),
            f => f.session !== 'Asian',
        ],
    },

    // ── REGIME edges — session × vol-regime universals ─────────────────────
    // Source: ml_edge_report.md §5.3 (REGIME source, confidence 0.835/0.802/0.796)
    // Gate: session tag + vol_regime = LOW (ATR-14 ≤ per-asset p33 from training window)
    // These were never JS-validated before — adding now.

    // ── REGIME PUT (as labelled in research) ────────────────────────────────
    {
        name: 'REGIME_EUR_LOW', direction: 'PUT', horizon: '15m', barsAhead: 3,
        researchWR: 0.977, researchN: 3940,
        walkFwd: { trainWR: 0.970, testWR: 0.984, decay: +0.014 },
        notes: 'DEAD — 77% flat-price outcomes in European+LOW (exit==entry). PUT 10.9%, CALL 12.1%, ties 77%. Python 97.7% counted flat as PUT win.',
        gates: [
            f => f.session === 'European',
            f => f.regime  === 'LOW',
        ],
    },
    {
        name: 'REGIME_ASI_LOW', direction: 'PUT', horizon: '15m', barsAhead: 3,
        researchWR: 0.885, researchN: 7128,
        walkFwd: { trainWR: 0.854, testWR: 0.923, decay: +0.069 },
        notes: 'DEAD — 55% flat-price outcomes in Asian+LOW. PUT 22.6%, CALL 22.3%. Same outcome-definition mismatch as EUR edge.',
        gates: [
            f => f.session === 'Asian',
            f => f.regime  === 'LOW',
        ],
    },
    {
        name: 'REGIME_AME_LOW', direction: 'PUT', horizon: '15m', barsAhead: 3,
        researchWR: 0.957, researchN: 6039,
        walkFwd: { trainWR: 0.992, testWR: 0.924, decay: -0.068 },
        notes: 'DEAD — 78% flat-price outcomes in American+LOW. PUT 10.2%. Same outcome-definition mismatch as EUR/ASI.',
        gates: [
            f => f.session === 'American',
            f => f.regime  === 'LOW',
        ],
    },
];

// ── Stats helpers ──────────────────────────────────────────────────────────

function wilson95(wins, n) {
    if (n === 0) return [null, null];
    const z = 1.96, p = wins / n;
    const mid  = (p + z*z/(2*n)) / (1 + z*z/n);
    const half = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / (1 + z*z/n);
    return [+(mid - half).toFixed(3), +(mid + half).toFixed(3)];
}

function ztest(wins, n, nullP) {
    if (n < 5) return { z: null, p: null };
    const p = wins / n;
    const se = Math.sqrt(nullP * (1 - nullP) / n);
    const z  = (p - nullP) / se;
    // two-tailed p (approximate)
    const absz = Math.abs(z);
    const pval = 2 * (1 - normalCDF(absz));
    return { z: +z.toFixed(3), p: +pval.toFixed(5) };
}

function normalCDF(x) {
    // Abramowitz & Stegun approximation
    const t = 1 / (1 + 0.2316419 * x);
    const poly = t * (0.319381530
        + t * (-0.356563782
        + t * (1.781477937
        + t * (-1.821255978
        + t *  1.330274429))));
    return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
}

// ── Per-asset ATR tercile computation (first 70% of bars) ─────────────────

function computeTerciles(byAsset) {
    const out = {};
    for (const [asset, bars] of byAsset) {
        const trainBars = bars.slice(0, Math.floor(bars.length * 0.70));
        const atrs = trainBars.map(b => b.atr_14).filter(v => v != null).sort((a, b) => a - b);
        if (atrs.length < 6) continue;
        out[asset] = {
            p33: atrs[Math.floor(0.33 * atrs.length)],
            p67: atrs[Math.floor(0.67 * atrs.length)],
        };
    }
    return out;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
    const db = new Database(DB_PATH, { readonly: true });

    // Detect available columns (graceful degradation)
    const iCols = new Set(db.pragma('table_info(indicators)').map(c => c.name));
    const col = (name, alias) =>
        iCols.has(name) ? `i.${name}` : `NULL as ${alias ?? name}`;

    const query = `
        SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
               i.atr_14, i.rsi_14,
               ${col('macd_line')}, ${col('macd_signal')}, ${col('macd_histogram')},
               i.adx, i.plus_di, i.minus_di, i.bb_width_bps,
               i.stoch_k, i.stoch_d, i.stc_value,
               ${col('williams_r')}, ${col('cci_20')}, ${col('psar_is_bullish')}
        FROM candles c
        JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
        ${filterAsset ? `WHERE c.asset = '${filterAsset}'` : ''}
        ORDER BY c.asset, c.timestamp
    `;

    const rows = db.prepare(query).all();
    db.close();

    const assets = [...new Set(rows.map(r => r.asset))];
    console.log(`\nLoaded ${rows.length.toLocaleString()} bars  |  ${assets.length} assets`);

    // Group by asset (already sorted)
    const byAsset = new Map();
    for (const row of rows) {
        if (!byAsset.has(row.asset)) byAsset.set(row.asset, []);
        byAsset.get(row.asset).push(row);
    }

    // Compute ATR terciles from training split
    const assetTerciles = computeTerciles(byAsset);
    const tercileAssets = Object.keys(assetTerciles).length;
    console.log(`ATR terciles computed for ${tercileAssets}/${assets.length} assets (70% training split)\n`);

    const activeStrats = filterStrategy
        ? STRATEGIES.filter(s => s.name === filterStrategy)
        : STRATEGIES;

    // Per-strategy state
    const acc = {};
    for (const s of activeStrats) {
        acc[s.name] = {
            n: 0, wins: 0,
            bySession: { Asian: [0,0], European: [0,0], American: [0,0] },
            byRegime:  { LOW: [0,0], MED: [0,0], HIGH: [0,0] },
            byAsset:   {},
            samples:   [],   // for --verbose
        };
    }

    let warmBars = 0;

    for (const [asset, bars] of byAsset) {
        const state = createAssetState();

        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            const feat = buildMLFeatures(bar, state, { assetTerciles });
            if (feat == null) continue;
            if (!isWarm(state)) continue;

            warmBars++;

            // signed_body_atr is now produced by features_ml.js directly

            for (const strat of activeStrats) {
                if (strat.gates.length === 0) continue;  // deleted tombstone — skip evaluation
                // Evaluate all gates
                let pass = true;
                for (const g of strat.gates) {
                    if (!g(feat)) { pass = false; break; }
                }
                if (!pass) continue;

                // Outcome at horizon
                const exitIdx = i + strat.barsAhead;
                if (exitIdx >= bars.length) continue;

                const entryClose = bar.close;
                const exitClose  = bars[exitIdx].close;
                const win = strat.direction === 'CALL'
                    ? exitClose > entryClose
                    : exitClose < entryClose;

                const a = acc[strat.name];
                a.n++;
                if (win) a.wins++;

                // Session breakdown
                const sess = feat.session;
                if (sess && a.bySession[sess]) {
                    a.bySession[sess][0]++;
                    if (win) a.bySession[sess][1]++;
                }

                // Regime breakdown
                const reg = feat.regime;
                if (reg && a.byRegime[reg]) {
                    a.byRegime[reg][0]++;
                    if (win) a.byRegime[reg][1]++;
                }

                // Asset breakdown
                if (!a.byAsset[asset]) a.byAsset[asset] = [0,0];
                a.byAsset[asset][0]++;
                if (win) a.byAsset[asset][1]++;

                // Verbose samples
                if (verbose && a.samples.length < 5) {
                    const ts = new Date(bar.timestamp * 1000).toISOString();
                    a.samples.push({ ts, asset, entryClose, exitClose, win });
                }
            }
        }
    }

    console.log(`Warm bars processed: ${warmBars.toLocaleString()}\n`);

    // ── Summary table ────────────────────────────────────────────────────────
    const LINE = '═'.repeat(125);
    const DASH = '─'.repeat(125);

    console.log(LINE);
    console.log('  ML STRATEGY VALIDATION v2  —  data/agent.db  |  Features: features_ml.js');
    console.log(LINE);

    const HDR = [
        'Strategy'.padEnd(14), 'Dir'.padEnd(4), 'Hz'.padEnd(3),
        'N_actual'.padStart(9), 'WR_actual'.padStart(10),
        'Research'.padStart(9), 'Gap'.padStart(7),
        'CI_95%'.padStart(14),
        'z'.padStart(7), 'p-val'.padStart(8),
        'Status'.padStart(12),
    ].join(' ');
    console.log(HDR);
    console.log(DASH);

    for (const s of activeStrats) {
        const a    = acc[s.name];
        const wr   = a.n > 0 ? a.wins / a.n : null;
        const wrPct = wr != null ? (wr * 100).toFixed(1) : '—';
        const resPct = (s.researchWR * 100).toFixed(1);
        const gap  = wr != null ? ((wr - s.researchWR) * 100).toFixed(1) : '—';
        const [lo, hi] = wilson95(a.wins, a.n);
        const nullP = s.direction === 'CALL' ? 0.358 : 0.642;
        const { z, p } = a.n > 0 ? ztest(a.wins, a.n, nullP) : { z: null, p: null };
        const ciStr = lo != null ? `[${lo}, ${hi}]` : '—';

        const status = a.n === 0                      ? '⚠️  NO SIG'  :
                       wr >= s.researchWR - 0.05       ? '✅ MATCH'    :
                       wr >= s.researchWR - 0.10       ? '⚠️  CLOSE'   :
                       wr >= s.researchWR - 0.20       ? '❌ DRIFT'    :
                                                         '❌❌ BREAK';

        console.log([
            s.name.padEnd(14), s.direction.padEnd(4), s.horizon.padEnd(3),
            String(a.n).padStart(9), `${wrPct}%`.padStart(10),
            `${resPct}%`.padStart(9), `${gap}pp`.padStart(7),
            ciStr.padStart(14),
            (z ?? '—').toString().padStart(7),
            (p ?? '—').toString().padStart(8),
            status.padStart(12),
        ].join(' '));

        if (s.notes) console.log(`               ↳ ${s.notes}`);
    }

    // ── Walk-forward decay reminder ─────────────────────────────────────────
    console.log(`\n${DASH}`);
    console.log('  WALK-FORWARD DECAY (research 70/30 chrono; for context only)');
    console.log(DASH);
    console.log(
        `  ${'Strategy'.padEnd(14)} ${'Train WR'.padStart(9)} ${'Test WR'.padStart(9)} ${'Decay'.padStart(7)}`
    );
    for (const s of activeStrats) {
        if (!s.walkFwd) continue;
        const { trainWR, testWR, decay } = s.walkFwd;
        const flag = decay > 0 ? '✅' : decay >= -0.05 ? '⚠️ ' : '❌';
        console.log(
            `  ${s.name.padEnd(14)} ${(trainWR*100).toFixed(1).padStart(8)}% ` +
            `${(testWR*100).toFixed(1).padStart(8)}% ${(decay*100 > 0 ? '+' : '') + (decay*100).toFixed(1)}pp  ${flag}`
        );
    }

    // ── Session / Regime breakdown ───────────────────────────────────────────
    console.log(`\n${DASH}`);
    console.log('  SESSION + REGIME BREAKDOWN  (N ≥ 15)');
    console.log(DASH);

    for (const s of activeStrats) {
        const a = acc[s.name];
        if (a.n < 15) continue;

        const wr = (a.wins / a.n * 100).toFixed(1);
        console.log(`\n  ${s.name} [${s.direction}/${s.horizon}]  N=${a.n}  WR=${wr}%`);

        // Sessions
        const sessPairs = Object.entries(a.bySession).filter(([,v]) => v[0] >= 10);
        if (sessPairs.length) {
            console.log('    Session:');
            for (const [sess, [n, w]] of sessPairs) {
                const swr = (w/n*100).toFixed(1);
                console.log(`      ${sess.padEnd(12)} N=${String(n).padStart(5)}  WR=${swr}%`);
            }
        }

        // Regimes
        const regPairs = Object.entries(a.byRegime).filter(([,v]) => v[0] >= 10);
        if (regPairs.length) {
            console.log('    Regime:');
            for (const [reg, [n, w]] of regPairs) {
                const rwr = (w/n*100).toFixed(1);
                console.log(`      ${reg.padEnd(8)} N=${String(n).padStart(5)}  WR=${rwr}%`);
            }
        }

        // Top 5 assets by N
        const assetPairs = Object.entries(a.byAsset)
            .filter(([,v]) => v[0] >= 10)
            .sort((a, b) => b[1][0] - a[1][0])
            .slice(0, 5);
        if (assetPairs.length) {
            console.log('    Top assets (by N):');
            for (const [ast, [n, w]] of assetPairs) {
                const awr = (w/n*100).toFixed(1);
                console.log(`      ${ast.padEnd(8)} N=${String(n).padStart(5)}  WR=${awr}%`);
            }
        }
    }

    // ── Verbose samples ───────────────────────────────────────────────────
    if (verbose) {
        console.log(`\n${DASH}`);
        console.log('  SIGNAL SAMPLES (up to 5 per strategy, --verbose)');
        console.log(DASH);
        for (const s of activeStrats) {
            const a = acc[s.name];
            if (!a.samples.length) continue;
            console.log(`\n  ${s.name}:`);
            for (const samp of a.samples) {
                const result = samp.win ? 'WIN' : 'LOSS';
                console.log(`    ${samp.ts}  ${samp.asset}  entry=${samp.entryClose}  exit=${samp.exitClose}  ${result}`);
            }
        }
    }

    console.log(`\n${DASH}`);
    console.log('  KEY OBSERVATIONS — post-verdict (validation_report.md §8)');
    console.log(DASH);
    console.log('  DELETED from router:');
    console.log('    EDGE_03, EDGE_05 — calendar overfit (hr_sin ≤ -0.983 primary trigger; artefact of single UTC hour)');
    console.log('    EDGE_04          — degenerate leaf (56% fire-rate; LOW-vol baseline in disguise; regime inversion)');
    console.log('  ACTIVE edges:');
    console.log('    EDGE_01 (WR 80.2% N=96)  : T1 CALL — macd+rsi confluence, Asian session best');
    console.log('    EDGE_02 (WR 78.6% N=84)  : T1 CALL — ret_1/ret_6 reversion, small N, treat cautiously');
    console.log('    EDGE_06 (WR 74.7% N=99)  : T2 CALL — adx+DI+EMA, BRITTLE frag=0.150, exclude CHF pairs');
    console.log('    EDGE_07 (WR 74.7% N=221) : T2 CALL — extreme spike bar + signed_body_atr (bearish reversal)');
    console.log('    EDGE_08 (gated ≈62-65%)  : T3 PUT  — gated on regime∈{MED,HIGH} + session≠Asian');
    console.log('  Fire-rate rule: any edge triggering > 5% of warm bars is suspect (degenerate-class risk).');
    console.log(LINE);
    console.log('  Run with --verbose to see sample trigger bars per strategy.');
    console.log('  Run with --strategy ML_EDGE_07 to drill into a single edge.');
    console.log(LINE + '\n');
}

main();
