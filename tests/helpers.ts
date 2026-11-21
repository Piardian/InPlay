import { configSchema, type Config } from '../src/config.js';
import { OrderBookManager } from '../src/engine/orderBookManager.js';
import { TapeAnalyzer } from '../src/engine/tapeAnalyzer.js';
import { PaperBroker } from '../src/simulator/paperBroker.js';
import { StrategyStateMachine } from '../src/engine/strategyStateMachine.js';
import type { Depth, Instrument, Level, Market, Signal, Trade } from '../src/types.js';
export const T = 1800000000000;
export function setup(overrides: Partial<Config> = {}) {
  const c = configSchema.parse({ requireCostCoverage: false, minConfidence: 0.5, warmupMs: 1, ...overrides });
  const instruments: Instrument[] = ['TESTUSDT', 'BTCUSDT'].flatMap(symbol => (['spot', 'futures'] as const).map(market => ({ symbol, market, tick: 0.01, step: 0.01, minQty: 0.01, minNotional: 1 })));
  const events: { type: string; data: unknown }[] = [], log = (type: string, data: unknown) => { events.push({ type, data: structuredClone(data) }); };
  // Accounting/legacy A/B/C unit fixtures bypass admission explicitly; application never does.
  const manager = new OrderBookManager(c, instruments, log), tape = new TapeAnalyzer(c), broker = new PaperBroker(c, manager, log, { check: () => ({ allowed: true, reason: 'UNIT_FIXTURE' }) }), strategy = new StrategyStateMachine(c, manager, tape, broker, log, ['A', 'B', 'C']);
  for (const i of instruments) seed(manager, i.market, i.symbol, T);
  return { c, manager, tape, broker, strategy, events };
}
export function seed(manager: OrderBookManager, market: Market, symbol: string, time: number, bid = 10000, ask = 10002, wall?: number): void {
  const b = manager.book(market, symbol);
  const bids: Level[] = Array.from({ length: 60 }, (_, n) => [bid - n, n === 1 && wall !== undefined ? wall : 1]);
  const asks: Level[] = Array.from({ length: 60 }, (_, n) => [ask + n, 1]);
  b.snapshot({ last: 10, bids, asks });
  b.apply({ market, symbol, first: 10, last: 11, previous: 9, time, received: time, bids: [], asks: [] });
}
export function refresh(manager: OrderBookManager, market: Market, symbol: string, time: number, bids: Level[] = [], asks: Level[] = []): Depth {
  const b = manager.book(market, symbol), d: Depth = { market, symbol, first: b.last + 1, last: b.last + 1, previous: b.last, bids, asks, time, received: time };
  b.apply(d); manager.update(market, symbol, time); return d;
}
export function trade(time: number, id: number, ticks = 10000, qty = 1, side: 'buy' | 'sell' = 'sell', symbol = 'TESTUSDT', market: Market = 'futures'): Trade {
  return { market, symbol, id, ticks, qty, side, time, received: time };
}
export function signal(time = T, overrides: Partial<Signal> = {}): Signal {
  return { symbol: 'TESTUSDT', strategy: 'A', side: 'buy', kind: 'maker', ticks: 10000, stop: 9997, targetTicks: 8, time, reason: 'fixture', ...overrides };
}
export function warm(manager: OrderBookManager, tape: TapeAnalyzer, time: number): void {
  for (const symbol of ['TESTUSDT', 'BTCUSDT']) for (const market of ['spot', 'futures'] as const) {
    refresh(manager, market, symbol, time);
    tape.clear(market, symbol); tape.add(trade(time - 10, 1, 10000, 0.01, 'buy', symbol, market)); tape.add(trade(time, 2, 10000, 0.01, 'sell', symbol, market));
  }
}
