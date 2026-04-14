const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/trading_data.db');

async function review() {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

    const query = (sql) => new Promise((resolve, reject) => {
        db.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        // Row counts
        const tables = ['candles', 'indicators', 'signals', 'trades', 'prices', 'performance', 'signal_outcomes', 'orders_queue', 'trades_ordered'];
        console.log('=== ROW COUNTS ===');
        for (const t of tables) {
            const rows = await query(`SELECT COUNT(*) as cnt FROM ${t}`);
            console.log(`  ${t.padEnd(20)} ${rows[0].cnt} rows`);
        }

        // Recent signals
        console.log('\n=== RECENT SIGNALS (last 5) ===');
        const signals = await query('SELECT id, asset, direction, strategy_used as strategy, timestamp, created_at FROM signals ORDER BY id DESC LIMIT 5');
        signals.forEach(s => {
            console.log(`  [${s.id}] ${s.asset} ${s.direction} | ${s.strategy} | ts=${s.timestamp}`);
        });

        // Recent trades
        console.log('\n=== RECENT TRADES (last 5) ===');
        const trades = await query('SELECT * FROM trades ORDER BY id DESC LIMIT 5');
        trades.forEach(t => {
            console.log(`  [${t.id}] ${t.asset} ${t.direction} | result=${t.result} | profit=${t.profit}`);
        });

        // Signal outcomes
        console.log('\n=== SIGNAL OUTCOMES (last 5) ===');
        const outcomes = await query('SELECT * FROM signal_outcomes ORDER BY id DESC LIMIT 5');
        outcomes.forEach(o => {
            console.log(`  [${o.id}] signal_id=${o.signal_id} | result=${o.result}`);
        });

        // Orders queue
        console.log('\n=== ORDERS QUEUE (recent) ===');
        const orders = await query('SELECT * FROM orders_queue ORDER BY id DESC LIMIT 10');
        orders.forEach(o => {
            console.log(`  [${o.id}] ${o.asset} ${o.direction} | ${o.status} | ${o.status_reason || ''}`);
        });

        // Assets in candles
        console.log('\n=== ASSETS WITH DATA ===');
        const assets = await query('SELECT DISTINCT asset FROM candles ORDER BY asset');
        assets.forEach(a => console.log(`  ${a.asset}`));

        // Price data
        console.log('\n=== PRICES (last 3) ===');
        const prices = await query('SELECT * FROM prices ORDER BY id DESC LIMIT 3');
        prices.forEach(p => console.log(`  ${p.asset} | ${p.price} | ts=${p.timestamp}`));

        // Trades ordered (live trades)
        console.log('\n=== TRADES_ORDERED (recent live trades) ===');
        const tradesOrdered = await query('SELECT * FROM trades_ordered ORDER BY id DESC LIMIT 5');
        tradesOrdered.forEach(t => {
            console.log(`  [${t.id}] ${t.asset} ${t.direction} | amount=${t.amount} | status=${t.status}`);
        });

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        db.close();
    }
}

review();
