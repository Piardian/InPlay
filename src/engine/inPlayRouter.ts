import type { Instrument } from '../types.js';
import type { InPlayScanner } from './inPlayScanner.js';

export class InPlayRouter {
  private reasons = new Map<string, string>();
  private initialCount: number;
  constructor(private symbols: string[], private catalog: Instrument[], private scanner: InPlayScanner,
    private attach: (symbol: string) => void, private log: (type: string, data: unknown) => void, private extraCapacity = 15) { this.initialCount = symbols.length; }
  update(time: number): void {
    for (const symbol of this.scanner.candidates(time)) {
      if (this.symbols.includes(symbol)) continue;
      const pair = this.catalog.filter(i => i.symbol === symbol);
      const reason = !pair.some(i => i.market === 'spot') || !pair.some(i => i.market === 'futures') ? 'SPOT_CONFIRMATION_UNAVAILABLE' :
        this.symbols.length >= this.initialCount + this.extraCapacity ? 'DYNAMIC_BOOK_CAPACITY_15' : undefined;
      if (reason) {
        if (this.reasons.get(symbol) !== reason) this.log('IN_PLAY_UNROUTABLE', { symbol, reason });
        this.reasons.set(symbol, reason); continue;
      }
      this.attach(symbol); this.symbols.push(symbol);
      this.log('IN_PLAY_BOOK_ATTACHED', { ruleVersion: 'crypto-inplay-v2', symbol, time });
    }
  }
}
