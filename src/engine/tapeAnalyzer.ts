import type { Config } from '../config.js';
import type { LocalOrderBook } from './orderBookManager.js';
import { key, type Market, type Side, type Trade } from '../types.js';
interface Tape { items: (Trade | undefined)[]; head: number; size: number; lastId: number; lastTime: number; warmedAt: number; overflow: boolean }
export interface Pressure { buy: number; sell: number; count: number; rate: number; delta: number }
export class TapeAnalyzer {
  private tapes = new Map<string, Tape>();
  constructor(readonly config: Config, private capacity = 100000) {}
  clear(market: Market, symbol: string): void { this.tapes.delete(key(market, symbol)); }
  add(t: Trade): 'ok' | 'duplicate' | 'gap' | 'late' | 'overflow' {
    const k = key(t.market, t.symbol);
    let b = this.tapes.get(k);
    if (!b) { b = { items: new Array<Trade | undefined>(this.capacity), head: 0, size: 0, lastId: -1, lastTime: 0, warmedAt: t.received, overflow: false }; this.tapes.set(k, b); }
    if (t.id <= b.lastId) return 'duplicate';
    if (t.time < b.lastTime) return 'late';
    const gap = b.lastId >= 0 && t.id !== b.lastId + 1;
    if (gap) { b.head = 0; b.size = 0; b.warmedAt = t.received; }
    this.prune(b, t.received);
    if (b.size === this.capacity) { b.overflow = true; b.warmedAt = t.received; return 'overflow'; }
    b.items[(b.head + b.size) % this.capacity] = t; b.size++; b.lastId = t.id; b.lastTime = t.time;
    return gap ? 'gap' : 'ok';
  }
  private prune(b: Tape, time: number): void {
    while (b.size && (b.items[b.head]?.received ?? 0) < time - 10000) { b.items[b.head] = undefined; b.head = (b.head + 1) % this.capacity; b.size--; }
  }
  trades(market: Market, symbol: string, time: number, window: number, offset = 0): Trade[] {
    const b = this.tapes.get(key(market, symbol)); if (!b) return [];
    this.prune(b, time); const out: Trade[] = [];
    for (let n = 0; n < b.size; n++) { const t = b.items[(b.head + n) % this.capacity]!; if (t.received > time - window - offset && t.received <= time - offset) out.push(t); }
    return out;
  }
  healthy(market: Market, symbol: string, time: number): boolean {
    const b = this.tapes.get(key(market, symbol)), last = b && b.items[(b.head + b.size - 1) % this.capacity];
    return !!b && !b.overflow && !!last && time - last.received <= this.config.staleMs && time - b.warmedAt >= this.config.warmupMs;
  }
  pressure(market: Market, symbol: string, tick: number, time: number, window = 1000, offset = 0): Pressure {
    const trades = this.trades(market, symbol, time, window, offset); let buy = 0, sell = 0;
    for (const t of trades) { const usd = t.ticks * tick * t.qty; if (t.side === 'buy') buy += usd; else sell += usd; }
    return { buy, sell, count: trades.length, rate: (buy + sell) * 1000 / window, delta: buy + sell ? (buy - sell) / (buy + sell) : 0 };
  }
  attacking(symbol: string, ticks: number, side: Side, time: number, window = 1000, market: Market = 'futures'): { usdQty: number; count: number } {
    const trades = this.trades(market, symbol, time, window).filter(t => t.ticks === ticks && t.side === side);
    return { usdQty: trades.reduce((s, t) => s + t.ticks * t.qty, 0), count: trades.length };
  }
  leaderOpposes(side: Side, tick: number, time: number): boolean {
    const ts = this.trades('futures', 'BTCUSDT', time, 2000), first = ts[0], last = ts.at(-1);
    if (!first || !last) return true;
    const move = last.ticks / first.ticks - 1, p = this.pressure('futures', 'BTCUSDT', tick, time, 2000);
    return side === 'buy' ? move < -this.config.btcMovePct || p.delta < -this.config.btcDeltaRatio : move > this.config.btcMovePct || p.delta > this.config.btcDeltaRatio;
  }
  absorption(symbol: string, b: LocalOrderBook, time: number): { ticks: number; side: Side } | undefined {
    const trades = this.trades('futures', symbol, time, 5000), avg = b.average(this.config.levels);
    const groups = new Map<string, { ticks: number; attack: Side; usd: number; first: number; last: number }>();
    for (const t of trades) {
      const id = `${t.side}:${t.ticks}`, g = groups.get(id) ?? { ticks: t.ticks, attack: t.side, usd: 0, first: t.received, last: t.received };
      g.usd += t.ticks * b.instrument.tick * t.qty; g.last = t.received; groups.set(id, g);
    }
    for (const g of groups.values()) {
      if (g.usd < avg * this.config.absorptionRatio || g.last - g.first < 3000 || time - g.last > 1000) continue;
      const passive = g.attack === 'sell' ? 'bid' : 'ask';
      if (b.qty(passive, g.ticks) * g.ticks * b.instrument.tick >= avg * this.config.densityRatio) continue;
      if (trades.some(t => t.received >= g.first && (g.attack === 'sell' ? t.ticks < g.ticks : t.ticks > g.ticks))) continue;
      const recent = this.trades('futures', symbol, time, 1000).filter(t => t.side === g.attack && t.ticks === g.ticks).length;
      const previous = this.trades('futures', symbol, time, 1000, 1000).filter(t => t.side === g.attack && t.ticks === g.ticks).length;
      if (previous >= 3 && recent < previous * this.config.slowdownRatio) return { ticks: g.ticks, side: g.attack === 'sell' ? 'buy' : 'sell' };
    }
    return undefined;
  }
}
