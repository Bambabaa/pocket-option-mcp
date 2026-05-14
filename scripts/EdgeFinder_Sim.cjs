// Edge Finder Simulation — driven by exported sim_config JSON
// Mirrors the dashboard Edge Finder confluence logic exactly
// Usage: node scripts/EdgeFinder_Sim.cjs [simConfigJson] [dbPath] [outCsv] [asset]
//   asset: exact asset name (e.g. AEDCNY_otc) or partial match (e.g. AEDCNY) — default: all assets
//   If omitted, uses _meta.asset from config if present, otherwise runs all assets.

'use strict';
const fs       = require('fs');
const Database = require('better-sqlite3');

const configPath = process.argv[2] || 'dashboard/sch/sim_config_AEDCNY_otc_2026-05-12.json';
const dbPath     = process.argv[3] || 'data/trading_data.db';
const outPath    = process.argv[4] || 'data/edgefinder_signals.csv';
// Asset filter: CLI arg > config _meta.asset > 'all'
const assetArg   = process.argv[5] || null;

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
const GL_FLOOR       = cfg.g4_goldilocks_floor ?? 0;      // 0 = OFF
const GL_CEIL        = cfg.g4_goldilocks_ceil  ?? 50;     // 50 = OFF
const GL_ACTIVE      = GL_FLOOR > 0 || GL_CEIL < 50;
const VELOCITY       = cfg.g4_velocity_min ?? 0;          // 0 = OFF
const MIN_CONF       = cfg.min_confluence_gates;          // e.g. 4
const LOOKBACK       = cfg.lookback_bars;                 // e.g. 2

// Derived stoch zone boundaries — mirrors dashboard boundOB/boundOS
const BOUND_OB = OU_ZONE === 100 ? 80 : OU_ZONE;
const BOUND_OS = OU_ZONE === 100 ? 20 : (100 - OU_ZONE);

const AMOUNT  = 500;
const PAYOUT  = 0.92;
const EXPIRIES = [1, 2, 3]; // minutes

// Resolve asset filter: CLI arg only — meta.asset is informational, not a filter
const metaAsset   = cfg._meta?.asset ?? null;
const assetFilter = (assetArg && assetArg !== 'all') ? assetArg : null; // null = all assets

console.log('─── Edge Finder Simulation ───────────────────────────────');
console.log(`Config : ${configPath}`);
console.log(`Asset  : ${assetFilter ?? 'all'}`);
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
console.log(`  g4_goldilocks_floor    : ${GL_FLOOR === 0  ? 'OFF' : GL_FLOOR}`);
console.log(`  g4_goldilocks_ceil     : ${GL_CEIL  === 50 ? 'OFF' : GL_CEIL}`);
console.log(`  g4_velocity_min        : ${VELOCITY  === 0  ? 'OFF' : VELOCITY}`);
console.log(`  min_confluence_gates   : ${MIN_CONF}`);
console.log(`  lookback_bars          : ${LOOKBACK}`);
console.log('──────────────────────────────────────────────────────────');

// ─── Load candles + indicators ────────────────────────────────────────────────
const db = new Database(dbPath, { readonly: true });

// Asset filter: exact match if contains '_otc', otherwise LIKE 'ARG%_otc'
const assetWhere = assetFilter
  ? (assetFilter.includes('_') ? `AND i.asset = '${assetFilter}'`
                                : `AND i.asset LIKE '${assetFilter.toUpperCase()}%'`)
  : '';

const rows = db.prepare(`
  SELECT
    i.asset, i.timestamp,
    c.open, c.high, c.low, c.close,
    i.stochastic_k_v2, i.stochastic_d_v2,
    i.bb_upper, i.bb_middle, i.bb_lower,
    i.schaff_value,
    LAG(i.schaff_value, 1) OVER (PARTITION BY i.asset ORDER BY i.timestamp) AS prev_schaff_value,
    i.cci_8
  FROM indicators i
  JOIN candles c ON c.asset = i.asset AND c.timestamp = i.timestamp
  WHERE 1=1
    ${assetWhere}
  ORDER BY i.asset, i.timestamp ASC
`).all();

// ─── Tick prices for exit lookup ──────────────────────────────────────────────
const pricesByAsset = {};
const priceWhere = assetFilter
  ? (assetFilter.includes('_') ? `WHERE asset = '${assetFilter}'`
                                : `WHERE asset LIKE '${assetFilter.toUpperCase()}%'`)
  : '';
for (const p of db.prepare(
  `SELECT asset, timestamp, price FROM prices ${priceWhere} ORDER BY asset, timestamp ASC`
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
    const stcPrev = r.prev_schaff_value;
    const k      = r.stochastic_k_v2;
    const d      = r.stochastic_d_v2;
    // Null rows count toward cooldown (matches dashboard behaviour) but skip gate evaluation
    if (stc == null || stcPrev == null || k == null || d == null) continue;

    const stcDelta = stc - stcPrev;

    for (const direction of ['CALL', 'PUT']) {

      // ── G4: STC — current bar only (trigger gate) ─────────────────────────
      let g4_pass = 0;
      if (direction === 'CALL') {
        const base = stcPrev <= STC_CALL_CEIL;
        const vel  = stcDelta >= (VELOCITY > 0 ? VELOCITY : 0);
        const gl   = !GL_ACTIVE || (stc >= GL_FLOOR && stc <= GL_CEIL);
        if (base && vel && gl) g4_pass = 1;
      } else {
        const base = stcPrev >= STC_PUT_FLOOR;
        const vel  = stcDelta <= (VELOCITY > 0 ? -VELOCITY : 0);
        const gl   = !GL_ACTIVE || (stc >= (100 - GL_CEIL) && stc <= (100 - GL_FLOOR));
        if (base && vel && gl) g4_pass = 1;
      }

      // ── G1/G2/G3: sweep the lookback window ───────────────────────────────
      let g1_pass = G1_BB_PIERCE ? 0 : 1; // if BB not required, always pass
      let g2_pass = 0, g3_pass = 0;

      // Zone escape + CCI cross tracking (resolved after loop)
      const currentNeutral = k > BOUND_OS && k < BOUND_OB;
      let sawExtCall = false, sawExtPut = false;
      let crossedCCI_call = false, crossedCCI_put = false;

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
          const gap = Math.abs(pk - pd);
          if (ZONE_ESCAPE) {
            // Require K crossed D inside the extreme zone with minimum gap (matches dashboard)
            if (pk <= BOUND_OS && pd <= BOUND_OS && pk > pd && gap > STOCH_GAP) sawExtCall = true;
            if (pk >= BOUND_OB && pd >= BOUND_OB && pk < pd && gap > STOCH_GAP) sawExtPut  = true;
          } else {
            if (direction === 'CALL' && pk <= BOUND_OS && pk > pd && gap > STOCH_GAP) g2_pass = 1;
            if (direction === 'PUT'  && pk >= BOUND_OB && pk < pd && gap > STOCH_GAP) g2_pass = 1;
          }
        }

        // G3 — CCI cross of ±CCI_THRESH within window (matches dashboard runSimulation)
        if (pi.cci_8 != null && idx - step - 1 >= 0) {
          const pi_prev = assetRows[idx - step - 1];
          if (pi_prev && pi_prev.cci_8 != null) {
            if (pi_prev.cci_8 < -CCI_THRESH && pi.cci_8 >= -CCI_THRESH) crossedCCI_call = true;
            if (pi_prev.cci_8 > CCI_THRESH  && pi.cci_8 <= CCI_THRESH)  crossedCCI_put  = true;
          }
        }
      }

      g3_pass = (direction === 'CALL' && crossedCCI_call) ? 1 :
                (direction === 'PUT'  && crossedCCI_put)  ? 1 : 0;

      // Resolve zone escape: extreme seen in window + current K back in neutral zone
      if (ZONE_ESCAPE) {
        g2_pass = (sawExtCall && currentNeutral && direction === 'CALL') ? 1 :
                  (sawExtPut  && currentNeutral && direction === 'PUT')  ? 1 : 0;
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
