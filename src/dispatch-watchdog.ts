/**
 * Watchdog for an SDK dispatch — tracks first-event arrival and between-event
 * gaps, fires onTimeout when too much time passes.
 *
 * Two-phase timeout policy:
 *   - Before the first event: INITIAL_TIMEOUT_MS (e.g. 45s). If we don't hear
 *     anything, the SDK connection is probably stale and the caller will try
 *     a fresh resume.
 *   - After the first event: betweenEventTimeout (DISPATCH_TIMEOUT_MS for
 *     interactive sessions, 15 minutes for swarm/agent). Tool execution
 *     pauses the watchdog entirely — tools can run as long as they need.
 *
 * Bumps the between-event timeout to 15 minutes after the first
 * tool.execution_complete (long-running plans are normal after that point).
 */

export interface WatchdogConfig {
  initialTimeoutMs: number;
  betweenEventTimeoutMs: number;
  longRunningTimeoutMs: number;
  onTimeout: (reason: WatchdogTimeoutReason) => void;
}

export type WatchdogTimeoutReason =
  | { kind: 'no-first-event'; timeoutMs: number }
  | { kind: 'between-events'; timeoutMs: number };

export interface Watchdog {
  /** Notify the watchdog that a fresh SDK event arrived. */
  notifyEvent(eventType: string): void;
  /** Reset the timer using the current (between-event) timeout. */
  reset(): void;
  /** Stop the timer entirely. */
  cancel(): void;
}

export function createWatchdog(config: WatchdogConfig): Watchdog {
  let handle: NodeJS.Timeout | undefined;
  let receivedFirstEvent = false;
  let toolExecuting = false;
  let betweenEventTimeout = config.betweenEventTimeoutMs;

  function cancel(): void {
    if (handle) {
      clearTimeout(handle);
      handle = undefined;
    }
  }

  function reset(): void {
    if (toolExecuting) return;
    cancel();
    const timeoutMs = receivedFirstEvent ? betweenEventTimeout : config.initialTimeoutMs;
    handle = setTimeout(() => {
      const reason: WatchdogTimeoutReason = receivedFirstEvent
        ? { kind: 'between-events', timeoutMs }
        : { kind: 'no-first-event', timeoutMs };
      config.onTimeout(reason);
    }, timeoutMs);
  }

  function notifyEvent(eventType: string): void {
    receivedFirstEvent = true;
    if (eventType === 'tool.execution_start') {
      toolExecuting = true;
      cancel();
    } else if (eventType === 'tool.execution_complete') {
      toolExecuting = false;
      betweenEventTimeout = config.longRunningTimeoutMs;
      reset();
    } else {
      reset();
    }
  }

  reset();

  return { notifyEvent, reset, cancel };
}
