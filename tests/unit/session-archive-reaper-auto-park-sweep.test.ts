/**
 * Sweep-level integration for auto-park (spec-auto-park-idle-root).
 *
 * Exercises:
 *  - runAutoPark's kill-switch and log emission (Acceptance 10, 11)
 *  - the per-tick cap applied at the sweep loop, not the predicate (Acceptance 6)
 *  - the `movedToRootAt` stamp threaded through the folder PATCH updater's
 *    real behaviour (Acceptance 7, 13, 14) — via a captured-updater smoke test
 *    against the real folder-PATCH branch semantics
 *
 * Pure predicate + parkForAutoPark helper oracles live in the sibling
 * session-archive-reaper-auto-park.test.ts file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUTO_ARCHIVE_FOLDER } from '../../src/config.js';
import type { SessionMeta } from '../../src/session-meta-store.js';

// Suppress the [AUTO-PARK] log spam that the runner emits by design; each test
// that asserts on the log line reads from a spy directly.
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  consoleLogSpy.mockRestore();
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// ============================================================================
// Fixture infrastructure — an in-memory meta store keyed by session id.
// The mocks below replace listSessionIds, getSessionMeta, updateSessionMeta,
// and readSessionHeadResult so runAutoPark's whole loop drives against a
// deterministic fixture without touching disk.
// ============================================================================

const fixture = new Map<string, SessionMeta>();

vi.mock('../../src/sdk-session-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/sdk-session-store.js')>('../../src/sdk-session-store.js');
  return {
    ...actual,
    listSessionIds: () => Array.from(fixture.keys()),
    readSessionHeadResult: () => ({ ok: false, kind: 'missing' } as const),
  };
});

vi.mock('../../src/session-meta-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/session-meta-store.js')>('../../src/session-meta-store.js');
  return {
    ...actual,
    getSessionMeta: (id: string) => fixture.get(id) ?? null,
    updateSessionMeta: (id: string, mutate: (m: SessionMeta) => SessionMeta | void, opts?: { createIfMissing?: boolean }) => {
      const existing = fixture.get(id);
      if (!existing) {
        if (opts?.createIfMissing === false) return false;
        const blank: SessionMeta = { name: '' };
        const returned = mutate(blank);
        fixture.set(id, returned ?? blank);
        return true;
      }
      const returned = mutate(existing);
      fixture.set(id, returned ?? existing);
      return true;
    },
  };
});

vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    isBusy: vi.fn(() => false),
    isActive: vi.fn(() => false),
    isResuming: vi.fn(() => false),
    isUnderMaintenance: vi.fn(() => false),
  },
}));

vi.mock('../../src/herd.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/herd.js')>('../../src/herd.js');
  return {
    ...actual,
    isHerdParent: () => false,
  };
});

// Import AFTER the mocks so runAutoPark sees the stubbed dependencies.
import { runAutoPark, sweepAutoArchive } from '../../src/session-archive-reaper.js';
import { applyFolderChange } from '../../src/folder-transitions.js';

function reset(): void {
  fixture.clear();
}

function addFreshRoot(id: string): void {
  fixture.set(id, { name: id, lastUsedAt: new Date(NOW - 1 * DAY).toISOString() });
}

function addStaleRoot(id: string, ageDays = 30): void {
  fixture.set(id, { name: id, lastUsedAt: new Date(NOW - ageDays * DAY).toISOString() });
}

function withThirtyFillers(): void {
  for (let i = 0; i < 30; i++) addFreshRoot(`fill-${i.toString().padStart(3, '0')}`);
}

beforeEach(reset);

// ============================================================================
// Kill switches — one oracle per switch (Acceptance 10)
// ============================================================================

describe('runAutoPark — kill switches', () => {
  it('is a no-op when autoArchiveEnabled=false (even with autoParkEnabled=true): no writes, no log, ran=false', () => {
    withThirtyFillers();
    addStaleRoot('t');
    const before = { ...fixture.get('t')! };
    // Force the counterpart ON so the test proves autoArchiveEnabled is the
    // deciding factor rather than passing because env-CACO_AUTO_PARK happens
    // to be off in the test environment.
    const result = runAutoPark(NOW, { autoArchiveEnabled: false, autoParkEnabled: true });
    expect(result.ran).toBe(false);
    expect(result.parked).toBe(0);
    expect(fixture.get('t')).toEqual(before);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when autoParkEnabled=false (even with autoArchiveEnabled=true): no writes, no log, ran=false', () => {
    withThirtyFillers();
    addStaleRoot('t');
    const before = { ...fixture.get('t')! };
    const result = runAutoPark(NOW, { autoArchiveEnabled: true, autoParkEnabled: false });
    expect(result.ran).toBe(false);
    expect(result.parked).toBe(0);
    expect(fixture.get('t')).toEqual(before);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Gate silences (Acceptance 11)
// ============================================================================

describe('runAutoPark — gate silences', () => {
  it('below-threshold pass: no candidates, no log, ran=false', () => {
    // 5 fresh + 1 stale = 6 root total, below default threshold. Use override
    // to make the stale-count > 0 to prove it is the volume gate that closed.
    for (let i = 0; i < 5; i++) addFreshRoot(`r-${i}`);
    addStaleRoot('t');
    const result = runAutoPark(NOW, { thresholdRoot: 30, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(result.ran).toBe(false);
    expect(result.parked).toBe(0);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('zero-stale pass: 30+ fresh root, no log, ran=false', () => {
    withThirtyFillers();
    const result = runAutoPark(NOW, { thresholdRoot: 30, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(result.ran).toBe(false);
    expect(result.parked).toBe(0);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Gate-passing pass emits the [AUTO-PARK] line (Acceptance 11)
// ============================================================================

describe('runAutoPark — summary log', () => {
  it('parks ≥1 ⇒ emits [AUTO-PARK] with all eight skip buckets in canonical order', () => {
    withThirtyFillers();
    addStaleRoot('t');
    runAutoPark(NOW, { thresholdRoot: 30, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const line = consoleLogSpy.mock.calls[0][0] as string;
    expect(line).toContain('[AUTO-PARK]');
    expect(line).toContain('root=31');
    expect(line).toContain('stale=1');
    expect(line).toContain('parked=1');
    // Canonical order of the skip block.
    const skipMatch = line.match(/skipped=\{([^}]+)\}/);
    expect(skipMatch).not.toBeNull();
    expect(skipMatch![1]).toBe('busy:0, active:0, resuming:0, herd:0, scheduled:0, maintenance:0, metadata:0, stale:0');
  });

  it('gate-passing but zero-parked still emits the line (a session skipped by a guard)', async () => {
    // 30 fresh + 1 stale-but-active — passes both gates but skipped.
    withThirtyFillers();
    addStaleRoot('t');
    const sm = await import('../../src/session-manager.js');
    (sm.sessionManager.isActive as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id === 't');
    try {
      runAutoPark(NOW, { thresholdRoot: 30, idleMs: 21 * DAY, maxPerTick: 100 });
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const line = consoleLogSpy.mock.calls[0][0] as string;
      expect(line).toContain('parked=0');
      expect(line).toContain('active:1');
    } finally {
      (sm.sessionManager.isActive as ReturnType<typeof vi.fn>).mockImplementation(() => false);
    }
  });
});

// ============================================================================
// Per-tick cap applied at the loop (Acceptance 6)
// ============================================================================

describe('runAutoPark — per-tick cap', () => {
  it('caps writes at maxPerTick, parks oldest first, leaves the rest', () => {
    for (let i = 0; i < 3; i++) addFreshRoot(`fresh-${i}`); // small root but we override threshold
    addStaleRoot('young', 25);
    addStaleRoot('mid', 30);
    addStaleRoot('old', 40);
    // Threshold 1 so both gates pass with any stale present.
    const result = runAutoPark(NOW, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 2 });
    expect(result.ran).toBe(true);
    expect(result.parked).toBe(2);
    // Oldest two get parked, youngest survives.
    expect(fixture.get('old')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(fixture.get('mid')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(fixture.get('young')?.folder).toBeUndefined();

    // A subsequent sweep at the same clock parks the third.
    const second = runAutoPark(NOW, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 2 });
    expect(second.parked).toBe(1);
    expect(fixture.get('young')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
  });
});

// ============================================================================
// Rescue round-trip via the REAL production folder-transition function
// (spec-auto-park-idle-root, Acceptance 13). Importing applyFolderChange from
// src/folder-transitions.ts means removing the movedToRootAt stamp there
// turns THESE tests red, not just the source-shape assertion in
// tests/unit/folder-transitions.test.ts.
// ============================================================================

function patchFolder(id: string, next: string | undefined, patchTime: number): void {
  const meta = fixture.get(id);
  if (!meta) throw new Error(`no fixture for ${id}`);
  applyFolderChange(meta, next, patchTime);
}

describe('runAutoPark — rescue round-trip (Acceptance 13)', () => {
  it('parks, user rescues to root, does not re-park for 21 days, does park after 22 days', () => {
    // Start: one stale root session (age 60d).
    addStaleRoot('t', 60);
    const t0 = NOW;

    // First sweep — threshold 1 so the gate passes with just one candidate.
    const r1 = runAutoPark(t0, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(r1.parked).toBe(1);
    expect(fixture.get('t')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(fixture.get('t')?.autoArchiveTaggedAt).toBe(t0);

    // User rescues to root at t1 via the REAL applyFolderChange.
    const t1 = t0 + 1 * DAY;
    patchFolder('t', undefined, t1);
    expect(fixture.get('t')?.folder).toBeUndefined();
    expect(fixture.get('t')?.autoArchiveTaggedAt).toBeUndefined();
    expect(fixture.get('t')?.movedToRootAt).toBe(t1);

    // Second sweep at t1 + 1h: gate passes (root=1, threshold=1) but the rescue
    // anchor is fresh, so stale count is 0 and the pass is a no-op.
    const r2 = runAutoPark(t1 + 60 * 60 * 1000, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(r2.ran).toBe(false);
    expect(r2.stale).toBe(0);
    expect(fixture.get('t')?.folder).toBeUndefined(); // not re-parked

    // Third sweep at t1 + 22d: rescue anchor has aged past window ⇒ re-parked.
    const r3 = runAutoPark(t1 + 22 * DAY, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(r3.parked).toBe(1);
    expect(fixture.get('t')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
  });
});

// ============================================================================
// User-folder → root also stamps (Acceptance 14)
// ============================================================================

describe('runAutoPark — user-folder to root variant (Acceptance 14)', () => {
  it("dragging from 'work' to root also stamps movedToRootAt and defers re-parking", () => {
    // Session sat in 'work' for 60 days.
    fixture.set('t', {
      name: 't',
      folder: 'work',
      lastUsedAt: new Date(NOW - 60 * DAY).toISOString(),
    });

    // User drags to root via the REAL applyFolderChange.
    const t1 = NOW;
    patchFolder('t', undefined, t1);
    expect(fixture.get('t')?.movedToRootAt).toBe(t1);
    expect(fixture.get('t')?.folder).toBeUndefined();

    // Sweep 1s later — the rescue anchor is fresh, so no park.
    const r = runAutoPark(t1 + 1000, { thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 100 });
    expect(r.ran).toBe(false);
    expect(fixture.get('t')?.folder).toBeUndefined(); // still at root
  });
});

// ============================================================================
// Auto-park → reaper composition in one tick (Acceptance 12).
// Exercises the REAL sweepAutoArchive end-to-end, not just runAutoPark, so a
// mutation removing auto-park from sweepAutoArchive OR reversing the ordering
// with the reap loop turns this red.
// ============================================================================

describe('sweep composition — sweepAutoArchive runs auto-park then reap (Acceptance 12)', () => {
  it('a just-auto-parked session is not reaped in the same sweep', async () => {
    const sm = await import('../../src/session-manager.js');
    const reapSpy = vi.fn(async () => 'skipped' as const);
    (sm.sessionManager as unknown as { reapArchive: typeof reapSpy }).reapArchive = reapSpy;

    // One stale root session; the auto-park override lowers the threshold to
    // 1 so the gate passes. The reap loop reads its own env-driven constants
    // for its 3-day window, which won't help the just-parked session — that
    // window measures from `autoArchiveTaggedAt = <sweep now>`, so the reaper
    // must skip it and this assertion catches it if it doesn't.
    addStaleRoot('t', 60);

    const result = await sweepAutoArchive({ thresholdRoot: 1, idleMs: 21 * DAY, maxPerTick: 100 });

    // Auto-park half ran and parked the session.
    expect(result.parked).toBe(1);
    expect(fixture.get('t')?.folder).toBe(AUTO_ARCHIVE_FOLDER);
    expect(fixture.get('t')?.autoArchiveTaggedAt).toBeDefined();
    // Reap half saw the freshly-parked session (scanned) but did NOT invoke
    // reapArchive on it: the anchor is `now`, far from expired.
    expect(reapSpy).not.toHaveBeenCalled();
    expect(result.scanned).toBe(1); // t was scanned by the reap loop's prefilter
    expect(result.archived).toBe(0);
  });
});
