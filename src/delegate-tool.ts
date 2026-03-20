import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import sessionManager from './session-manager.js';

const POLL_INTERVAL_MS = 5000;
const DELEGATE_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function countAssistantMessages(sessionId: string): Promise<number> {
  try {
    const events = await sessionManager.getHistory(sessionId);
    return events.filter(e => e.type === 'assistant.message').length;
  } catch { return 0; }
}

async function getAssistantMessageAfter(sessionId: string, priorCount: number): Promise<string> {
  try {
    const events = await sessionManager.getHistory(sessionId);
    const assistantMessages = events.filter(e => e.type === 'assistant.message');
    if (assistantMessages.length > priorCount) {
      const firstNew = assistantMessages[priorCount];
      const content = firstNew.data?.content;
      if (typeof content === 'string') return content;
    }
    return '(no new response)';
  } catch (e) {
    return `(error reading history: ${e instanceof Error ? e.message : e})`;
  }
}

export function createDelegateTool(sessionRef: SessionIdRef) {
  const cacoSessionDelegate = defineTool('caco_session_delegate', {
    description: `Delegate work to 1-2 existing Caco sessions and wait for their response. Use this to collaborate with a known Caco session that has useful context and perspective.

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
        priorCount: number;
        startedAt: number;
        done: boolean;
        result: string | null;
      }> = [];

      for (const p of prompts) {
        try {
          const stateRes = await fetch(`${SERVER_URL}/api/sessions/${p.sessionId}/state`);
          if (!stateRes.ok) {
            return { textResultForLlm: `Session ${p.sessionId.slice(0, 8)} not found.`, resultType: 'error' as const };
          }
          const state = await stateRes.json();
          if (state.isBusy) {
            return { textResultForLlm: `Session ${p.sessionId.slice(0, 8)} ("${state.name || 'unnamed'}") is busy. Wait or choose another session.`, resultType: 'error' as const };
          }
        } catch (e) {
          return { textResultForLlm: `Failed to check session ${p.sessionId.slice(0, 8)}: ${e instanceof Error ? e.message : e}`, resultType: 'error' as const };
        }

        const priorCount = await countAssistantMessages(p.sessionId);
        delegates.push({ sessionId: p.sessionId, priorCount, startedAt: Date.now(), done: false, result: null });
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

      let completed = delegates.filter(d => d.done).length;
      while (completed < delegates.length) {
        await sleep(POLL_INTERVAL_MS);

        for (const d of delegates) {
          if (d.done) continue;

          if (Date.now() - d.startedAt > DELEGATE_TIMEOUT_MS) {
            d.done = true;
            d.result = '(timed out after 15 minutes)';
            completed++;
            console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} timed out`);
            continue;
          }

          try {
            const res = await fetch(`${SERVER_URL}/api/sessions/${d.sessionId}/state`);
            if (!res.ok) continue;
            const state = await res.json();
            if (state.status === 'idle' || state.status === 'inactive') {
              d.done = true;
              d.result = await getAssistantMessageAfter(d.sessionId, d.priorCount);
              completed++;
              console.log(`[DELEGATE] Session ${d.sessionId.slice(0, 8)} responded`);
            }
          } catch { /* retry next poll */ }
        }
      }

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
