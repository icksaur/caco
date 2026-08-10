import { describe, it, expect, vi, beforeEach } from 'vitest';

const sm = vi.hoisted(() => ({
  isBusy: vi.fn((_id: string) => false),
  isActive: vi.fn((_id: string) => false),
  isResuming: vi.fn((_id: string) => false),
  reapArchive: vi.fn(async (_id: string, _recheck: () => boolean): Promise<'archived' | 'skipped'> => 'archived'),
}));
const herd = vi.hoisted(() => ({ isHerdParent: vi.fn((_id: string) => false) }));
const store = vi.hoisted(() => ({
  listSessionIds: vi.fn((): string[] => []),
  getSessionMeta: vi.fn((_id: string): Record<string, unknown> | undefined => undefined),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm }));
vi.mock('../../src/herd.js', () => ({ isHerdParent: herd.isHerdParent }));
vi.mock('../../src/sdk-session-store.js', () => ({ listSessionIds: store.listSessionIds }));
vi.mock('../../src/session-meta-store.js', () => ({ getSessionMeta: store.getSessionMeta }));

import { sweepAutoArchive } from '../../src/session-archive-reaper.js';
import { AUTO_ARCHIVE_IDLE_MS } from '../../src/config.js';

const HOUR = 60 * 60 * 1000;
// Derived from the real window, not a fixed age: a fixture hardcoded to "48h
// old" silently stops being aged the moment the window is lengthened, which is
// exactly what happened when it became three days (spec-archive-staging).
const AGED = Date.now() - AUTO_ARCHIVE_IDLE_MS - HOUR;

beforeEach(() => {
  vi.clearAllMocks();
  sm.isBusy.mockReturnValue(false);
  sm.isActive.mockReturnValue(false);
  sm.isResuming.mockReturnValue(false);
  herd.isHerdParent.mockReturnValue(false);
  sm.reapArchive.mockResolvedValue('archived');
});

describe('sweepAutoArchive wiring', () => {
  it('archives exactly the eligible parked sessions and skips the rest', async () => {
    store.listSessionIds.mockReturnValue(['aged', 'fresh', 'elsewhere', 'busy']);
    store.getSessionMeta.mockImplementation((id: string) => {
      if (id === 'aged') return { folder: 'auto-archive', autoArchiveTaggedAt: AGED };
      if (id === 'fresh') return { folder: 'auto-archive', autoArchiveTaggedAt: Date.now() };
      if (id === 'elsewhere') return { folder: 'work', autoArchiveTaggedAt: AGED };
      if (id === 'busy') return { folder: 'auto-archive', autoArchiveTaggedAt: AGED };
      return undefined;
    });
    sm.isBusy.mockImplementation((id: string) => id === 'busy');

    const result = await sweepAutoArchive();

    expect(sm.reapArchive).toHaveBeenCalledTimes(1);
    expect(sm.reapArchive).toHaveBeenCalledWith('aged', expect.any(Function));
    expect(result).toEqual({ scanned: 3, archived: 1 }); // aged, fresh, busy are in-folder; only aged eligible
  });

  it('continues past a reapArchive that throws (best-effort)', async () => {
    store.listSessionIds.mockReturnValue(['a', 'b']);
    store.getSessionMeta.mockImplementation((id: string) => ({ folder: 'auto-archive', autoArchiveTaggedAt: AGED, name: id }));
    sm.reapArchive.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('archived');

    const result = await sweepAutoArchive();

    expect(sm.reapArchive).toHaveBeenCalledTimes(2);
    expect(result.archived).toBe(1); // second succeeded despite the first throwing
  });

  it('excludes herd parents and children even when aged and parked', async () => {
    store.listSessionIds.mockReturnValue(['parent', 'child']);
    store.getSessionMeta.mockImplementation((id: string) => (
      id === 'child'
        ? { folder: 'auto-archive', autoArchiveTaggedAt: AGED, orchestratedBy: 'p' }
        : { folder: 'auto-archive', autoArchiveTaggedAt: AGED }
    ));
    herd.isHerdParent.mockImplementation((id: string) => id === 'parent');

    const result = await sweepAutoArchive();

    expect(sm.reapArchive).not.toHaveBeenCalled();
    expect(result.archived).toBe(0);
  });
});
