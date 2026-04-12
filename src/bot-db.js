/**
 * Read-only connection to the bot's SQLite database (pocket-option-bot.js).
 * This file NEVER writes. All mutations go through mcp-db.js instead.
 *
 * Default path: <repo>/data/trading_data.db
 * The bot must be configured to write to this same path.
 * Override: PO_DB_PATH env var (only needed if you move the data dir)
 */

import sqlite3pkg from 'sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_BOT_DB = resolve(__dirname, '../data/trading_data.db');
export const BOT_DB_PATH = process.env.PO_DB_PATH || DEFAULT_BOT_DB;

let _db = null;

function getBotDb() {
  if (_db) return _db;
  if (!existsSync(BOT_DB_PATH)) {
    throw new Error(
      `Bot DB not found at: ${BOT_DB_PATH}\n` +
      `Ensure pocket-option-bot.js is configured to write to this path and has run at least once.\n` +
      `Override with PO_DB_PATH env var if needed.`
    );
  }
  _db = new sqlite3.Database(BOT_DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) throw new Error(`Failed to open bot DB: ${err.message}`);
  });
  return _db;
}

export function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getBotDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getBotDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}
