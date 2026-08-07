import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkStore = vi.hoisted(() => ({
  listSessionIds: vi.fn<() => string[]>(),
}));
const sessionManagerMock = vi.hoisted(() => ({
  hasPendingAutoContinue: vi.fn<(sessionId: string) => boolean>(),
  isBusy: vi.fn<(sessionId: string) => boolean>(),
  isActive: vi.fn<(sessionId: string) => boolean>(),
}));
const storage = vi.hoisted(() => ({
  markSessionIdle: vi.fn<(sessionId: string) => void>(),
  getSessionMeta: vi.fn<(sessionId: string) => { name?: string; orchestratedBy?: string; lastIdleAt?: string } | undefined>(),
  readSessionMeta: vi.fn<(sessionId: string) => { ok: true } | { ok: false; kind: 'missing' | 'corrupt' }>(),
  updateSessionMeta: vi.fn<(sessionId: string, updater: (meta: { orchestratedBy?: string }) => void) => void>(),
}));

vi.mock('../../src/sdk-session-store.js', () => sdkStore);
vi.mock('../../src/session-manager.js', () => ({ sessionManager: sessionManagerMock }));
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/config.js', () => ({ SERVER_URL: 'http://herd.test' }));

import { onSessionDeleted, onSessionIdle, rebuildHerdIndexFromDisk, scanHerdsOnBoot, wakeParent } from '../../src/herd-runtime.js';
import * as herd from '../../src/herd.js';

function metaFor(id: string): { name?: string; orchestratedBy?: string; lastIdleAt?: string } | undefined {
  const records: Record<string, { name?: string; orchestratedBy?: string; lastIdleAt?: string }> = {
    child1: { name: 'first child', orchestratedBy: 'parent1', lastIdleAt: '2026-07-10T12:00:00.000Z' },
    child2: { name: 'second child', orchestratedBy: 'parent1', lastIdleAt: '2026-07-10T12:01:00.000Z' },
    parent1: { name: 'parent' },
  };
  return records[id];
}

beforeEach(() => {
  vi.clearAllMocks();
  herd.rebuildHerdIndex([]);
  herd._resetHerdWakeChains();
  sdkStore.listSessionIds.mockReturnValue([]);
  storage.getSessionMeta.mockImplementation(metaFor);
  storage.readSessionMeta.mockReturnValue({ ok: true });
  storage.updateSessionMeta.mockImplementation((_sessionId, updater) => updater({ orchestratedBy: 'parent1' }));
  sessionManagerMock.hasPendingAutoContinue.mockReturnValue(false);
  sessionManagerMock.isBusy.mockReturnValue(false);
  sessionManagerMock.isActive.mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

describe('rebuildHerdIndexFromDisk', () => {
  it('derives parent membership from child metadata and ignores unbonded sessions', () => {
    sdkStore.listSessionIds.mockReturnValue(['child1', 'parent1', 'child2', 'unbonded']);
    storage.getSessionMeta.mockImplementation(id => id === 'unbonded' ? {} : metaFor(id));

    rebuildHerdIndexFromDisk();

    expect(herd.getHerdChildren('parent1')).toEqual(['child1', 'child2']);
    expect(herd.getHerdParent('parent1')).toBeUndefined();
  });
});

describe('onSessionIdle more lifecycle branches', () => {
  it('self-heals a child whose parent metadata is missing', async () => {
    storage.getSessionMeta.mockReturnValue({ orchestratedBy: 'missing-parent' });
    storage.readSessionMeta.mockReturnValue({ ok: false, kind: 'missing' });
    herd.registerHerdBond('child1', 'missing-parent');

    await onSessionIdle('child1');

    expect(storage.markSessionIdle).toHaveBeenCalledWith('child1', false);
    expect(storage.updateSessionMeta).toHaveBeenCalledWith('child1', expect.any(Function));
    expect(herd.getHerdParent('child1')).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('leaves a corrupt parent bond in place and does not wake', async () => {
    storage.getSessionMeta.mockReturnValue({ orchestratedBy: 'corrupt-parent' });
    storage.readSessionMeta.mockReturnValue({ ok: false, kind: 'corrupt' });
    herd.registerHerdBond('child1', 'corrupt-parent');

    await onSessionIdle('child1');

    expect(storage.updateSessionMeta).not.toHaveBeenCalled();
    expect(herd.getHerdParent('child1')).toBe('corrupt-parent');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('registers a present parent bond and posts a wake with live child status', async () => {
    storage.getSessionMeta.mockImplementation(id => id === 'child1'
      ? { name: 'first child', orchestratedBy: 'parent1', lastIdleAt: '2026-07-10T12:00:00.000Z' }
      : metaFor(id));
    sessionManagerMock.isActive.mockImplementation(id => id === 'child1');

    await onSessionIdle('child1');

    expect(herd.getHerdParent('child1')).toBe('parent1');
    expect(globalThis.fetch).toHaveBeenCalledWith('http://herd.test/api/sessions/parent1/messages', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('first child'),
    }));
  });

  it('re-evaluates a parent herd when the parent itself becomes idle', async () => {
    herd.registerHerdBond('child1', 'parent1');
    sessionManagerMock.isActive.mockImplementation(id => id === 'child1');
    storage.getSessionMeta.mockImplementation(metaFor);

    await onSessionIdle('parent1');

    expect(globalThis.fetch).toHaveBeenCalledWith('http://herd.test/api/sessions/parent1/messages', expect.objectContaining({ method: 'POST' }));
  });
});

describe('wakeParent and boot/delete cleanup', () => {
  it('does not post a wake to a busy parent', async () => {
    herd.registerHerdBond('child1', 'parent1');
    sessionManagerMock.isBusy.mockImplementation(id => id === 'parent1');

    await wakeParent('parent1');

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('boot scan self-heals missing parents and wakes surviving parents', async () => {
    sdkStore.listSessionIds.mockReturnValue(['child1', 'child2', 'parent1']);
    storage.getSessionMeta.mockImplementation(id => {
      if (id === 'child2') return { name: 'orphan', orchestratedBy: 'missing-parent' };
      return metaFor(id);
    });
    storage.readSessionMeta.mockImplementation(id => id === 'missing-parent' ? { ok: false, kind: 'missing' } : { ok: true });
    sessionManagerMock.isActive.mockReturnValue(false);

    await scanHerdsOnBoot();

    expect(storage.updateSessionMeta).toHaveBeenCalledWith('child2', expect.any(Function));
    expect(herd.getHerdParent('child2')).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith('http://herd.test/api/sessions/parent1/messages', expect.objectContaining({ method: 'POST' }));
  });

  it('deleting a parent disowns its children and deleting a child clears its ghost bond', () => {
    herd.registerHerdBond('child1', 'parent1');
    herd.registerHerdBond('child2', 'parent1');

    onSessionDeleted('parent1');

    expect(storage.updateSessionMeta).toHaveBeenCalledWith('child1', expect.any(Function));
    expect(storage.updateSessionMeta).toHaveBeenCalledWith('child2', expect.any(Function));
    expect(herd.getHerdChildren('parent1')).toEqual([]);

    herd.registerHerdBond('child1', 'parent1');
    onSessionDeleted('child1');

    expect(herd.getHerdParent('child1')).toBeUndefined();
  });
});
