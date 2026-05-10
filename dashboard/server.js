import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const db = new Database(path.join(__dirname, '../data/trading_data.db'), { readonly: true });

console.log('📊 Dashboard server starting...');
const columns = db.prepare('PRAGMA table_info(indicators)').all();
console.log('Indicators columns found:', columns.map(c => c.name).join(', '));

app.use(express.static(__dirname));

app.get('/api/assets', (req, res) => {
  try {
    // Sort by most recent candle so active assets appear first
    const assets = db.prepare(
      'SELECT asset, MAX(timestamp) as latest FROM candles GROUP BY asset ORDER BY latest DESC'
    ).all();
    res.json(assets.map(a => a.asset));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/candles', (req, res) => {
  const { asset, limit = 1000 } = req.query;
  if (!asset) return res.status(400).json({ error: 'asset required' });

  try {
    const candles = db.prepare(`
      SELECT timestamp, open, high, low, close 
      FROM candles 
      WHERE asset = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(asset, parseInt(limit));
    res.json(candles.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indicators', (req, res) => {
  const { asset, limit = 1000 } = req.query;
  if (!asset) return res.status(400).json({ error: 'asset required' });

  try {
    const indicators = db.prepare(`
      SELECT 
        timestamp,
        stochastic_k_v2,
        stochastic_d_v2,
        schaff_value,
        LAG(schaff_value, 1) OVER (ORDER BY timestamp) as prev_schaff_value,
        cci_8,
        bb_upper,
        bb_middle,
        bb_lower,
        CASE 
          WHEN bb_middle > 0 THEN ((bb_upper - bb_lower) / bb_middle) * 10000.0
          ELSE NULL 
        END as bb_width_bps
      FROM indicators 
      WHERE asset = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `).all(asset, parseInt(limit));
    res.json(indicators.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals', (req, res) => {
  const { asset, limit = 1000 } = req.query;
  if (!asset) return res.status(400).json({ error: 'asset required' });
  try {
    // Retrieve signals directly joined with trades for the asset
    const rows = db.prepare(`
      SELECT s.timestamp, s.direction, s.strategy_used,
             t.result, t.profit_loss
      FROM signals s
      LEFT JOIN trades_ordered t ON t.signal_id = s.id
      WHERE s.asset = ?
      ORDER BY s.timestamp ASC
    `).all(asset);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Dashboard running at http://localhost:${PORT}`);
});
