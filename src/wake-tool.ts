import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import type { SessionIdRef } from './types.js';
import type { WakeState } from './session-meta-store.js';
import { WAKE_MIN_HOURS, WAKE_MAX_HOURS, WAKE_NOTE_MAX, WAKE_HUMAN_QUIET_MS, WAKE_EXPIRE_MS, WAKE_MAX_FAILURES } from './config.js';
import { wakeManager, WAKE_TOOL_NAME } from './wake-runtime.js';

function describe(w: WakeState): string {
  const parts = [`Wake every ${w.everyMinutes / 60}h.`];
  if (w.note) parts.push(`Note: ${w.note}.`);
  if (w.pausedReason) parts.push(`PAUSED (${w.pausedReason}); call set again to resume.`);
  else parts.push(`Next wake ${w.nextWakeAt}.`);
  if (w.lastWakeAt) parts.push(`Last wake ${w.lastWakeAt}, result ${w.lastResult ?? 'unknown'}${w.lastError ? ` (${w.lastError})` : ''}.`);
  return parts.join(' ');
}

/**
 * `caco_wake` (spec-session-wake): a session schedules its own wakes. Acts only
 * on the calling session. Never auto-deferred: every wake prompt tells the
 * session to call it to stop.
 */
export function createWakeTool(sessionRef: SessionIdRef) {
  const wake = defineTool(WAKE_TOOL_NAME, {
    description: `Schedule this session to be woken periodically while it waits on external data (a PR review, a reply, a deployment).

- action "set": wake every \`everyHours\` (whole hours, ${WAKE_MIN_HOURS}-${WAKE_MAX_HOURS}). Replaces any existing wake. Optional \`note\` (max ${WAKE_NOTE_MAX} chars) saying what you wait for; it is repeated in every wake prompt.
- action "clear": stop waking this session. Call it as soon as you are no longer waiting on anything external.
- action "status": show the current wake.

Wakes skip live conversations (busy, or a user message in the last ${WAKE_HUMAN_QUIET_MS / 60000} minutes) and off-hours; a wake due off-hours fires once when the window opens. Wakes pause after ${Math.round(WAKE_EXPIRE_MS / 86400000)} days without a user message (after one final wake), after ${WAKE_MAX_FAILURES} failed wakes, and are suspended while the session sits in the auto-archive folder (moving it out resumes them). Each wake is a short prompt with the local time and time since the last wake. End a wake quietly when nothing changed; end with a caco-actions block only when the user must decide something.`,
    parameters: z.object({
      action: z.enum(['set', 'clear', 'status']),
      everyHours: z.number().optional().describe(`Required for set: whole hours ${WAKE_MIN_HOURS}-${WAKE_MAX_HOURS}.`),
      note: z.string().optional().describe(`Optional for set: what you are waiting on (max ${WAKE_NOTE_MAX} chars).`),
    }),
    handler: async ({ action, everyHours, note }) => {
      const sessionId = sessionRef.id;
      if (!sessionId) return { textResultForLlm: 'caco_wake: no active session.' };
      if (action === 'clear') {
        return { textResultForLlm: wakeManager.clear(sessionId) ? 'Wake cleared. This session will not be woken again.' : 'No wake was set.' };
      }
      if (action === 'status') {
        const w = wakeManager.get(sessionId);
        return { textResultForLlm: w ? describe(w) : 'No wake is set for this session.' };
      }
      const result = wakeManager.set(sessionId, everyHours, note);
      if (!result.ok) return { textResultForLlm: `caco_wake set failed: ${result.error} Nothing was changed.` };
      return { textResultForLlm: `Wake set. ${describe(result.wake)}` };
    },
  });
  return [wake];
}
