import WebSocket from 'ws';
import { z } from 'zod';
import type { Config } from '../config.js';
import { now } from '../journal.js';
import { key, ticks, type Depth, type Instrument, type Level, type Market, type Trade } from '../types.js';
import { LocalOrderBook } from '../engine/orderBookManager.js';
import { errorDetails, transientNetworkError } from '../diagnostics.js';
import type { OrderBookManager } from '../engine/orderBookManager.js';

const REST = { spot: 'https://api.binance.com', futures: 'https://fapi.binance.com' };
const num = z.number().int().nonnegative().safe();
const decimal = z.string().refine(v => Number.isFinite(Number(v)) && Number(v) >= 0, 'nonnegative decimal');
const levels = z.array(z.tuple([decimal, decimal]));
const depthSchema = z.object({ e: z.literal('depthUpdate'), s: z.string(), E: num, U: num, u: num, pu: num.optional(), b: levels, a: levels });
const tradeSchema = z.object({ e: z.literal('aggTrade'), s: z.string(), a: num, T: num, p: decimal, q: decimal, m: z.boolean() });
const snapshotSchema = z.object({ lastUpdateId: num, bids: levels, asks: levels });
const infoSchema = z.object({ symbols: z.array(z.object({ symbol: z.string(), status: z.string(), baseAsset: z.string(), quoteAsset: z.string(), contractType: z.string().optional(), isSpotTradingAllowed: z.boolean().optional(), filters: z.array(z.object({ filterType: z.string() }).passthrough()) })) });
const tickersSchema = z.array(z.object({ symbol: z.string(), quoteVolume: decimal }));
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) {
        if (r.status === 418 || r.status === 429) {
          // Stop instead of retrying into an IP ban; operator can restart after Retry-After.
          throw new Error(`RATE_LIMIT ${r.status}, Retry-After=${r.headers.get('retry-after') ?? 'unspecified'}: ${url}`);
        }
        if (r.status < 500) throw new Error(`HTTP_FATAL ${r.status}: ${url}`);
        throw new Error(`HTTP ${r.status}: ${url}`);
      }
      return await r.json();
    } catch (error) {
      if (attempt === 3 || /RATE_LIMIT|HTTP_FATAL/.test(String(error))) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
  throw new Error('Request attempts exhausted');
}

export async function discover(config: Config): Promise<{ symbols: string[]; instruments: Instrument[]; catalog: Instrument[]; futureSymbols: string[] }> {
  const results = await Promise.allSettled([
    getJson(`${REST.spot}/api/v3/exchangeInfo`), getJson(`${REST.futures}/fapi/v1/exchangeInfo`),
    getJson(`${REST.spot}/api/v3/ticker/24hr`), getJson(`${REST.futures}/fapi/v1/ticker/24hr`)
  ]);
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) throw new Error(`Discovery failed: ${failures.map(f => String(f.reason)).join('; ')}`);
  const values = results.map(r => r.status === 'fulfilled' ? r.value : undefined);
  const infos = { spot: infoSchema.parse(values[0]), futures: infoSchema.parse(values[1]) };
  const spotVolumes = new Map(tickersSchema.parse(values[2]).map(t => [t.symbol, Number(t.quoteVolume)]));
  const futuresVolumes = new Map(tickersSchema.parse(values[3]).map(t => [t.symbol, Number(t.quoteVolume)]));
  const eligible = new Map(infos.spot.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false).map(s => [s.symbol, s]));
  const stables = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE', 'USD1', 'BUSD']);
  const common = infos.futures.symbols.filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && eligible.has(s.symbol) && !stables.has(s.baseAsset));
  const ranked = common.sort((a, b) => {
    const score = (s: string): number => Math.min(spotVolumes.get(s) ?? 0, futuresVolumes.get(s) ?? 0);
    return score(b.symbol) - score(a.symbol) || a.symbol.localeCompare(b.symbol);
  });
  const symbols = config.symbols.length ? [...new Set(config.symbols)] : ranked.slice(0, config.symbolCount).map(s => s.symbol);
  if (symbols.length !== (config.symbols.length || config.symbolCount)) throw new Error('Insufficient common instruments or duplicate symbols');
  for (const s of [...symbols, 'BTCUSDT']) if (!common.some(c => c.symbol === s)) throw new Error(`Not an eligible spot + perpetual pair: ${s}`);
  const instruments: Instrument[] = [];
  const catalog: Instrument[] = [];
  // BTC is an additional leader feed if the requested universe excludes it.
  for (const market of ['spot', 'futures'] as const) for (const symbol of common.map(c => c.symbol)) {
    const s = infos[market].symbols.find(i => i.symbol === symbol)!;
    const filter = (name: string): Record<string, unknown> => s.filters.find(f => f.filterType === name) ?? {};
    const tick = Number(filter('PRICE_FILTER').tickSize), step = Number(filter('LOT_SIZE').stepSize), minQty = Number(filter('LOT_SIZE').minQty);
    const notional = filter('MIN_NOTIONAL'), minNotional = Number(notional.minNotional ?? notional.notional ?? filter('NOTIONAL').minNotional ?? 0);
    if (!(tick > 0 && step > 0 && minQty > 0 && Number.isFinite(minNotional))) throw new Error(`Invalid instrument filters ${market}:${symbol}`);
    const instrument = { symbol, market, tick, step, minQty, minNotional };
    catalog.push(instrument);
    if (symbols.includes(symbol) || symbol === 'BTCUSDT') instruments.push(instrument);
  }
  return { symbols, instruments, catalog, futureSymbols: infos.futures.symbols.filter(s => s.status === 'TRADING' && ['USDT', 'USDC'].includes(s.quoteAsset)).map(s => s.symbol) };
}

interface SyncState { buffer: Depth[]; loading: boolean; generation: number; ready: boolean; failures: number; retryAt: number }
interface Hooks {
  depth: (d: Depth) => void; trade: (t: Trade) => void;
  invalid: (market: Market, symbol: string, reason: string) => void;
  log: (type: string, data: unknown) => void; fatal: (error: unknown) => void;
}
export class BinanceWs {
  private states = new Map<string, SyncState>(); private sockets = new Set<WebSocket>();
  private timers = new Set<ReturnType<typeof setTimeout>>(); private stopped = false;
  private snapshotJobs: (() => Promise<void>)[] = []; private activeJobs = 0;
  constructor(private manager: OrderBookManager, private instruments: Instrument[], private hooks: Hooks,
    private requestJson: (url: string) => Promise<unknown> = getJson) {
    for (const i of instruments) this.states.set(key(i.market, i.symbol), { buffer: [], loading: false, generation: 0, ready: false, failures: 0, retryAt: 0 });
  }
  start(): void {
    const symbols = [...new Set(this.instruments.map(i => i.symbol))];
    this.connect('spot', ['depth', 'trade'], 'wss://stream.binance.com:9443', symbols);
    this.connect('futures', ['depth'], 'wss://fstream.binance.com/public', symbols);
    this.connect('futures', ['trade'], 'wss://fstream.binance.com/market', symbols);
  }
  addSymbol(symbol: string, catalog: Instrument[]): void {
    if (this.stopped || this.states.has(key('futures', symbol))) return;
    const pair = catalog.filter(i => i.symbol === symbol);
    if (pair.length !== 2) throw new Error(`Missing spot/futures instruments: ${symbol}`);
    for (const i of pair) {
      this.manager.books.set(key(i.market, symbol), new LocalOrderBook(i));
      this.states.set(key(i.market, symbol), { buffer: [], loading: false, generation: 0, ready: false, failures: 0, retryAt: 0 });
    }
    this.connect('spot', ['depth', 'trade'], 'wss://stream.binance.com:9443', [symbol]);
    this.connect('futures', ['depth'], 'wss://fstream.binance.com/public', [symbol]);
    this.connect('futures', ['trade'], 'wss://fstream.binance.com/market', [symbol]);
  }
  stop(): void {
    this.stopped = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    for (const ws of this.sockets) ws.terminate(); this.sockets.clear(); this.snapshotJobs = [];
  }
  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) fn(); }, ms); this.timers.add(timer); return timer;
  }
  private invalidate(market: Market, symbol: string, reason: string): void {
    const state = this.states.get(key(market, symbol))!;
    state.generation++; state.ready = false; state.loading = false; state.buffer = [];
    this.manager.invalidate(market, symbol); this.hooks.invalid(market, symbol, reason);
  }
  private connect(market: Market, kinds: ('depth' | 'trade')[], base: string, symbols: string[], attempt = 0): void {
    if (this.stopped) return;
    const streams = symbols.flatMap(s => kinds.map(k => `${s.toLowerCase()}@${k === 'depth' ? 'depth@100ms' : 'aggTrade'}`));
    const ws = new WebSocket(`${base}/stream?streams=${streams.join('/')}`, { perMessageDeflate: false, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
    this.sockets.add(ws); let lastMessage = now(), opened = 0;
    const watch = (): void => { if (ws.readyState === WebSocket.OPEN && now() - lastMessage > 15000) ws.terminate(); else if (ws.readyState !== WebSocket.CLOSED) this.later(watch, 5000); };
    this.later(watch, 5000);
    const rotation = this.later(() => ws.terminate(), 23 * 60 * 60 * 1000);
    ws.on('open', () => { opened = now(); this.hooks.log('WS_OPEN', { market, kinds }); });
    // ws automatically echoes server ping payloads in pong frames.
    ws.on('message', raw => {
      if (this.stopped) return;
      lastMessage = now();
      try {
        const envelope: unknown = JSON.parse(raw.toString());
        const object = z.object({ data: z.record(z.string(), z.unknown()) }).parse(envelope).data;
        if (object.e === 'serverShutdown') { ws.terminate(); return; }
        if (object.e === 'depthUpdate') this.depth(market, object, lastMessage);
        else if (object.e === 'aggTrade') this.trade(market, object, lastMessage);
        else throw new Error(`Unexpected stream event: ${String(object.e)}`);
      } catch (error) {
        this.hooks.log('MARKET_PACKET_FAILED', { market, kinds, error: errorDetails(error), sample: raw.toString().slice(0, 8192) });
        this.hooks.fatal(error);
      }
    });
    ws.on('error', error => { if (!this.stopped) this.hooks.log('WS_ERROR', { market, kinds, error: errorDetails(error) }); });
    ws.on('close', (code, reason) => {
      this.sockets.delete(ws); clearTimeout(rotation); this.timers.delete(rotation);
      if (this.stopped) return;
      for (const symbol of symbols) {
        if (kinds.includes('depth')) this.invalidate(market, symbol, 'depth_disconnect');
        else this.hooks.invalid(market, symbol, 'tape_disconnect');
      }
      const nextAttempt = opened && now() - opened > 30000 ? 0 : attempt + 1;
      const wait = Math.min(30000, 500 * 2 ** Math.min(nextAttempt, 6)) + Math.floor(Math.random() * 300);
      this.hooks.log('WS_RECONNECT', { market, kinds, wait, code, reason: reason.toString() });
      this.later(() => this.connect(market, kinds, base, symbols, nextAttempt), wait);
    });
  }
  private convert(market: Market, symbol: string, data: [string, string][]): Level[] {
    const i = this.manager.book(market, symbol).instrument;
    return data.map(([p, q]) => [ticks(p, i.tick), Number(q)]);
  }
  private trade(market: Market, raw: unknown, received: number): void {
    const t = tradeSchema.parse(raw), i = this.manager.book(market, t.s).instrument;
    if (Number(t.q) <= 0) throw new Error('Nonpositive trade quantity');
    this.hooks.trade({ market, symbol: t.s, id: t.a, ticks: ticks(t.p, i.tick), qty: Number(t.q), side: t.m ? 'sell' : 'buy', time: t.T, received });
  }
  private depth(market: Market, raw: unknown, received: number): void {
    const d = depthSchema.parse(raw);
    if (market === 'futures' && d.pu === undefined) throw new Error('Futures depth missing pu');
    const event: Depth = { market, symbol: d.s, first: d.U, last: d.u, previous: d.pu, time: d.E, received, bids: this.convert(market, d.s, d.b), asks: this.convert(market, d.s, d.a) };
    if (event.first > event.last) throw new Error('Inverted depth sequence');
    const state = this.states.get(key(market, d.s))!;
    if (!state.ready) {
      if (state.buffer.length >= 5000) { this.invalidate(market, d.s, 'depth_buffer_overflow'); return; }
      state.buffer.push(event); if (!state.loading && received >= state.retryAt) this.snapshot(market, d.s); return;
    }
    const result = this.manager.book(market, d.s).apply(event);
    if (result === 'gap') { this.invalidate(market, d.s, 'sequence_gap'); state.buffer.push(event); this.snapshot(market, d.s); }
    else if (result === 'ok') {
      const book = this.manager.book(market, d.s), needed = this.manager.config.levels;
      if (book.top('bid', needed).length < needed || book.top('ask', needed).length < needed) {
        this.invalidate(market, d.s, 'snapshot_coverage_exhausted'); this.snapshot(market, d.s); return;
      }
      this.hooks.depth(event);
    }
  }
  private pump(): void {
    while (!this.stopped && this.activeJobs < 2 && this.snapshotJobs.length) {
      const job = this.snapshotJobs.shift()!; this.activeJobs++;
      void job().catch(error => this.hooks.fatal(error)).finally(() => { this.activeJobs--; this.pump(); });
    }
  }
  private snapshot(market: Market, symbol: string): void {
    const state = this.states.get(key(market, symbol))!;
    if (state.loading || this.stopped || now() < state.retryAt) return;
    state.loading = true; const generation = state.generation;
    this.snapshotJobs.push(async () => {
      if (this.stopped || state.generation !== generation) return;
      const path = market === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
      let response: unknown;
      try { response = await this.requestJson(`${REST[market]}${path}?symbol=${symbol}&limit=1000`); }
      catch (error) {
        if (this.stopped || state.generation !== generation) return;
        this.hooks.log('SNAPSHOT_REQUEST_FAILED', { market, symbol, error: errorDetails(error), recoverable: transientNetworkError(error) });
        if (!transientNetworkError(error)) throw error; // rate limits and configuration faults still halt safely
        this.invalidate(market, symbol, 'snapshot_network_failure');
        const wait = Math.min(60000, 5000 * 2 ** Math.min(state.failures++, 4));
        state.retryAt = now() + wait;
        const nextGeneration = state.generation;
        this.hooks.log('SNAPSHOT_RETRY', { market, symbol, wait });
        this.later(() => { if (state.generation === nextGeneration && !state.ready && !state.loading) this.snapshot(market, symbol); }, wait);
        return;
      }
      const raw = snapshotSchema.parse(response);
      if (this.stopped || state.generation !== generation) return;
      const book = this.manager.book(market, symbol);
      book.snapshot({ last: raw.lastUpdateId, bids: this.convert(market, symbol, raw.bids), asks: this.convert(market, symbol, raw.asks) });
      const buffer = state.buffer; state.buffer = []; state.loading = false; state.ready = true; state.failures = 0; state.retryAt = 0;
      let latest: Depth | undefined;
      for (const d of buffer) {
        const result = book.apply(d);
        if (result === 'gap') {
          this.invalidate(market, symbol, 'snapshot_bridge_gap');
          this.later(() => { if (!state.loading && !state.ready) this.snapshot(market, symbol); }, 1000); return;
        }
        if (result === 'ok') latest = d;
      }
      if (latest) this.hooks.depth(latest);
      // No bridging event yet: the next live event still has to span the snapshot.
      this.hooks.log('BOOK_SNAPSHOT', { market, symbol, last: raw.lastUpdateId, appliedLast: book.last, ...(this.manager.config.record ? { bids: [...book.bids], asks: [...book.asks], received: book.received } : {}) });
    }); this.pump();
  }
}
