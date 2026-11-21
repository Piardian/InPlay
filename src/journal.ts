import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const epoch = Date.now(), start = performance.now();
export const now = (): number => Math.round(epoch + performance.now() - start);
export class Journal {
  private stream: WriteStream;
  private failed?: Error;
  readonly path: string;
  constructor(dir: string, config: unknown) {
    this.path = join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
    mkdirSync(this.path, { recursive: true });
    writeFileSync(join(this.path, 'config.json'), JSON.stringify(config, null, 2));
    this.stream = createWriteStream(join(this.path, 'events.jsonl'), { flags: 'ax' });
    this.stream.on('error', error => { this.failed = error; });
  }
  write(type: string, data: unknown): void {
    if (this.failed) throw this.failed;
    if (this.stream.writableLength > 16 * 1024 * 1024) throw new Error('Journal backpressure exceeded 16MB; stopping');
    this.stream.write(JSON.stringify({ at: now(), type, data }) + '\n');
  }
  async close(): Promise<void> {
    if (this.failed) throw this.failed;
    await new Promise<void>((resolve, reject) => { this.stream.once('error', reject); this.stream.end(resolve); });
  }
}
