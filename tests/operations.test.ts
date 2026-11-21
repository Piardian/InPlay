import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireSingleton, RuntimeState } from '../src/operations.js';
test('OS singleton rejects a second worker and releases for the next one', async () => {
  const port = 42000 + process.pid % 1000;
  const release = await acquireSingleton(port);
  try { await assert.rejects(acquireSingleton(port), /EADDRINUSE/); } finally { release(); }
  await new Promise(resolve => setTimeout(resolve, 10));
  const again = await acquireSingleton(port); again();
});
test('heartbeat writes atomically; stop request targets only its worker and accepts PowerShell BOM', () => {
  const path = mkdtempSync(join(tmpdir(), 'masa2-ops-'));
  try {
    const state = new RuntimeState(path); state.write({ state: 'RUNNING' }); state.write({ state: 'STOPPED' });
    assert.equal(JSON.parse(readFileSync(join(path, 'heartbeat.json'), 'utf8')).state, 'STOPPED');
    assert.equal(state.stopRequested(), false);
    writeFileSync(join(path, 'stop-request.json'), JSON.stringify({ pid: process.pid + 1 })); assert.equal(state.stopRequested(), false);
    writeFileSync(join(path, 'stop-request.json'), '\uFEFF' + JSON.stringify({ pid: process.pid })); assert.equal(state.stopRequested(), true);
  } finally {
    const target = resolve(path), expected = resolve(tmpdir()) + '\\masa2-ops-';
    assert.ok(target.toLowerCase().startsWith(expected.toLowerCase()));
    rmSync(target, { recursive: true });
  }
});

test('Windows sharing violations preserve the last heartbeat and recover on the next publication without throwing', () => {
  const path = mkdtempSync(join(tmpdir(), 'masa2-ops-'));
  try {
    new RuntimeState(path).write({ state: 'BEFORE' });
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      let locked = true;
      const state = new RuntimeState(path, (from, to) => {
        if (locked) throw Object.assign(new Error('Windows sharing violation'), { code });
        renameSync(from, to);
      });
      assert.equal(state.write({ state: 'AFTER' }), false);
      assert.equal(state.writeFailures, 1);
      assert.equal(JSON.parse(readFileSync(join(path, 'heartbeat.json'), 'utf8')).state, 'BEFORE');
      locked = false; assert.equal(state.write({ state: 'AFTER' }), true);
      assert.equal(state.lastWriteError, undefined);
      assert.equal(JSON.parse(readFileSync(join(path, 'heartbeat.json'), 'utf8')).state, 'AFTER');
      state.write({ state: 'BEFORE' });
    }
  } finally {
    const target = resolve(path); assert.ok(target.toLowerCase().startsWith((resolve(tmpdir()) + '\\masa2-ops-').toLowerCase()));
    rmSync(target, { recursive: true });
  }
});

test('unexpected heartbeat I/O failures still propagate rather than masquerading as a transient lock', () => {
  const path = mkdtempSync(join(tmpdir(), 'masa2-ops-'));
  try {
    const state = new RuntimeState(path, () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); });
    assert.throws(() => state.write({ state: 'RUNNING' }), /I\/O failure/);
  } finally {
    const target = resolve(path); assert.ok(target.toLowerCase().startsWith((resolve(tmpdir()) + '\\masa2-ops-').toLowerCase()));
    rmSync(target, { recursive: true });
  }
});
