import assert from 'node:assert/strict';
import { configSchema } from './config.js';
import { OrderBookManager } from './engine/orderBookManager.js';
import { PaperBroker } from './simulator/paperBroker.js';
import type { Instrument, Level, Trade } from './types.js';

// Synthetic fixture deliberately uses a coarse tick to make transaction costs visible.
// It demonstrates accounting only, and supplies no evidence about strategy returns.
const config = configSchema.parse({ queueMultiplier: 1 });
const instruments: Instrument[] = (['spot', 'futures'] as const).map(market => ({ symbol: 'DEMOUSDT', market, tick: 0.1, step: 0.01, minQty: 0.01, minNotional: 1 }));
const events: { type: string; data: unknown }[] = [];
const log = (type: string, data: unknown): void => { events.push({ type, data: structuredClone(data) }); };
const manager = new OrderBookManager(config, instruments, log), broker = new PaperBroker(config, manager, log, { check: () => ({ allowed: true, reason: 'SYNTHETIC_ACCOUNTING_DEMO' }) });
const time = 1800000000000;
for (const i of instruments) {
  const bids: Level[] = Array.from({ length: 100 }, (_, n) => [1000 - n, 1]);
  const asks: Level[] = Array.from({ length: 100 }, (_, n) => [1002 + n, 1]);
  const b = manager.book(i.market, i.symbol); b.snapshot({ last: 100, bids, asks });
  b.apply({ market: i.market, symbol: i.symbol, first: 100, last: 101, previous: 99, bids: [], asks: [], time, received: time });
}
assert.equal(broker.submit({ symbol: 'DEMOUSDT', strategy: 'A', side: 'buy', kind: 'maker', ticks: 1000, stop: 997, targetTicks: 8, time, reason: 'synthetic_accounting_fixture' }, time), true);
broker.onBook('DEMOUSDT', time + 100);
const print = (offset: number, id: number, ticks: number, qty: number, side: 'buy' | 'sell'): void => {
  const t: Trade = { market: 'futures', symbol: 'DEMOUSDT', id, ticks, qty, side, time: time + offset, received: time + offset }; broker.onTrade(t);
};
print(200, 1, 1000, 0.5, 'sell'); assert.equal(broker.positions.size, 0);
print(300, 2, 1000, 10, 'sell'); assert.equal(broker.positions.size, 1);
broker.onBook('DEMOUSDT', time + 400);
print(500, 3, 1005, 10, 'buy'); print(600, 4, 1008, 10, 'buy');
assert.equal(broker.closedCount, 1);
console.log('SYNTHETIC DEMO: latency + real-price tape queue + partial targets + fees. This is not a backtest.');
console.table(broker.closed);
console.log(`Net PnL: $${broker.realized.toFixed(4)} | fees: $${broker.fees.toFixed(4)} | accounting events: ${events.length}`);
