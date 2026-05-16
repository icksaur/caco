/**
 * Tests for src/dispatch-watchdog.ts
 *
 * Uses vitest fake timers so 45s + 10min timeouts are tested in milliseconds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWatchdog, type WatchdogTimeoutReason } from '../../src/dispatch-watchdog.js';

describe('createWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeConfig(overrides: Partial<Parameters<typeof createWatchdog>[0]> = {}) {
    const onTimeout = vi.fn();
    return {
      onTimeout,
      config: {
        initialTimeoutMs: 1000,
        betweenEventTimeoutMs: 5000,
        longRunningTimeoutMs: 60_000,
        onTimeout,
        ...overrides,
      },
    };
  }

  it('fires no-first-event timeout when no event arrives within initialTimeoutMs', () => {
    const { onTimeout, config } = makeConfig();
    createWatchdog(config);
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const reason = onTimeout.mock.calls[0][0] as WatchdogTimeoutReason;
    expect(reason.kind).toBe('no-first-event');
    expect(reason.timeoutMs).toBe(1000);
  });

  it('switches to between-event timeout after first event', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.notifyEvent('assistant.message');
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const reason = onTimeout.mock.calls[0][0] as WatchdogTimeoutReason;
    expect(reason.kind).toBe('between-events');
    expect(reason.timeoutMs).toBe(5000);
  });

  it('does not fire while a tool is executing', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.notifyEvent('tool.execution_start');
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('extends to long-running timeout after tool.execution_complete', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.notifyEvent('tool.execution_start');
    wd.notifyEvent('tool.execution_complete');
    // betweenEventTimeoutMs (5000) would have fired by now; long-running
    // timeout is 60_000.
    vi.advanceTimersByTime(59_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect((onTimeout.mock.calls[0][0] as WatchdogTimeoutReason).timeoutMs).toBe(60_000);
  });

  it('reset() restarts the current timer', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.notifyEvent('assistant.message');
    vi.advanceTimersByTime(4999);
    wd.reset();
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents the timer from firing', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('notifyEvent on a non-tool event resets the between-event timer', () => {
    const { onTimeout, config } = makeConfig();
    const wd = createWatchdog(config);
    wd.notifyEvent('assistant.message');
    vi.advanceTimersByTime(4000);
    wd.notifyEvent('assistant.usage');
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
