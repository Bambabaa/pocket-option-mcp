const fs = require('fs');

const data = fs.readFileSync('data/edgefinder_ALL.csv', 'utf-8');
const lines = data.split('\n');

let totalSignals = 0;
let totalWins2m = 0;
let totalLosses2m = 0;

let highDeltaSignals = 0;
let highDeltaWins2m = 0;
let highDeltaLosses2m = 0;

console.log("--- High Velocity Jumps (|Delta| > 10) Examples ---");
let examplesShown = 0;

for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 30) continue;

    const symbol = parts[1];
    const action = parts[2];
    const stc = parseFloat(parts[12]);
    const stcPrev = parseFloat(parts[13]);
    const stcDelta = parseFloat(parts[14]);
    const win2m = parts[26].trim();

    if (win2m === '1' || win2m === '0') {
        totalSignals++;
        if (win2m === '1') totalWins2m++;
        else totalLosses2m++;
        
        // Show the top 20 jumps regardless of delta size
        if (examplesShown < 20 && (symbol === 'EURRUB_otc' || symbol === 'USDPKR_otc')) {
            console.log(`[${symbol}] ${action} | Prev STC: ${stcPrev.toFixed(1)} -> Current STC: ${stc.toFixed(1)} | Delta: ${stcDelta.toFixed(1)} | 2m Win: ${win2m === '1' ? 'YES' : 'NO'}`);
            examplesShown++;
        }

        if (Math.abs(stcDelta) > 1.5) {
            highDeltaSignals++;
            if (win2m === '1') highDeltaWins2m++;
            else highDeltaLosses2m++;
        }
    }
}

console.log("\n--- OVERALL PERFORMANCE COMPARISON ---");

const totalWinRate = totalSignals > 0 ? ((totalWins2m / totalSignals) * 100).toFixed(1) : 0;
console.log(`ALL SIGNALS (No Velocity Filter)`);
console.log(`Total: ${totalSignals} | Win Rate: ${totalWinRate}% (${totalWins2m} W / ${totalLosses2m} L)`);

const highDeltaWinRate = highDeltaSignals > 0 ? ((highDeltaWins2m / highDeltaSignals) * 100).toFixed(1) : 0;
console.log(`\nFILTERED VELOCITY (|Delta| > 1.5)`);
console.log(`Total: ${highDeltaSignals} | Win Rate: ${highDeltaWinRate}% (${highDeltaWins2m} W / ${highDeltaLosses2m} L)`);

console.log(`\nFiltered Out: ${totalSignals - highDeltaSignals} weak 'Death Grind' setups.`);
