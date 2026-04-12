/**
 * Writable SQLite database owned entirely by this MCP server.
 * Stores manual orders enqueued via po_trade and their outcomes.
 * The bot reads this DB to pick up PENDING orders and write results back.
 *
 * Path: <repo>/data/mcp.db  (created on first run)
 * Override: MCP_DB_PATH env var
 */

import sqlite3pkg from 'sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MCP_DB = resolve(__dirname, '../data/mcp.db');
export const MCP_DB_PATH = process.env.MCP_DB_PATH || DEFAULT_MCP_DB;

let _db = null;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function initSchema(db) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS mcp_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      asset        TEXT NOT NULL,
      direction    TEXT NOT NULL CHECK(direction IN ('CALL','PUT')),
      amount       REAL,
      signal_ts    INTEGER NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      status       TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK(status IN ('PENDING','EXECUTED','SKIPPED','FAILED','CANCELLED')),
      status_reason TEXT,
      updated_at   INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_orders_status ON mcp_orders(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mcp_orders_asset  ON mcp_orders(asset)`,
  ];
  for (const s of stmts) await run(db, s);
}

export async function getMcpDb() {
  if (_db) return _db;

  // Ensure data/ dir exists
  const dir = dirname(MCP_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(MCP_DB_PATH, (err) => {
      if (err) reject(new Error(`Failed to open MCP DB: ${err.message}`));
      else resolve(db);
    });
  });

  await run(_db, 'PRAGMA journal_mode = WAL');
  await run(_db, 'PRAGMA busy_timeout = 10000');
  await initSchema(_db);
  return _db;
}

export function mcpRun(sql, params = []) {
  return getMcpDb().then(db => run(db, sql, params));
}

export function mcpGet(sql, params = []) {
  return getMcpDb().then(db => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  }));
}

export function mcpAll(sql, params = []) {
  return getMcpDb().then(db => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  }));
}
