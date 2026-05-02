// Add cci_8 column to indicators table
// Usage: node bot/scripts/add-cci-column.js [path/to/db]
//        defaults to data/trading_data.db relative to repo root.

const path = require('path');
const { TradingDatabase } = require('../database');

const DB_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'trading_data.db');

(async () => {
    const db = new TradingDatabase(DB_PATH);
    await db.initialize();

    console.log('Adding cci_8 column to indicators table...');

    try {
        // Check if column already exists
        const columns = await db.all('PRAGMA table_info(indicators)');
        const hasColumn = columns.some(c => c.name === 'cci_8');

        if (hasColumn) {
            console.log('✓ Column cci_8 already exists');
        } else {
            await db.run('ALTER TABLE indicators ADD COLUMN cci_8 REAL');
            console.log('✓ Column cci_8 added successfully');
        }

        // Verify
        const finalColumns = await db.all('PRAGMA table_info(indicators)');
        const verified = finalColumns.some(c => c.name === 'cci_8');
        
        if (verified) {
            console.log('✓ Verified: cci_8 column exists');
        } else {
            throw new Error('Column verification failed');
        }

    } catch (err) {
        console.error('Error adding column:', err);
        process.exit(1);
    }

    await db.close();
    console.log('Done.');
})();
