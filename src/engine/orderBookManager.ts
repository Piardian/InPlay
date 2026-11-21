import type { Config } from '../config.js';
import { key, type BookSide, type Depth, type Instrument, type Level, type Market, type Snapshot } from '../types.js';
export class LocalOrderBook {
  bids = new Map<number, number>(); asks = new Map<number, number>();
  last = 0; received = 0; synced = false; private bridged = false;
  private bidBoundary = 0; private askBoundary = Infinity;
  constructor(readonly instrument: Instrument) {}
  reset(): void { this.synced = false; this.bridged = false; this.last = 0; this.received = 0; this.bids.clear(); this.asks.clear(); }
  snapshot(s: Snapshot): void {
    this.bids = new Map(s.bids); this.asks = new Map(s.asks); this.last = s.last;
    this.bidBoundary = Math.min(...s.bids.map(l => l[0])); this.askBoundary = Math.max(...s.asks.map(l => l[0]));
    this.synced = false; this.bridged = false;
  }
  apply(d: Depth): 'old' | 'gap' | 'ok' {
    const futures = this.instrument.market === 'futures';
    if (d.last < this.last || (d.last === this.last && (!futures || this.bridged))) return 'old';
    const target = this.last + (futures && !this.bridged ? 0 : 1);
    if ((!this.bridged && !(d.first <= target && d.last >= target)) ||
        (this.bridged && (futures ? d.previous !== this.last : d.first > this.last + 1))) {
      this.synced = false; return 'gap';
    }
    for (const [ticks, qty] of d.bids) if (ticks >= this.bidBoundary) { if (qty === 0) this.bids.delete(ticks); else this.bids.set(ticks, qty); }
    for (const [ticks, qty] of d.asks) if (ticks <= this.askBoundary) { if (qty === 0) this.asks.delete(ticks); else this.asks.set(ticks, qty); }
    this.last = d.last; this.received = d.received; this.bridged = true;
    const bid = this.top('bid', 1)[0], ask = this.top('ask', 1)[0];
    this.synced = !!bid && !!ask && bid[0] < ask[0];
    return this.synced ? 'ok' : 'gap';
  }
  top(side: BookSide, n = 50): Level[] { return [...(side === 'bid' ? this.bids : this.asks)].sort((a, b) => side === 'bid' ? b[0] - a[0] : a[0] - b[0]).slice(0, n); }
  qty(side: BookSide, ticks: number): number { return (side === 'bid' ? this.bids : this.asks).get(ticks) ?? 0; }
  mid(): number { const b = this.top('bid', 1)[0], a = this.top('ask', 1)[0]; return b && a ? (b[0] + a[0]) / 2 : 0; }
  healthy(time: number, staleMs: number, levels = 1): boolean { return this.synced && time - this.received <= staleMs && this.top('bid', levels).length >= levels && this.top('ask', levels).length >= levels; }
  average(n: number): number {
    const levels = [...this.top('bid', n), ...this.top('ask', n)];
    return levels.length ? levels.reduce((s, [p, q]) => s + p * this.instrument.tick * q, 0) / levels.length : 0;
  }
}
export interface Wall {
  id: string; market: Market; symbol: string; side: BookSide; ticks: number;
  initial: number; usd: number; peak: number; firstSeen: number; lastSeen: number;
  verified: boolean; spoof: boolean; confidence: 0.5 | 1; executed: number;
}
export class OrderBookManager {
  readonly books = new Map<string, LocalOrderBook>(); readonly walls = new Map<string, Wall>();
  private blacklist = new Map<string, number>(); spoofCount = 0;
  constructor(readonly config: Config, instruments: Instrument[], private log: (type: string, data: unknown) => void = () => {}) {
    for (const i of instruments) this.books.set(key(i.market, i.symbol), new LocalOrderBook(i));
  }
  book(market: Market, symbol: string): LocalOrderBook { const b = this.books.get(key(market, symbol)); if (!b) throw new Error(`Unknown instrument ${market}:${symbol}`); return b; }
  invalidate(market: Market, symbol: string): void {
    this.book(market, symbol).reset();
    for (const [id, w] of this.walls) if (w.market === market && w.symbol === symbol) this.walls.delete(id);
  }
  execution(market: Market, symbol: string, price: number, qty: number, side: 'buy' | 'sell'): void {
    const id = `${key(market, symbol)}:${side === 'buy' ? 'ask' : 'bid'}:${price}`;
    const w = this.walls.get(id); if (w) w.executed += price * this.book(market, symbol).instrument.tick * qty;
  }
  update(market: Market, symbol: string, time: number): void {
    for (const [id, until] of this.blacklist) if (until <= time) { this.blacklist.delete(id); if (this.walls.get(id)?.spoof) this.walls.delete(id); }
    const b = this.book(market, symbol), avg = b.average(this.config.levels), mid = b.mid();
    if (!b.healthy(time, this.config.staleMs, this.config.levels) || !avg) return;
    const visible = new Set<string>();
    for (const side of ['bid', 'ask'] as const) {
      const levels = b.top(side, this.config.levels);
      for (const [p, q] of levels) {
        const id = `${key(market, symbol)}:${side}:${p}`, usd = p * b.instrument.tick * q;
        visible.add(id);
        let w = this.walls.get(id);
        if (!w && usd >= avg * this.config.densityRatio && !this.blacklist.has(id)) {
          w = { id, market, symbol, side, ticks: p, initial: usd, usd, peak: usd, firstSeen: time, lastSeen: time, verified: false, spoof: false, confidence: market === 'spot' ? 1 : 0.5, executed: 0 };
          this.walls.set(id, w); this.log('WALL_CANDIDATE', w);
        }
        if (w) this.refresh(w, usd, mid, time);
      }
      const outer = levels.at(-1)?.[0];
      for (const [id, w] of this.walls) {
        if (w.market !== market || w.symbol !== symbol || w.side !== side || visible.has(id)) continue;
        const outside = outer === undefined || (side === 'bid' ? w.ticks < outer : w.ticks > outer);
        // Leaving the observation window is not proof of cancellation.
        if (outside || time - w.lastSeen > 2000) this.walls.delete(id);
        else this.refresh(w, 0, mid, time, false);
      }
    }
    for (const w of this.walls.values()) {
      if (w.symbol !== symbol || w.market !== 'futures') continue;
      const spot = this.book('spot', symbol);
      const futuresTick = this.book('futures', symbol).instrument.tick;
      w.confidence = spot.healthy(time, this.config.staleMs, this.config.levels) && [...this.walls.values()].some(s => s.market === 'spot' && s.symbol === symbol && s.side === w.side && s.verified && !s.spoof && s.usd > 0 && Math.abs(s.ticks * spot.instrument.tick / (w.ticks * futuresTick) - 1) <= this.config.crossPct) ? 1 : 0.5;
    }
  }
  private refresh(w: Wall, usd: number, mid: number, time: number, visible = true): void {
    const near = Math.abs(mid / w.ticks - 1) <= this.config.nearPct;
    if (w.usd === 0 && usd > 0) {
      w.firstSeen = time; w.initial = usd; w.peak = usd; w.executed = 0; w.verified = false;
    }
    w.usd = usd; if (visible) w.lastSeen = time;
    if (usd === 0) { w.verified = false; w.firstSeen = time; }
    if (!w.verified && usd < w.initial * (1 - this.config.spoofDrop)) w.firstSeen = time;
    // L2 cancellation attribution is heuristic: only classify unexplained reductions.
    const unexplained = Math.max(0, w.peak - usd - w.executed);
    if (!w.spoof && near && unexplained > w.peak * this.config.spoofDrop) {
      w.spoof = true; w.verified = false; this.blacklist.set(w.id, time + this.config.blacklistMs);
      this.spoofCount++; this.log('SPOOF_DETECTED', w);
    }
    if (usd > w.peak) { w.peak = usd; w.executed = 0; }
    if (!w.verified && !w.spoof && usd >= w.initial * (1 - this.config.spoofDrop) && time - w.firstSeen >= this.config.wallAgeMs) {
      w.verified = true; this.log('WALL_VERIFIED', w);
    }
    if (w.spoof && time >= (this.blacklist.get(w.id) ?? Infinity)) this.walls.delete(w.id);
  }
  active(symbol: string): Wall[] {
    const all = [...this.walls.values()].filter(w => w.symbol === symbol && w.verified && !w.spoof && w.confidence >= this.config.minConfidence);
    const futures = all.filter(w => w.market === 'futures'), fTick = this.book('futures', symbol).instrument.tick, sTick = this.book('spot', symbol).instrument.tick;
    const spotOnly = all.filter(w => w.market === 'spot' && !futures.some(f => f.side === w.side && Math.abs(f.ticks * fTick / (w.ticks * sTick) - 1) <= this.config.crossPct));
    // Returned engagement prices are always in execution-market ticks; IDs still
    // reference the original source wall for ageing, consumption and panic exits.
    return [...futures, ...spotOnly.map(w => ({ ...w, ticks: Math.round(w.ticks * sTick / fTick) }))];
  }
}
