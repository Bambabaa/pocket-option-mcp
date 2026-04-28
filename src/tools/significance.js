import { z } from 'zod';
import { jsonResult } from './_format.js';
import { significanceTests } from '../core/significance.js';

export function registerSignificanceTools(server) {
  server.tool(
    'po_significance',
    'Binomial significance test — proves whether the STC reversal strategy\'s win rates are statistically different from random (50%). Tests H0: WR=50% for every slice of replay data: overall, CALL vs PUT, per-asset, per STC entry zone (0-10, 10-20, 20-25 for CALL; 75-85, 85-95, 95-100 for PUT), and per hour of day. Returns p-value, z-score, Wilson 95% CI, verdict (SIGNIFICANT_99 / SIGNIFICANT_95 / MARGINAL_90 / NOT_SIGNIFICANT / NO_EDGE), Kelly fraction, and required_n to reach significance if not yet there. Also tests live executed trades from trades_ordered.',
    {},
    async () => {
      try { return jsonResult(significanceTests()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
