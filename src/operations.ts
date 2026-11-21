import { createServer } from 'node:net';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** OS-owned lock: automatically released even after a forced process termination. */
export async function acquireSingleton(port = 39172): Promise<() => void> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.removeListener('error', reject); accept(); });
  });
  server.unref();
  return () => { server.close(); };
}
export class RuntimeState {
  readonly directory: string;
  lastWriteError?: unknown;
  writeFailures = 0;
  constructor(directory: string, private replaceFile: (from: string, to: string) => void = renameSync) { this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true }); }
  write(data: object): boolean {
    const tmp = join(this.directory, `heartbeat.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, utc: new Date().toISOString(), ...data }, null, 2));
    try {
      this.replaceFile(tmp, join(this.directory, 'heartbeat.json'));
      this.lastWriteError = undefined; return true;
    } catch (error) {
      // A Windows reader/antivirus may briefly deny rename/delete sharing.
      // Preserve the last complete heartbeat; retry on the next 5s publication.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      this.lastWriteError = error; this.writeFailures++; return false;
    }
  }
  stopRequested(): boolean {
    const path = join(this.directory, 'stop-request.json');
    if (!existsSync(path)) return false;
    const request = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as { pid?: number };
    return request.pid === process.pid;
  }
  failure(data: object): void {
    appendFileSync(join(this.directory, 'fatal-history.jsonl'), JSON.stringify({ pid: process.pid, utc: new Date().toISOString(), ...data }) + '\n');
  }
}
