import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { waitForSessionIdle } from './dispatch-state.js';
import { getSessionMeta } from './storage.js';

const DELEGATE_TIMEOUT_MS = 15 * 60 * 1000;

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
    description: `Delegate work to 1-2 existing Caco sessions and wait for their response. Returns the delegate's full response so you can use it immediately.

**This is the preferred tool for cross-session collaboration.** Unlike send_caco_message (fire-and-forget), this tool blocks until the delegate responds and gives you the result.

The delegate sessions must already exist. The user provides session IDs (caco-session:UUID format) or you can verify them with get_session_state first.

**When to use:** Ask a reviewer session to check your work, ask a research session to look something up, or coordinate with a session working on a related part of the system.

**When NOT to use:** Don't use this for quick sub-tasks (use the task tool). Don't use this to create new sessions (use create_caco_session). Don't delegate to yourself.

**Tips:**
- Ask delegates to keep responses concise
- Delegates see the message as coming from your session
- Delegate sessions persist — they are not deleted after responding`,

    parameters: z.object({
      prompts: z.array(z.object({
        sessionId: z.string().describe('Target session ID (UUID)'),
        message: z.string().describe('Message to send to the delegate'),
      })).min(1).max(2).describe('Sessions to delegate to (1-2)'),
    }),

    handler: async ({ prompts }) => {
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
        if (!sessionManager.getSessionCwd(p.sessionId)) {
          return { textResultForLlm: `Session ${p.sessionId.slice(0, 8)} not found.`, resultType: 'error' as const };
        }
        if (sessionManager.isBusy(p.sessionId)) {
          const meta = getSessionMeta(p.sessionId);
          return { textResultForLlm: `Session ${p.sessionId.slice(0, 8)} ("${meta?.name || 'unnamed'}") is busy. Wait or choose another session.`, resultType: 'error' as const };
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
            d.result = `(send failed: ${err.error})`;
          }
        } catch (e) {
          d.done = true;
          d.result = `(send failed: ${e instanceof Error ? e.message : e})`;
        }
      }

      const waitPromises = delegates
        .filter(d => !d.done)
        .map(async (d) => {
          const result = await waitForSessionIdle(
            d.sessionId,
            DELEGATE_TIMEOUT_MS,
            () => !sessionManager.getSessionCwd(d.sessionId)
          );

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
            d.result = '(timed out after 15 minutes)';
            console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} timed out`);
          }
        });

      await Promise.all(waitPromises);

      const results = delegates.map(d => ({
        sessionId: d.sessionId,
        response: d.result || '(no response)',
      }));

      return {
        textResultForLlm: JSON.stringify(results, null, 2),
        resultType: 'text' as const,
      };
    }
  });

  return [cacoSessionDelegate];
}
