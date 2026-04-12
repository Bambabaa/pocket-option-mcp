import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool(
    'po_health',
    'Check connection to the Pocket Option bot SQLite database. Returns DB path, row counts, latest price timestamp, and whether the bot appears to be running.',
    {},
    async () => {
      try { return jsonResult(core.healthCheck()); }
      catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Ensure pocket-option-bot.js is running and PO_DB_PATH is correct.' }, true); }
    }
  );
}
