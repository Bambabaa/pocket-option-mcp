import { z } from 'zod';

// Schema for defining external strategy configurations.
// This allows agents to specify named strategies with their own parameter sets.
export const strategyConfigSchema = z.object({
  // The unique name of the strategy.
  name: z.string().describe('The unique name of the strategy (e.g., "KT_Video2_Aggressive")'),

  // A human-readable description of the strategy.
  description: z.string().optional().describe('A human-readable description of the strategy'),

  // Parameters specific to this strategy. This can be any object,
  // but ideally should conform to a more specific schema if known.
  parameters: z.record(z.string(), z.any()).default({}).describe('An object containing strategy-specific parameters. Example: {"rsi_threshold": 30, "k_crash_min": 20}')
});

// Example of how this schema could be used:
// const validConfig = strategyConfigSchema.parse({
//   name: "ExampleStrategy",
//   description: "An example strategy for testing.",
//   parameters: { "lookback_period": 14, "ma_type": "EMA" }
// });

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;
