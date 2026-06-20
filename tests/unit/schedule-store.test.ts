import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const testState = vi.hoisted(() => ({ homeDir: `/tmp/schedule-store-test-${process.pid}` }));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: () => testState.homeDir };
});

import { loadDefinitionResult, loadLastRunResult, saveDefinition } from '../../src/schedule-store.js';

function schedDir(slug: string): string {
  return join(testState.homeDir, '.caco', 'schedule', slug);
}

beforeEach(() => {
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true });
  mkdirSync(join(testState.homeDir, '.caco', 'schedule'), { recursive: true });
});

afterEach(() => {
  rmSync(join(testState.homeDir, '.caco'), { recursive: true, force: true });
});

describe('schedule-store typed loaders', () => {
  it('classifies an absent definition as missing', async () => {
    const r = await loadDefinitionResult('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('missing');
  });

  it('classifies a corrupt definition as corrupt (not missing)', async () => {
    mkdirSync(schedDir('bad'), { recursive: true });
    writeFileSync(join(schedDir('bad'), 'definition.json'), '{ not valid json');
    const r = await loadDefinitionResult('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });

  it('reads a valid definition as ok', async () => {
    await saveDefinition({
      slug: 'good',
      prompt: 'do the thing',
      enabled: true,
      schedule: { type: 'interval', intervalMinutes: 120 },
      sessionConfig: { persistSession: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const r = await loadDefinitionResult('good');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prompt).toBe('do the thing');
  });

  it('classifies a corrupt last-run as corrupt', async () => {
    mkdirSync(schedDir('lr'), { recursive: true });
    writeFileSync(join(schedDir('lr'), 'last-run.json'), 'totally broken');
    const r = await loadLastRunResult('lr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('corrupt');
  });
});

import { validateScheduleInterval } from '../../src/schedule-store.js';

describe('validateScheduleInterval', () => {
  it('accepts a valid interval at/above the minimum', () => {
    expect(validateScheduleInterval({ type: 'interval', intervalMinutes: 60 })).toBeNull();
  });

  it('accepts a valid cron at/above the minimum', () => {
    expect(validateScheduleInterval({ type: 'cron', expression: '0 9 * * *' })).toBeNull();
  });

  it('rejects an interval schedule with no intervalMinutes', () => {
    expect(validateScheduleInterval({ type: 'interval' })).toBeTruthy();
  });

  it('rejects a cron schedule with no expression', () => {
    expect(validateScheduleInterval({ type: 'cron' })).toBeTruthy();
  });

  it('rejects an invalid cron expression', () => {
    expect(validateScheduleInterval({ type: 'cron', expression: 'not-a-cron' })).toBeTruthy();
  });

  it('rejects an interval below the minimum', () => {
    expect(validateScheduleInterval({ type: 'interval', intervalMinutes: 5 })).toBeTruthy();
  });
});
