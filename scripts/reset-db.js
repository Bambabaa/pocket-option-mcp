/**
 * reset-db.js — Complete database reset for pocket-option-mcp.
 *
 * Usage:
 *   node scripts/reset-db.js              ← dry run (shows what would happen)
 *   node scripts/reset-db.js --confirm    ← actually delete + recreate
 *   node scripts/reset-db.js --mcp-only   ← reset mcp.db only (safe, fast)
 *
 * ALWAYS backs up existing DBs to data/backup/ before deleting.
 */

import { existsSync, mkdirSync, copyFileSync, rmSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../data');
const BACKUP_DIR = resolve(DATA_DIR, 'backup');

const BOT_DB = resolve(DATA_DIR, 'trading_data.db');
const MCP_DB = resolve(DATA_DIR, 'mcp.db');

const args = process.argv.slice(2);
const isConfirm = args.includes('--confirm');
const isMcpOnly = args.includes('--mcp-only');

function log(msg) { console.log(`[reset-db] ${msg}`); }
function warn(msg) { console.warn(`[reset-db] ⚠  ${msg}`); }
function ok(msg) { console.log(`[reset-db] ✓ ${msg}`); }

function size(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fileExists(path) {
  return existsSync(path);
}

function getFileSize(path) {
  try { return require('fs').statSync(path).size; } catch { return 0; }
}

async function backup(path) {
  if (!fileExists(path)) return null;
  const name = require('path').basename(path);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(BACKUP_DIR, `${name}.${timestamp}.bak`);
  copyFileSync(path, backupPath);
  return backupPath;
}

async function resetMcpDb() {
  log('Resetting mcp.db...');

  if (fileExists(MCP_DB)) {
    const backupPath = await backup(MCP_DB);
    ok(`Backed up mcp.db → ${backupPath} (${size(getFileSize(MCP_DB))})`);
    rmSync(MCP_DB);
    ok('Deleted mcp.db');
  } else {
    log('mcp.db does not exist — nothing to reset');
  }

  log('mcp.db will be recreated automatically when the MCP server starts.');
}

async function resetBotDb() {
  log('Resetting trading_data.db...');

  if (fileExists(BOT_DB)) {
    const backupPath = await backup(BOT_DB);
    ok(`Backed up trading_data.db → ${backupPath} (${size(getFileSize(BOT_DB))})`);
    rmSync(BOT_DB);
    ok('Deleted trading_data.db');
  } else {
    log('trading_data.db does not exist — nothing to reset');
  }

  warn('The bot (pocket-option-bot.js) must be running to rebuild this database.');
  warn('It will re-scrape all assets from scratch — this takes hours.');
}

async function main() {
  log('Pocket Option MCP — Database Reset');
  log('─'.repeat(50));

  // Ensure backup dir exists
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    log(`Created backup directory: ${BACKUP_DIR}`);
  }

  // Show current state
  log('Current databases:');
  if (fileExists(BOT_DB)) {
    log(`  trading_data.db: ${size(getFileSize(BOT_DB))}`);
  } else {
    log('  trading_data.db: does not exist');
  }
  if (fileExists(MCP_DB)) {
    log(`  mcp.db:          ${size(getFileSize(MCP_DB))}`);
  } else {
    log('  mcp.db:          does not exist');
  }
  log('');

  if (!isConfirm && !isMcpOnly) {
    log('DRY RUN — no files will be modified.');
    log('');
    log('To actually reset, run one of:');
    log('  node scripts/reset-db.js --confirm    ← reset BOTH databases');
    log('  node scripts/reset-db.js --mcp-only   ← reset mcp.db only (safe)');
    log('');
    log('What this does:');
    log('  1. Backs up existing DBs to data/backup/');
    log('  2. Deletes the DB files');
    log('  3. mcp.db → auto-recreated on MCP server start');
    log('  4. trading_data.db → rebuilt by bot from scratch (takes hours)');
    return;
  }

  if (isMcpOnly) {
    await resetMcpDb();
    log('');
    log('Done. Start the MCP server to recreate mcp.db.');
    return;
  }

  // Full reset
  warn('FULL RESET — this will delete BOTH databases.');
  warn('The bot must rebuild trading_data.db from scratch.');
  log('');

  await resetMcpDb();
  log('');
  await resetBotDb();

  log('');
  log('─'.repeat(50));
  log('Next steps:');
  log('  1. Start pocket-option-bot.js → it will rebuild trading_data.db');
  log('  2. Start MCP server → it will recreate mcp.db');
  log('  3. Run po_health to confirm both DBs are accessible');
  log('');
  log('Backups are in: data/backup/');
}

main().catch(err => {
  console.error('[reset-db] FATAL:', err);
  process.exit(1);
});
