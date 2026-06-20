import { describe, it, expect } from 'vitest';
import { calculateNextRun } from '../../src/schedule-manager.js';
import type { ScheduleDefinition } from '../../src/schedule-store.js';

function def(schedule: ScheduleDefinition['schedule']): ScheduleDefinition {
  return {
    slug: 'test',
    prompt: 'p',
    enabled: true,
    schedule,
    sessionConfig: { persistSession: true },
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z'
  };
}

describe('calculateNextRun', () => {
  const from = new Date('2020-01-01T08:00:00.000Z');

  it('returns a valid future occurrence for a valid cron expression', () => {
    const next = calculateNextRun(def({ type: 'cron', expression: '0 9 * * *' }), from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(Number.isNaN(next.getTime())).toBe(false);
  });

  it('returns from + intervalMinutes for a valid interval', () => {
    const next = calculateNextRun(def({ type: 'interval', intervalMinutes: 60 }), from);
    expect(next.getTime()).toBe(from.getTime() + 60 * 60 * 1000);
  });

  it('throws on an invalid cron expression instead of falling back to 1h', () => {
    expect(() => calculateNextRun(def({ type: 'cron', expression: 'not-a-cron' }), from)).toThrow();
  });

  it('throws on an unknown/incomplete schedule shape instead of falling back to 1h', () => {
    expect(() => calculateNextRun(def({ type: 'interval' }), from)).toThrow();
    expect(() => calculateNextRun(def({ type: 'cron' }), from)).toThrow();
  });
});
