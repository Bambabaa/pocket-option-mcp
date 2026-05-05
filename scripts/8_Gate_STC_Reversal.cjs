// 8-Gate STC Reversal — paper-trading simulation
// Gate spec: docs/8GSR.TXT
// Usage: node scripts/8_Gate_STC_Reversal.cjs [dbPath] [outCsv]
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || 'data/trading_data.db';
const outPath = process.argv[3] || 'data/8gsr_signals.csv';
const db = new Database(dbPath, { readonly: true });

const AMOUNT = 500, PAYOUT = 0.92;
const EXPIRIES = [1, 2, 3, 4, 5]; // minutes

// ─── Constants (docs/8GSR.TXT) ────────────────────────────────────────────────
const LOOKBACK_BB = 3;
const LOOKBACK_STOCH_CROSS = 2;
const CCI_DEPTH_LOOKBACK = 10;
const CCI_BUY_THRESH = -150;
const CCI_SELL_THRESH = 150;
const STC_BUY_ZONE = 25;
const STC_SELL_ZONE = 75;
const CURRENT_K_BUY_MAX = 50;
const CURRENT_K_SELL_MIN = 50;
const DELTA_MIN = 0.5;

// ─── did_stoch_cross_from_deep ────────────────────────────────────────────────
function didStochCrossFromDeep(assetRows, idx, direction) {
    for (let i = idx - LOOKBACK_STOCH_CROSS; i <= idx; i++) {
        if (i < 1) continue;
        const cur = assetRows[i];
        const prev = assetRows[i - 1];
        if (!cur || !prev) continue;
        const kCur = cur.stochastic_k_v2, dCur = cur.stochastic_d_v2;
        const kPrev = prev.stochastic_k_v2, dPrev = prev.stochastic_d_v2;
        if (kCur == null || dCur == null || kPrev == null || dPrev == null) continue;
        if (direction === 'BUY') {
            if (kPrev <= dPrev && kCur > dCur && kPrev < 30 && dPrev < 30) return true;
        } else {
            if (kPrev >= dPrev && kCur < dCur && kPrev > 80 && dPrev > 80) return true;
        }
    }
    return false;
}

// ─── Load rows ────────────────────────────────────────────────────────────────
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
    AND i.bb_upper        IS NOT NULL
    AND i.schaff_value    IS NOT NULL
    AND i.cci_8           IS NOT NULL
  ORDER BY i.asset, i.timestamp ASC
`).all();

// Close price index for exit lookups
const closeByKey = new Map();
for (const r of rows) closeByKey.set(r.asset + '|' + r.timestamp, r.close);

// Per-asset row arrays
const byAsset = {};
for (const r of rows) {
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
}

// ─── Output ───────────────────────────────────────────────────────────────────
const header = [
    'timestamp_utc', 'asset', 'direction',
    'open', 'high', 'low', 'close',
    'stoch_k', 'stoch_d',
    'bb_upper', 'bb_middle', 'bb_lower',
    'stc', 'stc_prev',
    'cci_8',
];
for (const e of EXPIRIES) header.push(`exit_${e}m`, `pnl_${e}m`, `win_${e}m`);

const lines = [header.join(',')];
let sigCount = 0;

const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return Number.isInteger(v) ? v.toString() : v.toFixed(6);
    return String(v);
};

// ─── Main loop ────────────────────────────────────────────────────────────────
for (const [asset, assetRows] of Object.entries(byAsset)) {
    for (let idx = 1; idx < assetRows.length; idx++) {
        const r = assetRows[idx];

        const stc = r.schaff_value;
        const stcPrev = assetRows[idx - 1].schaff_value;
        const k = r.stochastic_k_v2;
        const d = r.stochastic_d_v2;

        if (stc == null || stcPrev == null || k == null || d == null) continue;

        for (const direction of ['BUY', 'SELL']) {

            // ── Gate 4: STC — primary trigger ────────────────────────────────
            let stc_ok = false;
            if (direction === 'BUY') {
                if (stcPrev <= STC_BUY_ZONE && stc > stcPrev) stc_ok = true;
            } else {
                if (stcPrev >= STC_SELL_ZONE && stc < stcPrev) stc_ok = true;
            }
            if (!stc_ok) continue;

            // ── Gate 1: BB touch within LOOKBACK_BB candles before C ─────────
            let bb_touch = false;
            for (let j = 1; j <= LOOKBACK_BB; j++) {
                if (idx - j < 0) break;
                const prev = assetRows[idx - j];
                if (prev.bb_lower == null || prev.bb_upper == null) continue;
                if (direction === 'BUY' && prev.low <= prev.bb_lower) { bb_touch = true; break; }
                if (direction === 'SELL' && prev.high >= prev.bb_upper) { bb_touch = true; break; }
            }
            if (!bb_touch) continue;

            // ── Gate 2: Stochastic cross from deep + K zone + delta ──────────
            if (!didStochCrossFromDeep(assetRows, idx, direction)) continue;
            let stoch_ok = false;
            if (direction === 'BUY' && k < CURRENT_K_BUY_MAX && Math.abs(k - d) > DELTA_MIN) stoch_ok = true;
            if (direction === 'SELL' && k > CURRENT_K_SELL_MIN && Math.abs(k - d) > DELTA_MIN) stoch_ok = true;
            if (!stoch_ok) continue;

            // ── Gate 3: CCI crossed ±100 + depth check ───────────────────────
            let cci_ok = false;
            if (direction === 'BUY') {
                for (let X = idx - 1; X >= 1; X--) {
                    const cciX = assetRows[X].cci_8;
                    const cciXm1 = assetRows[X - 1].cci_8;
                    if (cciX == null || cciXm1 == null) continue;
                    if (cciXm1 <= -100 && cciX > -100) {
                        const start = Math.max(0, X - CCI_DEPTH_LOOKBACK);
                        const slice = assetRows.slice(start, X - 1).map(r => r.cci_8).filter(v => v != null);
                        if (slice.length > 0 && Math.min(...slice) < CCI_BUY_THRESH) cci_ok = true;
                        break;
                    }
                }
            } else {
                for (let X = idx - 1; X >= 1; X--) {
                    const cciX = assetRows[X].cci_8;
                    const cciXm1 = assetRows[X - 1].cci_8;
                    if (cciX == null || cciXm1 == null) continue;
                    if (cciXm1 >= 100 && cciX < 100) {
                        const start = Math.max(0, X - CCI_DEPTH_LOOKBACK);
                        const slice = assetRows.slice(start, X - 1).map(r => r.cci_8).filter(v => v != null);
                        if (slice.length > 0 && Math.max(...slice) > CCI_SELL_THRESH) cci_ok = true;
                        break;
                    }
                }
            }
            if (!cci_ok) continue;

            // ── All 4 gates passed — entry at open of C+1 ────────────────────
            sigCount++;
            const row = [
                new Date(r.timestamp * 1000).toISOString(),
                asset, direction,
                r.open, r.high, r.low, r.close,
                k, d,
                r.bb_upper, r.bb_middle, r.bb_lower,
                stc, stcPrev,
                r.cci_8,
            ];
            for (const e of EXPIRIES) {
                const exitTs = r.timestamp + e * 60;
                const exit = closeByKey.get(asset + '|' + exitTs);
                if (exit == null) { row.push('', '', ''); continue; }
                const win = direction === 'BUY' ? exit > r.close : exit < r.close;
                const pl = win ? AMOUNT * PAYOUT : -AMOUNT;
                row.push(exit, pl, win ? 1 : 0);
            }
            lines.push(row.map(fmt).join(','));
        }
    }
}

fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} signal rows -> ${outPath}`);
console.log(`DB rows scanned: ${rows.length}, signals fired: ${sigCount}`);
