import { all, get } from '../connection.js';

export async function getQualifiedAssets() {
  const rows = await all(
    'SELECT asset, consecutive_wins, qualified_since, updated_at FROM qualified_assets ORDER BY consecutive_wins DESC'
  );
  return { count: rows.length, qualified_assets: rows };
}

export async function getAssetStreaks(asset = null) {
  if (asset) {
    const row = await get('SELECT * FROM asset_streaks WHERE asset = ?', [asset]);
    return row || { asset, consecutive_wins: 0, last_result: null };
  }
  const rows = await all('SELECT * FROM asset_streaks ORDER BY consecutive_wins DESC');
  return { count: rows.length, streaks: rows };
}

export async function getQualificationOutcomes(asset = null, limit = 50) {
  let sql = 'SELECT * FROM qualification_outcomes WHERE 1=1';
  const params = [];
  if (asset) { sql += ' AND asset = ?'; params.push(asset); }
  sql += ' ORDER BY signal_timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  return { count: rows.length, outcomes: rows };
}

export async function getAssetTrades(asset = null, limit = 50) {
  let sql = 'SELECT * FROM assets_trades WHERE 1=1';
  const params = [];
  if (asset) { sql += ' AND asset = ?'; params.push(asset); }
  sql += ' ORDER BY signal_timestamp DESC LIMIT ?';
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
