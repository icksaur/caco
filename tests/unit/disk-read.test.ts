/**
 * disk-read: missing vs corrupt vs ok classification for sync + async readers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonFileSync, readJsonFile } from '../../src/disk-read.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'diskread-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readJsonFileSync', () => {
  it('returns ok with the parsed value for valid JSON', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ a: 1 }));
    const r = readJsonFileSync<{ a: number }>(p);
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('returns missing for an absent file', () => {
    const r = readJsonFileSync(join(dir, 'nope.json'));
    expect(r).toEqual({ ok: false, kind: 'missing' });
  });

  it('returns corrupt for unparseable content', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    const r = readJsonFileSync(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('corrupt');
      if (r.kind === 'corrupt') expect(r.error).toBeInstanceOf(Error);
    }
  });
});

describe('readJsonFile (async)', () => {
  it('returns ok with the parsed value for valid JSON', async () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify([1, 2, 3]));
    const r = await readJsonFile<number[]>(p);
    expect(r).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('returns missing for an absent file (ENOENT)', async () => {
    const r = await readJsonFile(join(dir, 'nope.json'));
    expect(r).toEqual({ ok: false, kind: 'missing' });
  });

  it('returns corrupt for unparseable content', async () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, 'definitely not json');
    const r = await readJsonFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });
});
