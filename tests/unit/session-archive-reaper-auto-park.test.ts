/**
 * Auto-park predicate + park helper oracles (spec-auto-park-idle-root).
 *
 * These are pure / seam-mocked unit tests. Sweep-level integration (folder PATCH
 * threading, ordering with the reaper) lives in
 * session-archive-reaper-auto-park-sweep.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rootAnchorMs,
  pickAutoParkCandidates,
  parkForAutoPark,
  AUTO_PARK_SKIP_ORDER,
  type AutoParkEntry,
  type ReaperFacts,
} from '../../src/session-archive-reaper.js';
import { AUTO_ARCHIVE_FOLDER } from '../../src/config.js';
import type { SessionMeta, SessionKind } from '../../src/session-meta-store.js';

// Silence expected [AUTO-PARK] warn/log spam from tests that exercise error paths.
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  consoleWarnSpy.mockRestore();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const IDLE = 21 * DAY;
const THRESHOLD = 30;
const NOW = 1_700_000_000_000;

const liveNothing: ReaperFacts = { isBusy: false, isActive: false, isResuming: false, isParent: false };

interface EntryOverride {
  meta?: Partial<SessionMeta>;
  facts?: ReaperFacts;
  creationMs?: number | null;
}

function entry(id: string, over: EntryOverride = {}): AutoParkEntry {
  const metaOver = over.meta ?? {};
  return {
    id,
    meta: { name: id, ...metaOver } as SessionMeta,
    facts: over.facts ?? liveNothing,
    creationMs: over.creationMs ?? null,
  };
}

function staleRoot(id: string, over: Partial<SessionMeta> = {}): AutoParkEntry {
  return entry(id, { meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString(), ...over } });
}

function freshRoot(id: string): AutoParkEntry {
  return entry(id, { meta: { lastUsedAt: new Date(NOW - 1 * DAY).toISOString() } });
}

/** Build a fixture with 30 fresh root sessions so any single stale addition trips
 *  the volume gate but the fillers themselves don't qualify. */
function withThirtyFreshFillers(...extras: AutoParkEntry[]): AutoParkEntry[] {
  const fillers: AutoParkEntry[] = [];
  for (let i = 0; i < 30; i++) fillers.push(freshRoot(`fill-${i.toString().padStart(3, '0')}`));
  return [...fillers, ...extras];
}

// ============================================================================
// rootAnchorMs
// ============================================================================

describe('rootAnchorMs — the auto-park anchor', () => {
  it('takes the max of movedToRootAt, lastUsedAt, lastIdleAt, creation', () => {
    const m: SessionMeta = {
      name: 'x',
      movedToRootAt: NOW - 100 * HOUR,
      lastUsedAt: new Date(NOW - 3 * HOUR).toISOString(),
      lastIdleAt: new Date(NOW - 50 * HOUR).toISOString(),
    };
    expect(rootAnchorMs(m, NOW - 200 * HOUR)).toBe(NOW - 3 * HOUR); // lastUsedAt wins
  });

  it('honours movedToRootAt as the freshest signal after a drag-to-root', () => {
    // A session with old lastUsedAt that the user just moved to root: the drag
    // is the newest datapoint, so it wins even though its literal timestamp is
    // "younger" than the reaper's own anchor would prefer.
    const m: SessionMeta = {
      name: 'x',
      movedToRootAt: NOW - 1 * HOUR,
      lastUsedAt: new Date(NOW - 100 * DAY).toISOString(),
    };
    expect(rootAnchorMs(m, null)).toBe(NOW - 1 * HOUR);
  });

  it('returns null when nothing is resolvable (fail-safe)', () => {
    expect(rootAnchorMs({ name: 'x' }, null)).toBeNull();
  });

  it('falls back to creationMs when no activity stamps exist', () => {
    expect(rootAnchorMs({ name: 'x' }, NOW - 5 * DAY)).toBe(NOW - 5 * DAY);
  });

  it('ignores autoArchiveTaggedAt (that stamp is for the reaper, not auto-park)', () => {
    // Even if a session somehow has this stamp AND is at root, the auto-park
    // anchor must not pick it up — root sessions cannot legitimately carry the
    // park stamp, and consulting it would silently borrow the reaper's window.
    const m: SessionMeta = {
      name: 'x',
      autoArchiveTaggedAt: NOW, // freshest value
      lastUsedAt: new Date(NOW - 30 * DAY).toISOString(),
    };
    expect(rootAnchorMs(m, null)).toBe(new Date(new Date(NOW - 30 * DAY).toISOString()).getTime());
  });
});

// ============================================================================
// pickAutoParkCandidates — table of hand cases (Acceptance 1)
// ============================================================================

describe('pickAutoParkCandidates — inclusion / exclusion by state', () => {
  it('root stale ⇒ candidate', () => {
    const target = staleRoot('t');
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual(['t']);
    expect(r.stats.root).toBe(31);
    expect(r.stats.stale).toBe(1);
  });

  it("root fresh ⇒ skipped as 'not stale' (no bucket, just doesn't count)", () => {
    const r = pickAutoParkCandidates(withThirtyFreshFillers(), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.root).toBe(30);
    expect(r.stats.stale).toBe(0);
  });

  it("folder='work' stale ⇒ not root ⇒ not counted", () => {
    const target = staleRoot('t', { folder: 'work' });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.root).toBe(30); // target excluded from root count
  });

  it("folder='auto-archive' stale ⇒ not root ⇒ never re-parked by auto-park", () => {
    const target = staleRoot('t', { folder: AUTO_ARCHIVE_FOLDER });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.root).toBe(30);
  });

  it('herd parent stale ⇒ skipped under herd bucket', () => {
    const target = entry('t', {
      meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString() },
      facts: { ...liveNothing, isParent: true },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.skipped.herd).toBe(1);
  });

  it('herd child (orchestratedBy set) stale ⇒ skipped under herd bucket', () => {
    const target = staleRoot('t', { orchestratedBy: 'parent-x' });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.skipped.herd).toBe(1);
  });

  it('active stale ⇒ skipped under active bucket', () => {
    const target = entry('t', {
      meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString() },
      facts: { ...liveNothing, isActive: true },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.skipped.active).toBe(1);
  });

  it('busy stale ⇒ skipped under busy bucket (first-match precedence)', () => {
    // Session is BOTH busy AND active: first-match precedence must classify as busy.
    const target = entry('t', {
      meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString() },
      facts: { ...liveNothing, isBusy: true, isActive: true },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.stats.skipped.busy).toBe(1);
    expect(r.stats.skipped.active).toBe(0);
  });

  it('resuming stale ⇒ skipped under resuming bucket', () => {
    const target = entry('t', {
      meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString() },
      facts: { ...liveNothing, isResuming: true },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.stats.skipped.resuming).toBe(1);
  });

  it("kind='scheduled' stale ⇒ skipped under scheduled bucket", () => {
    const target = staleRoot('t', { kind: 'scheduled' as SessionKind });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.skipped.scheduled).toBe(1);
  });

  it('anchor unresolvable ⇒ not counted as stale ⇒ silently skipped', () => {
    const target = entry('t', { meta: {}, creationMs: null });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.stale).toBe(0);
  });

  it('movedToRootAt fresh ⇒ skipped as young (even with old lastUsedAt)', () => {
    const target = entry('t', {
      meta: {
        movedToRootAt: NOW - 1 * HOUR,
        lastUsedAt: new Date(NOW - 100 * DAY).toISOString(),
      },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.stats.stale).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it('movedToRootAt aged past window ⇒ parked', () => {
    const target = entry('t', {
      meta: {
        movedToRootAt: NOW - 22 * DAY,
        lastUsedAt: new Date(NOW - 100 * DAY).toISOString(),
      },
    });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(target), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual(['t']);
  });
});

// ============================================================================
// Ordering + gates (Acceptance 2, 3, 4, 5)
// ============================================================================

describe('pickAutoParkCandidates — ordering', () => {
  it('returns candidates by ASCENDING anchor (oldest first)', () => {
    const a25 = entry('a', { meta: { lastUsedAt: new Date(NOW - 25 * DAY).toISOString() } });
    const b30 = entry('b', { meta: { lastUsedAt: new Date(NOW - 30 * DAY).toISOString() } });
    const c40 = entry('c', { meta: { lastUsedAt: new Date(NOW - 40 * DAY).toISOString() } });
    // Insert in scrambled order; predicate must sort by anchor.
    const r = pickAutoParkCandidates(withThirtyFreshFillers(a25, c40, b30), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual(['c', 'b', 'a']); // 40d, 30d, 25d ⇒ oldest first
  });

  it('tie-breaks on id lexicographically when anchors match', () => {
    const iso = new Date(NOW - 30 * DAY).toISOString();
    const y = entry('y', { meta: { lastUsedAt: iso } });
    const x = entry('x', { meta: { lastUsedAt: iso } });
    const r = pickAutoParkCandidates(withThirtyFreshFillers(y, x), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual(['x', 'y']);
  });
});

describe('pickAutoParkCandidates — gates', () => {
  it('below-threshold gate: 29 root, many stale ⇒ empty', () => {
    const fillers: AutoParkEntry[] = [];
    for (let i = 0; i < 15; i++) fillers.push(freshRoot(`fill-${i}`));
    const stales = [staleRoot('s1'), staleRoot('s2'), staleRoot('s3')];
    // Total root = 15 + 3 = 18, well below 30.
    const r = pickAutoParkCandidates([...fillers, ...stales], THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.root).toBe(18);
    expect(r.stats.stale).toBe(3); // stale counted even though gate failed
  });

  it('below-threshold gate evaluated against ROOT count, not total sessions', () => {
    // 5 root + 100 foldered stale ⇒ root count is 5, gate fails.
    const rootFillers: AutoParkEntry[] = [];
    for (let i = 0; i < 5; i++) rootFillers.push(freshRoot(`root-${i}`));
    const foldered: AutoParkEntry[] = [];
    for (let i = 0; i < 100; i++) {
      foldered.push(entry(`fld-${i}`, {
        meta: { folder: 'work', lastUsedAt: new Date(NOW - 30 * DAY).toISOString() },
      }));
    }
    const r = pickAutoParkCandidates([...rootFillers, ...foldered], THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.root).toBe(5);
  });

  it('zero-stale gate: 30+ root, all fresh ⇒ empty', () => {
    const r = pickAutoParkCandidates(withThirtyFreshFillers(), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toEqual([]);
    expect(r.stats.stale).toBe(0);
  });

  it('both gates pass: batch-all — every qualifying id is returned', () => {
    const stales = [staleRoot('s1'), staleRoot('s2'), staleRoot('s3')];
    const r = pickAutoParkCandidates(withThirtyFreshFillers(...stales), THRESHOLD, IDLE, NOW);
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
  });

  it('adding one more qualifying id adds it to the output', () => {
    const withThree = pickAutoParkCandidates(
      withThirtyFreshFillers(staleRoot('s1'), staleRoot('s2'), staleRoot('s3')),
      THRESHOLD, IDLE, NOW,
    );
    const withFour = pickAutoParkCandidates(
      withThirtyFreshFillers(staleRoot('s1'), staleRoot('s2'), staleRoot('s3'), staleRoot('s4')),
      THRESHOLD, IDLE, NOW,
    );
    expect(withFour.candidates.length).toBe(withThree.candidates.length + 1);
  });
});

// ============================================================================
// AUTO_PARK_SKIP_ORDER (log column contract)
// ============================================================================

describe('AUTO_PARK_SKIP_ORDER — canonical skip-bucket sequence', () => {
  it('is exactly the eight reasons in the documented order', () => {
    expect(AUTO_PARK_SKIP_ORDER).toEqual([
      'busy', 'active', 'resuming', 'herd', 'scheduled', 'maintenance', 'metadata', 'stale',
    ]);
  });
});

// ============================================================================
// parkForAutoPark — return-value discrimination (Acceptance 8, 9)
// ============================================================================

vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    isUnderMaintenance: vi.fn(() => false),
  },
}));

vi.mock('../../src/session-meta-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/session-meta-store.js')>('../../src/session-meta-store.js');
  return {
    ...actual,
    updateSessionMeta: vi.fn(),
  };
});

import { sessionManager } from '../../src/session-manager.js';
import { updateSessionMeta } from '../../src/session-meta-store.js';

const mockedIsUnderMaintenance = sessionManager.isUnderMaintenance as unknown as ReturnType<typeof vi.fn>;
const mockedUpdateSessionMeta = updateSessionMeta as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedIsUnderMaintenance.mockReset();
  mockedIsUnderMaintenance.mockReturnValue(false);
  mockedUpdateSessionMeta.mockReset();
});

describe('parkForAutoPark — return-value discrimination', () => {
  it("returns 'maintenance' when the session is under a claim; no meta write attempted", () => {
    mockedIsUnderMaintenance.mockReturnValue(true);
    const result = parkForAutoPark('sess-1', NOW);
    expect(result).toBe('maintenance');
    expect(mockedUpdateSessionMeta).not.toHaveBeenCalled();
  });

  it("returns 'metadata' when updateSessionMeta returns false (missing / corrupt)", () => {
    mockedUpdateSessionMeta.mockReturnValue(false);
    expect(parkForAutoPark('sess-1', NOW)).toBe('metadata');
  });

  it("returns 'metadata' when updateSessionMeta throws; no re-throw", () => {
    mockedUpdateSessionMeta.mockImplementation(() => { throw new Error('EBADF'); });
    expect(() => parkForAutoPark('sess-1', NOW)).not.toThrow();
    expect(parkForAutoPark('sess-1', NOW)).toBe('metadata');
  });

  it('passes { createIfMissing: false } to updateSessionMeta', () => {
    mockedUpdateSessionMeta.mockReturnValue(true);
    parkForAutoPark('sess-1', NOW);
    const [, , opts] = mockedUpdateSessionMeta.mock.calls[0];
    expect(opts).toEqual({ createIfMissing: false });
  });

  it("returns 'ok' and the callback writes folder + tag when meta is clean root", () => {
    let capturedMeta: SessionMeta | null = null;
    mockedUpdateSessionMeta.mockImplementation((_id: string, cb: (m: SessionMeta) => void) => {
      const m: SessionMeta = { name: 'x' }; // no folder, no orchestratedBy, no kind
      cb(m);
      capturedMeta = m;
      return true;
    });
    const result = parkForAutoPark('sess-1', NOW);
    expect(result).toBe('ok');
    expect(capturedMeta).toEqual({
      name: 'x',
      folder: AUTO_ARCHIVE_FOLDER,
      autoArchiveTaggedAt: NOW,
    });
  });
});

describe('parkForAutoPark — write-time durable rechecks (Acceptance 9)', () => {
  it("recheck: folder became non-root ⇒ 'stale', callback leaves meta unchanged", () => {
    let capturedMeta: SessionMeta | null = null;
    mockedUpdateSessionMeta.mockImplementation((_id: string, cb: (m: SessionMeta) => void) => {
      const m: SessionMeta = { name: 'x', folder: 'work' }; // user moved it to a folder
      cb(m);
      capturedMeta = m;
      return true;
    });
    expect(parkForAutoPark('sess-1', NOW)).toBe('stale');
    expect(capturedMeta).toEqual({ name: 'x', folder: 'work' }); // untouched
  });

  it("recheck: orchestratedBy was set (became a herd child) ⇒ 'stale'", () => {
    let capturedMeta: SessionMeta | null = null;
    mockedUpdateSessionMeta.mockImplementation((_id: string, cb: (m: SessionMeta) => void) => {
      const m: SessionMeta = { name: 'x', orchestratedBy: 'parent-x' };
      cb(m);
      capturedMeta = m;
      return true;
    });
    expect(parkForAutoPark('sess-1', NOW)).toBe('stale');
    expect(capturedMeta).toEqual({ name: 'x', orchestratedBy: 'parent-x' }); // untouched
  });

  it("recheck: kind became 'scheduled' ⇒ 'stale'", () => {
    let capturedMeta: SessionMeta | null = null;
    mockedUpdateSessionMeta.mockImplementation((_id: string, cb: (m: SessionMeta) => void) => {
      const m: SessionMeta = { name: 'x', kind: 'scheduled' };
      cb(m);
      capturedMeta = m;
      return true;
    });
    expect(parkForAutoPark('sess-1', NOW)).toBe('stale');
    expect(capturedMeta).toEqual({ name: 'x', kind: 'scheduled' }); // untouched
  });
});
