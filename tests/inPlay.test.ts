import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InPlayScanner, type Catalyst } from '../src/engine/inPlayScanner.js';
import { InPlayPolicy } from '../src/engine/inPlayPolicy.js';
import { InPlayRouter } from '../src/engine/inPlayRouter.js';
import { StrategyStateMachine } from '../src/engine/strategyStateMachine.js';
import { PaperBroker } from '../src/simulator/paperBroker.js';
import { configSchema } from '../src/config.js';
import { T, setup, signal, trade, warm, seed, refresh } from './helpers.js';

const news = (time: number, overrides: object = {}) => ({ _id: 'n1', source: 'Binance EN', time,
  title: 'Binance Lists TEST', body: 'New market', suggestions: [{ coin: 'TEST' }], ...overrides });
function scannerFixture() {
  const events: Catalyst[] = [], logs: { type: string; data: unknown }[] = [];
  const scanner = new InPlayScanner(new Set(['TESTUSDT']), e => events.push(e), (type, data) => logs.push({ type, data }));
  let id = 0;
  const send = (time: number, usd: number, price = 100, skip = 0) => {
    id += 1 + skip; scanner.trade({ e: 'aggTrade', s: 'TESTUSDT', a: id, T: time, p: String(price), q: String(usd / price) }, time);
  };
  return { scanner, events, logs, send };
}
function ready() {
  const f = scannerFixture();
  for (let s = 0; s < 1860; s++) for (let n = 0; n < 3; n++) f.send(T + s * 1000 + n * 100, 1000);
  const at = T + 1860000;
  f.scanner.news(news(at), at); f.send(at, 2020000, 101);
  return { ...f, at };
}

test('news requires publisher AND topic AND valid freshness; body mention is insufficient', () => {
  const f = scannerFixture();
  for (const overrides of [{ source: 'Twitter', body: 'Binance EN Lists TEST' }, { title: 'Security update' }, { time: undefined }, { time: T - 120001 }, { time: T + 5001 }]) f.scanner.news(news(T, overrides), T);
  assert.equal(f.events.length, 0); assert.equal(f.logs.length, 5);
  f.scanner.news(news(T), T); f.scanner.news(news(T), T + 1);
  assert.equal(f.events.length, 1); assert.equal(f.events[0]!.symbol, 'TESTUSDT');
  assert.equal(f.scanner.snapshot('TESTUSDT', T).eligible, false);
});

test('numeric seconds, ISO time and exchange suggestions resolve without coin field; older news cannot replace newest', () => {
  const f = scannerFixture();
  f.scanner.news(news(T, { time: T / 1000, suggestions: [{ symbols: [{ exchange: 'binance-futures', symbol: 'TEST_USDT' }] }] }), T);
  assert.equal(f.events.length, 1);
  f.scanner.news(news(T + 1000, { _id: 'newer', time: new Date(T + 1000).toISOString() }), T + 1000);
  f.scanner.news(news(T, { _id: 'older' }), T + 1001);
  assert.equal(f.scanner.snapshot('TESTUSDT', T + 1001).newsId, 'newer');
  f.scanner.news(news(T, { _id: 'unknown', suggestions: ['FAKE'] }), T + 1002);
  assert.equal(f.events.length, 2);
});

test('31m warmup, strict $1m boundary, baseline separation, duplicate and missing aggregate IDs', () => {
  const f = scannerFixture();
  for (let s = 0; s < 1860; s++) f.send(T + s * 1000, 1000);
  const at = T + 1860000;
  assert.equal(f.events.length, 0);
  f.send(at, 941000); assert.equal(f.events.length, 0);
  f.send(at, 1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0]!.details.volume60s, 1000001);
  assert.equal(f.events[0]!.details.previous30mMean, 60000);
  f.send(at + 1, 1); assert.equal(f.events.length, 1);
  f.send(at + 1000, 3000000, 100, 1);
  assert.equal(f.scanner.snapshot('TESTUSDT', at + 1000).warmed, false);
});

test('confirmed requires recent news, volume, tick frequency and actual price reaction', () => {
  const f = ready(), s = f.scanner.snapshot('TESTUSDT', f.at);
  assert.equal(s.eligible, true); assert.equal(s.side, 'buy');
  assert.ok(s.rvol >= 10); assert.ok(s.aggTicksPerSecond >= 2); assert.equal(s.newsId, 'n1');
  f.send(f.at + 1, 1, 100); assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 1).reason, 'PRICE_REACTION_UNCONFIRMED');
  f.send(f.at + 2, 1, 99); assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 2).side, 'sell');
});

test('a news label is insufficient; an empty baseline is undefined and sparse ticks are rejected', () => {
  const f = scannerFixture(), at = T + 1860000;
  f.scanner.news(news(T), T); f.send(T, 1000);
  assert.equal(f.scanner.snapshot('TESTUSDT', T).reason, 'RVOL_WARMUP');
  f.scanner.news(news(at, { _id: 'fresh' }), at); f.send(at, 3000000, 101);
  assert.equal(f.scanner.snapshot('TESTUSDT', at).reason, 'RVOL_BASE_UNDEFINED');
  const sparse = scannerFixture();
  for (let s = 0; s < 1860; s++) sparse.send(T + s * 1000, 1000);
  sparse.scanner.news(news(at), at); sparse.send(at, 3000000, 101);
  assert.equal(sparse.scanner.snapshot('TESTUSDT', at).reason, 'TICK_FREQUENCY_LOW');
});

test('RVOL candidate alone never authorizes entries; stale/reset/expired evidence revokes eligibility immediately', () => {
  const f = ready(); assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 2001).reason, 'SCANNER_STALE');
  f.scanner.reset(['TESTUSDT']); assert.equal(f.scanner.snapshot('TESTUSDT', f.at).eligible, false);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 900000).reason, 'NO_FRESH_NEWS');
  const volume = scannerFixture();
  for (let s = 0; s < 1860; s++) volume.send(T + s * 1000, 1000);
  volume.send(f.at, 3000000, 101);
  assert.equal(volume.events[0]!.mode, 'IN_PLAY_RVOL'); assert.equal(volume.scanner.snapshot('TESTUSDT', f.at).reason, 'NO_FRESH_NEWS');
});

test('sliding windows decay on clock advance; old RVOL events cannot keep eligibility alive', () => {
  const f = ready();
  for (let s = 1; s <= 60; s++) f.send(f.at + s * 1000, 1000, 101);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 60000).reason, 'VOLUME_UNCONFIRMED');
});

test('miniTicker 24h totals do not create volume; malformed, stale and repeated packets cannot revive eligibility', () => {
  const f = scannerFixture();
  f.scanner.mini([{ s: 'TESTUSDT', E: T, c: '100', q: '999999999' }, null], T);
  f.scanner.mini([{ s: 'TESTUSDT', E: T + 1000, c: '110', q: '99999999999' }], T + 1000);
  assert.ok(Math.abs(f.scanner.metrics('TESTUSDT').priceChange60s - .1) < 1e-10);
  assert.equal(f.events.length, 0);
  const r = ready();
  r.scanner.trade({ e: 'aggTrade', s: 'TESTUSDT', a: 99999, T: r.at, p: '1', q: '1' }, r.at + 10000);
  assert.equal(r.scanner.snapshot('TESTUSDT', r.at + 10000).warmed, false);
});

test('policy accepts only B in response direction, rejects wide spreads, inadequate range and opposing BTC', () => {
  const f = ready(), s = setup(); warm(s.manager, s.tape, f.at);
  const policy = new InPlayPolicy(s.c, f.scanner, s.manager, s.tape, () => {});
  const b = signal(f.at, { strategy: 'B', kind: 'taker', ticks: 10002 });
  assert.equal(policy.check('TESTUSDT', f.at, b).allowed, true);
  assert.equal(policy.check('TESTUSDT', f.at, signal(f.at)).reason, 'SETUP_NOT_ENABLED');
  assert.equal(policy.check('TESTUSDT', f.at, { ...b, side: 'sell' }).reason, 'REACTION_DIRECTION_MISMATCH');
  const tight = new InPlayPolicy(configSchema.parse({ inPlay: { minRangeCostRatio: 100 } }), f.scanner, s.manager, s.tape, () => {});
  assert.equal(tight.check('TESTUSDT', f.at, b).reason, 'RANGE_BELOW_COST_BUFFER');
  seed(s.manager, 'futures', 'TESTUSDT', f.at, 10000, 10030);
  assert.equal(policy.check('TESTUSDT', f.at, b).reason, 'SPREAD_TOO_WIDE');
  seed(s.manager, 'futures', 'TESTUSDT', f.at);
  s.tape.clear('futures', 'BTCUSDT'); s.tape.add(trade(f.at, 1, 10000, 10, 'sell', 'BTCUSDT'));
  assert.equal(policy.check('TESTUSDT', f.at, b).reason, 'BTC_OPPOSES');
});

test('application broker fails closed without policy; delayed taker entry cancelled if evidence expires before fill', () => {
  const f = ready(), s = setup(); warm(s.manager, s.tape, f.at);
  const b = signal(f.at, { strategy: 'B', kind: 'taker', ticks: 10002 });
  const missing = new PaperBroker(s.c, s.manager);
  assert.equal(missing.submit(b, f.at), false); assert.equal(missing.lastRejection, 'ENTRY_POLICY_MISSING');
  const policy = new InPlayPolicy(s.c, f.scanner, s.manager, s.tape, () => {});
  const broker = new PaperBroker(s.c, s.manager, () => {}, policy);
  assert.equal(broker.submit(b, f.at), true);
  f.scanner.reset(['TESTUSDT']); broker.onBook('TESTUSDT', f.at + 100);
  assert.equal(broker.orders.size, 0); assert.equal(broker.positions.size, 0);
});

test('open position survives catalyst loss; protective targets and time-stop continue', () => {
  const f = ready(), s = setup(); warm(s.manager, s.tape, f.at);
  const policy = new InPlayPolicy(s.c, f.scanner, s.manager, s.tape, () => {});
  const broker = new PaperBroker(s.c, s.manager, () => {}, policy);
  const strategy = new StrategyStateMachine(s.c, s.manager, s.tape, broker);
  assert.equal(broker.submit(signal(f.at, { strategy: 'B', kind: 'taker', ticks: 10002 }), f.at), true);
  broker.onBook('TESTUSDT', f.at + 100); assert.equal(broker.positions.size, 1);
  f.scanner.reset(['TESTUSDT']); strategy.evaluate('TESTUSDT', f.at + 200);
  assert.equal(broker.positions.get('TESTUSDT')!.exitReason, undefined);
  assert.ok([...broker.orders.values()].some(o => o.role === 'target'));
  const end = f.at + 100 + s.c.maxHoldMs;
  warm(s.manager, s.tape, end); broker.onBook('TESTUSDT', end);
  assert.equal(broker.positions.get('TESTUSDT')!.exitReason, 'TIME_STOP');
  broker.onBook('TESTUSDT', end + s.c.latencyMs); assert.equal(broker.positions.size, 0); assert.equal(broker.closedCount, 1);
});

test('startup symbols cannot emit without admission, and the default strategy does not evaluate A/C', () => {
  const s = setup(); warm(s.manager, s.tape, T);
  const broker = new PaperBroker(s.c, s.manager);
  const strategy = new StrategyStateMachine(s.c, s.manager, s.tape, broker);
  strategy.evaluate('TESTUSDT', T); assert.equal(strategy.states.get('TESTUSDT'), 'NOT_IN_PLAY'); assert.equal(strategy.signals, 0);
});

test('router waits for full confirmation, attaches once and records unsupported symbols without flooding', () => {
  const f = ready(), s = setup(), symbols: string[] = [], attached: string[] = [], logs: string[] = [];
  const catalog = [...s.manager.books.values()].map(b => b.instrument);
  const router = new InPlayRouter(symbols, catalog, f.scanner, symbol => attached.push(symbol), type => logs.push(type));
  router.update(f.at); router.update(f.at + 1);
  assert.deepEqual(attached, ['TESTUSDT']); assert.deepEqual(symbols, ['TESTUSDT']);
  const unsupported = new InPlayRouter([], [], f.scanner, () => assert.fail('must not attach'), type => logs.push(type));
  unsupported.update(f.at); unsupported.update(f.at + 1);
  assert.equal(logs.filter(x => x === 'IN_PLAY_UNROUTABLE').length, 1);
  const full = new InPlayRouter([], catalog, f.scanner, () => assert.fail('capacity'), () => {}, 0); full.update(f.at);
});

test('real B state machine trigger carries contemporaneous admission evidence into journal and order', () => {
  const f = ready(), s = setup(); const at = f.at;
  // Aged ask gets consumed by observed aggressive buys before the breakout entry.
  seed(s.manager, 'futures', 'TESTUSDT', at - 4000, 9997, 9999);
  refresh(s.manager, 'futures', 'TESTUSDT', at - 4000, [], [[9999, 100]]);
  refresh(s.manager, 'futures', 'TESTUSDT', at - 900);
  const wall = [...s.manager.walls.values()].find(w => w.ticks === 9999)!;
  assert.ok(wall?.verified);
  warm(s.manager, s.tape, at);
  s.tape.add(trade(at, 3, 9999, 85, 'buy'));
  s.manager.execution('futures', 'TESTUSDT', 9999, 85, 'buy');
  refresh(s.manager, 'futures', 'TESTUSDT', at, [], [[9999, 15]]);
  const log = (type: string, data: unknown) => s.events.push({ type, data });
  const policy = new InPlayPolicy(s.c, f.scanner, s.manager, s.tape, log);
  const broker = new PaperBroker(s.c, s.manager, log, policy);
  const strategy = new StrategyStateMachine(s.c, s.manager, s.tape, broker, log);
  strategy.evaluate('TESTUSDT', at);
  assert.equal(strategy.signals, 1); assert.equal(broker.orders.size, 1);
  assert.ok(s.events.some(e => e.type === 'ORDER_SUBMITTED' && (e.data as { inPlay?: unknown }).inPlay));
});

test('clock queries ahead of lagged trade timestamps do not discard required baseline buckets', () => {
  const f = ready(), at = f.at;
  f.scanner.snapshot('TESTUSDT', at + 1100);
  f.send(at + 200, 100, 101);
  assert.equal(f.scanner.snapshot('TESTUSDT', at + 200).previous30mMean, 180000);
  assert.equal(f.scanner.snapshot('TESTUSDT', at + 200).volume60s, 2197100);
});

test('expired news stays expired with fresh active market data, and a replacement catalyst cancels old pending orders', () => {
  const f = ready(), s = setup(); warm(s.manager, s.tape, f.at);
  const policy = new InPlayPolicy(s.c, f.scanner, s.manager, s.tape, () => {});
  const broker = new PaperBroker(s.c, s.manager, () => {}, policy);
  assert.equal(broker.submit(signal(f.at, { strategy: 'B', kind: 'taker', ticks: 10002 }), f.at), true);
  f.scanner.news(news(f.at + 10, { _id: 'replacement' }), f.at + 10);
  f.send(f.at + 20, 2000000, 102);
  broker.onBook('TESTUSDT', f.at + 100); assert.equal(broker.positions.size, 0); assert.equal(broker.orders.size, 0);
  f.send(f.at + 900010, 2000000, 103);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 900010).reason, 'NO_FRESH_NEWS');
});

test('default setup selection ignores an A wall even with an explicitly permissive fixture broker', () => {
  const s = setup(); seed(s.manager, 'futures', 'TESTUSDT', T, 10000, 10002, 100);
  s.manager.update('futures', 'TESTUSDT', T); refresh(s.manager, 'futures', 'TESTUSDT', T + 3001);
  warm(s.manager, s.tape, T + 3100);
  const strategy = new StrategyStateMachine(s.c, s.manager, s.tape, s.broker);
  strategy.evaluate('TESTUSDT', T + 3100); assert.equal(strategy.signals, 0);
  s.strategy.evaluate('TESTUSDT', T + 3100); assert.equal(s.strategy.signals, 1); // legacy fixture enables A
});

test('Upbit Korean/en listing with quote market list, Binance Futures perpetual launch, and official @handle news classify properly', () => {
  const events: Catalyst[] = [];
  const scanner = new InPlayScanner(new Set(['BTCUSDT', 'SANCUSDT', 'COLLECTUSDT', 'PEARLUSDT', 'TESTUSDT']), e => events.push(e));
  const upbitOutcome = scanner.news({
    _id: 'up1',
    source: 'Upbit',
    time: T,
    title: '생텀(SANC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
    en: 'Notice of New Trading Support for Sanctum (SANC) (KRW, BTC, USDT Markets)',
    suggestions: [{ coin: 'BTC', symbols: [{ exchange: 'binance-futures', symbol: 'BTCUSDT' }] }]
  }, T);
  assert.deepEqual(upbitOutcome, { accepted: 1, reason: 'NEWS_ACCEPTED' });
  assert.equal(scanner.snapshot('SANCUSDT', T).newsTopic, 'LISTING');
  assert.equal(scanner.snapshot('BTCUSDT', T).newsId, undefined);

  const futuresOutcome = scanner.news({
    _id: 'bf1',
    source: 'Binance EN',
    time: T,
    title: 'Binance Futures Will Launch COLLECTUSDT Perpetual Contract',
    suggestions: [{ coin: 'COLLECT' }]
  }, T);
  assert.deepEqual(futuresOutcome, { accepted: 1, reason: 'NEWS_ACCEPTED' });
  assert.equal(scanner.snapshot('COLLECTUSDT', T).newsTopic, 'LISTING');

  const twitterOutcome = scanner.news({
    _id: 'cb1',
    source: '',
    time: T,
    title: 'Coinbase Assets 🛡️ (@CoinbaseAssets)',
    body: 'Spot trading for PEARL will go live on 12 November 2026.',
    suggestions: [{ coin: 'PEARL' }]
  }, T);
  assert.deepEqual(twitterOutcome, { accepted: 1, reason: 'NEWS_ACCEPTED' });
  assert.equal(scanner.snapshot('PEARLUSDT', T).newsSource, '@CoinbaseAssets');

  const delistOutcome = scanner.news({
    _id: 'del1',
    source: 'Upbit',
    time: T,
    title: '거래지원 종료 안내 (TEST)',
    en: 'Notice of End of Trading Support for TEST',
    suggestions: [{ coin: 'TEST' }]
  }, T);
  assert.equal(delistOutcome.accepted, 0);
  assert.equal(delistOutcome.reason, 'NEWS_TOPIC_UNCLASSIFIED');
});

test('reconnect preserves 31m RVOL warmup across brief disconnect and resets on >60s disconnect', () => {
  const f = ready();
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at).warmed, true);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at).eligible, true);

  f.scanner.reconnect(['TESTUSDT'], f.at + 100);
  f.send(f.at + 600, 1000, 101, 5);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 600).warmed, true);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 600).eligible, true);

  f.scanner.reconnect(['TESTUSDT'], f.at + 1000);
  f.send(f.at + 62000, 1000, 101, 5);
  assert.equal(f.scanner.snapshot('TESTUSDT', f.at + 62000).warmed, false);
});
