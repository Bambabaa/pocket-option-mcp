#!/usr/bin/env node
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/trading_data.db');
const db = new Database(dbPath, { readonly: true });

console.log('\n══════════════════════════════════════════════════════════');
console.log('  DYNAMIC ASSET BLOCKING CRITERIA — HISTORICAL ANALYSIS');
console.log('══════════════════════════════════════════════════════════\n');

// 1. Overall Performance
console.log('📊 ASSET PERFORMANCE (All-Time)\n');
const overall = db.prepare(`
    SELECT 
        asset,
        COUNT(*) as total_signals,
        SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr,
        MIN(datetime(signal_timestamp, 'unixepoch')) as first_signal,
        MAX(datetime(signal_timestamp, 'unixepoch')) as last_signal,
        ROUND(julianday(MAX(datetime(signal_timestamp, 'unixepoch'))) - 
              julianday(MIN(datetime(signal_timestamp, 'unixepoch'))), 1) as days_span
    FROM signal_outcomes
    GROUP BY asset
    ORDER BY total_signals DESC
`).all();

console.log('Asset                  | N   | WR%  | Days | First       | Last');
console.log('─────────────────────────────────────────────────────────────────────────');
overall.forEach(row => {
    const flag = row.wr < 40 ? '❌' : row.wr < 50 ? '⚠️ ' : row.wr >= 70 ? '✅' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.wr).padStart(4)} | ${String(row.days_span).padStart(4)} | ${row.first_signal.substring(5, 10)} | ${row.last_signal.substring(5, 10)}`
    );
});

// 2. Rolling 10-Signal WR
console.log('\n\n📉 ROLLING 10-SIGNAL WR (Consistency Check)\n');
const rolling = db.prepare(`
    WITH rolling_stats AS (
        SELECT 
            asset,
            signal_timestamp,
            result,
            ROW_NUMBER() OVER (PARTITION BY asset ORDER BY signal_timestamp) as signal_num,
            SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) OVER (
                PARTITION BY asset 
                ORDER BY signal_timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as wins_last_10,
            COUNT(*) OVER (
                PARTITION BY asset 
                ORDER BY signal_timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as count_last_10
        FROM signal_outcomes
    )
    SELECT 
        asset,
        COUNT(*) as total_signals,
        ROUND(MIN(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as worst_rolling_wr,
        ROUND(MAX(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as best_rolling_wr,
        ROUND(AVG(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as avg_rolling_wr
    FROM rolling_stats
    WHERE signal_num >= 10
    GROUP BY asset
    HAVING total_signals >= 10
    ORDER BY worst_rolling_wr ASC
`).all();

console.log('Asset                  | N   | Worst 10 | Best 10 | Avg 10 | Range');
console.log('──────────────────────────────────────────────────────────────────────');
rolling.forEach(row => {
    const range = (row.best_rolling_wr - row.worst_rolling_wr).toFixed(1);
    const flag = row.worst_rolling_wr < 30 ? '⚠️ ' : row.worst_rolling_wr < 40 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.worst_rolling_wr).padStart(8)} | ${String(row.best_rolling_wr).padStart(7)} | ${String(row.avg_rolling_wr).padStart(6)} | ${String(range).padStart(5)}`
    );
});

// 3. Recent vs Historical
console.log('\n\n🕐 RECENT (7d) vs HISTORICAL\n');
const recentVsHist = db.prepare(`
    WITH recent AS (
        SELECT 
            asset,
            COUNT(*) as recent_n,
            ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as recent_wr
        FROM signal_outcomes
        WHERE signal_timestamp >= strftime('%s', 'now', '-7 days')
        GROUP BY asset
    ),
    historical AS (
        SELECT 
            asset,
            COUNT(*) as hist_n,
            ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as hist_wr
        FROM signal_outcomes
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
    WHERE h.hist_n >= 5
    ORDER BY ABS(COALESCE(r.recent_wr, 0) - h.hist_wr) DESC
    LIMIT 25
`).all();

console.log('Asset                  | Hist N | Hist WR | 7d N | 7d WR | Change');
console.log('─────────────────────────────────────────────────────────────────────');
recentVsHist.forEach(row => {
    const changeStr = row.wr_change > 0 ? `+${row.wr_change.toFixed(1)}` : row.wr_change.toFixed(1);
    const flag = row.recent_n === 0 ? '💤' : Math.abs(row.wr_change) > 25 ? '⚠️ ' : row.wr_change < -15 ? '📉' : row.wr_change > 15 ? '📈' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.hist_n).padStart(6)} | ${String(row.hist_wr).padStart(7)} | ${String(row.recent_n).padStart(4)} | ${String(row.recent_wr).padStart(5)} | ${changeStr.padStart(6)}`
    );
});

// 4. Max Losing Streak
console.log('\n\n🔥 MAX LOSING STREAK\n');
const streaks = db.prepare(`
    WITH ranked AS (
        SELECT 
            asset,
            signal_timestamp,
            result,
            ROW_NUMBER() OVER (PARTITION BY asset ORDER BY signal_timestamp) - 
            ROW_NUMBER() OVER (PARTITION BY asset, result ORDER BY signal_timestamp) as grp
        FROM signal_outcomes
    ),
    loss_streaks AS (
        SELECT 
            asset,
            grp,
            COUNT(*) as streak_length
        FROM ranked
        WHERE result = 'LOSS'
        GROUP BY asset, grp
    )
    SELECT 
        asset,
        (SELECT COUNT(*) FROM signal_outcomes WHERE signal_outcomes.asset = loss_streaks.asset) as total_signals,
        MAX(streak_length) as max_loss_streak
    FROM loss_streaks
    GROUP BY asset
    HAVING total_signals >= 5
    ORDER BY max_loss_streak DESC
    LIMIT 20
`).all();

console.log('Asset                  | N   | Max Streak');
console.log('────────────────────────────────────────────');
streaks.forEach(row => {
    const flag = row.max_loss_streak >= 5 ? '⚠️ ' : row.max_loss_streak >= 4 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.max_loss_streak).padStart(10)}`
    );
});

// 5. BLOCKING RECOMMENDATIONS
console.log('\n\n🚫 DYNAMIC BLOCKING RECOMMENDATIONS\n');
const blockable = db.prepare(`
    WITH asset_stats AS (
        SELECT 
            asset,
            COUNT(*) as n,
            ROUND(100.0 * SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr
        FROM signal_outcomes
        GROUP BY asset
        HAVING n >= 5
    ),
    rolling_stats AS (
        SELECT 
            asset,
            signal_timestamp,
            result,
            ROW_NUMBER() OVER (PARTITION BY asset ORDER BY signal_timestamp) as signal_num,
            SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) OVER (
                PARTITION BY asset 
                ORDER BY signal_timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as wins_last_10,
            COUNT(*) OVER (
                PARTITION BY asset 
                ORDER BY signal_timestamp 
                ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
            ) as count_last_10
        FROM signal_outcomes
    ),
    rolling_agg AS (
        SELECT 
            asset,
            ROUND(MIN(100.0 * wins_last_10 / NULLIF(count_last_10, 0)), 1) as worst_rolling_wr
        FROM rolling_stats
        WHERE signal_num >= 10
        GROUP BY asset
    )
    SELECT 
        a.asset,
        a.n,
        a.wr as overall_wr,
        COALESCE(r.worst_rolling_wr, a.wr) as worst_rolling_wr,
        CASE 
            WHEN a.wr < 40 THEN 'BLOCK_IMMEDIATELY'
            WHEN a.wr < 50 AND COALESCE(r.worst_rolling_wr, 100) < 30 THEN 'BLOCK_ON_NEXT_LOSS'
            WHEN COALESCE(r.worst_rolling_wr, 100) < 20 THEN 'BLOCK_HIGH_RISK'
            ELSE 'MONITOR'
        END as recommendation
    FROM asset_stats a
    LEFT JOIN rolling_agg r ON a.asset = r.asset
    WHERE a.wr < 60 OR COALESCE(r.worst_rolling_wr, 100) < 40
    ORDER BY 
        CASE recommendation
            WHEN 'BLOCK_IMMEDIATELY' THEN 1
            WHEN 'BLOCK_ON_NEXT_LOSS' THEN 2
            WHEN 'BLOCK_HIGH_RISK' THEN 3
            ELSE 4
        END,
        a.wr ASC
`).all();

console.log('Recommendation         | Asset                  | N   | Overall WR | Worst 10 WR');
console.log('──────────────────────────────────────────────────────────────────────────────────');
blockable.forEach(row => {
    let flag = '  ';
    if (row.recommendation === 'BLOCK_IMMEDIATELY') flag = '❌';
    else if (row.recommendation.includes('BLOCK')) flag = '⚠️ ';
    else if (row.recommendation === 'MONITOR') flag = '👁️ ';
    
    console.log(
        `${flag} ${row.recommendation.padEnd(20)} | ${row.asset.padEnd(22)} | ${String(row.n).padStart(3)} | ${String(row.overall_wr).padStart(10)} | ${String(row.worst_rolling_wr).padStart(11)}`
    );
});

console.log('\n\n📋 BLOCKING CRITERIA SUMMARY:\n');
console.log('❌ BLOCK_IMMEDIATELY    → Overall WR < 40%');
console.log('⚠️  BLOCK_ON_NEXT_LOSS  → Overall WR 40-50% AND worst rolling 10 WR < 30%');
console.log('⚠️  BLOCK_HIGH_RISK     → Worst rolling 10 WR < 20% (regardless of overall)');
console.log('👁️  MONITOR             → WR 50-60% OR worst rolling 10 WR 30-40%');

console.log('\n\n💡 IMPLEMENTATION STRATEGY:\n');
console.log('1. IMMEDIATE: Block all "BLOCK_IMMEDIATELY" assets (< 40% WR)');
console.log('2. CONDITIONAL: Auto-block "BLOCK_ON_NEXT_LOSS" after 1 more loss');
console.log('3. WATCHLIST: Monitor "BLOCK_HIGH_RISK" with 10-signal rolling WR < 20%');
console.log('4. AUTO-UNBLOCK: If blocked asset achieves 3 consecutive wins, unblock');

db.close();

console.log('\n══════════════════════════════════════════════════════════');
console.log('✅ Analysis complete!\n');
