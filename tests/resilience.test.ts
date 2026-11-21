import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceWs } from '../src/connectors/binanceWs.js';
import { CatalystWs } from '../src/connectors/catalystWs.js';
import { TreeDecoder } from '../src/connectors/treeDecoder.js';
import { InPlayScanner } from '../src/engine/inPlayScanner.js';
import { errorDetails, transientNetworkError } from '../src/diagnostics.js';
import { RuntimeState } from '../src/operations.js';
import { now } from '../src/journal.js';
import { setup, T } from './helpers.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Tree distinguishes control/non-JSON/unknown/news and retains bounded raw packets and filter outcome', () => {
  const events: { type: string; data: unknown }[] = [];
  const log = (type: string, data: unknown) => events.push({ type, data });
  const scanner = new InPlayScanner(new Set(['BTCUSDT']), e => log(e.mode, e));
  const decoder = new TreeDecoder((raw, time) => scanner.news(raw, time), log);
  decoder.handle('pong', T); decoder.handle(JSON.stringify({ status: 'connected' }), T);
  decoder.handle('[]', T);
  const packet = { id: 'a', source: 'Binance EN', time: T, title: 'Binance Lists BTC', suggestions: [{ coin: 'BTC' }] };
  decoder.handle(JSON.stringify({ data: packet }), T);
  decoder.handle(JSON.stringify(packet), T + 1);
  decoder.handle(JSON.stringify({ ...packet, id: 'b', source: 'unknown' }), T + 2);
  decoder.handle('x'.repeat(20000), T + 3);
  assert.equal(events.filter(e => e.type === 'IN_PLAY_NEWS').length, 1);
  const status = decoder.status() as { counts: Record<string, number>; lastNewsReceived: number };
  assert.equal(status.counts.NEWS_ACCEPTED, 1); assert.equal(status.counts.NEWS_DUPLICATE, 1);
  assert.equal(status.counts.NEWS_SOURCE_UNVERIFIED, 1); assert.equal(status.counts.CONTROL, 1);
  assert.equal(status.counts.NEWS_NEAR_CANDIDATE, 1);
  assert.equal(status.counts.UNRECOGNIZED, 1); assert.equal(status.counts.NON_JSON, 2);
  const lastRaw = events.filter(e => e.type === 'TREE_RAW_PACKET').at(-1)!.data as { text: string; truncated: boolean };
  assert.equal(lastRaw.text.length, 16384); assert.equal(lastRaw.truncated, true);
});

test('Tree business callback errors propagate rather than becoming parse errors', () => {
  const decoder = new TreeDecoder(() => { throw new Error('CALLBACK_FAULT'); }, () => {});
  assert.throws(() => decoder.handle('{"title":"news"}', T), /CALLBACK_FAULT/);
});

test('error record preserves stack, nested network code and AggregateError; only network faults are recoverable', () => {
  const dns = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' });
  const outer = new TypeError('fetch failed', { cause: dns });
  const record = errorDetails(outer);
  assert.equal((record.cause as { code: string }).code, 'ENOTFOUND'); assert.ok(record.stack);
  assert.equal(transientNetworkError(outer), true);
  assert.equal(transientNetworkError(new Error('RATE_LIMIT 429')), false);
  assert.equal(transientNetworkError(new Error('invalid instrument')), false);
  assert.ok(errorDetails(new AggregateError([dns], 'multiple')).errors);
});

type Wire = { depth: (market: 'futures', raw: unknown, received: number) => void; states: Map<string, { retryAt: number }> };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('transient snapshot DNS failure invalidates only that book, retries locally, and leaves scanner process alive', async () => {
  const s = setup(), events: { type: string; data: unknown }[] = [], fatal: unknown[] = [];
  let attempts = 0;
  const connector = new BinanceWs(s.manager, [...s.manager.books.values()].map(b => b.instrument), {
    depth: () => {}, trade: () => {}, invalid: () => {}, log: (type, data) => events.push({ type, data }), fatal: e => fatal.push(e)
  }, async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS'), { code: 'ENOTFOUND' }) });
    return { lastUpdateId: 10, bids: Array.from({ length: 60 }, (_, n) => [(100 - n * .01).toFixed(2), '1']),
      asks: Array.from({ length: 60 }, (_, n) => [(100.02 + n * .01).toFixed(2), '1']) };
  });
  const wire = connector as unknown as Wire;
  const raw = { e: 'depthUpdate', s: 'TESTUSDT', E: now(), U: 10, u: 11, pu: 9, b: [], a: [] };
  try {
    wire.depth('futures', raw, now()); await tick();
    assert.equal(fatal.length, 0); assert.equal(s.manager.book('futures', 'TESTUSDT').synced, false);
    assert.equal(s.manager.book('futures', 'BTCUSDT').synced, true);
    assert.equal(events.filter(e => e.type === 'SNAPSHOT_RETRY').length, 1);
    wire.depth('futures', raw, now()); await tick(); assert.equal(attempts, 1); // cooldown suppresses request storms
    wire.states.get('futures:TESTUSDT')!.retryAt = 0; // expire cooldown without a five-second unit-test wait
    wire.depth('futures', raw, now()); await tick();
    assert.equal(attempts, 2); assert.equal(s.manager.book('futures', 'TESTUSDT').synced, true);
    assert.equal(fatal.length, 0);
  } finally { connector.stop(); }
});

test('snapshot rate limit is preserved as fatal, never blindly retried', async () => {
  const s = setup(), fatal: unknown[] = [];
  const connector = new BinanceWs(s.manager, [...s.manager.books.values()].map(b => b.instrument), {
    depth: () => {}, trade: () => {}, invalid: () => {}, log: () => {}, fatal: e => fatal.push(e)
  }, async () => { throw new Error('RATE_LIMIT 429'); });
  try {
    (connector as unknown as Wire).depth('futures', { e: 'depthUpdate', s: 'TESTUSDT', E: now(), U: 10, u: 11, pu: 9, b: [], a: [] }, now());
    await tick(); assert.equal(fatal.length, 1); assert.match(String(fatal[0]), /RATE_LIMIT/);
  } finally { connector.stop(); }
});

test('fatal history appends across RuntimeState instances instead of overwriting previous failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'masa2-fatal-'));
  try {
    new RuntimeState(directory).failure({ stage: 'FIRST', error: errorDetails(new Error('one')) });
    new RuntimeState(directory).failure({ stage: 'SECOND', error: errorDetails(new Error('two')) });
    const rows = readFileSync(join(directory, 'fatal-history.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    assert.equal(rows.length, 2); assert.equal(rows[0].stage, 'FIRST'); assert.equal(rows[1].error.message, 'two');
  } finally {
    const target = resolve(directory); assert.ok(target.toLowerCase().startsWith((resolve(tmpdir()) + '\\masa2-fatal-').toLowerCase()));
    rmSync(target, { recursive: true });
  }
});

test('terminating connecting sockets does not write asynchronous errors after journal shutdown', async () => {
  const s = setup(), logs: string[] = [], fatal: unknown[] = [];
  const connector = new BinanceWs(s.manager, [...s.manager.books.values()].map(b => b.instrument), {
    depth: () => {}, trade: () => {}, invalid: () => {}, log: type => logs.push(type), fatal: error => fatal.push(error)
  });
  (connector as unknown as { connect: (...args: unknown[]) => void }).connect('futures', ['trade'], 'ws://127.0.0.1:1', ['TESTUSDT']);
  connector.stop();
  const scanner = new InPlayScanner(new Set(['TESTUSDT']), () => {});
  const catalyst = new CatalystWs(scanner, ['TESTUSDT'], type => logs.push(type), e => fatal.push(e));
  (catalyst as unknown as { connect: (...args: unknown[]) => void }).connect('tree', 'ws://127.0.0.1:1', () => {}, []);
  catalyst.stop();
  const before = logs.length; await tick();
  assert.equal(logs.length, before); assert.equal(fatal.length, 0);
});
