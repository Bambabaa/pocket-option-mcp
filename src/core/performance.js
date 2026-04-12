import { all, get } from '../connection.js';

export async function getDailyPerformance(days = 30) {
  const rows = await all('SELECT * FROM performance ORDER BY date DESC LIMIT ?', [days]);
  return { count: rows.length, performance: rows };
}

export async function getRollingSummary(days = 7) {
  const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;

  const rows = await all(
    `SELECT * FROM trades_ordered
     WHERE result IN ('WIN','LOSS','DRAW') AND entry_timestamp >= ?
     ORDER BY entry_timestamp DESC`,
    [cutoff]
  );

  const wins = rows.filter(r => r.result === 'WIN').length;
  const losses = rows.filter(r => r.result === 'LOSS').length;
  const draws = rows.filter(r => r.result === 'DRAW').length;
  const totalPL = rows.reduce((a, r) => a + (r.profit_loss || 0), 0);
  const totalRisked = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const best = rows.reduce((m, r) => (r.profit_loss > m ? r.profit_loss : m), -Infinity);
  const worst = rows.reduce((m, r) => (r.profit_loss < m ? r.profit_loss : m), Infinity);

  let maxStreak = 0, cur = 0;
  for (const r of [...rows].reverse()) {
    if (r.result === 'WIN') { cur++; if (cur > maxStreak) maxStreak = cur; }
    else cur = 0;
  }

  return {
    period_days: days || 'all-time',
    total_trades: rows.length,
    wins,
    losses,
    draws,
    win_rate: rows.length ? ((wins / rows.length) * 100).toFixed(1) + '%' : 'N/A',
    total_profit_loss: parseFloat(totalPL.toFixed(2)),
    total_risked: parseFloat(totalRisked.toFixed(2)),
    roi_pct: totalRisked > 0 ? ((totalPL / totalRisked) * 100).toFixed(2) + '%' : 'N/A',
    best_trade: best === -Infinity ? null : parseFloat(best.toFixed(2)),
    worst_trade: worst === Infinity ? null : parseFloat(worst.toFixed(2)),
    max_win_streak: maxStreak,
  };
}

export async function getHourlyBreakdown() {
  const rows = await all(
    `SELECT
       (entry_timestamp % 86400) / 3600 as hour_utc,
       COUNT(*) as trades,
       SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
       ROUND(SUM(profit_loss),2) as pnl
     FROM trades_ordered
     WHERE result IN ('WIN','LOSS','DRAW')
     GROUP BY hour_utc
     ORDER BY hour_utc`
  );
  return { hours: rows };
}
