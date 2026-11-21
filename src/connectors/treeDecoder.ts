import { errorDetails } from '../diagnostics.js';
export interface NewsOutcome { accepted: number; reason: string; nearCandidate?: number }
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export class TreeDecoder {
  private counts: Record<string, number> = {};
  lastNewsReceived?: number;
  constructor(private news: (raw: unknown, received: number) => NewsOutcome, private log: (type: string, data: unknown) => void) {}
  status(): object { return { counts: { ...this.counts }, lastNewsReceived: this.lastNewsReceived }; }
  handle(text: string, received: number): void {
    this.log('TREE_RAW_PACKET', { received, bytes: Buffer.byteLength(text), truncated: text.length > 16384, text: text.slice(0, 16384) });
    const count = (kind: string) => { this.counts[kind] = (this.counts[kind] ?? 0) + 1; };
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch (error) { count('NON_JSON'); this.log('TREE_PACKET_CLASSIFIED', { received, kind: 'NON_JSON', error: errorDetails(error) }); return; }
    const root = object(raw), nested = object(root?.data);
    const n = nested && ('title' in nested || 'body' in nested || 'suggestions' in nested) ? nested : root;
    if (!n || !('title' in n || 'body' in n || 'suggestions' in n)) {
      const kind = typeof raw === 'string' || root && ('status' in root || 'message' in root || 'type' in root || 'op' in root) ? 'CONTROL' : 'UNRECOGNIZED';
      count(kind); this.log('TREE_PACKET_CLASSIFIED', { received, kind, keys: root ? Object.keys(root).slice(0, 20) : [] }); return;
    }
    this.lastNewsReceived = received; count('NEWS_PACKET');
    // Callback faults propagate; they are not misreported as malformed JSON.
    const outcome = this.news(n, received);
    count(outcome.reason);
    if ((outcome.nearCandidate ?? 0) > 0) count('NEWS_NEAR_CANDIDATE');
    this.log('TREE_PACKET_CLASSIFIED', { received, kind: 'NEWS', ...outcome, keys: Object.keys(n).slice(0, 20) });
  }
}
