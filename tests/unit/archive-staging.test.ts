import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * spec-archive-staging oracle 3, the central one.
 *
 * The bug this guards: `isAutoArchiveEligible` refuses any session in
 * `SessionManager.activeSessions`, and eviction only runs when that map exceeds
 * its cap. `/caco.session-archive` acts on the ACTIVE session, so a user with
 * few loaded sessions would park the session they are sitting in, and it would
 * stay loaded, stay ineligible, and never archive — while the visible half of
 * the operation (the folder move) succeeded.
 *
 * The fixture therefore places the session in the active map BEFORE staging and
 * never removes it by any other means: no cap pressure, no manual stop. The only
 * thing that can make it eligible is the release inside `stageForArchive`. If
 * this test passes with that release removed, it is vacuous and must be
 * rewritten (spec-archive-staging, Acceptance 3).
 */

const active = new Set<string>();

const sm = vi.hoisted(() => ({
  isBusy: vi.fn((_id: string) => false),
  isActive: vi.fn((_id: string) => false),
  isResuming: vi.fn((_id: string) => false),
  stop: vi.fn(async (_id: string) => {}),
  reapArchive: vi.fn(async (_id: string, recheck: () => boolean): Promise<'archived' | 'skipped'> =>
    (recheck() ? 'archived' : 'skipped')),
}));
const herd = vi.hoisted(() => ({ isHerdParent: vi.fn((_id: string) => false) }));
const store = vi.hoisted(() => ({
  listSessionIds: vi.fn((): string[] => []),
  getSessionMeta: vi.fn((_id: string): Record<string, unknown> | undefined => undefined),
  updateSessionMeta: vi.fn((_id: string, _mutate: (m: Record<string, unknown>) => void) => true),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm }));
vi.mock('../../src/herd.js', () => ({ isHerdParent: herd.isHerdParent }));
vi.mock('../../src/sdk-session-store.js', () => ({ listSessionIds: store.listSessionIds }));
vi.mock('../../src/session-meta-store.js', () => ({
  getSessionMeta: store.getSessionMeta,
  updateSessionMeta: store.updateSessionMeta,
}));

import { stageForArchive, sweepAutoArchive, overdueReason, resetOverdueReports, archiveEligibleAt } from '../../src/session-archive-reaper.js';
import { AUTO_ARCHIVE_FOLDER, AUTO_ARCHIVE_IDLE_MS } from '../../src/config.js';

/** Meta for one session, mutated in place by the real updateSessionMeta path. */
let meta: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  active.clear();
  meta = {};

  // The active map is the subject of this test: only `stop` may empty it.
  sm.isActive.mockImplementation((id: string) => active.has(id));
  sm.stop.mockImplementation(async (id: string) => { active.delete(id); });
  sm.isBusy.mockReturnValue(false);
  sm.isResuming.mockReturnValue(false);
  herd.isHerdParent.mockReturnValue(false);
  sm.reapArchive.mockImplementation(async (_id, recheck) => (recheck() ? 'archived' : 'skipped'));

  store.listSessionIds.mockReturnValue(['sess']);
  store.getSessionMeta.mockImplementation((id: string) => (id === 'sess' ? meta : undefined));
  store.updateSessionMeta.mockImplementation((id: string, mutate: (m: Record<string, unknown>) => void) => {
    if (id !== 'sess') return false;
    mutate(meta);
    return true;
  });
});

describe('staging an ACTIVE session (spec-archive-staging oracle 3)', () => {
  it('releases it, so it becomes eligible and is archived by a sweep', async () => {
    active.add('sess');                       // loaded, as the command's own session always is
    expect(sm.isActive('sess')).toBe(true);   // precondition: the bug's trigger

    const result = await stageForArchive('sess');
    expect(result.ok).toBe(true);

    expect(meta.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(typeof meta.autoArchiveTaggedAt).toBe('number');

    // Nothing else may empty the active map: no cap pressure, no manual stop.
    expect(sm.isActive('sess')).toBe(false);

    // Age it past the window without touching it.
    meta.autoArchiveTaggedAt = Date.now() - AUTO_ARCHIVE_IDLE_MS - 60_000;

    const swept = await sweepAutoArchive();
    expect(sm.reapArchive).toHaveBeenCalledWith('sess', expect.any(Function));
    expect(swept.archived).toBe(1);
  });

  it('is refused while a dispatch is in flight, writing neither folder nor anchor', async () => {
    active.add('sess');
    sm.isBusy.mockImplementation((id: string) => id === 'sess');

    const result = await stageForArchive('sess');

    expect(result).toEqual({ ok: false, reason: 'busy' });
    expect(meta.folder).toBeUndefined();
    expect(meta.autoArchiveTaggedAt).toBeUndefined();
    expect(sm.stop).not.toHaveBeenCalled();   // a refused stage must not release
    expect(sm.isActive('sess')).toBe(true);
  });

  it('re-staging restarts the window rather than resuming a partial one', async () => {
    const old = Date.now() - AUTO_ARCHIVE_IDLE_MS * 2;
    meta = { folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: old };

    await stageForArchive('sess');

    expect(meta.autoArchiveTaggedAt).toBeGreaterThan(old);
    const swept = await sweepAutoArchive();
    expect(swept.archived).toBe(0);           // fresh window: not eligible yet
  });

  it('reports nothing but still succeeds when the session was never loaded', async () => {
    const result = await stageForArchive('sess');
    expect(result.ok).toBe(true);
    expect(meta.folder).toBe(AUTO_ARCHIVE_FOLDER);
  });

  it('refuses a session with no meta rather than reporting a deadline it cannot honour', async () => {
    store.updateSessionMeta.mockReturnValue(false);
    const result = await stageForArchive('gone');
    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(sm.stop).not.toHaveBeenCalled();
  });

  /**
   * A failed release is reported, not rolled back. The park is durable and is
   * what the caller asked for; undoing it to report a clean failure would throw
   * away the half of the operation that worked.
   */
  it('keeps the park and reports it when the release fails', async () => {
    active.add('sess');
    sm.stop.mockRejectedValueOnce(new Error('disconnect exploded'));

    const result = await stageForArchive('sess');

    expect(result.ok).toBe(true);
    expect(result.ok && result.released).toBe(false);
    expect(meta.folder).toBe(AUTO_ARCHIVE_FOLDER);   // park survives
    expect(sm.isActive('sess')).toBe(true);          // honest about still being loaded
  });

  it('reports a clean release on the normal path', async () => {
    active.add('sess');
    const result = await stageForArchive('sess');
    expect(result.ok && result.released).toBe(true);
  });

  /**
   * Acceptance 8, the stated user-facing contract: the window measures time
   * since the session was last TOUCHED, not since it was staged. A literal
   * "three days in the folder" rule would archive a session the user
   * demonstrably came back to.
   */
  it('pushes the deadline out when a staged session is used', async () => {
    const staged = Date.now() - AUTO_ARCHIVE_IDLE_MS - 60_000; // parked long ago
    meta = {
      folder: AUTO_ARCHIVE_FOLDER,
      autoArchiveTaggedAt: staged,
      lastUsedAt: new Date(Date.now() - 60_000).toISOString(), // but used a minute ago
    };

    const swept = await sweepAutoArchive();

    expect(swept.archived).toBe(0);
    expect(archiveEligibleAt('sess')).toBeGreaterThan(Date.now()); // deadline is in the future
  });

  it('archives once that activity itself ages past the window', async () => {
    const long = Date.now() - AUTO_ARCHIVE_IDLE_MS - 60_000;
    meta = {
      folder: AUTO_ARCHIVE_FOLDER,
      autoArchiveTaggedAt: long,
      lastUsedAt: new Date(long).toISOString(),
    };

    const swept = await sweepAutoArchive();

    expect(swept.archived).toBe(1);
  });
});

/**
 * Acceptance 10. Overdue-but-ineligible is the signature of staged archival
 * failing, and before this it produced no output at all — the sweep skipped it
 * in silence, which is indistinguishable from working.
 */
describe('overdueReason (spec-archive-staging oracle 10)', () => {
  const OVERDUE = { folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: 1_000 } as Record<string, unknown>;
  const idle = { isBusy: false, isActive: false, isResuming: false, isParent: false };
  const now = 1_000 + AUTO_ARCHIVE_IDLE_MS + 60_000;

  it('names the stuck-loaded case, which is the bug this feature can regress into', () => {
    expect(overdueReason(OVERDUE as never, { ...idle, isActive: true }, now))
      .toBe('still loaded (never released)');
  });

  it('names the other disqualifiers', () => {
    expect(overdueReason(OVERDUE as never, { ...idle, isBusy: true }, now)).toBe('busy');
    expect(overdueReason(OVERDUE as never, { ...idle, isResuming: true }, now)).toBe('resuming');
    expect(overdueReason(OVERDUE as never, { ...idle, isParent: true }, now)).toBe('herd parent');
    expect(overdueReason({ ...OVERDUE, orchestratedBy: 'p' } as never, idle, now)).toBe('herd child');
  });

  it('stays silent for sessions that are not stuck', () => {
    expect(overdueReason(OVERDUE as never, idle, now)).toBeNull();               // overdue AND eligible
    expect(overdueReason(OVERDUE as never, { ...idle, isActive: true }, 2_000)).toBeNull(); // not overdue
    expect(overdueReason({ folder: 'work' } as never, { ...idle, isActive: true }, now)).toBeNull();
  });

  it('warns once per session per condition, not once per sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetOverdueReports();
    active.add('sess');
    meta = { folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: Date.now() - AUTO_ARCHIVE_IDLE_MS - 60_000 };

    await sweepAutoArchive();
    await sweepAutoArchive();

    const stuck = warn.mock.calls.filter(c => String(c[0]).includes('still loaded'));
    expect(stuck).toHaveLength(1);
    warn.mockRestore();
  });

  it('forgets a session that leaves the folder, so the report map cannot grow forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetOverdueReports();
    active.add('sess');
    meta = { folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: Date.now() - AUTO_ARCHIVE_IDLE_MS - 60_000 };
    await sweepAutoArchive();                                  // reported, remembered

    store.listSessionIds.mockReturnValue([]);                  // archived or deleted
    await sweepAutoArchive();                                  // entry pruned here

    store.listSessionIds.mockReturnValue(['sess']);            // same id staged again
    await sweepAutoArchive();

    const stuck = warn.mock.calls.filter(c => String(c[0]).includes('still loaded'));
    expect(stuck).toHaveLength(2);   // re-reported: the stale entry did not linger
    warn.mockRestore();
  });
});
