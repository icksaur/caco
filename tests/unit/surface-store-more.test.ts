import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let cacoHome: string;
let originalCacoHome: string | undefined;

function surfaceFile(sessionId: string): string {
  return join(cacoHome, 'sessions', sessionId, 'surface.json');
}

async function importStore() {
  return import('../../src/surface-store.js');
}

beforeEach(() => {
  originalCacoHome = process.env.CACO_HOME;
  cacoHome = mkdtempSync(join(tmpdir(), 'caco-surface-more-'));
  process.env.CACO_HOME = cacoHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalCacoHome === undefined) {
    delete process.env.CACO_HOME;
  } else {
    process.env.CACO_HOME = originalCacoHome;
  }
  rmSync(cacoHome, { recursive: true, force: true });
});

describe('surface-store additional hermetic coverage', () => {
  it('getOrInitSurface returns the initial document without persisting it', async () => {
    const { getOrInitSurface, INITIAL_DATA_TOKEN } = await importStore();
    const sessionId = 'surface-more-init';

    const doc = getOrInitSurface(sessionId);

    expect(doc).toEqual({
      dataToken: INITIAL_DATA_TOKEN,
      style: 'roadmap',
      items: [],
      changes: {},
      customScript: null,
      customStyle: null,
    });
    expect(existsSync(surfaceFile(sessionId))).toBe(false);
  });

  it('patchStyle materializes a document and persists the full surface shape', async () => {
    const { patchStyle, getSurface, INITIAL_DATA_TOKEN } = await importStore();
    const sessionId = 'surface-more-style';

    const result = patchStyle(sessionId, INITIAL_DATA_TOKEN, {
      style: 'custom',
      customScript: 'render(surface);',
      customStyle: '.card { color: red; }',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected patchStyle to succeed');
    const doc = getSurface(sessionId);
    const persisted = JSON.parse(readFileSync(surfaceFile(sessionId), 'utf-8'));
    expect(doc?.dataToken).toBe(result.dataToken);
    expect(persisted).toEqual({
      dataToken: result.dataToken,
      style: 'custom',
      items: [],
      changes: {},
      customScript: 'render(surface);',
      customStyle: '.card { color: red; }',
    });
  });

  it('patchStyle stale token reports the current token and does not create a file', async () => {
    const { patchStyle, INITIAL_DATA_TOKEN } = await importStore();
    const sessionId = 'surface-more-stale-style';

    const result = patchStyle(sessionId, 'stale-token', { style: 'custom' });

    expect(result).toEqual({ ok: false, reason: 'stale', currentDataToken: INITIAL_DATA_TOKEN });
    expect(existsSync(surfaceFile(sessionId))).toBe(false);
  });

  it('mutate rejects non-object creates and updates without string ids', async () => {
    const { mutate, INITIAL_DATA_TOKEN } = await importStore();
    const sessionId = 'surface-more-invalid';

    const result = mutate(sessionId, INITIAL_DATA_TOKEN, {
      create: [null as unknown as { id: string; type: string }],
      update: [{ id: 12, type: 'task' } as unknown as { id: string; type: string }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected mutate to reject invalid items');
    expect(result.reason).toBe('invalid');
    expect(result.currentDataToken).toBe(INITIAL_DATA_TOKEN);
    expect(result.errors).toEqual(['create: item must be an object', 'update: item.id must be a string']);
    expect(existsSync(surfaceFile(sessionId))).toBe(false);
  });

  it('putChange returns stale with the current token and leaves changes untouched', async () => {
    const { mutate, putChange, getSurface, INITIAL_DATA_TOKEN } = await importStore();
    const sessionId = 'surface-more-put-stale';
    const seed = mutate(sessionId, INITIAL_DATA_TOKEN, { create: [{ id: 'a', type: 'task', status: 'open' }] });
    if (!seed.ok) throw new Error('seed failed');

    const result = putChange(sessionId, 'old-token', 'a', { id: 'a', type: 'task', status: 'done' });

    expect(result).toEqual({ ok: false, reason: 'stale', currentDataToken: seed.dataToken });
    expect(getSurface(sessionId)?.changes).toEqual({});
  });

  it('putChange on a missing document returns unknown-item without creating a file', async () => {
    const { putChange } = await importStore();
    const sessionId = 'surface-more-missing-put';

    const result = putChange(sessionId, 'any-token', 'a', { id: 'a', type: 'task' });

    expect(result).toEqual({ ok: false, reason: 'unknown-item' });
    expect(existsSync(surfaceFile(sessionId))).toBe(false);
  });

  it('notifySurfaceUpdate broadcasts only successful mutations', async () => {
    const { notifySurfaceUpdate, SURFACE_UPDATED_EVENT } = await importStore();
    const broadcast = vi.fn();

    notifySurfaceUpdate('sid', 'agent', { ok: true, dataToken: 'tok' }, broadcast);
    notifySurfaceUpdate('sid', 'user', { ok: false, reason: 'invalid' }, broadcast);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('sid', {
      type: SURFACE_UPDATED_EVENT,
      data: { dataToken: 'tok', origin: 'agent' },
    });
  });

  it('deleteSurface reports false for a missing surface document', async () => {
    const { deleteSurface } = await importStore();

    expect(deleteSurface('surface-more-never-written')).toBe(false);
  });
});
