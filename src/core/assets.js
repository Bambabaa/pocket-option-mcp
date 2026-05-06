import { all, get } from '../connection.js';

export async function getAssetAnalytics(asset = null) {
  const assetFilter = asset ? 'AND t.asset = ?' : '';
  const p = asset ? [asset] : [];

  const overall = await all(`
    SELECT t.asset,
           COUNT(*) as total_trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN t.result='LOSS' THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(t.profit_loss), 2) as total_pnl,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate_pct
    FROM trades_ordered t
    WHERE t.result IN ('WIN','LOSS','DRAW') ${assetFilter}
    GROUP BY t.asset
    ORDER BY win_rate_pct DESC
  `, p);

  if (!asset) return { count: overall.length, assets: overall };

  const byDirection = await all(`
    SELECT t.direction,
           COUNT(*) as trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr_pct,
           ROUND(SUM(t.profit_loss), 2) as pnl
    FROM trades_ordered t
    WHERE t.result IN ('WIN','LOSS','DRAW') AND t.asset = ?
    GROUP BY t.direction
  `, [asset]);

  const bySTC = await all(`
    SELECT CASE
             WHEN i.schaff_value <= 25 THEN 'floor(<=25)'
             WHEN i.schaff_value >= 90 THEN 'ceiling(>=90)'
             ELSE 'middle(25-90)'
           END as stc_zone,
           COUNT(*) as trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr_pct
    FROM trades_ordered t
    LEFT JOIN indicators i ON i.candle_id = t.candle_id
    WHERE t.result IN ('WIN','LOSS','DRAW') AND t.asset = ? AND i.schaff_value IS NOT NULL
    GROUP BY stc_zone
    ORDER BY wr_pct DESC
  `, [asset]);

  const byRSI = await all(`
    SELECT CASE
             WHEN i.rsi_5 < 30 THEN 'oversold(<30)'
             WHEN i.rsi_5 > 70 THEN 'overbought(>70)'
             ELSE 'neutral(30-70)'
           END as rsi_zone,
           COUNT(*) as trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr_pct
    FROM trades_ordered t
    LEFT JOIN indicators i ON i.candle_id = t.candle_id
    WHERE t.result IN ('WIN','LOSS','DRAW') AND t.asset = ? AND i.rsi_5 IS NOT NULL
    GROUP BY rsi_zone
    ORDER BY wr_pct DESC
  `, [asset]);

  const byBB = await all(`
    SELECT CASE
             WHEN (i.bb_upper - i.bb_lower) / i.bb_middle * 10000 < 10  THEN 'flat(<10bps)'
             WHEN (i.bb_upper - i.bb_lower) / i.bb_middle * 10000 < 50  THEN 'normal(10-50bps)'
             ELSE 'volatile(>50bps)'
           END as bb_zone,
           COUNT(*) as trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr_pct
    FROM trades_ordered t
    LEFT JOIN indicators i ON i.candle_id = t.candle_id
    WHERE t.result IN ('WIN','LOSS','DRAW') AND t.asset = ?
      AND i.bb_middle IS NOT NULL AND i.bb_middle > 0
    GROUP BY bb_zone
    ORDER BY wr_pct DESC
  `, [asset]);

  const byHour = await all(`
    SELECT (t.entry_timestamp % 86400) / 3600 as hour_utc,
           COUNT(*) as trades,
           SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) as wins,
           ROUND(100.0 * SUM(CASE WHEN t.result='WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as wr_pct,
           ROUND(SUM(t.profit_loss), 2) as pnl
    FROM trades_ordered t
    WHERE t.result IN ('WIN','LOSS','DRAW') AND t.asset = ?
    GROUP BY hour_utc
    ORDER BY wr_pct DESC
  `, [asset]);

  const recent = await all(`
    SELECT result FROM trades_ordered
    WHERE result IN ('WIN','LOSS','DRAW') AND asset = ?
    ORDER BY entry_timestamp DESC LIMIT 20
  `, [asset]);
  const recentWins = recent.filter(r => r.result === 'WIN').length;

  const s = overall[0] || { total_trades: 0, wins: 0, losses: 0, total_pnl: 0, win_rate_pct: null };
  return {
    asset,
    total_trades: s.total_trades,
    wins: s.wins,
    losses: s.losses,
    total_pnl: s.total_pnl,
    win_rate_pct: s.win_rate_pct,
    recent_20_wr: recent.length ? ((recentWins / recent.length) * 100).toFixed(1) + '%' : 'N/A',
    by_direction: byDirection,
    by_stc_zone: bySTC,
    by_rsi_zone: byRSI,
    by_bb_zone: byBB,
    top_hours:   byHour.slice(0, 5),
    worst_hours: [...byHour].sort((a, b) => a.wr_pct - b.wr_pct).slice(0, 3),
  };
}

export async function getAssetStreaks(asset = null) {
  const rows = await all(`
    SELECT asset, result, entry_timestamp
    FROM trades_ordered
    WHERE result IN ('WIN','LOSS','DRAW')
    ${asset ? 'AND asset = ?' : ''}
    ORDER BY asset, entry_timestamp DESC
  `, asset ? [asset] : []);

  const byAsset = {};
  for (const r of rows) {
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
  }

  const streaks = Object.entries(byAsset).map(([a, trades]) => {
    let consecutive_wins = 0;
    for (const t of trades) {
      if (t.result === 'WIN') consecutive_wins++;
      else break;
    }
    return {
      asset: a,
      consecutive_wins,
      last_result: trades[0]?.result ?? null,
      last_result_timestamp: trades[0]?.entry_timestamp ?? null,
    };
  }).sort((a, b) => b.consecutive_wins - a.consecutive_wins);

  if (asset) return streaks[0] || { asset, consecutive_wins: 0, last_result: null };
  return { count: streaks.length, streaks };
}

export async function getSignalOutcomes(asset = null, limit = 50) {
  let sql = 'SELECT * FROM signal_outcomes WHERE 1=1';
  const params = [];
  if (asset) { sql += ' AND asset = ?'; params.push(asset); }
  sql += ' ORDER BY signal_timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  return { count: rows.length, outcomes: rows };
}

export async function getAssetTrades(asset = null, limit = 50) {
  let sql = `SELECT * FROM trades_ordered WHERE result IN ('WIN','LOSS','DRAW')`;
  const params = [];
  if (asset) { sql += ' AND asset = ?'; params.push(asset); }
  sql += ' ORDER BY entry_timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  const wins = rows.filter(r => r.result === 'WIN').length;
  const losses = rows.filter(r => r.result === 'LOSS').length;
  const totalPL = rows.reduce((acc, r) => acc + (r.profit_loss || 0), 0);

  return {
    count: rows.length,
    wins,
    losses,
    win_rate: rows.length ? ((wins / rows.length) * 100).toFixed(1) + '%' : 'N/A',
    total_profit_loss: parseFloat(totalPL.toFixed(2)),
    trades: rows,
  };
}
