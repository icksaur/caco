import { describe, it, expect } from 'vitest';
import { validateSchedulePutBody } from '../../src/routes/schedule.js';

describe('validateSchedulePutBody', () => {
  const cronHourly = { type: 'cron' as const, expression: '0 * * * *' };

  it('requires a prompt', () => {
    expect(validateSchedulePutBody({ schedule: cronHourly })).toBe('prompt is required');
    expect(validateSchedulePutBody({ prompt: '', schedule: cronHourly })).toBe('prompt is required');
  });

  it('requires a schedule object', () => {
    expect(validateSchedulePutBody({ prompt: 'p' })).toBe(
      'schedule with type and expression/intervalMinutes is required',
    );
  });

  it('requires an expression for a cron schedule', () => {
    expect(validateSchedulePutBody({ prompt: 'p', schedule: { type: 'cron' } })).toBe(
      'schedule with type and expression/intervalMinutes is required',
    );
  });

  it('requires intervalMinutes for an interval schedule', () => {
    expect(validateSchedulePutBody({ prompt: 'p', schedule: { type: 'interval' } })).toBe(
      'schedule with type and expression/intervalMinutes is required',
    );
  });

  it('enforces the minimum interval (min-interval rule from validateScheduleInterval)', () => {
    const err = validateSchedulePutBody({ prompt: 'p', schedule: { type: 'interval', intervalMinutes: 30 } });
    expect(err).toBe('Minimum interval is 60 minutes (1 hour)');
  });

  it('accepts a valid interval schedule (>= 60 min)', () => {
    expect(validateSchedulePutBody({ prompt: 'p', schedule: { type: 'interval', intervalMinutes: 60 } })).toBeNull();
  });

  it('accepts a valid hourly cron schedule', () => {
    expect(validateSchedulePutBody({ prompt: 'p', schedule: cronHourly })).toBeNull();
  });

  it('rejects a too-frequent cron schedule', () => {
    const err = validateSchedulePutBody({ prompt: 'p', schedule: { type: 'cron', expression: '* * * * *' } });
    expect(err).toBeTruthy();
    expect(err).toContain('Minimum interval');
  });
});
