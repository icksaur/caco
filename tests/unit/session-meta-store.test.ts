/**
 * P5 slice 1: updateSessionMeta must never overwrite a corrupt meta.json with
 * defaults — it backs the file up and refuses the write. markSessionObserved
 * (a background mutator) inherits that protection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const root = vi.hoisted(() => {
  const dir = `/tmp/metastore-${process.pid}-${Date.now()}`;
  process.env.CACO_HOME = dir;
  return dir;
});

import {
  getSessionMeta, setSessionMeta, updateSessionMeta, readSessionMeta, markSessionObserved,
} from '../../src/session-meta-store.js';

const SID = 'sess-1234';
function metaDir(): string { return join(root, 'sessions', SID); }
function metaPath(): string { return join(metaDir(), 'meta.json'); }

beforeEach(() => {
  rmSync(metaDir(), { recursive: true, force: true });
  mkdirSync(metaDir(), { recursive: true });
});
afterEach(() => { rmSync(metaDir(), { recursive: true, force: true }); });

describe('readSessionMeta', () => {
  it('classifies missing / corrupt / ok', () => {
    expect(readSessionMeta(SID)).toEqual({ ok: false, kind: 'missing' });

    writeFileSync(metaPath(), '{ broken');
    expect(readSessionMeta(SID).ok).toBe(false);

    writeFileSync(metaPath(), JSON.stringify({ name: 'Hi' }));
    const r = readSessionMeta(SID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Hi');
  });

  it('treats a parseable non-object as corrupt', () => {
    writeFileSync(metaPath(), '42');
    const r = readSessionMeta(SID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });
});

describe('updateSessionMeta', () => {
  it('mutates and persists when ok', () => {
    setSessionMeta(SID, { name: 'Orig', folder: 'work' });
    const wrote = updateSessionMeta(SID, m => { m.model = 'gpt'; });
    expect(wrote).toBe(true);
    const meta = getSessionMeta(SID);
    expect(meta?.name).toBe('Orig');
    expect(meta?.folder).toBe('work');
    expect(meta?.model).toBe('gpt');
  });

  it('creates from defaults when missing (createIfMissing default true)', () => {
    const wrote = updateSessionMeta(SID, m => { m.name = 'New'; });
    expect(wrote).toBe(true);
    expect(getSessionMeta(SID)?.name).toBe('New');
  });

  it('refuses to create when missing and createIfMissing is false', () => {
    const wrote = updateSessionMeta(SID, m => { m.name = 'X'; }, { createIfMissing: false });
    expect(wrote).toBe(false);
    expect(existsSync(metaPath())).toBe(false);
  });

  it('does NOT overwrite a corrupt file, backs it up, returns false', () => {
    writeFileSync(metaPath(), '{ name: "Important", folder: "keep" ');  // corrupt but holds real data
    const original = readFileSync(metaPath(), 'utf-8');

    const wrote = updateSessionMeta(SID, m => { m.lastIdleAt = 'now'; });

    expect(wrote).toBe(false);
    expect(readFileSync(metaPath(), 'utf-8')).toBe(original);  // untouched
    const backups = readdirSync(metaDir()).filter(f => f.startsWith('meta.json.corrupt-'));
    expect(backups.length).toBe(1);
  });

  it('backs up a corrupt file at most once across repeated refusals', () => {
    writeFileSync(metaPath(), '{ name: "Important" ');

    updateSessionMeta(SID, m => { m.lastIdleAt = 'a'; });
    updateSessionMeta(SID, m => { m.lastIdleAt = 'b'; });
    updateSessionMeta(SID, m => { m.lastIdleAt = 'c'; });

    const backups = readdirSync(metaDir()).filter(f => f.startsWith('meta.json.corrupt-'));
    expect(backups.length).toBe(1);
  });
});

describe('markSessionObserved (background mutator)', () => {
  it('does not clobber a corrupt meta.json', () => {
    writeFileSync(metaPath(), 'totally broken {');
    const original = readFileSync(metaPath(), 'utf-8');

    markSessionObserved(SID);

    expect(readFileSync(metaPath(), 'utf-8')).toBe(original);
  });

  it('persists lastObservedAt when meta is ok', () => {
    setSessionMeta(SID, { name: 'A' });
    markSessionObserved(SID);
    expect(getSessionMeta(SID)?.lastObservedAt).toBeTruthy();
  });
});
