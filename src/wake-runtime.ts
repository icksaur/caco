/**
 * Real wiring for the session wake manager (spec-session-wake): meta store,
 * dispatch state, the message route, the unobserved tracker, and the turn
 * outcome signal. Kept apart from wake-manager.ts so the logic stays testable.
 */

import {
  SERVER_URL, AUTO_ARCHIVE_FOLDER, WAKE_CHECK_INTERVAL_MS, WAKE_MIN_HOURS, WAKE_MAX_HOURS,
  WAKE_NOTE_MAX, WAKE_MAX_ACTIVE, WAKE_MAX_RUNNING, WAKE_MAX_FAILURES, WAKE_HUMAN_QUIET_MS,
  WAKE_EXPIRE_MS, WAKE_TURN_TIMEOUT_MS, WAKE_WINDOW, WAKE_WINDOW_DEFAULT,
} from './config.js';
import { listSessionIds } from './sdk-session-store.js';
import { getSessionMeta, updateSessionMeta } from './storage.js';
import { sessionManager } from './session-manager.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { disabledToolNames } from './tool-registry.js';
import { onTurnOutcome } from './turn-outcome.js';
import { parseWakeWindow, type WakeWindowSpec } from './wake-core.js';
import { createWakeManager } from './wake-manager.js';
import { activityVersion } from './activity-version.js';

export const WAKE_TOOL_NAME = 'caco_wake';

function resolveWindow(): WakeWindowSpec {
  try {
    return parseWakeWindow(WAKE_WINDOW);
  } catch (e) {
    console.error(`[WAKE] Invalid CACO_WAKE_WINDOW (${e instanceof Error ? e.message : 'error'}); using "${WAKE_WINDOW_DEFAULT}"`);
    return parseWakeWindow(WAKE_WINDOW_DEFAULT);
  }
}

export const wakeManager = createWakeManager({
  now: () => Date.now(),
  listSessionIds,
  getMeta: id => getSessionMeta(id),
  updateMeta: (id, mutate) => {
    const written = updateSessionMeta(id, mutate, { createIfMissing: false });
    // The pager shows a wake badge, so a wake change must wake its long-poll.
    if (written) activityVersion.bump();
    return written;
  },
  isBusy: id => sessionManager.isBusy(id),
  post: async (id, prompt) => {
    const res = await fetch(`${SERVER_URL}/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, source: 'scheduler', scheduleSlug: 'wake' }),
    });
    return res.status;
  },
  markUnobserved: id => { unobservedTracker.markIdle(id); },
  toolDisabled: () => disabledToolNames().has(WAKE_TOOL_NAME),
  log: msg => console.log(msg),
  config: {
    minHours: WAKE_MIN_HOURS,
    maxHours: WAKE_MAX_HOURS,
    noteMax: WAKE_NOTE_MAX,
    maxActive: WAKE_MAX_ACTIVE,
    maxRunning: WAKE_MAX_RUNNING,
    maxFailures: WAKE_MAX_FAILURES,
    humanQuietMs: WAKE_HUMAN_QUIET_MS,
    expireMs: WAKE_EXPIRE_MS,
    turnTimeoutMs: WAKE_TURN_TIMEOUT_MS,
    window: resolveWindow(),
    archiveFolder: AUTO_ARCHIVE_FOLDER,
  },
});

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** Post-listen: the first tick POSTs the message route, so the server must be up. */
export function startWakeManager(): void {
  if (timer) return;
  wakeManager.rebuild();
  unsubscribe = onTurnOutcome((id, outcome, reason) => wakeManager.settle(id, outcome, reason));
  void wakeManager.tick();
  timer = setInterval(() => { void wakeManager.tick(); }, WAKE_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopWakeManager(): void {
  if (timer) { clearInterval(timer); timer = null; }
  unsubscribe?.();
  unsubscribe = null;
}
