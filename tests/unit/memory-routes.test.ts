import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), 'caco-memory-routes-test-' + Date.now());

// Patch homedir before importing so readMemory/writeMemory hit a temp store.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => testDir.replace('/.caco', '') };
});

const memoryFile = () => join(testDir, '.caco', 'memory.json');
const seed = (store: Record<string, string>) => writeFileSync(memoryFile(), JSON.stringify(store));
const readFile = () => JSON.parse(readFileSync(memoryFile(), 'utf-8'));

describe('memory routes — backing handlers', () => {
  beforeEach(() => {
    const cacoDir = join(testDir, '.caco');
    if (!existsSync(cacoDir)) mkdirSync(cacoDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('getMemoryPayload returns { entries, count, capacity }', async () => {
    seed({ 'preferred-language': 'TypeScript', 'git-commits': 'facts only' });
    const { getMemoryPayload } = await import('../../src/routes/memory.js');
    const payload = getMemoryPayload();
    expect(payload.entries).toEqual({ 'preferred-language': 'TypeScript', 'git-commits': 'facts only' });
    expect(payload.count).toBe(2);
    expect(payload.capacity).toBe(50);
  });

  it('getMemoryPayload returns empty for a first-time user (no file)', async () => {
    const { getMemoryPayload } = await import('../../src/routes/memory.js');
    const payload = getMemoryPayload();
    expect(payload.entries).toEqual({});
    expect(payload.count).toBe(0);
    expect(payload.capacity).toBe(50);
  });

  it('deleteMemoryKey removes an existing key and returns the fresh entries', async () => {
    seed({ a: '1', b: '2' });
    const { deleteMemoryKey } = await import('../../src/routes/memory.js');
    const res = deleteMemoryKey('a');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, deleted: 'a', count: 1 });
    expect(res.body.entries).toEqual({ b: '2' });
    // persisted
    expect(readFile()).toEqual({ b: '2' });
  });

  it('deleteMemoryKey is a successful no-op for a missing key', async () => {
    seed({ a: '1' });
    const { deleteMemoryKey } = await import('../../src/routes/memory.js');
    const res = deleteMemoryKey('nope');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, notFound: 'nope', count: 1 });
    expect(res.body.entries).toEqual({ a: '1' });
    expect(readFile()).toEqual({ a: '1' });
  });

  it('deleteMemoryKey rejects an invalid slug with 400 and leaves the store unchanged', async () => {
    seed({ a: '1' });
    const { deleteMemoryKey } = await import('../../src/routes/memory.js');
    for (const bad of ['../etc', 'Has Space', 'UPPER', 'trailing-', 'semi;colon']) {
      const res = deleteMemoryKey(bad);
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    }
    // store never touched
    expect(readFile()).toEqual({ a: '1' });
  });
});
