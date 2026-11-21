import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type JournalEvent } from '../src/researchReport.js';
const event = (type: string, data: Record<string, unknown>): JournalEvent => ({ at: 1000, type, data });
const rules = event('RESEARCH_RULES', { version: 'crypto-inplay-v2' });
test('report separates closed net and fees, tracks missing evidence and never labels returns proven', () => {
  const r = summarize([rules, event('TRADE_CLOSED', { net: 5, fees: 2, inPlay: { newsId: 'n' } }),
    event('TRADE_CLOSED', { net: -3, fees: 1 }), event('ORDER_CANCELLED', { reason: 'NEWS_EXPIRED' }),
    event('SESSION_END', { equity: 10002, unresolved: [] })]);
  assert.equal(r.netClosedUsd, 2); assert.equal(r.feesClosedUsd, 3); assert.equal(r.winRate, .5);
  assert.equal(r.profitFactor, 5 / 3); assert.equal(r.missingEntryEvidence, 1);
  assert.equal(r.status, 'RESEARCH_ONLY_NO_EDGE_PROOF'); assert.equal(r.completeSession, true);
});
test('no-trade or incomplete session is not reported as a success; mixed and corrupt data fail', () => {
  const r = summarize([rules]); assert.equal(r.meanNetUsd, null); assert.equal(r.completeSession, false);
  assert.throws(() => summarize([rules, rules]), /mix/);
  assert.throws(() => summarize([rules, event('TRADE_CLOSED', { net: NaN, fees: 1 })]), /Invalid/);
});
