import type { Config } from '../config.js';
import type { EntryDecision, EntryPolicy, Signal } from '../types.js';
import type { InPlayScanner } from './inPlayScanner.js';
import type { OrderBookManager } from './orderBookManager.js';
import type { TapeAnalyzer } from './tapeAnalyzer.js';

/** Fixed v2 hypothesis: fresh classified news AND participation AND directional reaction.
 * All numbers are research settings, not ACE rules or measured optima. */
export class InPlayPolicy implements EntryPolicy {
  private observed = new Map<string, { reason: string; time: number }>();
  constructor(private c: Config, private scanner: InPlayScanner, private manager: OrderBookManager,
    private tape: TapeAnalyzer, private log: (type: string, data: unknown) => void) {}
  check(symbol: string, time: number, signal?: Signal): EntryDecision {
    const snapshot = this.scanner.snapshot(symbol, time);
    const blocked = (reason: string, extra: object = {}): EntryDecision => ({ allowed: false, reason, evidence: { ...snapshot, ...extra } });
    if (!snapshot.eligible) return blocked(snapshot.reason);
    const b = this.manager.books.get(`futures:${symbol}`);
    if (!b || !b.healthy(time, this.c.staleMs, this.c.levels)) return blocked('BOOK_WARMUP_OR_STALE');
    const bid = b.top('bid', 1)[0]![0], ask = b.top('ask', 1)[0]![0], mid = (bid + ask) / 2;
    const spreadBps = (ask - bid) / mid * 10000;
    const roundTripCostBps = spreadBps + (this.c.takerFee + this.c.makerFee) * 10000 + this.c.slippageTicks / mid * 10000;
    const evidence = { ...snapshot, spreadBps, roundTripCostBps, rangeCostRatio: snapshot.range60sBps / roundTripCostBps };
    if (ask - bid > this.c.maxSpreadTicks || spreadBps > this.c.inPlay.maxSpreadBps) return blocked('SPREAD_TOO_WIDE', evidence);
    if (snapshot.range60sBps < roundTripCostBps * this.c.inPlay.minRangeCostRatio) return blocked('RANGE_BELOW_COST_BUFFER', evidence);
    if (signal) {
      const original = signal.inPlay as { newsId?: string } | undefined;
      if (original?.newsId && original.newsId !== snapshot.newsId) return blocked('CATALYST_REPLACED', evidence);
      if (!this.c.setups.includes(signal.strategy)) return blocked('SETUP_NOT_ENABLED', evidence);
      if (signal.side !== snapshot.side) return blocked('REACTION_DIRECTION_MISMATCH', evidence);
      const leader = this.manager.book('futures', 'BTCUSDT');
      if (this.tape.leaderOpposes(signal.side, leader.instrument.tick, time)) return blocked('BTC_OPPOSES', evidence);
    }
    return { allowed: true, reason: 'IN_PLAY_CONFIRMED', evidence };
  }
  observe(symbol: string, time: number): EntryDecision {
    const d = this.check(symbol, time), old = this.observed.get(symbol);
    if (!old || old.reason !== d.reason || (d.allowed && time - old.time >= 5000)) {
      this.observed.set(symbol, { reason: d.reason, time });
      this.log('IN_PLAY_DECISION', { ruleVersion: 'crypto-inplay-v2', symbol, time, ...d });
    }
    return d;
  }
}
