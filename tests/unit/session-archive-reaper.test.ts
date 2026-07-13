import { describe, it, expect } from 'vitest';
import { isAutoArchiveEligible, archiveAnchorMs, type ReaperFacts } from '../../src/session-archive-reaper.js';
import { AUTO_ARCHIVE_FOLDER } from '../../src/config.js';
import type { SessionMeta } from '../../src/session-meta-store.js';

const HOUR = 60 * 60 * 1000;
const THRESHOLD = 24 * HOUR;
const NOW = 1_000_000_000_000;

const liveNothing: ReaperFacts = { isBusy: false, isActive: false, isResuming: false, isParent: false };

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return { name: 'x', folder: AUTO_ARCHIVE_FOLDER, autoArchiveTaggedAt: NOW - 25 * HOUR, ...over };
}

describe('archiveAnchorMs — most-recent of park time and activity', () => {
  it('takes the max of tagged, lastUsedAt, lastIdleAt, creation', () => {
    const m = meta({
      autoArchiveTaggedAt: NOW - 100 * HOUR,
      lastUsedAt: new Date(NOW - 3 * HOUR).toISOString(),
      lastIdleAt: new Date(NOW - 50 * HOUR).toISOString(),
    });
    expect(archiveAnchorMs(m, NOW - 200 * HOUR)).toBe(NOW - 3 * HOUR); // lastUsedAt wins
  });

  it('returns null when nothing is resolvable', () => {
    expect(archiveAnchorMs({ name: 'x', folder: AUTO_ARCHIVE_FOLDER }, null)).toBeNull();
  });
});

describe('isAutoArchiveEligible', () => {
  it('true: parked, quiescent past threshold, not live/load-bearing', () => {
    expect(isAutoArchiveEligible(meta(), liveNothing, NOW, null, THRESHOLD)).toBe(true);
  });

  it('false: not in the auto-archive folder', () => {
    expect(isAutoArchiveEligible(meta({ folder: 'work' }), liveNothing, NOW, null, THRESHOLD)).toBe(false);
    expect(isAutoArchiveEligible(meta({ folder: undefined }), liveNothing, NOW, null, THRESHOLD)).toBe(false);
  });

  it('false: not yet past threshold (anchored on tag time)', () => {
    // Old lastIdleAt (48h) but tagged 1h ago ⇒ NOT eligible: the grace window is
    // anchored on parking, not stale idle.
    const m = meta({ autoArchiveTaggedAt: NOW - 1 * HOUR, lastIdleAt: new Date(NOW - 48 * HOUR).toISOString() });
    expect(isAutoArchiveEligible(m, liveNothing, NOW, null, THRESHOLD)).toBe(false);
  });

  it('false: busy / active / resuming', () => {
    expect(isAutoArchiveEligible(meta(), { ...liveNothing, isBusy: true }, NOW, null, THRESHOLD)).toBe(false);
    expect(isAutoArchiveEligible(meta(), { ...liveNothing, isActive: true }, NOW, null, THRESHOLD)).toBe(false);
    expect(isAutoArchiveEligible(meta(), { ...liveNothing, isResuming: true }, NOW, null, THRESHOLD)).toBe(false);
  });

  it('false: herd parent', () => {
    expect(isAutoArchiveEligible(meta(), { ...liveNothing, isParent: true }, NOW, null, THRESHOLD)).toBe(false);
  });

  it('false: herd child (orchestratedBy set)', () => {
    expect(isAutoArchiveEligible(meta({ orchestratedBy: 'parent-1' }), liveNothing, NOW, null, THRESHOLD)).toBe(false);
  });

  it('false: unknown age (no anchor resolvable)', () => {
    const m: SessionMeta = { name: 'x', folder: AUTO_ARCHIVE_FOLDER };
    expect(isAutoArchiveEligible(m, liveNothing, NOW, null, THRESHOLD)).toBe(false);
  });

  it('old-child disown grace: 48h-idle child disowned now is not eligible until 24h after the tag', () => {
    const disownedNow = meta({ autoArchiveTaggedAt: NOW, lastIdleAt: new Date(NOW - 48 * HOUR).toISOString() });
    expect(isAutoArchiveEligible(disownedNow, liveNothing, NOW, null, THRESHOLD)).toBe(false);
    // 24h + 1ms later ⇒ eligible.
    expect(isAutoArchiveEligible(disownedNow, liveNothing, NOW + THRESHOLD + 1, null, THRESHOLD)).toBe(true);
  });
});
