/**
 * SessionRuntime: the single owner of an active session's in-memory runtime
 * state. Everything keyed by sessionId that is process-memory and tied to an
 * active session's lifetime is disposed here, so session-exit paths (stop,
 * drop-stale, eviction, client restart, delete) clean up through one call
 * instead of remembering a scattered list.
 *
 * NOT owned here: persisted disk state (meta.json, events.jsonl, roadmap,
 * notes) survives stop; and durable per-session module state cleaned only on
 * delete goes through `SessionState.onSessionEnd`.
 */

import { CacoEventQueue } from './caco-event-queue.js';
import { clearSession as clearThroughput } from './session-throughput.js';
import { clearSessionUsage } from './session-usage-cache.js';

export interface SessionRuntime {
  readonly sessionId: string;
  /** Synthetic caco.* event queue: produced during a turn, flushed on trigger. */
  readonly queue: CacoEventQueue;
  /** Idempotent: safe to call under stop/eviction/restart races. */
  dispose(): void;
}

const runtimes = new Map<string, SessionRuntime>();

function createRuntime(sessionId: string): SessionRuntime {
  const queue = new CacoEventQueue();
  let disposed = false;
  return {
    sessionId,
    queue,
    dispose() {
      if (disposed) return;
      disposed = true;
      queue.flush();
      clearThroughput(sessionId);
      clearSessionUsage(sessionId);
    },
  };
}

/** Get (lazily creating) the runtime for an active session. */
export function getSessionRuntime(sessionId: string): SessionRuntime {
  let runtime = runtimes.get(sessionId);
  if (!runtime) {
    runtime = createRuntime(sessionId);
    runtimes.set(sessionId, runtime);
  }
  return runtime;
}

/** Dispose and forget a session's runtime. No-op if none exists. */
export function disposeSessionRuntime(sessionId: string): void {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  runtimes.delete(sessionId);
  runtime.dispose();
}
