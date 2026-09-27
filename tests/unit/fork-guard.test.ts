import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync,
  existsSync, rmSync, statSync, chmodSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  guardedFork,
  reconcileFork,
  PREFORK_SUFFIX,
  COMPARE_CHUNK_BYTES,
} from '../../src/fork-guard.js';

/**
 * The runtime's `sessions.fork` copies the parent's history to the child, then
 * REPLACES the parent's events.jsonl with a single fork marker. The parent can
 * then never resume ("First event must be session.start or session.resume").
 *
 * Each fake below is a reference implementation of one runtime behavior. Every
 * expected byte comes from the fixture itself, never from the guard, so an
 * assertion cannot pass by agreeing with the code under test.
 */

const PARENT = 'parent-session';
const isWin = process.platform === 'win32';

let stateDir: string;
let dir: string;
let events: string;
let snapshot: string;
let original: Buffer;
let lastId: string;
const log = vi.fn();

function event(i: number, parentId: string | null): string {
  return JSON.stringify({
    type: i === 0 ? 'session.start' : 'assistant.message',
    data: i === 0 ? { sessionId: PARENT } : { content: `m${i}` },
    id: `e${i}`,
    timestamp: new Date(0).toISOString(),
    parentId,
  });
}

function writeFixture(count: number, extra = ''): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(event(i, i === 0 ? null : `e${i - 1}`));
  writeFileSync(events, lines.join('\n') + '\n' + extra);
  if (!isWin) chmodSync(events, 0o600);
  original = readFileSync(events);
  lastId = `e${count - 1}`;
}

function marker(parentId: string): string {
  return JSON.stringify({
    type: 'session.info', id: 'marker', timestamp: new Date(0).toISOString(), parentId,
    data: { infoType: 'fork', message: 'Forked this session into child' },
  });
}

/** Observed runtime: rewrite the parent to only its fork marker, in place. */
const truncatingFork = async () => {
  writeFileSync(events, marker(lastId) + '\n');
  return { sessionId: 'child' };
};

/** A runtime that behaves: append the marker, leaving history intact. */
const appendingFork = async () => {
  appendFileSync(events, marker(lastId) + '\n');
  return { sessionId: 'child' };
};

const deps = () => ({ stateDir, log });

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fork-guard-'));
  dir = join(stateDir, PARENT);
  mkdirSync(dir, { recursive: true });
  events = join(dir, 'events.jsonl');
  snapshot = events + PREFORK_SUFFIX;
  writeFixture(30);
  log.mockClear();
});

afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

describe('guardedFork', () => {
  it('restores the parent byte-for-byte after the runtime truncates it', async () => {
    const result = await guardedFork(PARENT, truncatingFork, deps());

    expect(result).toEqual({ sessionId: 'child' });
    expect(readFileSync(events).equals(original)).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[FORK]'));
  });

  it.skipIf(isWin)('keeps the private file mode through a restore', async () => {
    await guardedFork(PARENT, truncatingFork, deps());
    expect(statSync(events).mode & 0o777).toBe(0o600);
  });

  it('leaves a correctly forked parent exactly as the runtime wrote it', async () => {
    const inoBefore = statSync(events).ino;
    await guardedFork(PARENT, appendingFork, deps());

    // The runtime's own post-fork bytes: history plus its appended marker.
    const expected = Buffer.concat([original, Buffer.from(marker(lastId) + '\n')]);
    expect(readFileSync(events).equals(expected)).toBe(true);
    // No rename happened: a restore would swap in the snapshot's inode.
    if (inoBefore !== 0) expect(statSync(events).ino).toBe(inoBefore);
    expect(existsSync(snapshot)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('restores a torn append rather than keeping it', async () => {
    // A partial event with no newline: prefix intact, file unloadable.
    await guardedFork(PARENT, async () => {
      appendFileSync(events, '{"type":"session.info","id":"mar');
      return { sessionId: 'child' };
    }, deps());

    expect(readFileSync(events).equals(original)).toBe(true);
  });

  it('restores a same-size rewrite that changes bytes past the first chunk', async () => {
    // A fixture spanning several compare chunks. A guard that compared only the
    // first chunk would call this intact.
    const pad = 'x'.repeat(COMPARE_CHUNK_BYTES);
    writeFixture(3, JSON.stringify({ type: 'pad', id: 'p', parentId: 'e2', data: { pad } }) + '\n');
    await guardedFork(PARENT, async () => {
      const bytes = readFileSync(events);
      const at = bytes.length - 3;
      bytes[at] = bytes[at] === 0x78 ? 0x79 : 0x78;
      writeFileSync(events, bytes);
      return { sessionId: 'child' };
    }, deps());

    expect(readFileSync(events).equals(original)).toBe(true);
  });

  it('restores and rethrows when the fork rejects after truncating', async () => {
    const boom = new Error('fork exploded');
    await expect(guardedFork(PARENT, async () => {
      writeFileSync(events, marker(lastId) + '\n');
      throw boom;
    }, deps())).rejects.toBe(boom);

    expect(readFileSync(events).equals(original)).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('rethrows and leaves no artifacts when the fork rejects untouched', async () => {
    const boom = new Error('refused upstream');
    await expect(guardedFork(PARENT, async () => { throw boom; }, deps())).rejects.toBe(boom);

    expect(readFileSync(events).equals(original)).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('reconciles a stale snapshot left by an earlier crash before forking', async () => {
    // A crash after the runtime truncated but before the guard restored.
    copyFileSync(events, snapshot);
    writeFileSync(events, marker(lastId) + '\n');

    const fork = vi.fn(truncatingFork);
    await guardedFork(PARENT, fork, deps());

    expect(fork).toHaveBeenCalledTimes(1);
    expect(readFileSync(events).equals(original)).toBe(true);
  });

  it('fails closed without forking when a stale snapshot cannot be cleared', async () => {
    copyFileSync(events, snapshot);
    const fork = vi.fn(truncatingFork);
    const unlink = vi.fn(() => { throw new Error('EBUSY'); });

    await expect(guardedFork(PARENT, fork, { ...deps(), unlink })).rejects.toThrow(/snapshot/i);
    expect(fork).not.toHaveBeenCalled();
  });

  it('keeps the snapshot and throws a restore error when the restore rename fails', async () => {
    const rename = vi.fn(() => { throw new Error('EPERM'); });

    await expect(guardedFork(PARENT, truncatingFork, { ...deps(), rename }))
      .rejects.toThrow(/restore/i);

    // The only good copy survives for reconcile to retry.
    expect(readFileSync(snapshot).equals(original)).toBe(true);
  });

  it('fails loudly instead of reporting success when its snapshot vanished during the fork', async () => {
    // Without the snapshot the guard cannot tell a correct fork from a
    // truncating one. Returning success would silently lose the history.
    await expect(guardedFork(PARENT, async () => {
      rmSync(snapshot);
      writeFileSync(events, marker(lastId) + '\n');
      return { sessionId: 'child' };
    }, deps())).rejects.toThrow(/snapshot/i);
  });

  it('refuses to fork a parent with no history to protect', async () => {
    rmSync(events);
    const fork = vi.fn(truncatingFork);

    await expect(guardedFork(PARENT, fork, deps())).rejects.toThrow();
    expect(fork).not.toHaveBeenCalled();
  });
});

describe('reconcileFork', () => {
  it('reports clean when no snapshot is pending', () => {
    expect(reconcileFork(PARENT, { stateDir })).toBe('clean');
    expect(readFileSync(events).equals(original)).toBe(true);
  });

  it('drops a snapshot whose parent is intact (crash before the fork)', () => {
    copyFileSync(events, snapshot);
    expect(reconcileFork(PARENT, { stateDir })).toBe('committed-cleanup');
    expect(existsSync(snapshot)).toBe(false);
    expect(readFileSync(events).equals(original)).toBe(true);
  });

  it('keeps a correct fork marker when cleaning up (crash after a good fork)', () => {
    copyFileSync(events, snapshot);
    appendFileSync(events, marker(lastId) + '\n');
    const after = readFileSync(events);

    expect(reconcileFork(PARENT, { stateDir })).toBe('committed-cleanup');
    expect(readFileSync(events).equals(after)).toBe(true);
  });

  it('restores a truncated parent (crash between fork and restore)', () => {
    copyFileSync(events, snapshot);
    writeFileSync(events, marker(lastId) + '\n');

    expect(reconcileFork(PARENT, { stateDir })).toBe('restored');
    expect(readFileSync(events).equals(original)).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('restores a parent whose events file is missing', () => {
    copyFileSync(events, snapshot);
    rmSync(events);

    expect(reconcileFork(PARENT, { stateDir })).toBe('restored');
    expect(readFileSync(events).equals(original)).toBe(true);
  });
});
