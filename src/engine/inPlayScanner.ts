import { configSchema, type Config } from '../config.js';
import type { Side } from '../types.js';
import type { NewsOutcome } from '../connectors/treeDecoder.js';
export type InPlayMode = 'IN_PLAY_NEWS' | 'IN_PLAY_RVOL';
export interface Catalyst { symbol: string; mode: InPlayMode; time: number; details: Record<string, unknown> }
interface Bucket { usd: number; ticks: number; first: number; last: number; high: number; low: number }
interface Window {
  since: number; lastTime: number; received: number; id: number; price: number; reconnectingAt?: number;
  buckets: Map<number, Bucket>; evaluated: number; current: number; previous: number; ticks: number;
  first: number; high: number; low: number; fired: boolean;
}
interface News { id: string; published: number; received: number; expires: number; anchor?: number; source: string; topic: string }
export interface InPlaySnapshot {
  eligible: boolean; reason: string; side?: Side; newsId?: string; newsSource?: string; newsTopic?: string;
  newsReceived?: number; newsPublished?: number; newsExpires?: number; anchor?: number;
  volume60s: number; previous30mMean: number; rvol: number; aggTicksPerSecond: number;
  priceChange60s: number; range60sBps: number; reactionBps: number; warmed: boolean; marketTime?: number;
}
const object = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
export class InPlayScanner {
  private windows = new Map<string, Window>();
  private seen = new Map<string, number>();
  private newsItems = new Map<string, News>();
  private rvolCatalysts = new Map<string, { time: number; expires: number; anchor?: number; priceChange60s: number }>();
  private prices = new Map<string, { time: number; price: number }[]>();
  constructor(private symbols: Set<string>, private emit: (event: Catalyst) => void,
    private log: (type: string, data: unknown) => void = () => {}, private c: Config = configSchema.parse({})) {}

  candidates(time: number): string[] {
    for (const [s, n] of this.newsItems) if (n.expires <= time) this.newsItems.delete(s);
    for (const [s, r] of this.rvolCatalysts) if (r.expires <= time) this.rvolCatalysts.delete(s);
    return [...new Set([...this.newsItems.keys(), ...this.rvolCatalysts.keys()])];
  }
  mode(symbol: string, time: number): string {
    const s = this.snapshot(symbol, time);
    return s.eligible ? 'IN_PLAY_CONFIRMED' : s.newsId ? `NEWS_WAIT:${s.reason}` : 'WATCH';
  }
  news(raw: unknown, received: number): NewsOutcome {
    const n = object(raw); if (!n) return { accepted: 0, reason: 'NEWS_NOT_OBJECT' };
    const title = typeof n.title === 'string' ? n.title : '', en = typeof n.en === 'string' ? n.en : '', body = typeof n.body === 'string' ? n.body : '';
    const rawSource = ['source', 'sourceName', 'name'].map(k => typeof n[k] === 'string' ? n[k] : '').join(' ').trim();
    const handle = !rawSource ? title.match(/\(@(coinbase|CoinbaseAssets|CoinbaseMarkets|CoinbaseIntExch|binance|BinanceFutures|upbitglobal|BithumbOfficial|SECGov)\)\s*$/i)?.[1] : undefined;
    const source = rawSource || (handle ? `@${handle}` : '');
    // Claimed publisher field or verified official handle in Tree's Twitter format, never an exchange name merely mentioned in the body/title.
    const trusted = /^(Binance EN|Upbit|Bithumb|Coinbase|Blogs COINBASE|usGov SEC)(?:$|\s)/i.test(rawSource) || Boolean(handle);
    const text = `${title} ${en} ${body}`;
    const negative = /\b(delist(?:s|ing|ed)?|suspend(?:s|ed|ing)?|removal|investment warning)\b|유의\s*종목|거래지원\s*종료/i.test(text);
    const topic = negative ? undefined : /(\b(list(?:s|ing)?|launchpool|roadmap|new trading support|market addition)\b|\bwill launch\b[\s\S]*\bperpetual\b|\b(?:spot\s+)?trading for\b[\s\S]*\bwill go live\b|신규\s*거래지원|\[마켓\s*추가\])/i.test(text) ? 'LISTING' : /\b(ETF|SEC)\b/i.test(text) ? 'REGULATORY' : undefined;
    if (!trusted && !topic) return { accepted: 0, reason: 'NEWS_IRRELEVANT' };
    let published = typeof n.time === 'number' ? n.time : typeof n.time === 'string' ? (/^\d+(\.\d+)?$/.test(n.time) ? Number(n.time) : Date.parse(n.time)) : NaN;
    if (published > 1e9 && published < 1e11) published *= 1000;
    const reason = !trusted ? 'NEWS_SOURCE_UNVERIFIED' : !topic ? 'NEWS_TOPIC_UNCLASSIFIED' : !Number.isFinite(published) ? 'NEWS_TIMESTAMP_MISSING' : received - published > this.c.inPlay.maxNewsAgeMs || published > received + 5000 ? 'NEWS_STALE_OR_FUTURE' : undefined;
    if (reason) {
      // Research-only counter: a topical, symbol-bearing event blocked only by
      // the strict publisher whitelist. It never enters newsItems or the router.
      const nearCandidate = reason === 'NEWS_SOURCE_UNVERIFIED' && topic && Array.isArray(n.suggestions) && n.suggestions.length > 0 ? 1 : 0;
      this.log('NEWS_REJECTED', { reason, title, source, nearCandidate });
      return { accepted: 0, reason, nearCandidate };
    }
    if (!Array.isArray(n.suggestions)) { this.log('NEWS_REJECTED', { reason: 'NEWS_SYMBOL_MISSING', title }); return { accepted: 0, reason: 'NEWS_SYMBOL_MISSING' }; }
    for (const [k, until] of this.seen) if (until <= received) this.seen.delete(k);
    const id = String(n._id ?? n.id ?? `${source}|${title}|${body}`);
    if (this.seen.has(id)) return { accepted: 0, reason: 'NEWS_DUPLICATE' };
    if (this.seen.size >= 10000) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(id, received + 3600000);
    const resolved = new Set<string>();
    for (const suggestion of n.suggestions) {
      const item = object(suggestion), coin = typeof suggestion === 'string' ? suggestion : item?.coin ?? item?.symbol;
      if (typeof coin === 'string') {
        const normalized = coin.toUpperCase().replace(/^\$/, '');
        for (const s of [normalized, `${normalized}USDT`, `${normalized}USDC`]) if (this.symbols.has(s)) resolved.add(s);
      }
      if (Array.isArray(item?.symbols)) for (const pairRaw of item.symbols) {
        const pair = object(pairRaw);
        if (typeof pair?.symbol !== 'string' || !/^binance(?:-futures)?$/i.test(String(pair.exchange))) continue;
        const s = pair.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (this.symbols.has(s)) resolved.add(s);
      }
    }
    if (topic === 'LISTING') {
      const quoteAssets = new Set(['KRW', 'BTC', 'USDT', 'USDC', 'USD']);
      const header = `${title} ${en}`;
      const explicitTokens: string[] = [];
      for (const m of header.matchAll(/\(([A-Z0-9]{2,12})\)/g)) {
        const token = m[1]!;
        if (!quoteAssets.has(token)) {
          explicitTokens.push(token);
          for (const s of [token, `${token}USDT`, `${token}USDC`]) if (this.symbols.has(s)) resolved.add(s);
        }
      }
      for (const m of text.matchAll(/\b([A-Z0-9]{2,12})(?:USDT|USDC)\s+Perpetual\b/gi)) {
        const token = m[1]!.toUpperCase();
        explicitTokens.push(token);
        for (const s of [token, `${token}USDT`, `${token}USDC`]) if (this.symbols.has(s)) resolved.add(s);
      }
      const hasQuoteMarketList = /\((?:[^)]*\bKRW\b[^)]*\bBTC\b|\bBTC\b[^)]*\bUSDT\b)[^)]*\)/i.test(header);
      if (hasQuoteMarketList && (explicitTokens.length > 0 || [...resolved].some(s => s !== 'BTCUSDT' && s !== 'BTCUSDC'))) {
        resolved.delete('BTCUSDT');
        resolved.delete('BTCUSDC');
      }
    }
    let accepted = 0;
    for (const symbol of resolved) {
      const old = this.newsItems.get(symbol);
      if (old && old.published >= published) continue; // no rollback to a delayed older catalyst
      const w = this.windows.get(symbol), anchor = w && received - w.received <= this.c.maxEventLagMs ? w.price : undefined;
      const news: News = { id, published, received, expires: Math.min(published, received) + this.c.inPlay.newsTtlMs, source, topic: topic!, anchor };
      this.newsItems.set(symbol, news);
      accepted++;
      this.emit({ symbol, mode: 'IN_PLAY_NEWS', time: received, details: { title, body, ...news, classification: 'keyword_topic_not_economic_importance' } });
    }
    return { accepted, reason: accepted ? 'NEWS_ACCEPTED' : resolved.size ? 'NEWS_OLDER_THAN_CURRENT' : 'NEWS_SYMBOL_UNSUPPORTED' };
  }
  reset(symbols: string[]): void {
    for (const s of symbols) { this.windows.delete(s); this.prices.delete(s); this.rvolCatalysts.delete(s); const n = this.newsItems.get(s); if (n) n.anchor = undefined; }
  }
  reconnect(symbols: string[], time = Infinity): void {
    for (const s of symbols) {
      const w = this.windows.get(s);
      if (w) w.reconnectingAt = w.reconnectingAt ?? time;
    }
  }
  mini(raw: unknown, received: number): void {
    if (!Array.isArray(raw)) return;
    for (const rawItem of raw) {
      const t = object(rawItem); if (!t || typeof t.s !== 'string' || !this.symbols.has(t.s) || !Number.isSafeInteger(t.E) || Math.abs(received - Number(t.E)) > this.c.maxEventLagMs) continue;
      const p = Number(t.c), time = Number(t.E); if (!(p > 0 && Number.isFinite(p))) continue;
      const a = this.prices.get(t.s) ?? [];
      if (a.length && time <= a.at(-1)!.time) continue;
      a.push({ time, price: p });
      while (a.length && a[0]!.time < time - 60000) a.shift();
      this.prices.set(t.s, a);
    }
  }
  metrics(symbol: string): { priceChange60s: number; updates: number } {
    const p = this.prices.get(symbol) ?? [];
    return { priceChange60s: p.length > 1 ? p.at(-1)!.price / p[0]!.price - 1 : 0, updates: p.length };
  }
  private sum(w: Window, sec: number): void {
    if (w.evaluated === sec) return;
    w.current = 0; w.previous = 0; w.ticks = 0; w.first = 0; w.high = 0; w.low = Infinity;
    for (const [k, b] of w.buckets) {
      // Retain a small lag margin: a clock-based query may run ahead of the next
      // exchange timestamp. Never destroy that delayed event's baseline bins.
      if (k < sec - 1870) { w.buckets.delete(k); continue; }
      if (k < sec - 1859) continue;
      if (k > sec) continue;
      if (k > sec - 60) {
        w.current += b.usd; w.ticks += b.ticks; w.first ||= b.first;
        w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low);
      } else w.previous += b.usd;
    }
    w.evaluated = sec;
  }
  snapshot(symbol: string, time: number): InPlaySnapshot {
    const w = this.windows.get(symbol), n = this.newsItems.get(symbol);
    const rvolCat = this.c.inPlay.allowRvolCatalyst ? this.rvolCatalysts.get(symbol) : undefined;
    const sec = Math.floor(time / 1000);
    if (w) this.sum(w, sec);
    const average = (w?.previous ?? 0) / 30;
    const anchorPrice = n?.anchor ?? rvolCat?.anchor;
    const reactionBps = w && anchorPrice ? (w.price / anchorPrice - 1) * 10000 : (rvolCat ? rvolCat.priceChange60s * 10000 : 0);
    const s: InPlaySnapshot = {
      eligible: false, reason: 'NO_FRESH_NEWS', volume60s: w?.current ?? 0, previous30mMean: average,
      rvol: average > 0 ? (w?.current ?? 0) / average : 0, aggTicksPerSecond: (w?.ticks ?? 0) / 60,
      priceChange60s: w?.first ? w.price / w.first - 1 : 0,
      range60sBps: w && w.first && Number.isFinite(w.low) ? (w.high - w.low) / w.first * 10000 : 0,
      reactionBps, warmed: !!w && sec - w.since >= 1860, marketTime: w?.lastTime,
      ...(n ? { newsId: n.id, newsSource: n.source, newsTopic: n.topic, newsReceived: n.received,
        newsPublished: n.published, newsExpires: n.expires, anchor: n.anchor } :
        rvolCat ? { newsId: `rvol:${symbol}`, newsSource: 'RVOL_SCANNER', newsTopic: 'VOLUME_SURGE',
          newsReceived: rvolCat.time, newsPublished: rvolCat.time, newsExpires: rvolCat.expires, anchor: rvolCat.anchor } : {})
    };
    const hasActiveNews = !!n && n.expires > time && n.received <= time;
    const hasActiveRvol = !!rvolCat && rvolCat.expires > time && rvolCat.time <= time;
    if (!hasActiveNews && !hasActiveRvol) return s;
    if (!w || time - w.received > this.c.staleMs || w.lastTime > time + 5000 || w.received > time + 2000) { s.reason = 'SCANNER_STALE'; return s; }
    if (!s.warmed) { s.reason = 'RVOL_WARMUP'; return s; }
    if (average <= 0) { s.reason = 'RVOL_BASE_UNDEFINED'; return s; }
    if (s.volume60s <= this.c.inPlay.minVolumeUsd || s.rvol < this.c.inPlay.minRvol) { s.reason = 'VOLUME_UNCONFIRMED'; return s; }
    if (s.aggTicksPerSecond < this.c.inPlay.minAggTicksPerSecond) { s.reason = 'TICK_FREQUENCY_LOW'; return s; }
    const catReceived = n?.received ?? rvolCat?.time ?? 0;
    if (w.received < catReceived || Math.abs(reactionBps) < this.c.inPlay.minReactionBps) { s.reason = 'PRICE_REACTION_UNCONFIRMED'; return s; }
    s.eligible = true; s.reason = 'CONFIRMED'; s.side = reactionBps > 0 ? 'buy' : 'sell'; return s;
  }
  trade(raw: unknown, received: number): void {
    const t = object(raw); if (!t || typeof t.s !== 'string' || !this.symbols.has(t.s) || t.e !== 'aggTrade') return;
    const s = t.s, time = Number(t.T), id = Number(t.a), p = Number(t.p), q = Number(t.q);
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(id) || time < 0 || id < 0 || !(p > 0 && q > 0 && Number.isFinite(p * q))) { this.reset([s]); return; }
    if (Math.abs(received - time) > this.c.maxEventLagMs) { this.reset([s]); return; }
    const sec = Math.floor(time / 1000);
    let w = this.windows.get(s);
    if (w && id <= w.id) return;
    if (w && w.reconnectingAt !== undefined) {
      if (received - w.reconnectingAt <= 60_000 && time >= w.lastTime) {
        w.id = id - 1;
        w.reconnectingAt = undefined;
      } else {
        this.log('SCANNER_GAP', { symbol: s });
        this.reset([s]);
        w = undefined;
      }
    }
    if (w && (id !== w.id + 1 || time < w.lastTime)) { this.log('SCANNER_GAP', { symbol: s }); this.reset([s]); w = undefined; }
    if (!w) { w = { since: sec, lastTime: time, received, id, price: p, buckets: new Map(), evaluated: -1,
      current: 0, previous: 0, ticks: 0, first: 0, high: 0, low: Infinity, fired: false }; this.windows.set(s, w); }
    w.id = id; w.lastTime = time; w.received = received; w.price = p;
    const n = this.newsItems.get(s); if (n && n.anchor === undefined && received >= n.received) n.anchor = p;
    const b = w.buckets.get(sec) ?? { usd: 0, ticks: 0, first: p, last: p, high: p, low: p };
    b.usd += p * q; b.ticks++; b.last = p; b.high = Math.max(b.high, p); b.low = Math.min(b.low, p); w.buckets.set(sec, b);
    if (w.evaluated === sec) { w.current += p * q; w.ticks++; w.first ||= p; w.high = Math.max(w.high, p); w.low = Math.min(w.low, p); }
    else this.sum(w, sec);
    if (sec - w.since < 1860) return;
    const average = w.previous / 30, rvol = average > 0 ? w.current / average : 0;
    const qualifies = w.current > this.c.inPlay.minVolumeUsd && rvol >= this.c.inPlay.minRvol;
    if (qualifies && !w.fired) {
      if (this.c.inPlay.allowRvolCatalyst) {
        const metrics = this.metrics(s);
        this.rvolCatalysts.set(s, {
          time: received,
          expires: received + this.c.inPlay.rvolTtlMs,
          anchor: w.first || p,
          priceChange60s: metrics.priceChange60s
        });
      }
      this.emit({ symbol: s, mode: 'IN_PLAY_RVOL', time: received,
        details: { volume60s: w.current, previous30mMean: average, rvol, aggTicksPerSecond: w.ticks / 60, ...this.metrics(s) } });
    }
    w.fired = qualifies;
  }
}
