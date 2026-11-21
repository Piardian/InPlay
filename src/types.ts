export type Market = 'spot' | 'futures';
export type Side = 'buy' | 'sell';
export type BookSide = 'bid' | 'ask';
export type Level = [number, number]; // integer price ticks, base asset quantity
export interface Instrument { symbol: string; market: Market; tick: number; step: number; minQty: number; minNotional: number }
export interface Depth { market: Market; symbol: string; first: number; last: number; previous?: number; bids: Level[]; asks: Level[]; time: number; received: number }
export interface Snapshot { last: number; bids: Level[]; asks: Level[] }
export interface Trade { market: Market; symbol: string; id: number; ticks: number; qty: number; side: Side; time: number; received: number }
export interface Signal { symbol: string; strategy: 'A' | 'B' | 'C'; side: Side; kind: 'maker' | 'taker'; ticks: number; stop: number; wallId?: string; wallInitial?: number; targetTicks: number; time: number; reason: string; inPlay?: unknown }
export interface EntryDecision { allowed: boolean; reason: string; evidence?: unknown }
export interface EntryPolicy {
  check(symbol: string, time: number, signal?: Signal): EntryDecision;
}
export const key = (market: Market, symbol: string): string => `${market}:${symbol}`;
export const opposite = (side: Side): Side => side === 'buy' ? 'sell' : 'buy';
export const direction = (side: Side): number => side === 'buy' ? 1 : -1;
export function ticks(price: string | number, tick: number): number {
  const p = Number(price), n = Math.round(p / tick);
  if (!Number.isFinite(p) || p <= 0 || !Number.isSafeInteger(n) || Math.abs(n * tick - p) > tick * 1e-4) throw new Error(`Invalid tick price ${price}/${tick}`);
  return n;
}
export function floorQty(qty: number, step: number): number { return Number((Math.floor((qty + step * 1e-8) / step) * step).toPrecision(14)); }
