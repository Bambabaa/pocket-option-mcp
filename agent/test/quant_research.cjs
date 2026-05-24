'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { processAssetData } = require('./quant_features.cjs');

const dbPath = path.join(__dirname, '..', 'data', 'agent_hist.db');
const reportPath = path.join(__dirname, '..', 'data', 'quant_research_report.md');

if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database file does not exist at ${dbPath}`);
    process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
    SELECT c.asset, c.timestamp, c.open, c.high, c.low, c.close,
           i.sma_10, i.sma_20, i.sma_50, i.ema_12, i.ema_26, i.rsi_14,
           i.bb_width_bps, i.stoch_k, i.stoch_d, i.stc_value, i.stc_delta,
           i.adx, i.atr_14
    FROM candles c
    JOIN indicators i ON c.asset = i.asset AND c.timestamp = i.timestamp
    ORDER BY c.asset, c.timestamp ASC
`).all();

console.log(`Loaded ${rows.length} raw records from database.`);

// Group and engineer features
const assetGroups = {};
for (const row of rows) {
    if (!assetGroups[row.asset]) assetGroups[row.asset] = [];
    assetGroups[row.asset].push(row);
}

const EXPIRIES = [
    { label: '5m', bars: 1 },
    { label: '10m', bars: 2 },
    { label: '15m', bars: 3 }
];

const SETUPS = [
    {
        name: 'Liquidity Sweep Reversal (CALL)',
        direction: 'CALL',
        condition: (r) => r.feat_sweep_below_low === true && r.feat_body_percent > 0.5
    },
    {
        name: 'Liquidity Sweep Reversal (PUT)',
        direction: 'PUT',
        condition: (r) => r.feat_sweep_above_high === true && r.feat_body_percent > 0.5
    },
    {
        name: 'Volatility Exhaustion (CALL)',
        direction: 'CALL',
        condition: (r) => r.feat_z_score < -2.5 && r.feat_regime === 'EXHAUSTION'
    },
    {
        name: 'Volatility Exhaustion (PUT)',
        direction: 'PUT',
        condition: (r) => r.feat_z_score > 2.5 && r.feat_regime === 'EXHAUSTION'
    }
];

// Initialize Stats Tracker
const stats = {};
for (const setup of SETUPS) {
    stats[setup.name] = {};
    const regimes = ['TRENDING', 'RANGING', 'COMPRESSION', 'VOLATILITY_EXPANSION', 'EXHAUSTION', 'NORMAL', 'UNKNOWN'];
    for (const regime of regimes) {
        stats[setup.name][regime] = {
            'IS': {}, 'OOS': {}
        };
        for (const exp of EXPIRIES) {
            stats[setup.name][regime]['IS'][exp.label] = { trades: [], wins: 0, losses: 0, draws: 0 };
            stats[setup.name][regime]['OOS'][exp.label] = { trades: [], wins: 0, losses: 0, draws: 0 };
        }
    }
}

// Execution
const assets = Object.keys(assetGroups);
for (const asset of assets) {
    let list = assetGroups[asset];
    list = processAssetData(list); // Apply feature engineering
    
    const splitIndex = Math.floor(list.length * 0.7); // 70% IS, 30% OOS

    for (let i = 20; i < list.length - 3; i++) { // Skip lookback and lookahead
        const row = list[i];
        const isOOS = i >= splitIndex;
        const sampleType = isOOS ? 'OOS' : 'IS';
        const regime = row.feat_regime || 'UNKNOWN';

        const entryPrice = row.close;

        for (const setup of SETUPS) {
            if (setup.condition(row)) {
                for (const exp of EXPIRIES) {
                    const exitRow = list[i + exp.bars];
                    const exitPrice = exitRow.close;
                    
                    let mae = 0;
                    let mfe = 0;
                    
                    // Calculate MAE / MFE over the holding period
                    let minPrice = Infinity;
                    let maxPrice = -Infinity;
                    for (let j = 1; j <= exp.bars; j++) {
                        const wRow = list[i + j];
                        if (wRow.low < minPrice) minPrice = wRow.low;
                        if (wRow.high > maxPrice) maxPrice = wRow.high;
                    }

                    let pnl = 0;
                    if (setup.direction === 'CALL') {
                        pnl = exitPrice - entryPrice;
                        mae = minPrice - entryPrice;
                        mfe = maxPrice - entryPrice;
                    } else {
                        pnl = entryPrice - exitPrice;
                        mae = entryPrice - maxPrice;
                        mfe = entryPrice - minPrice;
                    }

                    const tracker = stats[setup.name][regime][sampleType][exp.label];
                    tracker.trades.push({ pnl, mae, mfe });

                    if (pnl > 0) tracker.wins++;
                    else if (pnl < 0) tracker.losses++;
                    else tracker.draws++;
                }
            }
        }
    }
}

function calculateMetrics(tracker) {
    const total = tracker.wins + tracker.losses + tracker.draws;
    if (total === 0) return null;
    
    const wr = (tracker.wins / (tracker.wins + tracker.losses)) * 100;
    
    let sumPnl = 0, sumMae = 0, sumMfe = 0;
    const pnls = [];
    for (const t of tracker.trades) {
        sumPnl += t.pnl;
        sumMae += t.mae;
        sumMfe += t.mfe;
        pnls.push(t.pnl);
    }
    
    pnls.sort((a, b) => a - b);
    const medianPnl = pnls[Math.floor(pnls.length / 2)];
    
    const avgPnl = sumPnl / total;
    const avgMae = sumMae / total;
    const avgMfe = sumMfe / total;

    // Standard deviation
    let sqDiff = 0;
    for (const p of pnls) sqDiff += Math.pow(p - avgPnl, 2);
    const stdDev = Math.sqrt(sqDiff / total);

    return { total, wr, avgPnl, medianPnl, stdDev, avgMae, avgMfe };
}

// Generate Report
let reportMd = `# Quantitative Reversal Research Report

**Date:** ${new Date().toISOString().split('T')[0]}  
**Database:** \`agent_hist.db\`  
**Total Dataset Size:** ${rows.length} rows  
**Methodology:** 70% In-Sample / 30% Out-of-Sample chronological split.

---

`;

let validSetupsCount = 0;

for (const setup of SETUPS) {
    let setupHasData = false;
    let setupReport = `## Setup Name: ${setup.name}\n\n`;
    
    const regimes = ['TRENDING', 'RANGING', 'COMPRESSION', 'VOLATILITY_EXPANSION', 'EXHAUSTION', 'NORMAL'];
    
    for (const regime of regimes) {
        let regimeHasData = false;
        let regimeReport = `### Market Regime: ${regime}\n\n`;
        regimeReport += `| Expiry | Sample | N | Win Rate | Expectancy (Avg Move) | Median Move | Std Dev | Avg MAE | Avg MFE |\n`;
        regimeReport += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

        for (const exp of EXPIRIES) {
            const isMetrics = calculateMetrics(stats[setup.name][regime]['IS'][exp.label]);
            const oosMetrics = calculateMetrics(stats[setup.name][regime]['OOS'][exp.label]);

            if (isMetrics && isMetrics.total > 0) {
                regimeHasData = true;
                setupHasData = true;
                regimeReport += `| ${exp.label} | IS | ${isMetrics.total} | ${isMetrics.wr.toFixed(1)}% | ${isMetrics.avgPnl.toFixed(5)} | ${isMetrics.medianPnl.toFixed(5)} | ${isMetrics.stdDev.toFixed(5)} | ${isMetrics.avgMae.toFixed(5)} | ${isMetrics.avgMfe.toFixed(5)} |\n`;
            }
            if (oosMetrics && oosMetrics.total > 0) {
                regimeReport += `| ${exp.label} | OOS | ${oosMetrics.total} | ${oosMetrics.wr.toFixed(1)}% | ${oosMetrics.avgPnl.toFixed(5)} | ${oosMetrics.medianPnl.toFixed(5)} | ${oosMetrics.stdDev.toFixed(5)} | ${oosMetrics.avgMae.toFixed(5)} | ${oosMetrics.avgMfe.toFixed(5)} |\n`;
            }
        }
        
        if (regimeHasData) {
            setupReport += regimeReport + '\n';
        }
    }
    
    if (setupHasData) {
        reportMd += setupReport;
        validSetupsCount++;
    }
}

if (validSetupsCount === 0) {
    reportMd += "\nNo setups generated sufficient data for analysis.\n";
}

fs.writeFileSync(reportPath, reportMd, 'utf8');
console.log(`\nQuantitative analysis complete. Report saved to ${reportPath}`);
console.log(`Evaluated ${validSetupsCount} setups across multiple regimes.`);

db.close();
