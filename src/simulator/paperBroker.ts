import type { Config } from '../config.js';
import { direction, floorQty, opposite, type EntryPolicy, type EntryDecision, type Instrument, type Side, type Signal, type Trade } from '../types.js';
import type { LocalOrderBook, OrderBookManager } from '../engine/orderBookManager.js';
export interface PaperOrder {
  id: number; symbol: string; side: Side; ticks: number; qty: number; remaining: number;
  role: 'entry' | 'target'; kind: 'maker' | 'taker'; activeAt: number; expires: number;
  queue: number | undefined; signal: Signal;
}
export interface Position {
  symbol: string; side: Side; qty: number; enteredQty: number; entry: number; stop: number;
  opened: number; signal: Signal; net: number; fees: number; exitQty: number; exitValue: number;
  exitReason?: string; exitAt?: number; peakRate: number;
}
export interface ClosedTrade { symbol: string; strategy: string; side: Side; opened: number; closed: number; entry: number; exit: number; qty: number; fees: number; net: number; reason: string; inPlay?: unknown }
export class PaperBroker {
  readonly orders = new Map<number, PaperOrder>(); readonly positions = new Map<string, Position>();
  readonly closed: ClosedTrade[] = []; realized = 0; fees = 0; rejected = 0; lastRejection = '';
  closedCount = 0; wins = 0; private nextId = 1;
  private consumed = new Map<string, { last: number; levels: Map<string, number> }>();
  private day = ''; private dayStart: number; private halted = false;
  constructor(readonly config: Config, readonly manager: OrderBookManager, private log: (type: string, data: unknown) => void = () => {},
    private policy: EntryPolicy = { check: () => ({ allowed: false, reason: 'ENTRY_POLICY_MISSING' }) }) { this.dayStart = config.initialEquity; }
  entryDecision(symbol: string, time: number, signal?: Signal): EntryDecision { return this.policy.check(symbol, time, signal); }
  busy(symbol: string): boolean { return this.positions.has(symbol) || [...this.orders.values()].some(o => o.symbol === symbol && o.role === 'entry'); }
  equity(time: number): number {
    let equity = this.config.initialEquity + this.realized;
    for (const p of this.positions.values()) {
      const b = this.manager.book('futures', p.symbol), best = b.top(p.side === 'buy' ? 'bid' : 'ask', 1)[0];
      // Last observable mark is displayed during a gap; it cannot execute an exit.
      const price = best ? best[0] * b.instrument.tick : p.entry;
      equity += direction(p.side) * (price - p.entry) * p.qty - price * p.qty * this.config.takerFee;
    }
    void time; return equity;
  }
  private reject(reason: string, signal: Signal): boolean { this.rejected++; this.lastRejection = reason; this.log('ORDER_REJECTED', { reason, signal }); return false; }
  submit(signal: Signal, time: number): boolean {
    this.updateDay(time);
    if (this.halted || this.config.mode !== 'paper') return false;
    const admission = this.entryDecision(signal.symbol, time, signal);
    if (!admission.allowed) return this.reject(admission.reason, signal);
    signal = { ...signal, inPlay: admission.evidence };
    const b = this.manager.book('futures', signal.symbol), i = b.instrument;
    if (this.busy(signal.symbol)) return this.reject('symbol_busy', signal);
    const exposureSymbols = new Set([...this.positions.keys(), ...[...this.orders.values()].filter(o => o.role === 'entry').map(o => o.symbol)]);
    if (exposureSymbols.size >= this.config.maxPositions) return this.reject('max_positions', signal);
    if (this.equity(time) <= this.dayStart - this.config.maxDailyLoss) { this.halt(time, 'DAILY_LOSS'); return this.reject('daily_loss', signal); }
    if (!b.healthy(time, this.config.staleMs, this.config.levels)) return this.reject('stale_book', signal);
    const bid = b.top('bid', 1)[0]![0], ask = b.top('ask', 1)[0]![0];
    if (ask - bid > this.config.maxSpreadTicks) return this.reject('spread', signal);
    if (signal.kind === 'maker' && (signal.side === 'buy' ? signal.ticks >= ask : signal.ticks <= bid)) return this.reject('post_only_cross', signal);
    if ((signal.ticks - signal.stop) * direction(signal.side) <= 0) return this.reject('invalid_stop', signal);
    const entry = signal.ticks * i.tick;
    const fee = signal.kind === 'maker' ? this.config.makerFee : this.config.takerFee;
    const stopCost = Math.abs(signal.ticks - signal.stop) * i.tick + i.tick * this.config.slippageTicks * (signal.kind === 'taker' ? 2 : 1) + entry * (fee + this.config.takerFee);
    const expectedCost = entry * (fee + this.config.makerFee) + i.tick * this.config.slippageTicks * (signal.kind === 'taker' ? 1 : 0);
    const expectedGrossProfit = signal.targetTicks * 0.75 * i.tick;
    if (this.config.requireCostCoverage && expectedGrossProfit <= expectedCost) return this.reject('target_below_cost', signal);
    let gross = 0;
    for (const p of this.positions.values()) gross += p.qty * p.entry;
    for (const o of this.orders.values()) if (o.role === 'entry') gross += o.remaining * o.ticks * this.manager.book('futures', o.symbol).instrument.tick;
    const available = Math.max(0, Math.min(this.config.maxGrossNotional - gross, this.equity(time) - gross));
    const qty = floorQty(Math.min(this.config.riskUsd / stopCost, this.config.maxNotional / entry, available / entry), i.step);
    if (qty < i.minQty || qty * entry < i.minNotional) return this.reject('size_below_exchange_minimum', signal);
    const o: PaperOrder = { id: this.nextId++, symbol: signal.symbol, side: signal.side, ticks: signal.ticks, qty, remaining: qty, role: 'entry', kind: signal.kind, activeAt: time + this.config.latencyMs, expires: time + this.config.entryTtlMs, queue: undefined, signal };
    this.orders.set(o.id, o); this.log('ORDER_SUBMITTED', { ...o, inPlay: admission.evidence }); return true;
  }
  private updateDay(time: number): void {
    const day = new Date(time).toISOString().slice(0, 10);
    if (!this.day) { this.day = day; return; }
    if (this.day !== day) { this.day = day; this.dayStart = this.equity(time); this.log('UTC_DAY_ROLLOVER', { day, equity: this.dayStart }); }
  }
  cancelEntries(symbol: string, reason: string): void { for (const o of [...this.orders.values()]) if (o.symbol === symbol && o.role === 'entry') this.cancel(o, reason); }
  cancelAll(symbol: string, reason: string): void { for (const o of [...this.orders.values()]) if (o.symbol === symbol) this.cancel(o, reason); }
  private cancel(o: PaperOrder, reason: string): void { this.orders.delete(o.id); this.log('ORDER_CANCELLED', { id: o.id, symbol: o.symbol, remaining: o.remaining, reason }); }
  dataGap(symbol: string, time: number, reason: string): void { this.cancelAll(symbol, reason); if (this.positions.has(symbol)) this.exit(symbol, time, 'DATA_GAP'); }
  halt(time: number, reason: string): void {
    if (!this.halted) this.log('RISK_HALT', { time, reason }); this.halted = true;
    for (const o of [...this.orders.values()]) this.cancel(o, reason);
    for (const p of this.positions.values()) this.exit(p.symbol, time, reason);
  }
  exit(symbol: string, time: number, reason: string): void {
    const p = this.positions.get(symbol); if (!p || p.exitReason) return;
    this.cancelAll(symbol, reason); p.exitReason = reason; p.exitAt = time + this.config.latencyMs;
    this.log('EXIT_REQUESTED', { symbol, reason, time, qty: p.qty });
  }
  onBook(symbol: string, time: number): void {
    this.updateDay(time); const b = this.manager.book('futures', symbol);
    if (!b.healthy(time, this.config.staleMs)) return;
    for (const o of [...this.orders.values()]) {
      if (o.symbol !== symbol) continue;
      if (o.role === 'entry') {
        const d = this.entryDecision(symbol, time, o.signal);
        if (!d.allowed) { this.cancel(o, d.reason); continue; }
      }
      if (time >= o.expires) { this.cancel(o, 'EXPIRED'); continue; }
      if (time < o.activeAt) continue;
      if (o.kind === 'taker') {
        this.sweep(o.side, o.remaining, b, (qty, price) => this.fill(o, qty, price, false, time));
        if (this.orders.has(o.id)) this.cancel(o, 'IOC_RESIDUAL');
      } else if (o.queue === undefined) {
        const cross = o.side === 'buy' ? o.ticks >= b.top('ask', 1)[0]![0] : o.ticks <= b.top('bid', 1)[0]![0];
        if (cross) this.cancel(o, 'POST_ONLY_REJECT_AT_ARRIVAL');
        else o.queue = b.qty(o.side === 'buy' ? 'bid' : 'ask', o.ticks) * this.config.queueMultiplier;
      }
    }
    const p = this.positions.get(symbol); if (!p) return;
    const best = b.top(p.side === 'buy' ? 'bid' : 'ask', 1)[0]![0];
    if (!p.exitReason && (p.side === 'buy' ? best <= p.stop : best >= p.stop)) this.exit(symbol, time, 'STOP');
    if (!p.exitReason && time - p.opened >= this.config.maxHoldMs) this.exit(symbol, time, 'TIME_STOP');
    if (p.exitReason && time >= p.exitAt!) this.sweep(opposite(p.side), p.qty, b, (qty, price) => this.closeFill(p, qty, price, false, time));
    if (!this.halted && this.equity(time) <= this.dayStart - this.config.maxDailyLoss) this.halt(time, 'DAILY_LOSS');
  }
  onTrade(t: Trade): void {
    if (t.market !== 'futures') return;
    const b = this.manager.book('futures', t.symbol);
    if (!b.healthy(t.received, this.config.staleMs) || t.received - t.time > this.config.maxEventLagMs) return;
    let available = t.qty;
    for (const o of [...this.orders.values()].sort((a, b) => a.id - b.id)) {
      if (o.symbol === t.symbol && o.role === 'entry') {
        const d = this.entryDecision(t.symbol, t.received, o.signal);
        if (!d.allowed) { this.cancel(o, d.reason); continue; }
      }
      if (available <= 0 || o.symbol !== t.symbol || o.kind !== 'maker' || o.side === t.side || o.ticks !== t.ticks) continue;
      if (t.received < o.activeAt || t.time < o.activeAt || t.received >= o.expires || o.queue === undefined) continue;
      const ahead = Math.min(o.queue, available); o.queue -= ahead; available -= ahead;
      const qty = Math.min(o.remaining, available);
      if (qty > 0) { this.fill(o, qty, o.ticks * b.instrument.tick, true, t.received); available -= qty; }
    }
    const p = this.positions.get(t.symbol);
    if (p && (p.side === 'buy' ? t.ticks <= p.stop : t.ticks >= p.stop)) this.exit(t.symbol, t.received, 'STOP_TAPE');
  }
  private sweep(side: Side, qty: number, b: LocalOrderBook, fill: (qty: number, price: number) => void): void {
    let ledger = this.consumed.get(b.instrument.symbol);
    if (!ledger || ledger.last !== b.last) { ledger = { last: b.last, levels: new Map() }; this.consumed.set(b.instrument.symbol, ledger); }
    for (const [ticks, visible] of b.top(side === 'buy' ? 'ask' : 'bid', 1000)) {
      const id = `${side}:${ticks}`, used = ledger.levels.get(id) ?? 0, take = Math.min(qty, Math.max(0, visible - used));
      if (take <= 0) continue;
      ledger.levels.set(id, used + take);
      fill(take, (ticks + direction(side) * this.config.slippageTicks) * b.instrument.tick);
      qty -= take; if (qty <= b.instrument.step * 1e-8) break;
    }
  }
  private fill(o: PaperOrder, qty: number, price: number, maker: boolean, time: number): void {
    const i = this.manager.book('futures', o.symbol).instrument;
    if (o.role === 'target') {
      const p = this.positions.get(o.symbol); if (!p || p.exitReason) return;
      const take = Math.min(qty, p.qty); o.remaining -= take;
      if (o.remaining <= i.step * 1e-8) this.orders.delete(o.id);
      this.closeFill(p, take, price, maker, time); return;
    }
    const cost = qty * price * (maker ? this.config.makerFee : this.config.takerFee);
    this.realized -= cost; this.fees += cost;
    let p = this.positions.get(o.symbol);
    if (!p) {
      p = { symbol: o.symbol, side: o.side, qty: 0, enteredQty: 0, entry: price, stop: o.signal.stop, opened: time, signal: o.signal, net: 0, fees: 0, exitQty: 0, exitValue: 0, peakRate: 0 };
      this.positions.set(o.symbol, p);
    }
    p.entry = (p.entry * p.qty + price * qty) / (p.qty + qty); p.qty += qty; p.enteredQty += qty; p.fees += cost; p.net -= cost;
    o.remaining -= qty; if (o.remaining <= i.step * 1e-8) this.orders.delete(o.id);
    this.log('FILL', { order: o.id, role: 'entry', symbol: o.symbol, qty, price, maker, fee: cost, time });
    this.targets(p, i, time);
  }
  private targets(p: Position, i: Instrument, time: number): void {
    for (const o of [...this.orders.values()]) if (o.symbol === p.symbol && o.role === 'target') this.cancel(o, 'RESIZE_TARGET');
    const half = floorQty(p.qty / 2, i.step), base = Math.round(p.entry / i.tick);
    const amounts = half >= i.minQty ? [half, p.qty - half] : [p.qty];
    amounts.forEach((qty, n) => {
      const distance = amounts.length === 1 || n === 1 ? p.signal.targetTicks : Math.max(1, Math.floor(p.signal.targetTicks * 0.625));
      const ticks = base + direction(p.side) * distance;
      const o: PaperOrder = { id: this.nextId++, symbol: p.symbol, side: opposite(p.side), ticks, qty, remaining: qty, role: 'target', kind: 'maker', activeAt: time + this.config.latencyMs, expires: time + this.config.maxHoldMs, queue: undefined, signal: p.signal };
      this.orders.set(o.id, o); this.log('TARGET_SUBMITTED', o);
    });
  }
  private closeFill(p: Position, qty: number, price: number, maker: boolean, time: number): void {
    const fee = qty * price * (maker ? this.config.makerFee : this.config.takerFee), pnl = direction(p.side) * (price - p.entry) * qty - fee;
    p.qty -= qty; p.net += pnl; p.fees += fee; p.exitQty += qty; p.exitValue += price * qty;
    this.realized += pnl; this.fees += fee;
    this.log('FILL', { role: 'exit', symbol: p.symbol, qty, price, maker, fee, net: pnl, time, reason: p.exitReason ?? 'TARGET' });
    if (p.qty > this.manager.book('futures', p.symbol).instrument.step * 1e-8) return;
    const closed: ClosedTrade = { symbol: p.symbol, strategy: p.signal.strategy, side: p.side, opened: p.opened, closed: time, entry: p.entry, exit: p.exitValue / p.exitQty, qty: p.enteredQty, fees: p.fees, net: p.net, reason: p.exitReason ?? 'TARGET', inPlay: p.signal.inPlay };
    this.positions.delete(p.symbol); this.cancelAll(p.symbol, 'POSITION_CLOSED'); this.closed.push(closed);
    this.closedCount++; if (closed.net > 0) this.wins++; if (this.closed.length > 200) this.closed.shift();
    this.log('TRADE_CLOSED', closed);
  }
}
