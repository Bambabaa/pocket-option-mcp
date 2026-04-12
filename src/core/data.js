import { all, get } from '../connection.js';

export async function getCandles(asset, limit = 100, summary = false) {
  const rows = await all(
    'SELECT timestamp, open, high, low, close, volume FROM candles WHERE asset = ? ORDER BY timestamp DESC LIMIT ?',
    [asset, limit]
  );

  if (summary) {
    if (!rows.length) return { asset, candle_count: 0 };
    const closes = rows.map(r => r.close);
    const latest = rows[0];
    const oldest = rows[rows.length - 1];
    return {
      asset,
      candle_count: rows.length,
      latest_timestamp: latest.timestamp,
      oldest_timestamp: oldest.timestamp,
      latest_close: latest.close,
      high_14: Math.max(...rows.slice(0, 14).map(r => r.high)),
      low_14: Math.min(...rows.slice(0, 14).map(r => r.low)),
      avg_close_14: closes.slice(0, 14).reduce((a, b) => a + b, 0) / Math.min(14, closes.length),
    };
  }

  return { asset, candle_count: rows.length, candles: rows.reverse() };
}

export async function getPrices(asset = null) {
  if (asset) {
    const row = await get(
      'SELECT asset, price, timestamp FROM prices WHERE asset = ? ORDER BY timestamp DESC LIMIT 1',
      [asset]
    );
    return row ? { asset, price: row.price, timestamp: row.timestamp } : { asset, price: null };
  }

  const rows = await all(
    `SELECT p.asset, p.price, p.timestamp
     FROM prices p
     INNER JOIN (
       SELECT asset, MAX(timestamp) as max_ts FROM prices GROUP BY asset
     ) latest ON p.asset = latest.asset AND p.timestamp = latest.max_ts
     ORDER BY p.asset`
  );
  return rows;
}

export async function getIndicators(asset, limit = 1) {
  const rows = await all(
    'SELECT * FROM indicators WHERE asset = ? ORDER BY timestamp DESC LIMIT ?',
    [asset, limit]
  );
  return { asset, count: rows.length, indicators: rows };
}

export async function getSignals(asset = null, limit = 20, direction = null) {
  let sql = 'SELECT id, asset, timestamp, direction, strategy_used, reasons FROM signals WHERE 1=1';
  const params = [];
  if (asset) { sql += ' AND asset = ?'; params.push(asset); }
  if (direction) { sql += ' AND direction = ?'; params.push(direction); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  return { count: rows.length, signals: rows };
}

export async function getPriceHistory(asset, fromTimestamp, toTimestamp, limit = 500) {
  const rows = await all(
    `SELECT timestamp, price FROM prices
     WHERE asset = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC LIMIT ?`,
    [asset, fromTimestamp, toTimestamp, limit]
  );
  return { asset, count: rows.length, prices: rows };
}

export async function listTrackedAssets() {
  const rows = await all(
    `SELECT asset, COUNT(*) as candle_count, MAX(timestamp) as latest_candle_ts
     FROM candles GROUP BY asset ORDER BY latest_candle_ts DESC`
  );
  return { count: rows.length, assets: rows };
}
