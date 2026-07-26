import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { dispatchState } from './dispatch-state.js';
import { getSessionMeta } from './storage.js';
import { getLastAssistantMessage } from './session-history.js';
import { applyPluginDirectories } from './plugin-directories-apply.js';

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
  /** The target's herd bond (spec-session-orchestration). A session that is a
   *  herd child is owned by its parent's drain loop; a blocking third-party
   *  delegate would fight it, so delegating to a child is rejected. */
  orchestratedBy?: string;
}): string | null {
  const label = opts.name ? ` ("${opts.name}")` : '';
  if (!opts.loaded) {
    if (opts.existsOnDisk) {
      return `Session ${opts.sessionId8}${label} exists but is not loaded, so it cannot receive a delegated message. ` +
        'Open/resume it first (in the UI, or ask the user to) and then retry — caco_session_delegate cannot wake a session that is not loaded.';
    }
    return `Session ${opts.sessionId8} does not exist. Check the ID (with or without the caco-session: prefix), or create one with create_caco_session.`;
  }
  if (opts.orchestratedBy) {
    return `Session ${opts.sessionId8}${label} is a herd child (orchestrated by ${opts.orchestratedBy.slice(0, 8)}), so it cannot be delegated to — its parent supervises it. Disown it from the herd first, or choose another session.`;
  }
  if (opts.busy) {
    return `Session ${opts.sessionId8}${label} is busy processing another message. Wait and retry, or choose another session.`;
  }
  return null;
}

/** The POST body for a delegate send. Delegating uses the agent-message path
 *  (`source:'agent'` + `fromSession`) so the prompt persists an `[agent:<id>]`
 *  prefix and renders in the agent color. INVARIANT (route contract,
 *  session-messages.ts `fromSession && !correlationId → 400`): whenever
 *  `fromSession` is set a `correlationId` MUST accompany it — so this builder
 *  takes a REQUIRED correlationId and always emits both, making the 400 that
 *  broke an earlier version unrepresentable. Also enables the runaway-guard /
 *  correlation-chain bookkeeping the route keys on `correlationId`. */
export function buildDelegateSendBody(
  message: string,
  fromSession: string,
  correlationId: string,
): { prompt: string; source: 'agent'; fromSession: string; correlationId: string } {
  return { prompt: message, source: 'agent', fromSession, correlationId };
}

export function createDelegateTool(sessionRef: SessionIdRef) {
  const cacoSessionDelegate = defineTool('caco_session_delegate', {
    description: `Delegate work to 1-2 existing Caco sessions and wait for their responses, returned to you. This blocks until they reply — the preferred tool for cross-session collaboration. Sessions must already exist (caco-session:UUID); verify with get_session_state if unsure. Delegates persist after replying and see the message as coming from your session.

Use to have a reviewer/research session check work or look something up. Don't delegate to yourself, create new sessions (use create_caco_session), or use for quick sub-tasks (use the task tool).`,

    parameters: z.object({
      prompts: z.array(z.object({
        sessionId: z.string().describe('Target session ID (UUID, with or without the caco-session: prefix)'),
        message: z.string().describe('Message to send to the delegate'),
        pluginDirectories: z.array(z.string()).optional().describe('Absolute paths to Open Plugins directories to configure on THIS target before sending (never installed into ~/.copilot). STICKY: this permanently changes the target\'s configuration, not just this request, and costs a reconnect if it is loaded. Omit to leave its existing dirs untouched; pass [] to clear them.'),
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
          orchestratedBy: meta?.orchestratedBy,
        });
        if (error) {
          return { textResultForLlm: error, resultType: 'error' as const };
        }

        delegates.push({ sessionId: p.sessionId, startedAt: Date.now(), done: false, result: null });
      }

      // Configure plugin directories BEFORE any dispatch (and before the blocking wait), so
      // each target answers with its plugins loaded. Per-target and NON-ATOMIC across
      // targets by design (they are independent sessions): a failure is reported and that
      // target is dropped from the batch rather than silently answering unconfigured.
      const pluginNotes: string[] = [];
      for (let i = delegates.length - 1; i >= 0; i--) {
        const dirs = prompts[i].pluginDirectories;
        if (dirs === undefined) continue;
        const applied = await applyPluginDirectories(SERVER_URL, delegates[i].sessionId, dirs);
        const id8 = delegates[i].sessionId.slice(0, 8);
        if (!applied.ok) {
          pluginNotes.push(`${id8}: plugin directories NOT set (${applied.error}) — no message sent to this target.`);
          delegates.splice(i, 1);
          prompts.splice(i, 1);
          continue;
        }
        if (applied.warnings?.length) pluginNotes.push(`${id8}: ${applied.warnings.join('; ')}`);
      }
      if (delegates.length === 0) {
        return { textResultForLlm: `No delegates were messaged.\n${pluginNotes.join('\n')}`, resultType: 'error' as const };
      }

      for (let i = 0; i < delegates.length; i++) {
        const d = delegates[i];
        try {
          console.log(`[DELEGATE] Sending to ${d.sessionId.slice(0, 8)}`);
          const res = await fetch(`${SERVER_URL}/api/sessions/${d.sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Agent-message path (source:'agent' + fromSession) → the prompt
            // persists an [agent:<callerId>] prefix and renders agent-colored,
            // matching herd child prompts (spec-session-orchestration A3). The
            // route REQUIRES a correlationId whenever fromSession is set, so we
            // thread the caller's live correlation (enabling the runaway guard),
            // falling back to a fresh id if the caller has none.
            body: JSON.stringify(buildDelegateSendBody(
              prompts[i].message,
              sessionRef.id,
              dispatchState.getCorrelationId(sessionRef.id) ?? randomUUID(),
            )),
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
            // A caco_enable_tools reveal-idle is not a real idle — but this is now
            // handled centrally: dispatchState suppresses the idle emit while a
            // continuation is pending, so waitForActive stays armed automatically
            // (spec-idle-suppression-central).
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
        textResultForLlm: pluginNotes.length
          ? `${JSON.stringify(results, null, 2)}\n\nPlugin directory notes:\n${pluginNotes.join('\n')}`
          : JSON.stringify(results, null, 2),
        resultType: 'text' as const,
      };
    }
  });

  return [cacoSessionDelegate];
}
