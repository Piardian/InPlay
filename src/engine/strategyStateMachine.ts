import type { Config } from '../config.js';
import { direction, type Signal } from '../types.js';
import type { OrderBookManager } from './orderBookManager.js';
import type { TapeAnalyzer } from './tapeAnalyzer.js';
import type { PaperBroker } from '../simulator/paperBroker.js';
export type State = 'WARMUP' | 'NOT_IN_PLAY' | 'WATCHING' | 'ACTIVE_ENGAGEMENT' | 'ORDER_PENDING' | 'POSITION_OPEN' | 'EXIT_PENDING' | 'COOLDOWN' | 'DATA_STALE';
export class StrategyStateMachine {
  readonly states = new Map<string, State>(); private next = new Map<string, number>(); private wasBusy = new Set<string>();
  signals = 0;
  constructor(private c: Config, private manager: OrderBookManager, private tape: TapeAnalyzer, private broker: PaperBroker, private log: (type: string, data: unknown) => void = () => {}, private setups: readonly Signal['strategy'][] = c.setups) {}
  private state(symbol: string, state: State): void { if (this.states.get(symbol) !== state) { this.states.set(symbol, state); this.log('STATE', { symbol, state }); } }
  evaluate(symbol: string, time: number): void {
    const admission = this.broker.entryDecision(symbol, time);
    if (!admission.allowed) this.broker.cancelEntries(symbol, admission.reason);
    const b = this.manager.book('futures', symbol), spot = this.manager.book('spot', symbol), leader = this.manager.book('futures', 'BTCUSDT');
    const healthy = b.healthy(time, this.c.staleMs, this.c.levels) && spot.healthy(time, this.c.staleMs, this.c.levels) && leader.healthy(time, this.c.staleMs) && this.tape.healthy('futures', symbol, time) && this.tape.healthy('spot', symbol, time) && this.tape.healthy('futures', 'BTCUSDT', time);
    if (!healthy) {
      this.state(symbol, 'DATA_STALE'); this.broker.cancelEntries(symbol, 'UNHEALTHY_FEED');
      if (this.broker.positions.has(symbol)) this.broker.exit(symbol, time, 'DATA_STALE'); return;
    }
    const p = this.broker.positions.get(symbol);
    if (p) {
      this.wasBusy.add(symbol); const w = p.signal.wallId ? this.manager.walls.get(p.signal.wallId) : undefined;
      if (p.signal.wallId && (!w || w.spoof || w.usd < (p.signal.wallInitial ?? 0) * this.c.panicRemaining) && p.signal.strategy === 'A') this.broker.exit(symbol, time, 'PANIC_EXIT');
      if (p.signal.strategy === 'B') {
        const recent = this.tape.pressure('futures', symbol, b.instrument.tick, time).count;
        const previous = this.tape.pressure('futures', symbol, b.instrument.tick, time, 1000, 1000).count;
        p.peakRate = Math.max(p.peakRate, recent);
        if (time - p.opened >= 1000 && previous > 0 && recent < previous * this.c.slowdownRatio) this.broker.exit(symbol, time, 'MOMENTUM_SLOWDOWN');
      }
      this.state(symbol, p.exitReason ? 'EXIT_PENDING' : 'POSITION_OPEN'); return;
    }
    if (!admission.allowed) { this.state(symbol, 'NOT_IN_PLAY'); return; }
    if (this.broker.busy(symbol)) {
      this.wasBusy.add(symbol);
      for (const o of this.broker.orders.values()) if (o.symbol === symbol && o.role === 'entry' && o.signal.wallId) {
        const w = this.manager.walls.get(o.signal.wallId);
        if (!w || w.spoof || !w.verified || w.usd < w.initial * this.c.panicRemaining) this.broker.cancelEntries(symbol, 'WALL_INVALIDATED');
      }
      this.state(symbol, 'ORDER_PENDING'); return;
    }
    if (this.wasBusy.delete(symbol)) this.next.set(symbol, time + this.c.cooldownMs);
    if (time < (this.next.get(symbol) ?? 0)) { this.state(symbol, 'COOLDOWN'); return; }
    this.state(symbol, 'WATCHING');
    const mid = b.mid();
    for (const w of this.manager.active(symbol)) {
      const near = Math.abs(mid - w.ticks) <= Math.max(3, w.ticks * this.c.engagePct);
      if (!near) continue;
      this.state(symbol, 'ACTIVE_ENGAGEMENT');
      const side = w.side === 'bid' ? 'buy' : 'sell', attack = w.side === 'bid' ? 'sell' : 'buy';
      const source = this.manager.walls.get(w.id)!, sourceTick = this.manager.book(w.market, symbol).instrument.tick;
      const pressure = this.tape.pressure(w.market, symbol, sourceTick, time, 2000);
      const atWall = this.tape.attacking(symbol, source.ticks, attack, time, 1000, w.market);
      const entry = b.top(attack === 'buy' ? 'ask' : 'bid', 1)[0]![0];
      const tickSize = b.instrument.tick;
      const minTargetTicks = Math.max(this.c.targetTicks, Math.ceil((entry * tickSize * (this.c.minTargetBps / 10000)) / tickSize));
      const stopDistanceTicks = Math.max(2, Math.ceil((entry * tickSize * (this.c.minStopBps / 10000)) / tickSize));
      if (this.setups.includes('B') && w.usd <= w.initial * this.c.breakRemaining && w.usd > 0 && w.executed >= (w.initial - w.usd) * 0.5 && atWall.usdQty * sourceTick >= w.initial * this.c.breakAttackRatioPerSec) {
        this.emit({ symbol, strategy: 'B', side: attack, kind: 'taker', ticks: entry, stop: w.ticks - direction(attack) * stopDistanceTicks, wallId: w.id, wallInitial: w.initial, targetTicks: minTargetTicks, time, reason: 'execution_supported_wall_depletion' }, time); return;
      }
      const attackingUsd = w.side === 'bid' ? pressure.sell : pressure.buy;
      if (this.setups.includes('A') && w.usd >= w.initial * (1 - this.c.spoofDrop) && attackingUsd < w.usd * this.c.bounceAttackRatio && !this.tape.leaderOpposes(side, leader.instrument.tick, time)) {
        this.emit({ symbol, strategy: 'A', side, kind: 'maker', ticks: w.ticks + direction(side), stop: w.ticks - direction(side) * stopDistanceTicks, wallId: w.id, wallInitial: w.initial, targetTicks: minTargetTicks, time, reason: 'aged_density_weak_aggression' }, time); return;
      }
    }
    const absorption = this.setups.includes('C') ? this.tape.absorption(symbol, b, time) : undefined;
    if (absorption && !this.tape.leaderOpposes(absorption.side, leader.instrument.tick, time)) {
      const entry = b.top(absorption.side === 'buy' ? 'ask' : 'bid', 1)[0]![0];
      const tickSize = b.instrument.tick;
      const minTargetTicks = Math.max(this.c.targetTicks, Math.ceil((entry * tickSize * (this.c.minTargetBps / 10000)) / tickSize));
      const stopDistanceTicks = Math.max(2, Math.ceil((entry * tickSize * (this.c.minStopBps / 10000)) / tickSize));
      this.emit({ symbol, strategy: 'C', side: absorption.side, kind: 'taker', ticks: entry, stop: absorption.ticks - direction(absorption.side) * stopDistanceTicks, targetTicks: minTargetTicks, time, reason: 'absorption_hypothesis_with_attack_slowdown' }, time);
    }
  }
  private emit(signal: Signal, time: number): void {
    const admission = this.broker.entryDecision(signal.symbol, time, signal);
    if (!admission.allowed) { this.log('ENTRY_BLOCKED', { signal, ...admission }); return; }
    this.signals++; this.log('SIGNAL', { ...signal, inPlay: admission.evidence });
    this.next.set(signal.symbol, time + this.c.cooldownMs);
    if (this.c.mode === 'paper') this.broker.submit(signal, time);
  }
}
