#!/usr/bin/env node
/**
 * po — Pocket Option MCP CLI
 *
 * Wraps every MCP tool as a plain shell command.
 * Output is newline-delimited JSON — pipe to `jq` for filtering.
 *
 * Usage:  node src/cli/index.js <command> [options]
 *    or:  po <command> [options]   (after npm link)
 *
 * Run `po help` for the full command list.
 * Run `po help <command>` for per-command usage.
 */

import * as health from '../core/health.js';
import * as data from '../core/data.js';
import * as assets from '../core/assets.js';
import * as orders from '../core/orders.js';
import * as validation from '../core/validation.js';
import * as perf from '../core/performance.js';

// ─── Output helpers ──────────────────────────────────────────────────────────

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

// ─── Arg parser ──────────────────────────────────────────────────────────────
// Supports --key=value and --key value and bare positional args.

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { flags, positional };
}

function num(val, fallback) {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) die(`expected a number, got: ${val}`);
  return n;
}

function bool(val, fallback) {
  if (val === undefined || val === null) return fallback;
  if (val === true || val === 'true' || val === '1') return true;
  if (val === false || val === 'false' || val === '0') return false;
  die(`expected true/false, got: ${val}`);
}

// ─── Command definitions ─────────────────────────────────────────────────────

const COMMANDS = {

  // ── Health ──────────────────────────────────────────────────────────────────
  health: {
    desc: 'Check bot DB connection and liveness',
    usage: 'po health',
    run: async () => print(await health.healthCheck()),
  },

  // ── Market data ─────────────────────────────────────────────────────────────
  assets: {
    desc: 'List all assets the bot has candle data for',
    usage: 'po assets',
    run: async () => print(await data.listTrackedAssets()),
  },

  prices: {
    desc: 'Latest price(s). Omit --asset for all.',
    usage: 'po prices [--asset EURUSD_otc]',
    run: async ({ flags }) => print(await data.getPrices(flags.asset || null)),
  },

  candles: {
    desc: 'OHLC candle bars for an asset',
    usage: 'po candles --asset EURUSD_otc [--limit 100] [--summary]',
    run: async ({ flags }) => {
      if (!flags.asset) die('--asset is required');
      print(await data.getCandles(flags.asset, num(flags.limit, 100), bool(flags.summary, false)));
    },
  },

  'price-history': {
    desc: 'Tick-level price history over a time range',
    usage: 'po price-history --asset EURUSD_otc --from 1700000000 --to 1700003600 [--limit 500]',
    run: async ({ flags }) => {
      if (!flags.asset) die('--asset is required');
      if (!flags.from) die('--from is required (unix seconds)');
      if (!flags.to) die('--to is required (unix seconds)');
      print(await data.getPriceHistory(flags.asset, num(flags.from), num(flags.to), num(flags.limit, 500)));
    },
  },

  indicators: {
    desc: 'Latest indicator values for an asset (MA, RSI, BB, Stoch, Keltner, Schaff)',
    usage: 'po indicators --asset EURUSD_otc [--limit 1]',
    run: async ({ flags }) => {
      if (!flags.asset) die('--asset is required');
      print(await data.getIndicators(flags.asset, num(flags.limit, 1)));
    },
  },

  signals: {
    desc: 'Recent CALL/PUT signals from the  strategy',
    usage: 'po signals [--asset EURUSD_otc] [--direction CALL|PUT] [--limit 20]',
    run: async ({ flags }) => {
      const dir = flags.direction ? flags.direction.toUpperCase() : null;
      if (dir && dir !== 'CALL' && dir !== 'PUT') die('--direction must be CALL or PUT');
      print(await data.getSignals(flags.asset || null, num(flags.limit, 20), dir));
    },
  },

  // ── Qualification ────────────────────────────────────────────────────────────
  qualified: {
    desc: 'Assets on the bot trading allow-list (2+ consecutive wins)',
    usage: 'po qualified',
    run: async () => print(await assets.getQualifiedAssets()),
  },

  streaks: {
    desc: 'Current consecutive win streak per asset',
    usage: 'po streaks [--asset EURUSD_otc]',
    run: async ({ flags }) => print(await assets.getAssetStreaks(flags.asset || null)),
  },

  leaderboard: {
    desc: 'Rank assets by active win streak',
    usage: 'po leaderboard [--min-wins 1]',
    run: async ({ flags }) => print(await validation.getStreakLeaderboard(num(flags['min-wins'], 1))),
  },

  outcomes: {
    desc: 'Signal validation history (entry/exit price, WIN/LOSS per signal)',
    usage: 'po outcomes [--asset EURUSD_otc] [--limit 50]',
    run: async ({ flags }) => print(await assets.getSignalOutcomes(flags.asset || null, num(flags.limit, 50))),
  },

  'asset-trades': {
    desc: 'Trade outcomes for qualified assets only',
    usage: 'po asset-trades [--asset EURUSD_otc] [--limit 50]',
    run: async ({ flags }) => print(await assets.getAssetTrades(flags.asset || null, num(flags.limit, 50))),
  },

  'validation-stats': {
    desc: 'Aggregate win rate and P/L from signal_outcomes',
    usage: 'po validation-stats [--asset EURUSD_otc]',
    run: async ({ flags }) => print(await validation.getValidationStats(flags.asset || null)),
  },

  'pending-signals': {
    desc: 'Signals past expiry with no validation outcome yet',
    usage: 'po pending-signals [--expiry 60] [--limit 50]',
    run: async ({ flags }) => print(await validation.getPendingSignals(num(flags.expiry, 60), num(flags.limit, 50))),
  },

  // ── Orders ───────────────────────────────────────────────────────────────────
  'bot-orders': {
    desc: "Bot's execution queue (readonly)",
    usage: 'po bot-orders [--status PENDING|EXECUTED|SKIPPED|FAILED] [--limit 50]',
    run: async ({ flags }) => print(await orders.getOrders(flags.status || null, num(flags.limit, 50))),
  },

  'mcp-orders': {
    desc: 'Manual orders you placed via `po trade`',
    usage: 'po mcp-orders [--status PENDING|EXECUTED|CANCELLED|FAILED] [--limit 50]',
    run: async ({ flags }) => print(await orders.getMcpOrders(flags.status || null, num(flags.limit, 50))),
  },

  trade: {
    desc: 'Enqueue a manual CALL or PUT trade (writes to MCP DB, bot executes it)',
    usage: 'po trade --asset EURUSD_otc --direction CALL [--amount 100]',
    run: async ({ flags }) => {
      if (!flags.asset) die('--asset is required');
      if (!flags.direction) die('--direction is required (CALL or PUT)');
      const dir = flags.direction.toUpperCase();
      if (dir !== 'CALL' && dir !== 'PUT') die('--direction must be CALL or PUT');
      const ts = Math.floor(Date.now() / 1000);
      print(await orders.enqueueManualTrade(flags.asset, dir, ts, flags.amount ? num(flags.amount) : null));
    },
  },

  cancel: {
    desc: 'Cancel a PENDING manual order by ID',
    usage: 'po cancel --id 42',
    run: async ({ flags }) => {
      if (!flags.id) die('--id is required');
      print(await orders.cancelOrder(num(flags.id)));
    },
  },

  // ── Results ──────────────────────────────────────────────────────────────────
  trades: {
    desc: 'Executed live trades with WIN/LOSS results',
    usage: 'po trades [--asset EURUSD_otc] [--result WIN|LOSS|DRAW] [--limit 50]',
    run: async ({ flags }) => {
      const res = flags.result ? flags.result.toUpperCase() : null;
      print(await orders.getTradesOrdered(flags.asset || null, res, num(flags.limit, 50)));
    },
  },

  pnl: {
    desc: 'P/L summary broken down by asset',
    usage: 'po pnl',
    run: async () => print(await orders.getPnlSummary()),
  },

  // ── Performance ──────────────────────────────────────────────────────────────
  summary: {
    desc: 'Rolling win rate, P/L, ROI. Use --days 0 for all-time.',
    usage: 'po summary [--days 7]',
    run: async ({ flags }) => print(await perf.getRollingSummary(num(flags.days, 7))),
  },

  performance: {
    desc: 'Daily performance records',
    usage: 'po performance [--days 30]',
    run: async ({ flags }) => print(await perf.getDailyPerformance(num(flags.days, 30))),
  },

  hourly: {
    desc: 'Trade distribution and P/L by hour of day (UTC)',
    usage: 'po hourly',
    run: async () => print(await perf.getHourlyBreakdown()),
  },

};

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(cmd) {
  if (cmd && COMMANDS[cmd]) {
    const c = COMMANDS[cmd];
    process.stdout.write(`${cmd}\n  ${c.desc}\n\nUsage:\n  ${c.usage}\n`);
    return;
  }

  const maxLen = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  process.stdout.write('po — Pocket Option MCP CLI\n\n');
  process.stdout.write('Usage:\n  po <command> [options]\n\n');
  process.stdout.write('Commands:\n');

  const sections = [
    ['Health', ['health']],
    ['Market data', ['assets', 'prices', 'candles', 'price-history', 'indicators', 'signals']],
    ['Qualification', ['qualified', 'streaks', 'leaderboard', 'outcomes', 'asset-trades', 'validation-stats', 'pending-signals']],
    ['Orders', ['bot-orders', 'mcp-orders', 'trade', 'cancel']],
    ['Results', ['trades', 'pnl']],
    ['Performance', ['summary', 'performance', 'hourly']],
  ];

  for (const [section, cmds] of sections) {
    process.stdout.write(`\n  ${section}:\n`);
    for (const name of cmds) {
      const desc = COMMANDS[name]?.desc ?? '';
      process.stdout.write(`    ${name.padEnd(maxLen + 2)}${desc}\n`);
    }
  }

  process.stdout.write('\nRun `po help <command>` for usage details.\n');
  process.stdout.write('\nAll output is JSON. Pipe to jq for filtering:\n');
  process.stdout.write('  po signals | jq \'.signals[] | select(.direction=="CALL")\'\n');
  process.stdout.write('  po trades --result WIN | jq \'.trades[] | .asset\'\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const cmd = positional[0];

if (!cmd || cmd === 'help') {
  printHelp(positional[1]);
  process.exit(0);
}

if (!COMMANDS[cmd]) {
  die(`unknown command: ${cmd}\nRun \`po help\` to see available commands.`);
}

COMMANDS[cmd].run({ flags, positional: positional.slice(1) }).catch(err => {
  die(err.message);
});
