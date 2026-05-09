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
    const assets = db.prepare('SELECT DISTINCT asset FROM candles ORDER BY asset').all();
    res.json(assets.map(a => a.asset));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/candles', (req, res) => {
  const { asset, limit = 150 } = req.query;
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
  const { asset, limit = 150 } = req.query;
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

app.listen(PORT, () => {
  console.log(`✅ Dashboard running at http://localhost:${PORT}`);
});
