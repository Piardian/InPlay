import { readFileSync } from 'node:fs';
import { z } from 'zod';
const positive = z.number().finite().positive();
export const configSchema = z.object({
  mode: z.enum(['paper', 'signal']).default('paper'),
  headless: z.boolean().default(false), runtimeDir: z.string().optional(),
  inPlay: z.object({
    newsTtlMs: positive.default(900000), maxNewsAgeMs: positive.default(120000),
    minVolumeUsd: positive.default(1000000), minRvol: positive.default(10),
    minReactionBps: positive.default(10), minAggTicksPerSecond: positive.default(2),
    maxSpreadBps: positive.default(10), minRangeCostRatio: positive.default(2),
    allowRvolCatalyst: z.boolean().default(false), rvolTtlMs: positive.default(300000)
  }).strict().default(() => ({ newsTtlMs: 900000, maxNewsAgeMs: 120000, minVolumeUsd: 1000000, minRvol: 10,
    minReactionBps: 10, minAggTicksPerSecond: 2, maxSpreadBps: 10, minRangeCostRatio: 2, allowRvolCatalyst: false, rvolTtlMs: 300000 })),
  symbols: z.array(z.string().regex(/^[A-Z0-9]+USDT$/)).max(15).default([]),
  symbolCount: z.number().int().min(1).max(15).default(15),
  levels: z.number().int().min(20).max(50).default(50),
  densityRatio: positive.default(12), wallAgeMs: positive.default(3000),
  nearPct: positive.default(0.0015), engagePct: positive.default(0.0005), crossPct: positive.default(0.0015),
  spoofDrop: z.number().min(0).max(1).default(0.3), blacklistMs: positive.default(60000),
  panicRemaining: z.number().min(0).max(1).default(0.35), breakRemaining: z.number().min(0).max(1).default(0.18),
  bounceAttackRatio: positive.default(0.15), breakAttackRatioPerSec: positive.default(0.2),
  absorptionRatio: positive.default(15), slowdownRatio: z.number().min(0).max(1).default(0.6),
  minConfidence: z.union([z.literal(0.5), z.literal(1)]).default(0.5),
  btcMovePct: positive.default(0.0003), btcDeltaRatio: z.number().min(0).max(1).default(0.6),
  setups: z.array(z.enum(['A', 'B', 'C'])).default(['B']),
  staleMs: positive.default(2000), maxEventLagMs: positive.default(2000), warmupMs: positive.default(10000),
  latencyMs: z.number().int().min(1).default(100), queueMultiplier: z.number().min(1).default(1.2),
  makerFee: z.number().min(0).max(0.01).default(0.0002), takerFee: z.number().min(0).max(0.01).default(0.0004),
  slippageTicks: z.number().int().min(0).default(1), initialEquity: positive.default(10000),
  riskUsd: positive.default(5), maxNotional: positive.default(500), maxGrossNotional: positive.default(1500),
  maxPositions: z.number().int().min(1).max(15).default(3), maxDailyLoss: positive.default(50),
  targetTicks: z.number().int().min(5).max(10).default(8), requireCostCoverage: z.boolean().default(true),
  minTargetBps: positive.default(15), minStopBps: positive.default(5),
  entryTtlMs: positive.default(3000), maxHoldMs: positive.default(15000), cooldownMs: positive.default(5000),
  maxSpreadTicks: z.number().int().positive().default(10), logDir: z.string().default('logs'),
  record: z.boolean().default(false), dashboardMs: positive.default(1000)
}).strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(): Config {
  const at = process.argv.indexOf('--config');
  if (at >= 0 && !process.argv[at + 1]) throw new Error('--config requires a JSON file');
  return configSchema.parse(at >= 0 ? JSON.parse(readFileSync(process.argv[at + 1]!, 'utf8')) : {});
}
