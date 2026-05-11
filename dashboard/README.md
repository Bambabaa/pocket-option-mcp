# Pocket Option Bot Dashboard

This dashboard is a powerful visualization and strategy refinement tool for the Pocket Option automated trading bot. It allows you to monitor live indicator data, replay historical price action, and test new strategy rules using the interactive "Edge Finder."

## Features

### 1. Multi-Panel Visualization
- **Price Chart**: Real-time OHLC candles with Bollinger Bands.
- **Indicators**: Dedicated panels for Schaff Trend Cycle (STC), Stochastic Oscillator, and CCI.
- **Signal Markers**: Trade entries are automatically plotted on the chart (Green/Red/Gray).

### 2. Candle Replay Mode
- Scrub through thousands of historical candles using a time-slider.
- Play/Pause functionality with adjustable speed (0.5x to 4x).
- Perfect synchronization between the price action and all indicator panels.

### 3. Interactive Edge Finder (Simulator)
The Edge Finder is a **zero-latency frontend simulator** that allows you to test "what-if" scenarios:
- **BB Pierce Logic**: Require the price to physically touch outer bands before entering.
- **Lookback Tolerance**: Allow indicators to align over a window of N candles (Asynchronous Confluence).
- **Stoch Zone Escape**: Require a crossover in the extreme zone followed by a confirmation in the neutral zone.
- **Scoreboard**: Instantly compare how many signals your new settings generate vs. historical performance.

## Getting Started

### Prerequisites
- Node.js installed.
- The bot's SQLite database must exist at `../data/trading_data.db`.

### Installation & Run
1. Navigate to the dashboard directory:
   ```bash
   cd dashboard
   ```
2. Install dependencies (if not already installed):
   ```bash
   npm install express better-sqlite3
   ```
3. Start the dashboard server:
   ```bash
   node server.js
   ```
4. Open your browser and go to:
   [http://localhost:3000](http://localhost:3000)

## API Endpoints

The server exposes several JSON endpoints for data retrieval:

| Endpoint | Description |
| :--- | :--- |
| `GET /api/assets` | Returns a list of all assets currently in the database. |
| `GET /api/candles` | Returns OHLC data for a specific asset. |
| `GET /api/indicators` | Returns computed indicators (STC, Stoch, CCI, BB). |
| `GET /api/signals` | Returns trade signals and their outcomes (WIN/LOSS). |

## Simulation Logic & Conditions

The Edge Finder uses the following mathematical conditions to generate simulated signals:

### 1. Bollinger Band Pierce (Gate 1)
- **CALL**: Checks if `Candle.Low <= BB.Lower` within the lookback window.
- **PUT**: Checks if `Candle.High >= BB.Upper` within the lookback window.
- *Replaces the static BB Width (BPS) check for better reversal accuracy.*

### 2. Stochastic Oscillator (Gate 2)
- **Divergence**: Checks if `|K - D| > Divergence Gap`.
- **Overbought/Oversold (O/U)**: 
  - **CALL**: `K <= (100 - O/U Threshold)` (e.g., K < 20).
  - **PUT**: `K >= O/U Threshold` (e.g., K > 80).
- **Zone Escape**: 
  - Requires a crossover to happen while Stochastic is in the **Extreme Zone**.
  - Requires the current candle to be in the **Neutral Zone** (between the O/U bounds).

### 3. Trend & Momentum (Gates 3 & 4)
- **CCI**: Checks if `|CCI| > Magnitude Threshold`.
- **STC (Schaff Trend Cycle)**: 
  - **CALL Trigger**: `Prev STC <= Call Threshold` AND `Current STC >= Prev STC`.
  - **PUT Trigger**: `Prev STC >= Put Threshold` AND `Current STC <= Prev STC`.

### 4. Asynchronous Confluence (Lookback Tolerance)
- If **Lookback Tolerance > 0**, the simulator doesn't require all gates to fire on the same candle.
- It sweeps the last `N` candles to see if each condition was met *at least once*.
- The signal only fires on the *current* candle if the final piece of the confluence puzzle is met, ensuring a "reactional" entry.

## Technology Stack
- **Backend**: Node.js, Express, better-sqlite3.
- **Frontend**: Vanilla Javascript, CSS Grid, [LightweightCharts](https://tradingview.github.io/lightweight-charts/).
- **Simulation Logic**: Purely client-side for instantaneous feedback.
