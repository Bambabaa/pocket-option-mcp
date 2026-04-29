#!/usr/bin/env node
/**
 * Deep Asset Historical Analysis
 * Analyzes historical signal performance across multiple dimensions
 * to identify which assets should be dynamically blocked
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/trading_data.db');
const db = new Database(dbPath, { readonly: true });

console.log('═══════════════════════════════════════════════════════════');
console.log('  DEEP ASSET HISTORICAL ANALYSIS — DYNAMIC BLOCKING');
console.log('═══════════════════════════════════════════════════════════\n');

// 1. Overall asset performance with historical span
console.log('📊 ASSET PERFORMANCE (All-Time Historical)\n');
const overall = db.prepare(`
    SELECT 
        so.asset,
        COUNT(*) as total_signals,
        SUM(CASE WHEN so.result = 'WIN' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN so.result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr,
        MIN(datetime(so.signal_timestamp, 'unixepoch')) as first_signal,
        MAX(datetime(so.signal_timestamp, 'unixepoch')) as last_signal,
        ROUND(julianday(MAX(datetime(so.signal_timestamp, 'unixepoch'))) - 
              julianday(MIN(datetime(so.signal_timestamp, 'unixepoch'))), 1) as days_span,
        ROUND(AVG(ABS(s.schaff_value - s.prev_schaff)), 2) as avg_stc_delta,
        ROUND(AVG(s.bb_width_bps), 2) as avg_bb_bps
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    GROUP BY so.asset
    ORDER BY total_signals DESC
`).all();

console.log('Asset                  | N   | WR%  | Days | STC Δ | BB bps');
console.log('──────────────────────────────────────────────────────────────');
overall.forEach(row => {
    const flag = row.wr < 40 ? '❌' : row.wr < 50 ? '⚠️ ' : row.wr >= 70 ? '✅' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.wr).padStart(4)} | ${String(row.days_span).padStart(4)} | ${String(row.avg_stc_delta).padStart(5)} | ${String(row.avg_bb_bps).padStart(6)}`
    );
});

// 2. Rolling 10-signal WR to detect consistency/volatility
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
console.log('─────────────────────────────────────────────────────────────────────');
rolling.forEach(row => {
    const range = (row.best_rolling_wr - row.worst_rolling_wr).toFixed(1);
    const flag = row.worst_rolling_wr < 30 ? '⚠️ ' : row.worst_rolling_wr < 40 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.worst_rolling_wr).padStart(8)} | ${String(row.best_rolling_wr).padStart(7)} | ${String(row.avg_rolling_wr).padStart(6)} | ${String(range).padStart(5)}`
    );
});

// 3. Recent (7d) vs Historical Performance
console.log('\n\n🕐 RECENT (Last 7 Days) vs HISTORICAL (All-Time)\n');
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
    LIMIT 30
`).all();

console.log('Asset                  | Hist N | Hist WR | 7d N | 7d WR | Change');
console.log('────────────────────────────────────────────────────────────────────');
recentVsHist.forEach(row => {
    const changeStr = row.wr_change > 0 ? `+${row.wr_change.toFixed(1)}` : row.wr_change.toFixed(1);
    const flag = row.recent_n === 0 ? '💤' : Math.abs(row.wr_change) > 25 ? '⚠️ ' : row.wr_change < -15 ? '📉' : row.wr_change > 15 ? '📈' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.hist_n).padStart(6)} | ${String(row.hist_wr).padStart(7)} | ${String(row.recent_n).padStart(4)} | ${String(row.recent_wr).padStart(5)} | ${changeStr.padStart(6)}`
    );
});

// 4. Losing Streak Analysis
console.log('\n\n🔥 MAX LOSING STREAK (Drawdown Risk)\n');
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
    LIMIT 25
`).all();

console.log('Asset                  | N   | Max Loss Streak');
console.log('──────────────────────────────────────────────────');
streaks.forEach(row => {
    const flag = row.max_loss_streak >= 5 ? '⚠️ ' : row.max_loss_streak >= 4 ? '⚡' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.total_signals).padStart(3)} | ${String(row.max_loss_streak).padStart(15)}`
    );
});

// 5. Volatility Consistency (BB Width Analysis)
console.log('\n\n🌊 VOLATILITY CONSISTENCY (BB Width Stability)\n');
const volatility = db.prepare(`
    SELECT 
        so.asset,
        COUNT(*) as n,
        ROUND(100.0 * SUM(CASE WHEN so.result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr,
        ROUND(AVG(s.bb_width_bps), 2) as avg_bb,
        ROUND(MIN(s.bb_width_bps), 2) as min_bb,
        ROUND(MAX(s.bb_width_bps), 2) as max_bb,
        SUM(CASE WHEN s.bb_width_bps < 10 THEN 1 ELSE 0 END) as signals_below_10bps,
        ROUND(100.0 * SUM(CASE WHEN s.bb_width_bps < 10 THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_below_10bps
    FROM signal_outcomes so
    JOIN signals s ON so.signal_id = s.id
    GROUP BY so.asset
    HAVING n >= 10
    ORDER BY (max_bb - min_bb) DESC
    LIMIT 25
`).all();

console.log('Asset                  | N   | WR%  | Avg BB | Min BB | Max BB | Range  | <10bps%');
console.log('───────────────────────────────────────────────────────────────────────────────────────');
volatility.forEach(row => {
    const range = (row.max_bb - row.min_bb).toFixed(1);
    const flag = row.pct_below_10bps > 20 ? '⚠️ ' : '  ';
    console.log(
        `${flag} ${row.asset.padEnd(20)} | ${String(row.n).padStart(3)} | ${String(row.wr).padStart(4)} | ${String(row.avg_bb).padStart(6)} | ${String(row.min_bb).padStart(6)} | ${String(row.max_bb).padStart(6)} | ${String(range).padStart(6)} | ${String(row.pct_below_10bps).padStart(6)}`
    );
});

// 6. Directional Bias per Asset
console.log('\n\n📍 DIRECTIONAL BIAS (CALL vs PUT Performance)\n');
const directional = db.prepare(`
    SELECT 
        so.asset,
        so.direction,
        COUNT(*) as n,
        SUM(CASE WHEN so.result = 'WIN' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN so.result = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr
    FROM signal_outcomes so
    GROUP BY so.asset, so.direction
    HAVING n >= 3
    ORDER BY so.asset, so.direction
`).all();

const grouped = {};
directional.forEach(row => {
    if (!grouped[row.asset]) grouped[row.asset] = {};
    grouped[row.asset][row.direction] = { n: row.n, wr: row.wr };
});

console.log('Asset                  | CALL WR (n) | PUT WR (n)  | Bias');
console.log('──────────────────────────────────────────────────────────────');
Object.entries(grouped).forEach(([asset, dirs]) => {
    const call = dirs.CALL || { wr: 0, n: 0 };
    const put = dirs.PUT || { wr: 0, n: 0 };
    const callStr = `${String(call.wr).padStart(4)}% (${call.n})`;
    const putStr = `${String(put.wr).padStart(4)}% (${put.n})`;
    let bias = 'BALANCED';
    if (call.n >= 3 && put.n >= 3) {
        if (call.wr - put.wr > 20) bias = 'CALL ONLY';
        else if (put.wr - call.wr > 20) bias = 'PUT ONLY';
    } else if (call.n < 3) bias = 'PUT ONLY';
    else if (put.n < 3) bias = 'CALL ONLY';
    
    const flag = bias !== 'BALANCED' ? '⚡' : '  ';
    console.log(
        `${flag} ${asset.padEnd(20)} | ${callStr.padEnd(11)} | ${putStr.padEnd(11)} | ${bias}`
    );
});

db.close();

console.log('\n═══════════════════════════════════════════════════════════');
console.log('✅ Analysis complete!\n');
