#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/trading_data.db');
const db = new Database(dbPath, { readonly: true });

console.log('═══════════════════════════════════════════════════════════');
console.log('  DEEP ASSET HISTORICAL ANALYSIS');
console.log('═══════════════════════════════════════════════════════════\n');

// 1. Overall historical performance
console.log('📊 ASSET PERFORMANCE (All-Time)\n');
const overall = db.prepare(`
    SELECT 
        so.asset,
        COUNT(*) as total_signals,
        SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 2) as win_rate_2m,
        MIN(datetime(so.timestamp, 'unixepoch')) as first_signal,
        MAX(datetime(so.timestamp, 'unixepoch')) as last_signal,
        ROUND(julianday(MAX(datetime(so.timestamp, 'unixepoch'))) - julianday(MIN(datetime(so.timestamp, 'unixepoch'))), 1) as days_span,
        ROUND(AVG(ABS(s.schaff_value - s.prev_schaff)), 2) as avg_stc_delta,
        ROUND(AVG(s.bb_width_bps), 2) as avg_bb_bps,
        COUNT(DISTINCT s.direction) as directions_traded
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    WHERE so.outcome IS NOT NULL
    GROUP BY so.asset
    ORDER BY total_signals DESC
`).all();

console.log('Asset                  | N    | WR%   | Span(d) | Avg STC Δ | Avg BB | Dirs');
console.log('─────────────────────────────────────────────────────────────────────────────');
overall.forEach(row => {
    console.log(
        `${row.asset.padEnd(22)} | ${String(row.total_signals).padStart(4)} | ${String(row.win_rate_2m).padStart(5)} | ${String(row.days_span).padStart(7)} | ${String(row.avg_stc_delta).padStart(9)} | ${String(row.avg_bb_bps).padStart(6)} | ${row.directions_traded}`
    );
});

// 2. Rolling 10-signal worst performance
console.log('\n\n📉 ROLLING 10-SIGNAL WORST PERFORMANCE (Consistency Check)\n');
const rolling = db.prepare(`
    WITH rolling_stats AS (
        SELECT 
            asset,
            timestamp,
            outcome,
            ROW_NUMBER() OVER (PARTITION BY asset ORDER BY timestamp) as signal_num,
            SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) OVER (
                PARTITION BY asset 
                ORDER BY timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as wins_last_10,
            COUNT(*) OVER (
                PARTITION BY asset 
                ORDER BY timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as count_last_10
        FROM signal_outcomes
        WHERE outcome IS NOT NULL
    )
    SELECT 
        asset,
        COUNT(*) as total_signals,
        ROUND(MIN(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as worst_rolling_10_wr,
        ROUND(MAX(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as best_rolling_10_wr,
        ROUND(AVG(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as avg_rolling_10_wr,
        ROUND(AVG(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) - 
        ROUND(MIN(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as wr_range
    FROM rolling_stats
    WHERE signal_num >= 10
    GROUP BY asset
    HAVING total_signals >= 10
    ORDER BY worst_rolling_10_wr ASC
`).all();

console.log('Asset                  | N    | Worst 10 | Best 10 | Avg 10 | Range');
console.log('─────────────────────────────────────────────────────────────────────');
rolling.forEach(row => {
    const flag = row.worst_rolling_10_wr < 30 ? '⚠️ ' : row.worst_rolling_10_wr < 40 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(4)} | ${String(row.worst_rolling_10_wr).padStart(8)} | ${String(row.best_rolling_10_wr).padStart(7)} | ${String(row.avg_rolling_10_wr).padStart(6)} | ${String(row.wr_range).padStart(5)}`
    );
});

// 3. Directional breakdown for problem assets
console.log('\n\n📍 DIRECTIONAL BREAKDOWN (Key Assets)\n');
const keyAssets = ['GBPUSD_otc', 'KESUSD_otc', 'MADUSD_otc', 'USDPKR_otc', 'EURGBP_otc',
                   'AUDNZD_otc', 'USDDZD_otc', 'NZDUSD_otc', 'AUDJPY_otc', 'CHFJPY_otc'];
const directional = db.prepare(`
    SELECT 
        so.asset,
        s.direction,
        COUNT(*) as n,
        SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr,
        ROUND(AVG(ABS(s.schaff_value - s.prev_schaff)), 2) as avg_stc_delta,
        ROUND(AVG(s.bb_width_bps), 2) as avg_bb_bps
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    WHERE so.outcome IS NOT NULL
    AND so.asset IN (${keyAssets.map(() => '?').join(',')})
    GROUP BY so.asset, s.direction
    ORDER BY so.asset, s.direction
`).all(...keyAssets);

console.log('Asset                  | Dir  | N  | WR%  | STC Δ | BB bps');
console.log('───────────────────────────────────────────────────────────────');
directional.forEach(row => {
    console.log(
        `${row.asset.padEnd(22)} | ${row.direction.padEnd(4)} | ${String(row.n).padStart(2)} | ${String(row.wr).padStart(4)} | ${String(row.avg_stc_delta).padStart(5)} | ${String(row.avg_bb_bps).padStart(6)}`
    );
});

// 4. Volatility consistency
console.log('\n\n🌊 VOLATILITY CONSISTENCY (BB Width Variance)\n');
const volatility = db.prepare(`
    SELECT 
        so.asset,
        COUNT(*) as n,
        ROUND(100.0 * SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr,
        ROUND(AVG(s.bb_width_bps), 2) as avg_bb,
        ROUND(MIN(s.bb_width_bps), 2) as min_bb,
        ROUND(MAX(s.bb_width_bps), 2) as max_bb,
        SUM(CASE WHEN s.bb_width_bps < 10 THEN 1 ELSE 0 END) as signals_below_10bps,
        ROUND(100.0 * SUM(CASE WHEN s.bb_width_bps < 10 THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_below_10bps
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    WHERE so.outcome IS NOT NULL
    GROUP BY so.asset
    HAVING n >= 10
    ORDER BY (max_bb - min_bb) DESC
`).all();

console.log('Asset                  | N    | WR%  | Avg BB | Min BB | Max BB | Range | <10bps%');
console.log('─────────────────────────────────────────────────────────────────────────────────────');
volatility.slice(0, 25).forEach(row => {
    const range = (row.max_bb - row.min_bb).toFixed(1);
    const flag = row.pct_below_10bps > 20 ? '⚠️ ' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.n).padStart(4)} | ${String(row.wr).padStart(4)} | ${String(row.avg_bb).padStart(6)} | ${String(row.min_bb).padStart(6)} | ${String(row.max_bb).padStart(6)} | ${String(range).padStart(5)} | ${String(row.pct_below_10bps).padStart(6)}`
    );
});

// 5. Recent vs historical performance comparison
console.log('\n\n🕐 RECENT (Last 7d) vs HISTORICAL (All-Time) COMPARISON\n');
const comparison = db.prepare(`
    WITH recent AS (
        SELECT 
            asset,
            COUNT(*) as recent_n,
            ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as recent_wr
        FROM signal_outcomes
        WHERE outcome IS NOT NULL
        AND timestamp >= strftime('%s', 'now', '-7 days')
        GROUP BY asset
    ),
    historical AS (
        SELECT 
            asset,
            COUNT(*) as hist_n,
            ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as hist_wr
        FROM signal_outcomes
        WHERE outcome IS NOT NULL
        GROUP BY asset
    )
    SELECT 
        h.asset,
        h.hist_n,
        h.hist_wr,
        COALESCE(r.recent_n, 0) as recent_n,
        COALESCE(r.recent_wr, 0) as recent_wr,
        COALESCE(r.recent_wr, 0) - h.hist_wr as wr_change
    FROM historical h
    LEFT JOIN recent r ON h.asset = r.asset
    WHERE h.hist_n >= 10
    ORDER BY ABS(COALESCE(r.recent_wr, 0) - h.hist_wr) DESC
`).all();

console.log('Asset                  | Hist N | Hist WR% | 7d N | 7d WR% | Change');
console.log('─────────────────────────────────────────────────────────────────────────');
comparison.slice(0, 25).forEach(row => {
    const changeStr = row.wr_change > 0 ? `+${row.wr_change.toFixed(1)}` : row.wr_change.toFixed(1);
    const flag = Math.abs(row.wr_change) > 20 ? '⚠️ ' : row.wr_change < -10 ? '📉' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.hist_n).padStart(6)} | ${String(row.hist_wr).padStart(8)} | ${String(row.recent_n).padStart(4)} | ${String(row.recent_wr).padStart(6)} | ${changeStr.padStart(6)}`
    );
});

// 6. Losing streak analysis
console.log('\n\n🔥 LOSING STREAK ANALYSIS (Max Consecutive Losses)\n');
const streaks = db.prepare(`
    WITH streaks AS (
        SELECT 
            asset,
            timestamp,
            outcome,
            SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) OVER (
                PARTITION BY asset 
                ORDER BY timestamp
            ) as win_group
        FROM signal_outcomes
        WHERE outcome IS NOT NULL
    ),
    loss_streaks AS (
        SELECT 
            asset,
            win_group,
            COUNT(*) as streak_length
        FROM streaks
        WHERE outcome = 'LOSS'
        GROUP BY asset, win_group
    )
    SELECT 
        asset,
        COUNT(*) as total_signals,
        MAX(streak_length) as max_loss_streak,
        ROUND(AVG(streak_length), 1) as avg_loss_streak
    FROM loss_streaks
    GROUP BY asset
    HAVING total_signals >= 5
    ORDER BY max_loss_streak DESC
`).all();

console.log('Asset                  | N    | Max Streak | Avg Streak');
console.log('────────────────────────────────────────────────────────────');
streaks.slice(0, 25).forEach(row => {
    const flag = row.max_loss_streak >= 5 ? '⚠️ ' : row.max_loss_streak >= 3 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(4)} | ${String(row.max_loss_streak).padStart(10)} | ${String(row.avg_loss_streak).padStart(10)}`
    );
});

db.close();

console.log('\n═══════════════════════════════════════════════════════════\n');
