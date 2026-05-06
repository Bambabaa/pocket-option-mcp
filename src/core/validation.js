import { all, get } from '../connection.js';

export async function getPendingSignals(lookAheadSeconds = 60, limit = 50) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - lookAheadSeconds;

  const rows = await all(
    `SELECT s.id, s.asset, s.timestamp, s.direction, s.strategy_used
     FROM signals s
     LEFT JOIN signal_outcomes q ON q.asset = s.asset AND q.signal_timestamp = s.timestamp
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

  const total = await get(`SELECT COUNT(*) as n FROM signal_outcomes WHERE 1=1 ${assetFilter}`, assetParam);
  const wins = await get(`SELECT COUNT(*) as n FROM signal_outcomes WHERE result='WIN' ${assetFilter}`, assetParam);
  const losses = await get(`SELECT COUNT(*) as n FROM signal_outcomes WHERE result='LOSS' ${assetFilter}`, assetParam);
  const draws = await get(`SELECT COUNT(*) as n FROM signal_outcomes WHERE result='DRAW' ${assetFilter}`, assetParam);

  const byAsset = await all(
    `SELECT asset,
            COUNT(*) as total,
            SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
            ROUND(SUM(profit_loss),2) as total_pnl
     FROM signal_outcomes
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
  const rows = await all(`
    SELECT asset, result, entry_timestamp
    FROM trades_ordered
    WHERE result IN ('WIN','LOSS','DRAW')
    ORDER BY asset, entry_timestamp DESC
  `);

  const byAsset = {};
  for (const r of rows) {
    if (!byAsset[r.asset]) byAsset[r.asset] = [];
    byAsset[r.asset].push(r);
  }

  const streaks = Object.entries(byAsset).map(([asset, trades]) => {
    let consecutive_wins = 0;
    for (const t of trades) {
      if (t.result === 'WIN') consecutive_wins++;
      else break;
    }
    return {
      asset,
      consecutive_wins,
      last_result: trades[0]?.result ?? null,
      last_result_timestamp: trades[0]?.entry_timestamp ?? null,
    };
  })
    .filter(s => s.consecutive_wins >= minWins)
    .sort((a, b) => b.consecutive_wins - a.consecutive_wins);

  return { count: streaks.length, streaks };
}
