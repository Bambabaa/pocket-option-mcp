import { all, get } from '../connection.js';

export async function getPendingSignals(lookAheadSeconds = 60, limit = 50) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - lookAheadSeconds;

  const rows = await all(
    `SELECT s.id, s.asset, s.timestamp, s.direction, s.strategy_used
     FROM signals s
     LEFT JOIN qualification_outcomes q ON q.asset = s.asset AND q.signal_timestamp = s.timestamp
     WHERE q.id IS NULL
       AND s.timestamp <= ?
     ORDER BY s.timestamp DESC LIMIT ?`,
    [cutoff, limit]
  );
  return { count: rows.length, pending_signals: rows };
}

export async function getValidationStats(asset = null) {
  const assetFilter = asset ? 'AND asset = ?' : '';
  const assetParam = asset ? [asset] : [];

  const total = await get(`SELECT COUNT(*) as n FROM qualification_outcomes WHERE 1=1 ${assetFilter}`, assetParam);
  const wins = await get(`SELECT COUNT(*) as n FROM qualification_outcomes WHERE result='WIN' ${assetFilter}`, assetParam);
  const losses = await get(`SELECT COUNT(*) as n FROM qualification_outcomes WHERE result='LOSS' ${assetFilter}`, assetParam);
  const draws = await get(`SELECT COUNT(*) as n FROM qualification_outcomes WHERE result='DRAW' ${assetFilter}`, assetParam);

  const byAsset = await all(
    `SELECT asset,
            COUNT(*) as total,
            SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
            ROUND(SUM(profit_loss),2) as total_pnl
     FROM qualification_outcomes
     WHERE 1=1 ${assetFilter}
     GROUP BY asset ORDER BY wins DESC`,
    assetParam
  );

  const n = total?.n || 0;
  return {
    total_validated: n,
    wins: wins?.n ?? 0,
    losses: losses?.n ?? 0,
    draws: draws?.n ?? 0,
    win_rate: n ? (((wins?.n ?? 0) / n) * 100).toFixed(1) + '%' : 'N/A',
    by_asset: byAsset,
  };
}

export async function getStreakLeaderboard(minWins = 1) {
  const rows = await all(
    `SELECT s.asset, s.consecutive_wins, s.last_result, s.last_result_timestamp,
            q.qualified_since
     FROM asset_streaks s
     LEFT JOIN qualified_assets q ON q.asset = s.asset
     WHERE s.consecutive_wins >= ?
     ORDER BY s.consecutive_wins DESC`,
    [minWins]
  );
  return { count: rows.length, streaks: rows };
}
