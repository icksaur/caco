import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import type { ScheduleDefinition, LastRunState } from '../../src/schedule-store.js';

const testState = vi.hoisted(() => ({ homeDir: `/tmp/schedule-store-more-${process.pid}` }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

import {
  MIN_INTERVAL_MINUTES,
  deleteSchedule,
  getScheduleForSession,
  listSchedules,
  loadDefinition,
  loadLastRun,
  saveDefinition,
  saveLastRun,
  scheduleExists,
  validateScheduleInterval,
} from '../../src/schedule-store.js';

function scheduleRoot(): string {
  return join(testState.homeDir, '.caco', 'schedule');
}

function schedDir(slug: string): string {
  return join(scheduleRoot(), slug);
}

function definition(overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    slug: 'daily-review',
    prompt: 'review the project',
    enabled: true,
    schedule: { type: 'interval', intervalMinutes: MIN_INTERVAL_MINUTES },
    sessionConfig: { model: 'claude-sonnet-4.6', persistSession: true },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function lastRun(overrides: Partial<LastRunState> = {}): LastRunState {
  return {
    lastRun: '2026-07-03T00:00:00.000Z',
    lastResult: 'success',
    lastError: null,
    sessionId: 'session-123',
    nextRun: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true });
  mkdirSync(scheduleRoot(), { recursive: true });
});

afterEach(() => {
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true });
});

describe('schedule-store additional file operations', () => {
  it('saveDefinition and loadDefinition round-trip the definition and write JSON to disk', async () => {
    const saved = definition();

    await saveDefinition(saved);

    expect(await loadDefinition(saved.slug)).toEqual(saved);
    expect(await scheduleExists(saved.slug)).toBe(true);
    const persisted = JSON.parse(await import('fs/promises').then(fs => fs.readFile(join(schedDir(saved.slug), 'definition.json'), 'utf-8')));
    expect(persisted.prompt).toBe('review the project');
    expect(persisted.sessionConfig.persistSession).toBe(true);
  });

  it('loadDefinition returns null for a missing definition', async () => {
    expect(await loadDefinition('missing-definition')).toBeNull();
    expect(await scheduleExists('missing-definition')).toBe(false);
  });

  it('saveLastRun and loadLastRun round-trip last-run state', async () => {
    const state = lastRun({ lastResult: 'error', lastError: 'boom', sessionId: 'session-error' });

    await saveLastRun('nightly', state);

    expect(await loadLastRun('nightly')).toEqual(state);
    const persisted = JSON.parse(await import('fs/promises').then(fs => fs.readFile(join(schedDir('nightly'), 'last-run.json'), 'utf-8')));
    expect(persisted.lastError).toBe('boom');
    expect(persisted.sessionId).toBe('session-error');
  });

  it('loadLastRun returns null when no last-run file exists', async () => {
    expect(await loadLastRun('never-ran')).toBeNull();
  });

  it('listSchedules returns visible schedule directories and ignores hidden dirs and files', async () => {
    mkdirSync(schedDir('alpha'), { recursive: true });
    mkdirSync(schedDir('.hidden'), { recursive: true });
    writeFileSync(join(scheduleRoot(), 'not-a-dir'), 'x');
    mkdirSync(schedDir('beta'), { recursive: true });

    expect((await listSchedules()).sort()).toEqual(['alpha', 'beta']);
  });

  it('listSchedules returns an empty list when the schedule root is absent', async () => {
    rmSync(scheduleRoot(), { recursive: true, force: true });

    expect(await listSchedules()).toEqual([]);
  });

  it('deleteSchedule removes definition and last-run files', async () => {
    await saveDefinition(definition({ slug: 'delete-me' }));
    await saveLastRun('delete-me', lastRun());

    expect(await deleteSchedule('delete-me')).toBe(true);

    expect(existsSync(schedDir('delete-me'))).toBe(false);
    expect(await scheduleExists('delete-me')).toBe(false);
    expect(await loadLastRun('delete-me')).toBeNull();
  });

  it('getScheduleForSession returns the matching schedule and converts empty nextRun to null', async () => {
    await saveDefinition(definition({ slug: 'first' }));
    await saveLastRun('first', lastRun({ sessionId: 'other-session' }));
    await saveDefinition(definition({ slug: 'matched' }));
    await saveLastRun('matched', lastRun({ sessionId: 'target-session', nextRun: '' }));

    expect(await getScheduleForSession('target-session')).toEqual({ slug: 'matched', nextRun: null });
  });

  it('getScheduleForSession returns null when no last-run state references the session', async () => {
    await saveDefinition(definition({ slug: 'unmatched' }));
    await saveLastRun('unmatched', lastRun({ sessionId: 'someone-else' }));

    expect(await getScheduleForSession('target-session')).toBeNull();
  });
});

describe('schedule-store additional validation', () => {
  it('accepts the exact minimum interval and rejects non-finite intervals', () => {
    expect(validateScheduleInterval({ type: 'interval', intervalMinutes: MIN_INTERVAL_MINUTES })).toBeNull();
    expect(validateScheduleInterval({ type: 'interval', intervalMinutes: Number.NaN })).toBe('Interval schedule requires a numeric intervalMinutes');
  });

  it('rejects cron expressions below the minimum interval with the computed minute count', () => {
    expect(validateScheduleInterval({ type: 'cron', expression: '*/30 * * * *' })).toBe('Cron expression runs every 30 minutes. Minimum interval is 60 minutes (1 hour)');
  });

  it('rejects unknown schedule types', () => {
    const invalidSchedule = { type: 'calendar' } as unknown as { type: 'cron' | 'interval' };

    expect(validateScheduleInterval(invalidSchedule)).toBe('Unknown schedule type');
  });
});
