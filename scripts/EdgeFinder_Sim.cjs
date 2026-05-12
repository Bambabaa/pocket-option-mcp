// Edge Finder Simulation — driven by exported sim_config JSON
// Mirrors the dashboard Edge Finder confluence logic exactly
// Usage: node scripts/EdgeFinder_Sim.cjs [simConfigJson] [dbPath] [outCsv]

'use strict';
const fs       = require('fs');
const Database = require('better-sqlite3');

const configPath = process.argv[2] || 'dashboard/sch/sim_config_AEDCNY_otc_2026-05-12.json';
const dbPath     = process.argv[3] || 'data/trading_data.db';
const outPath    = process.argv[4] || 'data/edgefinder_signals.csv';

// ─── Load & validate config ───────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const G1_BB_PIERCE   = cfg.g1_bb_pierce_required;
const STOCH_GAP      = cfg.g2_stoch_kd_gap_min;          // 0 = any divergence
const OU_ZONE        = cfg.g2_stoch_ou_zone_pct;          // e.g. 85
const ZONE_ESCAPE    = cfg.g2_stoch_zone_escape_mode;
const CCI_THRESH     = cfg.g3_cci_cross_threshold;        // e.g. 100
const STC_CALL_CEIL  = cfg.g4_stc_call_ceiling;           // e.g. 25
const STC_PUT_FLOOR  = cfg.g4_stc_put_floor;              // e.g. 85
const DELTA_DIR_ONLY = cfg.g4_stc_delta_direction_only;   // true = no magnitude cap
const MIN_CONF       = cfg.min_confluence_gates;          // e.g. 4
const LOOKBACK       = cfg.lookback_bars;                 // e.g. 2

// Derived stoch zone boundaries — mirrors dashboard boundOB/boundOS
const BOUND_OB = OU_ZONE === 100 ? 80 : OU_ZONE;
const BOUND_OS = OU_ZONE === 100 ? 20 : (100 - OU_ZONE);

const AMOUNT  = 500;
const PAYOUT  = 0.92;
const EXPIRIES = [1, 2, 3]; // minutes

console.log('─── Edge Finder Simulation ───────────────────────────────');
console.log(`Config : ${configPath}`);
console.log(`Asset  : ${cfg._meta?.asset ?? 'all'}`);
console.log(`Exported: ${cfg._meta?.exported_at ?? 'unknown'}`);
console.log(`Settings:`);
console.log(`  g1_bb_pierce_required  : ${G1_BB_PIERCE}`);
console.log(`  g2_stoch_kd_gap_min    : ${STOCH_GAP}`);
console.log(`  g2_stoch_ou_zone_pct   : ${OU_ZONE}  → OB=${BOUND_OB} OS=${BOUND_OS}`);
console.log(`  g2_stoch_zone_escape   : ${ZONE_ESCAPE}`);
console.log(`  g3_cci_cross_threshold : ±${CCI_THRESH}`);
console.log(`  g4_stc_call_ceiling    : ${STC_CALL_CEIL}`);
console.log(`  g4_stc_put_floor       : ${STC_PUT_FLOOR}`);
console.log(`  g4_stc_delta_dir_only  : ${DELTA_DIR_ONLY}`);
console.log(`  min_confluence_gates   : ${MIN_CONF}`);
console.log(`  lookback_bars          : ${LOOKBACK}`);
console.log('──────────────────────────────────────────────────────────');

// ─── Load candles + indicators ────────────────────────────────────────────────
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.stochastic_k_v2, i.stochastic_d_v2,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.schaff_value,
    i.cci_8
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE i.stochastic_k_v2 IS NOT NULL
    AND i.bb_upper         IS NOT NULL
    AND i.schaff_value     IS NOT NULL
    AND i.cci_8            IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`).all();

// ─── Tick prices for exit lookup ──────────────────────────────────────────────
const pricesByAsset = {};
for (const p of db.prepare(
  'SELECT asset, timestamp, price FROM prices ORDER BY asset, timestamp ASC'
).all()) {
  if (!pricesByAsset[p.asset]) pricesByAsset[p.asset] = [];
  pricesByAsset[p.asset].push(p);
}

function findExpiryPrice(priceList, signalTs, expirySeconds) {
  if (!priceList?.length) return null;
  const target = signalTs + expirySeconds;
  let closest = null, minDiff = Infinity;
  for (const p of priceList) {
    if (p.timestamp < target - 30) continue;
    if (p.timestamp > target + 30) break;
    const diff = Math.abs(p.timestamp - target);
    if (diff < minDiff) { minDiff = diff; closest = p.price; }
  }
  return closest;
}

// ─── Group by asset ───────────────────────────────────────────────────────────
const byAsset = {};
for (const r of rows) {
  if (!byAsset[r.asset]) byAsset[r.asset] = [];
  byAsset[r.asset].push(r);
}

// ─── CSV header ───────────────────────────────────────────────────────────────
const header = [
  'timestamp_utc', 'asset', 'direction',
  'open', 'high', 'low', 'close',
  'stoch_k', 'stoch_d',
  'bb_upper', 'bb_middle', 'bb_lower',
  'stc', 'stc_prev', 'stc_delta', 'cci_8',
  'g1_bb_pass', 'g2_stoch_pass', 'g3_cci_pass', 'g4_stc_pass', 'confluence',
];
for (const e of EXPIRIES) header.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);
const lines = [header.join(',')];

const fmt = v => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  return String(v);
};

let sigCount = 0;

// ─── Main loop ────────────────────────────────────────────────────────────────
for (const [asset, assetRows] of Object.entries(byAsset)) {
  let lastFireIdx = -100;

  for (let idx = 1; idx < assetRows.length; idx++) {
    // Shared cooldown — suppress re-fire within lookback bars of last signal
    if (idx - lastFireIdx <= LOOKBACK) continue;

    const r      = assetRows[idx];
    const stc    = r.schaff_value;
    const stcPrev = assetRows[idx - 1].schaff_value;
    const k      = r.stochastic_k_v2;
    const d      = r.stochastic_d_v2;
    if (stc == null || stcPrev == null || k == null || d == null) continue;

    const stcDelta = stc - stcPrev;

    for (const direction of ['CALL', 'PUT']) {

      // ── G4: STC — current bar only (trigger gate) ─────────────────────────
      let g4_pass = 0;
      if (direction === 'CALL') {
        const ok = stcPrev <= STC_CALL_CEIL && stcDelta >= 0 &&
                   (DELTA_DIR_ONLY || stcDelta < 0.5);
        if (ok) g4_pass = 1;
      } else {
        const ok = stcPrev >= STC_PUT_FLOOR && stcDelta <= 0 &&
                   (DELTA_DIR_ONLY || stcDelta > -0.9);
        if (ok) g4_pass = 1;
      }

      // ── G1/G2/G3: sweep the lookback window ───────────────────────────────
      let g1_pass = G1_BB_PIERCE ? 0 : 1; // if BB not required, always pass
      let g2_pass = 0, g3_pass = 0;

      // Zone escape tracking (resolved after loop)
      let sawExtCall = false, sawExtPut = false;

      for (let step = 0; step <= LOOKBACK; step++) {
        if (idx - step < 0) break;
        const pi = assetRows[idx - step];
        const pk = pi.stochastic_k_v2;
        const pd = pi.stochastic_d_v2;

        // G1 — BB pierce within window
        if (!g1_pass && G1_BB_PIERCE) {
          if (direction === 'CALL' && pi.bb_lower != null && pi.low  <= pi.bb_lower) g1_pass = 1;
          if (direction === 'PUT'  && pi.bb_upper != null && pi.high >= pi.bb_upper) g1_pass = 1;
        }

        // G2 — Stoch
        if (pk != null && pd != null) {
          if (ZONE_ESCAPE) {
            // Track if K and D were both deep in the extreme zone within window
            if (pk <= BOUND_OS && pd <= BOUND_OS) sawExtCall = true;
            if (pk >= BOUND_OB && pd >= BOUND_OB) sawExtPut  = true;
          } else {
            // Require K in zone, K > D (CALL) or K < D (PUT), gap > min
            const gap = Math.abs(pk - pd);
            if (direction === 'CALL' && pk <= BOUND_OS && pk > pd && gap > STOCH_GAP) g2_pass = 1;
            if (direction === 'PUT'  && pk >= BOUND_OB && pk < pd && gap > STOCH_GAP) g2_pass = 1;
          }
        }

        // G3 — CCI depth within window (fire at extreme, not after cross)
        if (!g3_pass && pi.cci_8 != null) {
          if (direction === 'CALL' && pi.cci_8 < -CCI_THRESH) g3_pass = 1;
          if (direction === 'PUT'  && pi.cci_8 >  CCI_THRESH) g3_pass = 1;
        }
      }

      // Resolve zone escape: extreme seen in window + current K back in neutral zone
      if (ZONE_ESCAPE) {
        g2_pass = (direction === 'CALL' && sawExtCall && k > BOUND_OS) ? 1 :
                  (direction === 'PUT'  && sawExtPut  && k < BOUND_OB) ? 1 : 0;
      }

      // ── Confluence check ──────────────────────────────────────────────────
      const confluence = g1_pass + g2_pass + g3_pass + g4_pass;
      if (confluence < MIN_CONF) continue;

      // ── Fire signal ───────────────────────────────────────────────────────
      sigCount++;
      lastFireIdx = idx;

      const row = [
        new Date(r.timestamp * 1000).toISOString(),
        asset, direction,
        r.open, r.high, r.low, r.close,
        k, d,
        r.bb_upper, r.bb_middle, r.bb_lower,
        stc, stcPrev, stcDelta, r.cci_8,
        g1_pass, g2_pass, g3_pass, g4_pass, confluence,
      ];

      for (const e of EXPIRIES) {
        const exit = findExpiryPrice(pricesByAsset[asset], r.timestamp, e * 60);
        if (exit == null) { row.push('', '', ''); continue; }
        const win = direction === 'CALL' ? exit > r.close : exit < r.close;
        row.push(exit, win ? AMOUNT * PAYOUT : -AMOUNT, win ? 1 : 0);
      }

      lines.push(row.map(fmt).join(','));
      break; // one direction per bar — CALL takes priority if both pass
    }
  }
}

// ─── Write CSV ────────────────────────────────────────────────────────────────
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nSignals fired : ${sigCount}`);
console.log(`Rows scanned  : ${rows.length}`);
console.log(`Output        : ${outPath}`);
