# Model Context Protocol (MCP) Implementation Overview

This document provides an overview of the Model Context Protocol (MCP) implementation within this project, which facilitates interaction with the Pocket Option trading platform for automated trading and data analysis.

## 1. Introduction

The MCP system acts as an interface layer, enabling external agents (like the Gemini CLI or Claude) to interact with a trading bot. It provides tools for querying market data, analyzing performance, and enqueuing trades, all while the bot handles real-time data collection, signal generation, and trade execution.

## 2. Architecture Overview

The system operates with a clear separation of concerns, primarily consisting of an **MCP Server** and a **Trading Bot**. Communication and data persistence are managed through two SQLite databases: `mcp.db` (shared for inter-process communication) and `trading_data.db` (internal to the bot).

```mermaid
graph TD
    A[External Agent/CLI] -->|`po_` commands| B(MCP Server)
    B -->|Writes manual orders| C(mcp.db - Shared DB)
    C -->|Polls for orders| D(Trading Bot)
    D -->|Executes trades| E(Pocket Option Platform)
    E -->|Real-time data (WebSocket)| D
    D -->|Writes market data, indicators, trades| F(trading_data.db - Bot Internal DB)
    B -->|Reads data| F
    D -->|Updates order status| C
```

## 3. Core Components

*   **MCP Server (`src/server.js`):**
    *   Acts as the control plane for the entire system.
    *   Initializes using `@modelcontextprotocol/sdk`.
    *   Registers numerous `po_` tools (e.g., `po_trade`, `po_candles`, `po_health`) that allow external agents to interact with the bot's data and functionality.
    *   Reads data from both `mcp.db` and `trading_data.db`.

*   **Trading Bot (`bot/pocket-option-bot.js`):**
    *   The core automation engine responsible for live interaction with Pocket Option.
    *   Uses Puppeteer for browser automation and WebSocket interception for real-time market data.
    *   Processes incoming data, calculates technical indicators (`bot/indicators.js`), generates trading signals (based on "ML leaf" patterns from the "KT Strategy").
    *   Executes trades and manages its internal state.
    *   Includes an "MCP Orders Worker" that polls `mcp.db` for pending manual orders, executes them, and updates their status.

*   **MCP Database (`mcp.db` - managed by `src/mcp-db.js`):**
    *   A shared SQLite database serving as the primary IPC mechanism between the Server and the Bot.
    *   Stores:
        *   `mcp_orders`: Manual trade requests enqueued by the server.
        *   `asset_controls`: Rules for blocking trading on specific assets.
        *   `agent_session_log`: Audit trail for agent decisions.
    *   Writable by the server (for order creation, asset blocking) and read/write by the bot (for order execution updates).

*   **Bot's Internal Database (`trading_data.db` - managed by `bot/database.js`):**
    *   The bot's comprehensive data store.
    *   Defines schemas and handles CRUD operations for:
        *   `candles`: OHLC data.
        *   `prices`: Real-time tick data.
        *   `indicators`: Calculated technical indicators.
        *   `signals`: Generated trading signals.
        *   `orders_queue`: Internal bot-generated orders.
        *   `trades_ordered`: Records of executed trades.
    *   Provides read-only access to the MCP Server via `src/bot-db.js` and `src/connection.js`.

*   **Indicators (`bot/indicators.js`):**
    *   Contains the logic for calculating various technical indicators (e.g., MA, RSI, Bollinger Bands, Stochastic) and generating trading signals based on the "KT Strategy" and "ML leaf" patterns.

## 4. Data Flow

1.  **Manual Order Initiation:** An external agent (e.g., via `po_trade` CLI command) sends a trade request to the MCP Server.
2.  **Server to `mcp.db`:** The MCP Server writes the manual order to the `mcp_orders` table in `mcp.db`.
3.  **Bot Consumes Order:** The Trading Bot's "MCP Orders Worker" continuously polls `mcp.db` for `PENDING` orders.
4.  **Trade Execution:** Upon finding a pending order, the bot executes the trade on the Pocket Option platform via Puppeteer.
5.  **Market Data Ingestion:** The bot intercepts WebSocket messages from Pocket Option, extracting real-time market data (prices, candles).
6.  **Bot to `trading_data.db`:** The bot processes this data, calculates indicators, generates signals, and stores all operational data into `trading_data.db`.
7.  **Bot Updates `mcp.db`:** After executing a manual order, the bot updates the `mcp_orders` table in `mcp.db` with the execution status (e.g., `EXECUTED`, `FAILED`).
8.  **Server Data Access:** The MCP Server's tools can query `trading_data.db` (read-only) for analysis and reporting, accessing the bot's collected data.

## 5. Key Technologies

*   **Node.js:** Backend runtime environment.
*   **Puppeteer:** Headless browser automation for interacting with Pocket Option UI and intercepting WebSockets.
*   **SQLite:** Lightweight, file-based database for both shared (mcp.db) and bot-internal (trading_data.db) data.
*   **`@modelcontextprotocol/sdk`:** Framework for building the MCP Server and its `po_` tools.
*   **ES Modules / CommonJS:** Mixed module system.

## 6. Identified Areas for Improvement (Redundancy Focus)

During the codebase investigation, several areas of redundancy and potential inefficiency were identified, particularly concerning database interactions:

*   **`mcp.db` Schema Definition Duplication:** The schema for `mcp_orders`, `asset_controls`, and `agent_session_log` is defined in both `src/mcp-db.js` and `bot/database.js`. This creates a maintenance burden and increases the risk of inconsistencies if schema changes are not applied uniformly. `src/mcp-db.js` is the intended canonical source.

*   **`mcp.db` Access Logic Duplication:** Functions for connecting to `mcp.db` and performing queries (`getMcpDb`, `mcpAll`, `mcpRun`) are implemented redundantly in `bot/pocket-option-bot.js`, mirroring the functionality already exposed by `src/mcp-db.js`. This is a direct violation of the DRY (Don't Repeat Yourself) principle.

*   **Architectural Friction (`shimDb`):** The presence of a `shimDb` in `bot/pocket-option-bot.js` to reconcile `executeOneOrder` with `mcp_orders` indicates a lack of a unified order management abstraction. This workaround suggests that a more generic `OrderRepository` interface or a more consistent approach to order handling across different database tables could simplify the architecture.

## 7. Conclusion

The MCP implementation provides a functional framework for interacting with Pocket Option. However, the identified redundancies, especially in database schema definition and access logic, present opportunities for refactoring to enhance maintainability, reduce potential bugs, and streamline future development. Centralizing these duplicated elements within `src/mcp-db.js` and ensuring other modules consistently consume them would lead to a more robust and coherent system.
