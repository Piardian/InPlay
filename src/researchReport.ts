import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface JournalEvent { at: number; type: string; data: Record<string, unknown> }
export function summarize(events: JournalEvent[]) {
  const rules = events.filter(e => e.type === 'RESEARCH_RULES');
  if (rules.length !== 1 || rules[0]!.data.version !== 'crypto-inplay-v2') throw new Error('Expected one v2 session; do not mix rules or sessions');
  const trades = events.filter(e => e.type === 'TRADE_CLOSED');
  let net = 0, fees = 0, wins = 0, profits = 0, losses = 0;
  for (const { data } of trades) {
    if (typeof data.net !== 'number' || typeof data.fees !== 'number' || !Number.isFinite(data.net) || !Number.isFinite(data.fees)) throw new Error('Invalid trade accounting');
    net += data.net; fees += data.fees;
    if (data.net > 0) { wins++; profits += data.net; } else losses -= data.net;
  }
  const decisionReasons: Record<string, number> = {}, rejectionReasons: Record<string, number> = {};
  const candidates = { news: 0, rvol: 0 }, counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'IN_PLAY_NEWS') candidates.news++;
    if (e.type === 'IN_PLAY_RVOL') candidates.rvol++;
    if (e.type === 'IN_PLAY_DECISION') { const key = String(e.data.reason); decisionReasons[key] = (decisionReasons[key] ?? 0) + 1; }
    if (['ORDER_REJECTED', 'ORDER_CANCELLED', 'NEWS_REJECTED', 'ENTRY_BLOCKED', 'IN_PLAY_UNROUTABLE'].includes(e.type)) {
      const key = `${e.type}:${String(e.data.reason)}`; rejectionReasons[key] = (rejectionReasons[key] ?? 0) + 1;
    }
  }
  const end = events.filter(e => e.type === 'SESSION_END');
  return {
    ruleVersion: 'crypto-inplay-v2', status: 'RESEARCH_ONLY_NO_EDGE_PROOF',
    accounting: 'paper fills; configured fees and slippage; no broker reconciliation or funding model',
    completeSession: end.length === 1, end: end.at(-1)?.data ?? null,
    candidates, submitted: counts.ORDER_SUBMITTED ?? 0, signals: counts.SIGNAL ?? 0,
    closed: trades.length, netClosedUsd: net, feesClosedUsd: fees,
    winRate: trades.length ? wins / trades.length : null,
    meanNetUsd: trades.length ? net / trades.length : null,
    profitFactor: losses > 0 ? profits / losses : null,
    missingEntryEvidence: trades.filter(t => !t.data.inPlay).length,
    decisionReasons, rejectionReasons,
    notes: ['Decision counts are transition/5s observations, not independent samples or time shares.',
      'Closed PnL excludes unresolved positions; inspect end.equity and end.unresolved.',
      'Zero trades do not mean zero edge. This report cannot establish profitability.']
  };
}
function main(): void {
  const at = process.argv.indexOf('--session'), out = process.argv.indexOf('--out');
  if (at < 0 || !process.argv[at + 1]) throw new Error('Usage: npm run report -- --session logs/<session> [--out report.json]');
  if (out >= 0 && !process.argv[out + 1]) throw new Error('--out requires a filename');
  const content = readFileSync(join(resolve(process.argv[at + 1]!), 'events.jsonl'), 'utf8');
  const events: JournalEvent[] = content.split(/\r?\n/).filter(l => l.trim()).map((line, n) => {
    const e = JSON.parse(line) as JournalEvent;
    if (!e || typeof e.type !== 'string' || !Number.isFinite(e.at) || !e.data || typeof e.data !== 'object') throw new Error(`Invalid event line ${n + 1}`);
    return e;
  });
  const output = JSON.stringify(summarize(events), null, 2) + '\n';
  if (out >= 0) writeFileSync(resolve(process.argv[out + 1]!), output, { flag: 'wx' });
  process.stdout.write(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
