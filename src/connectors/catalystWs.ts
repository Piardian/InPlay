import WebSocket from 'ws';
import { now } from '../journal.js';
import type { InPlayScanner } from '../engine/inPlayScanner.js';
import { TreeDecoder } from './treeDecoder.js';
import { errorDetails } from '../diagnostics.js';

/** Public feeds only. One bounded shard per 80 symbols; no API key or login. */
export class CatalystWs {
  private sockets = new Set<WebSocket>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  private counts = new Map<string, number>();
  private health = new Map<string, { connected: boolean; lastMessage?: number; lastPing?: number; lastPong?: number }>();
  // Avoid a reconnect storm: Binance can time out a burst of simultaneous handshakes.
  private connecting = 0;
  private decoder: TreeDecoder;
  constructor(private scanner: InPlayScanner, private symbols: string[], private log: (type: string, data: unknown) => void,
    private fatal: (error: unknown) => void = error => { throw error; }) { this.decoder = new TreeDecoder((raw, time) => scanner.news(raw, time), log); }
  status() { return { messages: Object.fromEntries(this.counts), feeds: Object.fromEntries(this.health), tree: this.decoder.status(),
    connected: [...this.health.values()].filter(f => f.connected).length, expected: 2 + Math.ceil(this.symbols.length / 80) }; }
  start(): void {
    this.connect('tree', 'wss://news.treeofalpha.com/ws', () => {}, []);
    this.later(() => this.connect('miniTicker', 'wss://fstream.binance.com/market/ws/!miniTicker@arr', raw => this.scanner.mini(raw, now()), []), 750);
    for (let i = 0; i < this.symbols.length; i += 80) {
      const shard = this.symbols.slice(i, i + 80);
      const name = `aggTrade-${i / 80}`;
      const url = `wss://fstream.binance.com/market/stream?streams=${shard.map(s => `${s.toLowerCase()}@aggTrade`).join('/')}`;
      this.later(() => this.connect(name, url, raw => this.scanner.trade((raw as { data?: unknown })?.data, now()), shard), 1500 + (i / 80) * 1000);
    }
  }
  stop(): void { this.stopped = true; this.log('CATALYST_FEED_COUNTS', Object.fromEntries(this.counts)); for (const t of this.timers) clearTimeout(t); this.timers.clear(); for (const ws of this.sockets) ws.terminate(); this.sockets.clear(); }
  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms); this.timers.add(t); return t;
  }
  private connect(name: string, url: string, consume: (raw: unknown) => void, symbols: string[], attempt = 0): void {
    if (this.stopped) return;
    if (this.connecting >= 2) {
      this.later(() => this.connect(name, url, consume, symbols, attempt), 1500 + Math.floor(Math.random() * 1000));
      return;
    }
    this.connecting++;
    const ws = new WebSocket(url, { handshakeTimeout: 20_000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    this.sockets.add(ws); let alive = now(), opened = 0, pingAt = 0, messages = 0;
    let handshakePending = true;
    const rotation = this.later(() => ws.terminate(), 23 * 3600_000);
    const watch = (): void => {
      if (ws.readyState === WebSocket.CLOSED) return;
      if (ws.readyState === WebSocket.OPEN) {
        if (pingAt && alive < pingAt && now() - pingAt > 20_000) { ws.terminate(); return; }
        const lastData = this.health.get(name)?.lastMessage ?? opened;
        if (name !== 'tree' && opened && now() - opened > 90000 && now() - lastData > 90000) {
          this.log('CATALYST_DATA_IDLE', { name }); ws.terminate(); return;
        }
        if (!pingAt || now() - pingAt >= 20_000) { pingAt = now(); ws.ping(); }
      }
      this.later(watch, 5000);
    }; this.later(watch, 5000);
    ws.on('open', () => {
      if (handshakePending) { handshakePending = false; this.connecting--; }
      opened = now(); alive = opened; this.health.set(name, { connected: true }); this.log('CATALYST_WS_OPEN', { name, symbols: symbols.length });
    });
    ws.on('pong', () => { alive = now(); this.health.set(name, { ...this.health.get(name), connected: true, lastPong: alive }); });
    ws.on('ping', () => { alive = now(); this.health.set(name, { ...this.health.get(name), connected: true, lastPing: alive }); });
    ws.on('message', raw => {
      if (this.stopped) return;
      messages++; this.counts.set(name, (this.counts.get(name) ?? 0) + 1); alive = now(); const start = performance.now();
      this.health.set(name, { ...this.health.get(name), connected: true, lastMessage: alive });
      try {
        if (name === 'tree') this.decoder.handle(raw.toString(), alive);
        else {
          let value: unknown;
          try { value = JSON.parse(raw.toString()); }
          catch (error) { this.log('CATALYST_BAD_PACKET', { name, error: errorDetails(error), sample: raw.toString().slice(0, 4096) }); ws.terminate(); return; }
          consume(value);
        }
      } catch (error) { this.fatal(error); }
      const ms = performance.now() - start;
      if (ms > 10) this.log('CATALYST_SLOW_PARSE', { name, ms });
    });
    ws.on('error', e => { if (!this.stopped) this.log('CATALYST_WS_ERROR', { name, error: errorDetails(e) }); });
    ws.on('close', (code, reason) => {
      if (handshakePending) { handshakePending = false; this.connecting--; }
      this.sockets.delete(ws); clearTimeout(rotation); this.timers.delete(rotation);
      this.health.set(name, { ...this.health.get(name), connected: false });
      if (this.stopped) return;
      this.log('CATALYST_WS_CLOSED', { name, messages, code, reason: reason.toString(), connectedMs: opened ? now() - opened : 0 });
      this.scanner.reconnect(symbols, now());
      if (this.stopped) return;
      const next = opened && now() - opened > 30_000 ? 0 : attempt + 1;
      const wait = Math.min(30_000, 500 * 2 ** Math.min(next, 6)) + Math.floor(Math.random() * 300);
      this.log('CATALYST_WS_RECONNECT', { name, wait });
      this.later(() => this.connect(name, url, consume, symbols, next), wait);
    });
  }
}
