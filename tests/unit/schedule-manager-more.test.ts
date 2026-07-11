import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LastRunState, ScheduleDefinition } from '../../src/schedule-store.js';

const store = vi.hoisted(() => ({
  listSchedules: vi.fn<() => Promise<string[]>>(),
  loadDefinitionResult: vi.fn<(slug: string) => Promise<{ ok: true; value: ScheduleDefinition } | { ok: false; kind: 'missing' | 'corrupt'; error?: Error }>>(),
  loadLastRunResult: vi.fn<(slug: string) => Promise<{ ok: true; value: LastRunState } | { ok: false; kind: 'missing' | 'corrupt'; error?: Error }>>(),
  saveLastRun: vi.fn<(slug: string, state: LastRunState) => Promise<void>>(),
  validateScheduleInterval: vi.fn<(_schedule: ScheduleDefinition['schedule']) => string | null>(),
}));

vi.mock('../../src/schedule-store.js', () => store);
vi.mock('../../src/config.js', () => ({
  SERVER_URL: 'http://scheduler.test',
  SCHEDULE_CHECK_INTERVAL_MS: 1_000,
  SCHEDULE_BUSY_DELAY_MS: 7_200_000,
}));

import { calculateNextRun, startScheduleManager, stopScheduleManager, triggerSchedule } from '../../src/schedule-manager.js';

function definition(schedule: ScheduleDefinition['schedule'], persistSession = true): ScheduleDefinition {
  return {
    slug: 'daily-job',
    prompt: 'run the job',
    enabled: true,
    schedule,
    sessionConfig: { model: 'gpt-test', persistSession },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function lastRun(sessionId: string | null, nextRun = '2026-01-01T00:00:00.000Z'): LastRunState {
  return {
    lastRun: '2025-12-31T00:00:00.000Z',
    lastResult: 'success',
    lastError: null,
    sessionId,
    nextRun,
  };
}

function okResponse(body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('calculateNextRun more oracles', () => {
  it('computes interval schedules from the supplied clock', () => {
    const from = new Date('2026-07-10T12:34:56.000Z');

    expect(calculateNextRun(definition({ type: 'interval', intervalMinutes: 90 }), from).toISOString()).toBe('2026-07-10T14:04:56.000Z');
    expect(calculateNextRun(definition({ type: 'interval', intervalMinutes: 24 * 60 }), from).toISOString()).toBe('2026-07-11T12:34:56.000Z');
  });

  it('computes cron schedules from concrete calendar cases', () => {
    expect(calculateNextRun(definition({ type: 'cron', expression: '15 * * * *' }), new Date('2026-07-10T08:00:00.000Z')).toISOString()).toBe('2026-07-10T08:15:00.000Z');
    expect(calculateNextRun(definition({ type: 'cron', expression: '15 * * * *' }), new Date('2026-07-10T08:20:00.000Z')).toISOString()).toBe('2026-07-10T09:15:00.000Z');
  });

  it('includes the slug and invalid shape in incomplete schedule errors', () => {
    expect(() => calculateNextRun(definition({ type: 'interval' }), new Date('2026-07-10T00:00:00.000Z'))).toThrow('Cannot compute next run for daily-job');
  });
});

describe('triggerSchedule branch behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    vi.clearAllMocks();
    store.loadDefinitionResult.mockResolvedValue({ ok: true, value: definition({ type: 'interval', intervalMinutes: 60 }) });
    store.loadLastRunResult.mockResolvedValue({ ok: false, kind: 'missing' });
    store.saveLastRun.mockResolvedValue();
    store.validateScheduleInterval.mockReturnValue(null);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    stopScheduleManager();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('creates a new persisted scheduled session when no prior session exists', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ sessionId: 'created-1' })).mockResolvedValueOnce(okResponse());

    await expect(triggerSchedule('daily-job')).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://scheduler.test/api/sessions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ cwd: process.cwd(), model: 'gpt-test', description: 'daily-job', kind: 'scheduled' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://scheduler.test/api/sessions/created-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prompt: 'run the job', source: 'scheduler', scheduleSlug: 'daily-job' }),
    }));
    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({
      lastResult: 'success',
      lastError: null,
      sessionId: 'created-1',
      nextRun: '2026-07-10T13:00:00.000Z',
    }));
  });

  it('does not persist a new session id when the definition asks for ephemeral sessions', async () => {
    store.loadDefinitionResult.mockResolvedValue({ ok: true, value: definition({ type: 'interval', intervalMinutes: 60 }, false) });
    fetchMock.mockResolvedValueOnce(okResponse({ sessionId: 'created-ephemeral' })).mockResolvedValueOnce(okResponse());

    await triggerSchedule('daily-job');

    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({ sessionId: null, lastResult: 'success' }));
  });

  it('reuses an existing session and records the next run on success', async () => {
    store.loadLastRunResult.mockResolvedValue({ ok: true, value: lastRun('existing-1') });
    fetchMock.mockResolvedValueOnce(okResponse());

    await expect(triggerSchedule('daily-job')).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledWith('http://scheduler.test/api/sessions/existing-1/messages', expect.objectContaining({ method: 'POST' }));
    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({
      lastResult: 'success',
      lastError: null,
      sessionId: 'existing-1',
      nextRun: '2026-07-10T13:00:00.000Z',
    }));
  });

  it('delays an existing session when the route reports it is busy', async () => {
    store.loadLastRunResult.mockResolvedValue({ ok: true, value: lastRun('busy-1') });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));

    await triggerSchedule('daily-job');

    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({
      lastResult: 'error',
      lastError: 'Session busy',
      sessionId: 'busy-1',
      nextRun: '2026-07-10T14:00:00.000Z',
    }));
  });

  it('creates a replacement session when the recorded session is missing', async () => {
    store.loadLastRunResult.mockResolvedValue({ ok: true, value: lastRun('gone-1') });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(okResponse({ sessionId: 'replacement-1' })).mockResolvedValueOnce(okResponse());

    await triggerSchedule('daily-job');

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://scheduler.test/api/sessions', expect.objectContaining({ method: 'POST' }));
    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({ sessionId: 'replacement-1', lastResult: 'success' }));
  });

  it('records create failures as schedule errors while triggerSchedule reports handled execution', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(triggerSchedule('daily-job')).resolves.toEqual({ success: true });

    expect(store.saveLastRun).toHaveBeenCalledWith('daily-job', expect.objectContaining({
      lastResult: 'error',
      lastError: 'Failed to create session: HTTP 503',
      sessionId: null,
      nextRun: '2026-07-10T13:00:00.000Z',
    }));
  });

  it('skips corrupt state that would otherwise duplicate a session', async () => {
    store.loadLastRunResult.mockResolvedValue({ ok: false, kind: 'corrupt', error: new Error('bad json') });

    await triggerSchedule('daily-job');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saveLastRun).not.toHaveBeenCalled();
  });

  it('returns success without side effects when the definition is missing', async () => {
    store.loadDefinitionResult.mockResolvedValue({ ok: false, kind: 'missing' });

    await expect(triggerSchedule('missing-job')).resolves.toEqual({ success: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saveLastRun).not.toHaveBeenCalled();
  });
});

describe('schedule manager loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sessionId: 'loop-session' })));
    store.validateScheduleInterval.mockReturnValue(null);
    store.saveLastRun.mockResolvedValue();
  });

  afterEach(() => {
    stopScheduleManager();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('executes enabled due schedules and ignores disabled, future, invalid, and corrupt entries', async () => {
    const due = definition({ type: 'interval', intervalMinutes: 60 });
    const disabled = { ...due, enabled: false };
    store.listSchedules.mockResolvedValue(['due', 'disabled', 'future', 'invalid', 'corrupt-def', 'corrupt-run']);
    store.loadDefinitionResult.mockImplementation(async slug => {
      if (slug === 'corrupt-def') return { ok: false, kind: 'corrupt', error: new Error('bad definition') };
      if (slug === 'invalid') return { ok: true, value: definition({ type: 'interval', intervalMinutes: 1 }) };
      return { ok: true, value: slug === 'disabled' ? disabled : due };
    });
    store.loadLastRunResult.mockImplementation(async slug => {
      if (slug === 'future') return { ok: true, value: lastRun(null, '2026-07-10T12:30:00.000Z') };
      if (slug === 'corrupt-run') return { ok: false, kind: 'corrupt', error: new Error('bad last run') };
      return { ok: false, kind: 'missing' };
    });
    store.validateScheduleInterval.mockImplementation(schedule => schedule.intervalMinutes === 60 ? null : 'too often');

    startScheduleManager();
    await vi.waitFor(() => expect(store.saveLastRun).toHaveBeenCalledTimes(1));

    expect(store.saveLastRun).toHaveBeenCalledWith('due', expect.objectContaining({ sessionId: 'loop-session', lastResult: 'success' }));
  });
});
