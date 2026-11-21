import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalOrderBook } from '../src/engine/orderBookManager.js';
import { TapeAnalyzer } from '../src/engine/tapeAnalyzer.js';
import { configSchema } from '../src/config.js';
import { T, setup, seed, refresh, trade, signal, warm } from './helpers.js';

test('spot snapshot bridge, duplicate discard, gap fails closed, zeros delete', () => {
  const b = new LocalOrderBook({ symbol: 'X', market: 'spot', tick: 0.01, step: 1, minQty: 1, minNotional: 1 });
  b.snapshot({ last: 100, bids: [[100, 1], [99, 2]], asks: [[102, 1]] });
  const d = { market: 'spot' as const, symbol: 'X', first: 99, last: 102, time: T, received: T, bids: [[99, 0] as [number, number]], asks: [] };
  assert.equal(b.apply(d), 'ok'); assert.equal(b.qty('bid', 99), 0); assert.equal(b.apply(d), 'old');
  assert.equal(b.apply({ ...d, first: 104, last: 104 }), 'gap'); assert.equal(b.synced, false);
});
test('futures bridge includes snapshot ID and requires subsequent pu chain', () => {
  const { manager } = setup(), b = manager.book('futures', 'TESTUSDT');
  b.snapshot({ last: 100, bids: [[10000, 1]], asks: [[10002, 1]] });
  const d = { market: 'futures' as const, symbol: 'TESTUSDT', first: 99, last: 100, previous: 98, bids: [], asks: [], time: T, received: T };
  assert.equal(b.apply(d), 'ok');
  assert.equal(b.apply({ ...d, first: 101, last: 102, previous: 100 }), 'ok');
  assert.equal(b.apply({ ...d, first: 103, last: 104, previous: 101 }), 'gap');
});
test('density requires age; execution-supported depletion differs from spoof heuristic', () => {
  const { manager } = setup(); seed(manager, 'futures', 'TESTUSDT', T, 10000, 10002, 100);
  manager.update('futures', 'TESTUSDT', T); const w = [...manager.walls.values()][0]!;
  assert.equal(w.verified, false); refresh(manager, 'futures', 'TESTUSDT', T + 3001); assert.equal(w.verified, true);
  manager.execution('futures', 'TESTUSDT', 9999, 85, 'sell');
  refresh(manager, 'futures', 'TESTUSDT', T + 3100, [[9999, 15]]); assert.equal(w.spoof, false);
  const other = setup(); seed(other.manager, 'futures', 'TESTUSDT', T, 10000, 10002, 100); other.manager.update('futures', 'TESTUSDT', T);
  refresh(other.manager, 'futures', 'TESTUSDT', T + 100, [[9999, 50]]); assert.equal(other.manager.spoofCount, 1);
  refresh(other.manager, 'futures', 'TESTUSDT', T + 61000, [[9999, 100]]);
  assert.equal([...other.manager.walls.values()][0]!.spoof, false);
});
test('wall outside top 50 is forgotten without claiming spoof', () => {
  const { manager } = setup(); seed(manager, 'futures', 'TESTUSDT', T, 10000, 10100, 100); manager.update('futures', 'TESTUSDT', T);
  refresh(manager, 'futures', 'TESTUSDT', T + 100, Array.from({ length: 50 }, (_, n) => [10050 - n, 1]));
  assert.equal(manager.spoofCount, 0); assert.equal(manager.walls.size, 0);
});
test('tape direction, deduplication, gaps, window expiry, bounded overload', () => {
  const c = configSchema.parse({ warmupMs: 1 }), t = new TapeAnalyzer(c, 3);
  assert.equal(t.add(trade(T, 1, 100, 2, 'buy')), 'ok'); assert.equal(t.add(trade(T, 1)), 'duplicate');
  t.add(trade(T + 1, 2, 100, 1, 'sell')); assert.equal(t.pressure('futures', 'TESTUSDT', 1, T + 2).delta, 1 / 3);
  assert.equal(t.add(trade(T + 2, 4)), 'gap'); assert.equal(t.healthy('futures', 'TESTUSDT', T + 2), false);
  t.add(trade(T + 3, 5)); t.add(trade(T + 4, 6)); assert.equal(t.add(trade(T + 5, 7)), 'overflow');
  assert.equal(t.trades('futures', 'TESTUSDT', T + 20000, 10000).length, 0);
});
test('maker waits for latency and queue volume; cancellations cannot advance queue', () => {
  const { broker, manager } = setup({ queueMultiplier: 1 }); assert.equal(broker.submit(signal(), T), true);
  broker.onBook('TESTUSDT', T + 100);
  broker.onTrade(trade(T + 99, 1, 10000, 100)); assert.equal(broker.positions.size, 0);
  refresh(manager, 'futures', 'TESTUSDT', T + 150, [[10000, 0.1]]);
  broker.onTrade(trade(T + 200, 2, 10000, 0.5)); assert.equal(broker.positions.size, 0);
  broker.onTrade(trade(T + 201, 3, 10000, 0.7)); assert.ok(Math.abs(broker.positions.get('TESTUSDT')!.qty - 0.2) < 1e-8);
});
test('net PnL charges maker entry and depth-walk taker exit plus adverse tick', () => {
  const { broker } = setup({ queueMultiplier: 1 }); broker.submit(signal(), T); broker.onBook('TESTUSDT', T + 100);
  broker.onTrade(trade(T + 200, 1, 10000, 100)); const p = broker.positions.get('TESTUSDT')!, qty = p.qty;
  assert.ok(qty > 1); broker.exit('TESTUSDT', T + 300, 'TEST'); broker.onBook('TESTUSDT', T + 399); assert.equal(broker.closedCount, 0);
  broker.onBook('TESTUSDT', T + 400); assert.equal(broker.closedCount, 1);
  const closed = broker.closed[0]!;
  assert.ok(closed.exit < 100); assert.ok(closed.fees > qty * 100 * 0.0002);
  assert.ok(Math.abs(closed.net - ((closed.exit - closed.entry) * qty - closed.fees)) < 1e-8);
  assert.ok(Math.abs(broker.realized - closed.net) < 1e-8);
});
test('post-only rejects crossing both at submission and arrival', () => {
  const { broker, manager } = setup(); assert.equal(broker.submit(signal(T, { ticks: 10002 }), T), false);
  assert.equal(broker.submit(signal(), T), true);
  seed(manager, 'futures', 'TESTUSDT', T + 100, 9998, 10000); broker.onBook('TESTUSDT', T + 100);
  assert.equal(broker.orders.size, 0); assert.equal(broker.positions.size, 0);
});
test('cost gate and total exposure reservation reject uneconomic or excess orders', () => {
  const s = setup({ requireCostCoverage: true }); assert.equal(s.broker.submit(signal(T, { targetTicks: 5 }), T), false); assert.equal(s.broker.lastRejection, 'target_below_cost');
  const p = setup({ maxPositions: 1 }); assert.equal(p.broker.submit(signal(), T), true);
  assert.equal(p.broker.submit(signal(T, { symbol: 'BTCUSDT' }), T), false); assert.equal(p.broker.lastRejection, 'max_positions');
});
test('maker targets require real tape volume, partial entry has immediate protection', () => {
  const { broker, manager } = setup({ queueMultiplier: 1 }); broker.submit(signal(), T); broker.onBook('TESTUSDT', T + 100);
  broker.onTrade(trade(T + 200, 1, 10000, 2)); assert.equal(broker.positions.get('TESTUSDT')!.qty, 1);
  broker.onBook('TESTUSDT', T + 300); assert.equal(broker.positions.get('TESTUSDT')!.qty, 1);
  broker.onTrade(trade(T + 400, 2, 10005, 10, 'buy')); assert.equal(broker.positions.get('TESTUSDT')!.qty, 0.5);
  refresh(manager, 'futures', 'TESTUSDT', T + 500, [[10000, 0], [9999, 0], [9998, 0], [9997, 1]]);
  broker.onBook('TESTUSDT', T + 500); assert.equal(broker.positions.get('TESTUSDT')!.exitReason, 'STOP');
  assert.equal([...broker.orders.values()].filter(o => o.role === 'entry').length, 0);
});
test('data gap cancels orders, defers exit on stale depth and never fabricates fills', () => {
  const { broker, manager } = setup(); broker.submit(signal(T, { kind: 'taker', ticks: 10002 }), T); broker.onBook('TESTUSDT', T + 100);
  manager.invalidate('futures', 'TESTUSDT'); broker.dataGap('TESTUSDT', T + 200, 'disconnect'); broker.onBook('TESTUSDT', T + 500);
  assert.equal(broker.closedCount, 0); assert.equal(broker.positions.size, 1);
  seed(manager, 'futures', 'TESTUSDT', T + 600); broker.onBook('TESTUSDT', T + 600); assert.equal(broker.closedCount, 1);
});
test('strategy A triggers after wall ageing and healthy feeds; panic invalidates held wall', () => {
  const s = setup(); seed(s.manager, 'futures', 'TESTUSDT', T, 10000, 10002, 100); s.manager.update('futures', 'TESTUSDT', T);
  warm(s.manager, s.tape, T + 3100); s.strategy.evaluate('TESTUSDT', T + 3100);
  assert.equal(s.strategy.signals, 1); assert.equal([...s.broker.orders.values()][0]!.signal.strategy, 'A');
  s.broker.onBook('TESTUSDT', T + 3200); s.broker.onTrade(trade(T + 3300, 20, 10000, 100));
  s.manager.execution('futures', 'TESTUSDT', 9999, 80, 'sell'); refresh(s.manager, 'futures', 'TESTUSDT', T + 3400, [[9999, 20]]);
  s.strategy.evaluate('TESTUSDT', T + 3400); assert.equal(s.broker.positions.get('TESTUSDT')!.exitReason, 'PANIC_EXIT');
});
test('strategy B requires observed attacking prints and a previously aged wall', () => {
  const s = setup(); seed(s.manager, 'futures', 'TESTUSDT', T, 10000, 10002, 100); s.manager.update('futures', 'TESTUSDT', T);
  warm(s.manager, s.tape, T + 3100);
  s.tape.add(trade(T + 3150, 3, 9999, 85)); s.manager.execution('futures', 'TESTUSDT', 9999, 85, 'sell');
  refresh(s.manager, 'futures', 'TESTUSDT', T + 3200, [[9999, 15]]); s.strategy.evaluate('TESTUSDT', T + 3200);
  assert.equal([...s.broker.orders.values()][0]!.signal.strategy, 'B');
});
test('absorption requires unbroken price floor, volume and slowing attack frequency', () => {
  const s = setup(), b = s.manager.book('futures', 'TESTUSDT'); let id = 0;
  for (let n = 0; n < 40; n++) s.tape.add(trade(T + n * 100, ++id, 10000, 1));
  s.tape.add(trade(T + 4400, ++id, 10000, 0.1));
  assert.deepEqual(s.tape.absorption('TESTUSDT', b, T + 4800), { ticks: 10000, side: 'buy' });
  s.tape.add(trade(T + 4500, ++id, 9999, 1)); assert.equal(s.tape.absorption('TESTUSDT', b, T + 4800), undefined);
});
test('stale spot feed blocks entry despite healthy futures', () => {
  const s = setup(); warm(s.manager, s.tape, T + 3100); s.manager.book('spot', 'TESTUSDT').received = T;
  s.strategy.evaluate('TESTUSDT', T + 3100); assert.equal(s.strategy.states.get('TESTUSDT'), 'DATA_STALE'); assert.equal(s.strategy.signals, 0);
});
test('daily mark-to-market loss circuit cancels entries and remains latched', () => {
  const s = setup({ maxDailyLoss: 0.01 });
  s.broker.submit(signal(T, { kind: 'taker', ticks: 10002 }), T); s.broker.onBook('TESTUSDT', T + 100);
  assert.equal(s.broker.positions.get('TESTUSDT')!.exitReason, 'DAILY_LOSS');
  s.broker.onBook('TESTUSDT', T + 200); assert.equal(s.broker.closedCount, 1);
  assert.equal(s.broker.submit(signal(T + 300, { symbol: 'BTCUSDT' }), T + 300), false);
});
test('unfilled taker exit residual stays pending when observable depth is insufficient', () => {
  const s = setup(); s.broker.submit(signal(T, { kind: 'taker', ticks: 10002 }), T); s.broker.onBook('TESTUSDT', T + 100);
  const b = s.manager.book('futures', 'TESTUSDT'); b.bids = new Map([[10000, 0.1]]);
  s.broker.exit('TESTUSDT', T + 200, 'TEST'); s.broker.onBook('TESTUSDT', T + 300);
  const qty = s.broker.positions.get('TESTUSDT')!.qty;
  s.broker.onBook('TESTUSDT', T + 400); assert.equal(s.broker.positions.get('TESTUSDT')!.qty, qty);
  assert.equal(s.broker.closedCount, 0); assert.equal(s.broker.positions.get('TESTUSDT')!.exitReason, 'TEST');
});
test('short maker entry and targets preserve direction and fee accounting', () => {
  const s = setup(); assert.equal(s.broker.submit(signal(T, { side: 'sell', ticks: 10002, stop: 10005 }), T), true);
  s.broker.onBook('TESTUSDT', T + 100); s.broker.onTrade(trade(T + 200, 1, 10002, 10, 'buy'));
  s.broker.onBook('TESTUSDT', T + 300);
  s.broker.onTrade(trade(T + 400, 2, 9997, 10, 'sell')); s.broker.onTrade(trade(T + 500, 3, 9994, 10, 'sell'));
  assert.equal(s.broker.closedCount, 1); const closed = s.broker.closed[0]!;
  assert.ok(closed.net > 0); assert.ok(Math.abs(closed.net - ((closed.entry - closed.exit) * closed.qty - closed.fees)) < 1e-8);
});
test('cross market confidence compares actual prices when tick sizes differ', () => {
  const s = setup({ minConfidence: 1 });
  s.manager.book('spot', 'TESTUSDT').instrument.tick = 0.1;
  seed(s.manager, 'spot', 'TESTUSDT', T, 1000, 1002, 100);
  seed(s.manager, 'futures', 'TESTUSDT', T, 9991, 9993, 100);
  s.manager.update('spot', 'TESTUSDT', T); s.manager.update('futures', 'TESTUSDT', T);
  refresh(s.manager, 'spot', 'TESTUSDT', T + 3100); refresh(s.manager, 'futures', 'TESTUSDT', T + 3100);
  assert.equal(s.manager.active('TESTUSDT').length, 1);
  s.manager.invalidate('spot', 'TESTUSDT'); refresh(s.manager, 'futures', 'TESTUSDT', T + 3200);
  assert.equal(s.manager.active('TESTUSDT').length, 0);
});
test('strategy C emits only after warm feeds and absorption slowdown', () => {
  const s = setup(); warm(s.manager, s.tape, T + 10); s.tape.clear('futures', 'TESTUSDT'); let id = 0;
  for (let n = 0; n < 40; n++) s.tape.add(trade(T + n * 100, ++id, 10000, 1));
  s.tape.add(trade(T + 4400, ++id, 10000, 0.1));
  for (const market of ['spot', 'futures'] as const) for (const symbol of ['TESTUSDT', 'BTCUSDT']) refresh(s.manager, market, symbol, T + 4800);
  s.tape.add(trade(T + 4800, 3, 10000, 0.1, 'buy', 'BTCUSDT'));
  s.tape.add(trade(T + 4800, 3, 10000, 0.1, 'sell', 'TESTUSDT', 'spot'));
  s.strategy.evaluate('TESTUSDT', T + 4800);
  assert.equal([...s.broker.orders.values()][0]!.signal.strategy, 'C');
});
test('spot-only verified wall can drive a futures paper entry at confidence 1', () => {
  const s = setup({ minConfidence: 1 }); seed(s.manager, 'spot', 'TESTUSDT', T, 10000, 10002, 100); s.manager.update('spot', 'TESTUSDT', T);
  warm(s.manager, s.tape, T + 3100); s.strategy.evaluate('TESTUSDT', T + 3100);
  const order = [...s.broker.orders.values()][0]!;
  assert.equal(order.signal.strategy, 'A'); assert.ok(order.signal.wallId?.startsWith('spot:'));
});
