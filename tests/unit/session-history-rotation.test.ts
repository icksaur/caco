/**
 * History rotation (Phase 1): cut-point selection, transactional copy-verify-swap
 * with auto-revert, concurrent-write guard, archive durability, and crash recovery.
 *
 * Core tests inject stateDir + stub verify/preserveModel so they never touch the
 * SDK or the real storage roots. The defaultPreserveModel test uses the hoisted
 * homedir + CACO_HOME redirection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

const env = vi.hoisted(() => {
  const home = `/tmp/rot-${process.pid}-${Date.now()}`;
  process.env.CACO_HOME = `${home}/.caco`;
  return { home };
});

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => env.home };
});

import {
  planRotation, performRotation, reconcileRotation, defaultPreserveModel, autoRotateIfEligible,
  sweepRotateEligible,
  type RotationConfig, type RotationDeps,
} from '../../src/session-history-rotation.js';

const LOOSE: RotationConfig = { thresholdBytes: 0, minTailEvents: 2, minSavingBytes: 0, pressureBytes: Number.MAX_SAFE_INTEGER };

function line(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, data: extra });
}
const START = line('session.start', { selectedModel: 'm' });
const COMPACT = line('session.compaction_complete', { summary: 'sum' });

let stateDir: string;

function writeSession(sid: string, lines: string[]): string {
  const dir = join(stateDir, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  return dir;
}
function read(path: string): string { return readFileSync(path, 'utf-8'); }
function eventsPath(sid: string): string { return join(stateDir, sid, 'events.jsonl'); }

function baseOverrides(verify: RotationDeps['verify']): Partial<RotationDeps> {
  return { stateDir, verify, preserveModel: () => true, isViewed: () => false, config: LOOSE, log: () => {} };
}

beforeEach(() => {
  stateDir = join(env.home, '.copilot', 'session-state');
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(env.home, '.caco'), { recursive: true, force: true });
});
afterEach(() => {
  rmSync(env.home, { recursive: true, force: true });
});

describe('planRotation', () => {
  const lines = [START, line('a'), line('b'), COMPACT, line('c'), line('d')];

  it('skips below the byte threshold', () => {
    const p = planRotation(lines, 10, { ...LOOSE, thresholdBytes: 1000 });
    expect(p.rotate).toBe(false);
    expect(p.reason).toBe('below-threshold');
  });

  it('cuts at the last compaction_complete, keeping it in the tail', () => {
    const p = planRotation(lines, 1000, LOOSE);
    expect(p.rotate).toBe(true);
    expect(p.cutIndex).toBe(3);
    expect(p.archivedLines).toBe(2);
    expect(p.retainedLines).toBe(4); // line0 + lines[3..5]
  });

  it('uses the last of several compaction events', () => {
    const many = [START, line('a'), COMPACT, line('b'), COMPACT, line('c')];
    expect(planRotation(many, 1000, LOOSE).cutIndex).toBe(4);
  });

  it('falls back to a fixed tail when no compaction exists', () => {
    const noComp = [START, line('a'), line('b'), line('c'), line('d'), line('e')];
    const p = planRotation(noComp, 1000, { ...LOOSE, minTailEvents: 2 });
    expect(p.rotate).toBe(true);
    expect(p.cutIndex).toBe(4); // len(6) - 2
  });

  it('refuses when the cut is too near the head', () => {
    const p = planRotation([START, COMPACT, line('a')], 1000, LOOSE);
    expect(p.rotate).toBe(false);
    expect(p.reason).toBe('cut-too-near-head');
  });

  it('refuses when the saving is too small', () => {
    const p = planRotation(lines, 1000, { ...LOOSE, minSavingBytes: 1_000_000 });
    expect(p.rotate).toBe(false);
    expect(p.reason).toBe('saving-too-small');
  });

  it('refuses with too few events', () => {
    expect(planRotation([START, COMPACT], 1000, LOOSE).reason).toBe('too-few-events');
  });

  it('counts retained user.message events in retained, not archived', () => {
    const u = line('user.message', { content: 'x' });
    const withUser = [START, u, line('a'), line('b'), COMPACT, line('c')];
    const p = planRotation(withUser, 1000, LOOSE);
    expect(p.rotate).toBe(true);
    expect(p.cutIndex).toBe(4);
    expect(p.archivedLines).toBe(2); // a, b — NOT the user message
    expect(p.retainedLines).toBe(4); // START, u, COMPACT, c
  });
});

describe('performRotation — happy path', () => {
  it('truncates to [start + last-compaction tail], archives the head, cleans sidecars', async () => {
    const sid = 'happy';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c'), line('d')]);

    const result = await performRotation(sid, baseOverrides(async () => { /* loads fine */ }));

    expect(result.ok).toBe(true);
    expect(read(eventsPath(sid))).toBe([START, COMPACT, line('c'), line('d')].join('\n') + '\n');
    expect(read(join(stateDir, sid, 'events-archive.jsonl'))).toBe([line('a'), line('b')].join('\n') + '\n');
    expect(existsSync(eventsPath(sid) + '.prerotate')).toBe(false);
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
    expect(result.archivedLines).toBe(2);
  });

  it('retains pre-cut user.message events (memory digest) instead of archiving them', async () => {
    const sid = 'keepusers';
    const u1 = line('user.message', { content: 'early ask' });
    writeSession(sid, [START, u1, line('a'), line('b'), COMPACT, line('c')]);

    const result = await performRotation(sid, baseOverrides(async () => {}));

    expect(result.ok).toBe(true);
    // u1 stays in the live file; only the non-user head (a, b) is archived.
    expect(read(eventsPath(sid))).toBe([START, u1, COMPACT, line('c')].join('\n') + '\n');
    expect(read(join(stateDir, sid, 'events-archive.jsonl'))).toBe([line('a'), line('b')].join('\n') + '\n');
    expect(result.archivedLines).toBe(2);
  });

  it('preserves the compaction_complete line so the model keeps its summary', async () => {
    const sid = 'keepsum';
    writeSession(sid, [START, line('a'), COMPACT, line('z')]);
    await performRotation(sid, baseOverrides(async () => {}));
    expect(read(eventsPath(sid)).includes('compaction_complete')).toBe(true);
  });
});

describe('performRotation — auto-revert and guards', () => {
  it('leaves events.jsonl byte-identical when verify throws', async () => {
    const sid = 'badverify';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    const before = read(eventsPath(sid));

    const result = await performRotation(sid, baseOverrides(async () => { throw new Error('corrupt'); }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('verify-failed');
    expect(read(eventsPath(sid))).toBe(before);
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
    expect(existsSync(eventsPath(sid) + '.prerotate')).toBe(false);
    expect(existsSync(join(stateDir, sid, 'events-archive.jsonl'))).toBe(false);
  });

  it('aborts the swap if the live file is written during verify', async () => {
    const sid = 'concurrent';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);

    const result = await performRotation(sid, baseOverrides(async () => {
      appendFileSync(eventsPath(sid), line('late') + '\n'); // user sent a message mid-rotation
    }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('concurrent-write');
    expect(read(eventsPath(sid)).includes('late')).toBe(true); // their write survived
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
  });

  it('aborts (no truncation) when the archive append fails', async () => {
    const sid = 'noarchive';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    const before = read(eventsPath(sid));
    // Make the archive path un-appendable by making it a directory.
    mkdirSync(join(stateDir, sid, 'events-archive.jsonl'));

    const result = await performRotation(sid, baseOverrides(async () => {}));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('archive-failed');
    expect(read(eventsPath(sid))).toBe(before);
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
  });

  it('aborts when preserveModel returns false, without touching events', async () => {
    const sid = 'nomodel';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    const before = read(eventsPath(sid));

    const result = await performRotation(sid, {
      ...baseOverrides(async () => {}),
      preserveModel: () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('model-persist-failed');
    expect(read(eventsPath(sid))).toBe(before);
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
  });

  it('aborts the swap if the session becomes viewed during verify', async () => {
    const sid = 'became-viewed';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    const before = read(eventsPath(sid));
    let viewed = false;
    const result = await performRotation(sid, {
      ...baseOverrides(async () => { viewed = true; }), // a client subscribes during verify
      isViewed: () => viewed,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('became-viewed');
    expect(read(eventsPath(sid))).toBe(before);
    expect(existsSync(eventsPath(sid) + '.candidate')).toBe(false);
  });

  it('refuses when rotation sidecars are already present', async () => {
    const sid = 'artifacts';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    writeFileSync(eventsPath(sid) + '.prerotate', 'x');

    const result = await performRotation(sid, baseOverrides(async () => {}));
    expect(result.reason).toBe('rotation-artifacts-present');
  });

  it('propagates a skip reason from the plan', async () => {
    const sid = 'skip';
    writeSession(sid, [START, line('a'), line('b'), COMPACT, line('c')]);
    const result = await performRotation(sid, {
      ...baseOverrides(async () => {}),
      config: { ...LOOSE, thresholdBytes: 1_000_000_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('below-threshold');
  });
});

describe('reconcileRotation — crash recovery by file presence', () => {
  function setup(sid: string, files: Record<string, string | null>) {
    const dir = join(stateDir, sid);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (content !== null) writeFileSync(join(dir, name), content);
    }
  }

  it('does nothing when no sidecars are present', () => {
    setup('a', { 'events.jsonl': 'live\n' });
    expect(reconcileRotation('a', { stateDir })).toBe('clean');
    expect(read(eventsPath('a'))).toBe('live\n');
  });

  it('discards a leftover candidate when the live file is intact', () => {
    setup('b', { 'events.jsonl': 'orig\n', 'events.jsonl.candidate': 'cand\n' });
    expect(reconcileRotation('b', { stateDir })).toBe('discarded-candidate');
    expect(read(eventsPath('b'))).toBe('orig\n');
    expect(existsSync(eventsPath('b') + '.candidate')).toBe(false);
  });

  it('installs the verified candidate when the live file is missing', () => {
    setup('c', { 'events.jsonl': null, 'events.jsonl.candidate': 'cand\n' });
    expect(reconcileRotation('c', { stateDir })).toBe('installed-candidate');
    expect(read(eventsPath('c'))).toBe('cand\n');
  });

  it('cleans up prerotate after a completed swap', () => {
    setup('d', { 'events.jsonl': 'new\n', 'events.jsonl.prerotate': 'orig\n' });
    expect(reconcileRotation('d', { stateDir })).toBe('committed-cleanup');
    expect(read(eventsPath('d'))).toBe('new\n');
    expect(existsSync(eventsPath('d') + '.prerotate')).toBe(false);
  });

  it('recovers the candidate when crash happened between the two renames', () => {
    setup('e', { 'events.jsonl': null, 'events.jsonl.prerotate': 'orig\n', 'events.jsonl.candidate': 'cand\n' });
    expect(reconcileRotation('e', { stateDir })).toBe('recovered-candidate');
    expect(read(eventsPath('e'))).toBe('cand\n');
    expect(existsSync(eventsPath('e') + '.prerotate')).toBe(false);
  });

  it('restores the original when nothing else survives the gap', () => {
    setup('f', { 'events.jsonl': null, 'events.jsonl.prerotate': 'orig\n' });
    expect(reconcileRotation('f', { stateDir })).toBe('restored-original');
    expect(read(eventsPath('f'))).toBe('orig\n');
  });
});

describe('autoRotateIfEligible — pre-gates (no SDK)', () => {
  const cfg: RotationConfig = { thresholdBytes: 1000, minTailEvents: 2, minSavingBytes: 0, pressureBytes: Number.MAX_SAFE_INTEGER };

  afterEach(() => { delete process.env.CACO_ROTATE_AUTO; });

  it('returns null when auto-rotate is disabled (CACO_ROTATE_AUTO=0)', async () => {
    process.env.CACO_ROTATE_AUTO = '0';
    writeSession('ar1', [START, line('a'), COMPACT, line('c')]);
    expect(await autoRotateIfEligible('ar1', { stateDir, config: cfg })).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('returns null when the events file is missing', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    expect(await autoRotateIfEligible('nope', { stateDir, config: cfg })).toMatchObject({ ok: false, reason: 'no-events' });
  });

  it('returns null when the file is below the size threshold', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    writeSession('ar2', [START, line('a'), COMPACT, line('c')]);
    expect(await autoRotateIfEligible('ar2', { stateDir, config: { ...cfg, thresholdBytes: 10_000_000 } })).toMatchObject({ ok: false, reason: 'under-threshold' });
  });

  it('skips an unobserved session (user likely about to open it)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-unobs';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    // Even with thresholds wide open, an unobserved session must short-circuit
    // to null BEFORE the size statSync / rotation work.
    const result = await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 },
      isUnobserved: () => true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unobserved' });
  });

  it('backs off within the cooldown after a recent attempt (even a failed one)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar3';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    // Simulate a just-recorded attempt timestamp in meta.
    mkdirSync(join(env.home, '.caco', 'sessions', sid), { recursive: true });
    writeFileSync(
      join(env.home, '.caco', 'sessions', sid, 'meta.json'),
      JSON.stringify({ name: '', lastRotateAttemptAt: Date.now() }),
    );
    // Threshold is 0 here so size passes; inject isBlocked=false so we reach the
    // cooldown gate, which must short-circuit WITHOUT calling rotateSessionHistory.
    expect(await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 }, isBlocked: () => false,
    })).toMatchObject({ ok: false, reason: 'cooldown' });
  });

  it('skips a viewed session before stat/rotation', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-viewed';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const result = await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 },
      isViewed: () => true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'viewed' });
  });

  it('skips when idle age is below minIdleAgeMs (sweep gate)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-fresh';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    mkdirSync(join(env.home, '.caco', 'sessions', sid), { recursive: true });
    writeFileSync(join(env.home, '.caco', 'sessions', sid, 'meta.json'),
      JSON.stringify({ name: '', lastIdleAt: new Date().toISOString() }));
    const result = await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 },
      isBlocked: () => false, minIdleAgeMs: 60_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not-idle' });
  });

  it('skips when there is no idle metadata under a sweep age gate', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-noidle';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const result = await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 },
      isBlocked: () => false, minIdleAgeMs: 60_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'never-idle' });
  });

  // ── Pressure escalation (docs/spec-rotation-pressure.md) ──

  it('at/above the pressure ceiling, a VIEWED session still rotates (courtesy gate overridden)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-viewed';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const seen: string[] = [];
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      // pressureBytes 0 => every size is "under pressure"
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isUnobserved: () => true,
      isBlocked: () => false,
      verify: async () => {},
      log: (m: string) => seen.push(m),
    });
    expect(result.ok).toBe(true);
    expect(seen.some(m => /overriding viewed\/unobserved/.test(m))).toBe(true);
  });

  it('the pressure override reaches the SWAP-TIME isViewed re-check, not just eligibility', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-swap';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    // performRotation re-checks isViewed immediately before the swap. If the override
    // stopped at the eligibility gate this would abort with 'became-viewed' after a
    // full verify — the exact bug that made an always-viewed session unrotatable.
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isBlocked: () => false,
      verify: async () => {},
    });
    expect(result.reason).not.toBe('became-viewed');
    expect(result.ok).toBe(true);
  });

  it('correctness gates stay absolute even far above the pressure ceiling', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-busy';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isBlocked: () => true, // busy/rotating/resuming
      verify: async () => { throw new Error('must not verify a blocked session'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('below the ceiling a viewed session is skipped WITHOUT running the verify (no wasted work)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-subceiling';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: Number.MAX_SAFE_INTEGER },
      isViewed: () => true,
      isBlocked: () => false,
      verify: async () => { throw new Error('verify must not run for a sub-ceiling viewed session'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'viewed' });
  });

  it('swap safety holds on the pressure path: a concurrent write still aborts the swap', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-concurrent';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const eventsPath = join(stateDir, sid, 'events.jsonl');
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isBlocked: () => false,
      // Mutate the live file DURING verify: the pre-swap stat re-check must abort.
      verify: async () => { writeFileSync(eventsPath, read(eventsPath) + '\n' + line('late')); },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed:concurrent-write');
  });

  it('swap safety holds on the pressure path: an archive failure aborts before any rename', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-archivefail';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const eventsPath = join(stateDir, sid, 'events.jsonl');
    const before = read(eventsPath);
    // Make the archive path unwritable by planting a DIRECTORY where the archive file goes.
    mkdirSync(join(stateDir, sid, 'events-archive.jsonl'), { recursive: true });
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isBlocked: () => false,
      verify: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed:archive-failed');
    // Live file untouched — archive-append precedes the swap.
    expect(read(eventsPath)).toBe(before);
  });

  it('swap safety holds on the pressure path: a verify failure leaves the file byte-identical', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-pressure-verifyfail';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const eventsPath = join(stateDir, sid, 'events.jsonl');
    const before = read(eventsPath);
    const result = await autoRotateIfEligible(sid, {
      stateDir,
      config: { ...cfg, thresholdBytes: 0, pressureBytes: 0 },
      isViewed: () => true,
      isBlocked: () => false,
      verify: async () => { throw new Error('staged load failed'); },
    });
    expect(result.ok).toBe(false);
    expect(read(eventsPath)).toBe(before);
  });

  it('does NOT stamp cooldown when the session is blocked (active/busy/etc.)', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const sid = 'ar-blocked';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const metaP = join(env.home, '.caco', 'sessions', sid, 'meta.json');
    const result = await autoRotateIfEligible(sid, {
      stateDir, config: { ...cfg, thresholdBytes: 0 },
      isBlocked: () => true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    // No attempt timestamp written → eligible again the moment it unblocks.
    const meta = existsSync(metaP) ? JSON.parse(read(metaP)) : {};
    expect(meta.lastRotateAttemptAt).toBeUndefined();
  });
});

describe('sweepRotateEligible', () => {
  it('logs a skip-reason breakdown so "rotated=0" is never silent', async () => {
    const rotate = async (id: string) => (
      id === 'big' ? { ok: true, savedBytes: 1048576 }
      : id === 'open' ? { ok: false, reason: 'viewed' }
      : { ok: false, reason: 'under-threshold' }
    );
    const lines: string[] = [];
    const summary = await sweepRotateEligible({
      knownSessionIds: () => ['big', 'open', 's1', 's2'],
      rotate, log: (m: string) => lines.push(m), stateDir,
    });
    expect(summary).toMatchObject({ scanned: 4, rotated: 1 });
    const line = lines.join('\n');
    expect(line).toContain('under-threshold:2');
    expect(line).toContain('viewed:1');
  });

  it('warns loudly when an over-pressure session still did not rotate', async () => {
    const sid = 'sweep-overpressure';
    writeSession(sid, [START, line('a'), COMPACT, line('c')]);
    const warns: string[] = [];
    // The skip result carries the measured size (no re-stat in the sweep), so a
    // contract-faithful stub must report it just as autoRotateIfEligible does.
    process.env.CACO_ROTATE_PRESSURE_BYTES = '1';
    try {
      await sweepRotateEligible({
        knownSessionIds: () => [sid],
        rotate: async () => ({ ok: false, reason: 'blocked', beforeBytes: 5_000_000 }),
        log: () => {}, warn: (m: string) => warns.push(m), stateDir,
      });
    } finally { delete process.env.CACO_ROTATE_PRESSURE_BYTES; }
    expect(warns.some(w => /did NOT rotate: blocked/.test(w))).toBe(true);
  });

  afterEach(() => { delete process.env.CACO_ROTATE_AUTO; });

  it('returns an empty summary when auto-rotate is disabled', async () => {
    process.env.CACO_ROTATE_AUTO = '0';
    const rotate = vi.fn(async () => ({ ok: true, savedBytes: 1 }));
    const summary = await sweepRotateEligible({ knownSessionIds: () => ['a', 'b'], rotate });
    expect(summary).toEqual({ scanned: 0, rotated: 0, savedBytes: 0 });
    expect(rotate).not.toHaveBeenCalled();
  });

  it('rotates eligible ids sequentially and tallies savings', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    let inFlight = 0;
    let maxConcurrent = 0;
    const rotate = vi.fn(async (id: string) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return id === 'big' ? { ok: true, savedBytes: 1000 } : { ok: false };
    });
    const summary = await sweepRotateEligible({ knownSessionIds: () => ['small', 'big', 'small2'], rotate });
    expect(summary.scanned).toBe(3);
    expect(summary.rotated).toBe(1);
    expect(summary.savedBytes).toBe(1000);
    expect(maxConcurrent).toBe(1); // never parallel
  });

  it('skips the boot-excluded id', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const seen: string[] = [];
    const rotate = vi.fn(async (id: string) => { seen.push(id); return { ok: false }; });
    await sweepRotateEligible({ knownSessionIds: () => ['keep', 'open-on-boot'], rotate, bootExcludeId: 'open-on-boot' });
    expect(seen).toEqual(['keep']);
  });

  it('continues when one id throws', async () => {
    process.env.CACO_ROTATE_AUTO = '1';
    const rotate = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('kaboom');
      return { ok: true, savedBytes: 5 };
    });
    const summary = await sweepRotateEligible({ knownSessionIds: () => ['boom', 'ok'], rotate });
    expect(summary.scanned).toBe(2);
    expect(summary.rotated).toBe(1);
  });
});

describe('defaultPreserveModel', () => {
  function writeEvents(sid: string, lines: string[]) {
    const dir = join(env.home, '.copilot', 'session-state', sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  }
  function metaPath(sid: string) { return join(env.home, '.caco', 'sessions', sid, 'meta.json'); }

  it('persists the parsed model into meta when meta lacks one', () => {
    const sid = 'pm1';
    writeEvents(sid, [line('session.start', { selectedModel: 'claude-x' }), line('a')]);
    expect(defaultPreserveModel(sid)).toBe(true);
    expect(JSON.parse(read(metaPath(sid))).model).toBe('claude-x');
  });

  it('keeps an existing meta model (BYOK/provider identity) untouched', () => {
    const sid = 'pm2';
    mkdirSync(join(env.home, '.caco', 'sessions', sid), { recursive: true });
    writeFileSync(metaPath(sid), JSON.stringify({ name: '', model: 'openrouter:foo' }));
    writeEvents(sid, [line('session.start', { selectedModel: 'claude-x' })]);
    expect(defaultPreserveModel(sid)).toBe(true);
    expect(JSON.parse(read(metaPath(sid))).model).toBe('openrouter:foo');
  });

  it('returns true (not abort) when there is no model to preserve', () => {
    const sid = 'pm3';
    writeEvents(sid, [line('a'), line('b')]);
    expect(defaultPreserveModel(sid)).toBe(true);
  });

  it('aborts (false) when meta.json is corrupt', () => {
    const sid = 'pm4';
    mkdirSync(join(env.home, '.caco', 'sessions', sid), { recursive: true });
    writeFileSync(metaPath(sid), '{ broken json');
    writeEvents(sid, [line('session.start', { selectedModel: 'claude-x' })]);
    expect(defaultPreserveModel(sid)).toBe(false);
  });
});
