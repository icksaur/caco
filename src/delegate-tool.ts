import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { dispatchState } from './dispatch-state.js';
import { getSessionMeta } from './storage.js';

const DELEGATE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DELEGATE_MAX_TOTAL_MS = 60 * 60 * 1000;

/** Per-delegate response character cap. With up to 2 delegates, keeping each reply
 *  under this keeps the combined JSON tool result below the generic output-shaper
 *  threshold (SHAPE_THRESHOLD_BYTES = 8 KB). Above that the shaper truncates by
 *  head/tail LINES, which mangles the pretty-printed JSON into unparseable output —
 *  the caller then sees a broken result and gives up. */
export const DELEGATE_RESPONSE_CHAR_CAP = 3000;

/** Bound a single delegate response so the combined tool output stays parseable (see
 *  DELEGATE_RESPONSE_CHAR_CAP). Oversized replies are cut with a clear marker pointing
 *  to the session's full history rather than silently truncated by the shaper. */
export function boundDelegateResponse(text: string, sessionId8: string, cap = DELEGATE_RESPONSE_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n[…response truncated to ${cap} chars; read the full reply in session ${sessionId8}'s history]`;
}

/** Classify a delegate target into an actionable error message, or null when it is OK
 *  to send. Distinguishes a session that truly does not exist from one that merely
 *  exists on disk but is INACTIVE (not loaded) — the latter cannot receive a delegated
 *  message until it is resumed, which this tool cannot do, so the caller must wake it
 *  first. The old code reported both as "not found", which left the agent stuck. */
export function delegateTargetError(opts: {
  sessionId8: string;
  active: boolean;
  existsOnDisk: boolean;
  busy: boolean;
  name?: string;
}): string | null {
  const label = opts.name ? ` ("${opts.name}")` : '';
  if (!opts.active) {
    if (opts.existsOnDisk) {
      return `Session ${opts.sessionId8}${label} exists but is INACTIVE (not loaded), so it cannot receive a delegated message. ` +
        'Open/resume it first (in the UI, or ask the user to) and then retry — caco_session_delegate cannot wake an inactive session.';
    }
    return `Session ${opts.sessionId8} does not exist. Check the ID (with or without the caco-session: prefix), or create one with create_caco_session.`;
  }
  if (opts.busy) {
    return `Session ${opts.sessionId8}${label} is busy processing another message. Wait and retry, or choose another session.`;
  }
  return null;
}

async function getLastAssistantMessage(sessionId: string): Promise<string> {
  try {
    const events = await sessionManager.getHistory(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'assistant.message') {
        const content = events[i].data?.content;
        if (typeof content === 'string') return content;
      }
    }
    return '(no assistant response found)';
  } catch (e) {
    return `(error reading history: ${e instanceof Error ? e.message : e})`;
  }
}

export function createDelegateTool(sessionRef: SessionIdRef) {
  const cacoSessionDelegate = defineTool('caco_session_delegate', {
    description: `Delegate work to 1-2 existing Caco sessions and wait for their responses, returned to you. This blocks until they reply — the preferred tool for cross-session collaboration. Sessions must already exist (caco-session:UUID); verify with get_session_state if unsure. Delegates persist after replying and see the message as coming from your session.

Use to have a reviewer/research session check work or look something up. Don't delegate to yourself, create new sessions (use create_caco_session), or use for quick sub-tasks (use the task tool).`,

    parameters: z.object({
      prompts: z.array(z.object({
        sessionId: z.string().describe('Target session ID (UUID, with or without the caco-session: prefix)'),
        message: z.string().describe('Message to send to the delegate'),
      })).min(1).max(2).describe('Sessions to delegate to (1-2)'),
    }),

    handler: async ({ prompts: rawPrompts }) => {
      const prompts = rawPrompts.map(p => ({ ...p, sessionId: p.sessionId.replace(/^caco-session:/, '') }));
      if (prompts.some(p => p.sessionId === sessionRef.id)) {
        return { textResultForLlm: 'Cannot delegate to yourself.', resultType: 'error' as const };
      }

      const delegates: Array<{
        sessionId: string;
        startedAt: number;
        done: boolean;
        result: string | null;
      }> = [];

      for (const p of prompts) {
        const id8 = p.sessionId.slice(0, 8);
        const meta = getSessionMeta(p.sessionId);
        const error = delegateTargetError({
          sessionId8: id8,
          active: !!sessionManager.getSessionCwd(p.sessionId),
          existsOnDisk: !!meta,
          busy: sessionManager.isBusy(p.sessionId),
          name: meta?.name,
        });
        if (error) {
          return { textResultForLlm: error, resultType: 'error' as const };
        }

        delegates.push({ sessionId: p.sessionId, startedAt: Date.now(), done: false, result: null });
      }

      for (let i = 0; i < delegates.length; i++) {
        const d = delegates[i];
        try {
          console.log(`[DELEGATE] Sending to ${d.sessionId.slice(0, 8)}`);
          const res = await fetch(`${SERVER_URL}/api/sessions/${d.sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompts[i].message }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            d.done = true;
            d.result = `(send failed: HTTP ${res.status} — ${err.error || res.statusText})`;
          }
        } catch (e) {
          d.done = true;
          d.result = `(send failed: ${e instanceof Error ? e.message : e})`;
        }
      }

      const waitPromises = delegates
        .filter(d => !d.done)
        .map(async (d) => {
          const result = await dispatchState.waitForActive(d.sessionId, {
            idleTimeoutMs: DELEGATE_IDLE_TIMEOUT_MS,
            maxTotalMs: DELEGATE_MAX_TOTAL_MS,
            isGone: () => !sessionManager.getSessionCwd(d.sessionId),
          });

          if (result === 'idle') {
            d.done = true;
            d.result = await getLastAssistantMessage(d.sessionId);
            console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} responded`);
          } else if (result === 'gone') {
            d.done = true;
            d.result = '(session disappeared during processing)';
            console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} gone`);
          } else {
            d.done = true;
            const idleMin = Math.round(DELEGATE_IDLE_TIMEOUT_MS / 60000);
            d.result = `(delegate still running after ${idleMin}m idle timeout — it may finish later; check the session list / its history rather than re-delegating)`;
            console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} timed out`);
          }
        });

      await Promise.all(waitPromises);

      const results = delegates.map(d => ({
        sessionId: d.sessionId,
        response: boundDelegateResponse(d.result || '(no response)', d.sessionId.slice(0, 8)),
      }));

      return {
        textResultForLlm: JSON.stringify(results, null, 2),
        resultType: 'text' as const,
      };
    }
  });

  return [cacoSessionDelegate];
}
