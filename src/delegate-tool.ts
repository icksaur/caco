import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { dispatchState } from './dispatch-state.js';
import { getSessionMeta } from './storage.js';

const DELEGATE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DELEGATE_MAX_TOTAL_MS = 60 * 60 * 1000;

/** Total byte budget for the combined delegate JSON result. Kept below the generic
 *  output-shaper threshold (SHAPE_THRESHOLD_BYTES = 8 KB), with margin for the JSON
 *  structure (keys, braces, session ids, pretty-print whitespace). Above the shaper
 *  threshold the hook truncates by head/tail LINES, mangling the pretty-printed JSON
 *  into unparseable output — so responses are byte-bounded to stay under it. */
export const DELEGATE_TOTAL_BYTE_BUDGET = 7000;

/** UTF-8 byte length of a string AS IT WILL APPEAR escaped inside JSON (quotes,
 *  backslashes, control chars, multibyte all accounted for). This is the size that
 *  actually counts toward the shaper threshold — a plain char count does not, since
 *  `"\n"`, `"\uXXXX"`, and multibyte chars all expand. */
function jsonEscapedBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8');
}

/** Bound a single delegate response so its escaped JSON size fits `byteBudget`, keeping
 *  the combined tool result parseable and under the shaper threshold (see
 *  DELEGATE_TOTAL_BYTE_BUDGET). Truncates by BYTES (not chars) via binary search on the
 *  escaped size, appending a marker that points to the session's full history. */
export function boundDelegateResponse(text: string, sessionId8: string, byteBudget = DELEGATE_TOTAL_BYTE_BUDGET): string {
  if (jsonEscapedBytes(text) <= byteBudget) return text;
  const marker = `\n\n[…response truncated; read the full reply in session ${sessionId8}'s history]`;
  const contentBudget = Math.max(0, byteBudget - jsonEscapedBytes(marker));
  // Largest char-prefix whose escaped byte size fits contentBudget.
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonEscapedBytes(text.slice(0, mid)) <= contentBudget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + marker;
}

/** Classify a delegate target into an actionable error message, or null when it is OK
 *  to send. `loaded` MUST mirror the messages endpoint's own gate (getSessionCwd — the
 *  session is in the runtime cache); that is exactly the condition under which a POST
 *  will be accepted, so this never diverges from the endpoint. A session that exists on
 *  disk but is not loaded (`loaded=false`, `existsOnDisk=true`) cannot receive a
 *  delegated message until it is resumed — which this tool cannot do — so the caller
 *  must wake it first. The old code reported both missing and not-loaded as "not found",
 *  leaving the agent stuck. (Note: NOT isActive/activeSessions — a cached-but-not-active
 *  session still accepts sends, so gating on isActive would falsely reject it.) */
export function delegateTargetError(opts: {
  sessionId8: string;
  loaded: boolean;
  existsOnDisk: boolean;
  busy: boolean;
  name?: string;
}): string | null {
  const label = opts.name ? ` ("${opts.name}")` : '';
  if (!opts.loaded) {
    if (opts.existsOnDisk) {
      return `Session ${opts.sessionId8}${label} exists but is not loaded, so it cannot receive a delegated message. ` +
        'Open/resume it first (in the UI, or ask the user to) and then retry — caco_session_delegate cannot wake a session that is not loaded.';
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
          loaded: !!sessionManager.getSessionCwd(p.sessionId),
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

      const perResponseBudget = Math.floor(DELEGATE_TOTAL_BYTE_BUDGET / Math.max(1, delegates.length));
      const results = delegates.map(d => ({
        sessionId: d.sessionId,
        response: boundDelegateResponse(d.result || '(no response)', d.sessionId.slice(0, 8), perResponseBudget),
      }));

      return {
        textResultForLlm: JSON.stringify(results, null, 2),
        resultType: 'text' as const,
      };
    }
  });

  return [cacoSessionDelegate];
}
