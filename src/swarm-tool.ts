/**
 * Session Swarm Tool
 * 
 * Dispatches 1-6 parallel Caco sessions with individual prompts,
 * waits for all to complete, and returns aggregated results.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import type { SessionIdRef } from './types.js';
import sessionManager from './session-manager.js';
import { broadcastGlobalEvent } from './routes/websocket.js';
import { waitForSessionIdle } from './dispatch-state.js';

const PER_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const activeSwarms = new Set<string>();

function validateSwarmModel(model: string, count: number): string | null {
  const lower = model.toLowerCase();
  if (count <= 2) return null;
  if (count <= 4) {
    if (lower.includes('opus')) {
      return `${model} not allowed for ${count} sessions (max 2 for opus). Use sonnet or cheaper.`;
    }
    return null;
  }
  // count 5-6
  if (lower.includes('opus') || lower.includes('sonnet')) {
    return `${model} not allowed for ${count} sessions (max 4 for sonnet). Use gpt-4.1 or cheaper.`;
  }
  return null;
}

function emitSwarmProgress(sessionId: string, completed: number, total: number): void {
  broadcastGlobalEvent({
    type: 'adhoc.swarmProgress',
    data: { sessionId, completed, total }
  });
}

interface SwarmSession {
  index: number;
  sessionId: string | null;
  startedAt: number;
  done: boolean;
  result: string | null;
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

export function createSwarmTool(sessionRef: SessionIdRef) {
  const cacoSessionSwarm = defineTool('caco_session_swarm', {
    description: `Dispatch 1-6 parallel Caco sessions and wait for all to complete. Returns aggregated results.

Use for fan-out tasks: analyze multiple repos, parallelize independent subtasks, get diverse perspectives.

Each session runs independently with its own prompt. Results are collected and returned as one structured response.

**Model tiers (enforced):**
- 1-2 sessions: use opus for best quality (any model allowed)
- 3-4 sessions: sonnet or cheaper (opus rejected)
- 5-6 sessions: gpt-4.1 or cheaper

**Tips:**
- Give each session a complete, self-contained task
- Ask sessions to keep responses brief or write to files
- Only one swarm can run at a time`,

    parameters: z.object({
      cwd: z.string().describe('Working directory for all sessions'),
      model: z.string().describe('Model ID for all sessions'),
      prompts: z.array(z.string()).min(1).max(6).describe('Prompt for each session (1-6)')
    }),

    handler: async ({ cwd, model, prompts }) => {
      if (activeSwarms.has(sessionRef.id)) {
        return {
          textResultForLlm: 'A swarm is already running for this session. Wait for it to complete.',
          resultType: 'error' as const
        };
      }
      activeSwarms.add(sessionRef.id);

      const tierError = validateSwarmModel(model, prompts.length);
      if (tierError) {
        activeSwarms.delete(sessionRef.id);
        return { textResultForLlm: tierError, resultType: 'error' as const };
      }
      const startTime = Date.now();
      const sessions: SwarmSession[] = [];

      try {

        // Create all sessions
        console.log(`[SWARM] Creating ${prompts.length} sessions with model ${model}`);
        for (let i = 0; i < prompts.length; i++) {
          const desc = `swarm ${i + 1}/${prompts.length}: ${prompts[i].slice(0, 50)}`;
          try {
            const res = await fetch(`${SERVER_URL}/api/sessions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cwd,
                model,
                parentSessionId: sessionRef.id,
                isSwarmSession: true,
                kind: 'swarm',
                description: desc
              })
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: res.statusText }));
              sessions.push({ index: i, sessionId: null, startedAt: Date.now(), done: true, result: `(failed to create: ${err.error})` });
              continue;
            }
            const data = await res.json();
            sessions.push({ index: i, sessionId: data.sessionId, startedAt: Date.now(), done: false, result: null });
          } catch (e) {
            sessions.push({ index: i, sessionId: null, startedAt: Date.now(), done: true, result: `(failed to create: ${e instanceof Error ? e.message : e})` });
          }
        }

        // Send prompts to all created sessions — use no source/correlation
        // to avoid the agent recursion guard. Swarm sessions are independent
        // parallel tasks, not recursive agent-to-agent delegation.
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          if (!s.sessionId || s.done) continue;
          try {
            console.log(`[SWARM] Sending prompt ${i + 1}/${sessions.length} to ${s.sessionId.slice(0, 8)}`);
            const res = await fetch(`${SERVER_URL}/api/sessions/${s.sessionId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: prompts[i]
              })
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: res.statusText }));
              console.error(`[SWARM] Failed to send to ${s.sessionId.slice(0, 8)}: ${err.error}`);
              s.done = true;
              s.result = `(failed to send: ${err.error})`;
            }
          } catch (e) {
            s.done = true;
            s.result = `(failed to send: ${e instanceof Error ? e.message : e})`;
          }
        }

        // Wait for all sessions via event-driven idle detection
        let completed = sessions.filter(s => s.done).length;
        emitSwarmProgress(sessionRef.id, completed, sessions.length);

        const waitPromises = sessions
          .filter(s => !s.done && s.sessionId)
          .map(async (s) => {
            const result = await waitForSessionIdle(
              s.sessionId!,
              PER_SESSION_TIMEOUT_MS,
              () => !sessionManager.getSessionCwd(s.sessionId!)
            );

            const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
            if (result === 'idle') {
              s.done = true;
              s.result = await getLastAssistantMessage(s.sessionId!);
              console.log(`[SWARM] Session ${s.sessionId!.slice(0, 8)} completed after ${elapsed}s`);
            } else if (result === 'gone') {
              s.done = true;
              s.result = '(session disappeared during processing)';
              console.log(`[SWARM] Session ${s.sessionId!.slice(0, 8)} gone after ${elapsed}s`);
            } else {
              s.done = true;
              s.result = '(timed out after 15 minutes)';
              console.log(`[SWARM] Session ${s.sessionId!.slice(0, 8)} timed out after ${elapsed}s`);
            }

            completed++;
            emitSwarmProgress(sessionRef.id, completed, sessions.length);
          });

        await Promise.all(waitPromises);

        // Aggregate results
        const sections = sessions.map((s, i) =>
          `## Session ${i + 1}${s.sessionId ? ` (${s.sessionId.slice(0, 8)})` : ''}\n\n${s.result || '(no response)'}`
        );

        return {
          textResultForLlm: sections.join('\n\n---\n\n'),
          toolTelemetry: {
            sessionsCreated: sessions.filter(s => s.sessionId).length,
            sessionsCompleted: sessions.filter(s => s.done && !s.result?.startsWith('(')).length,
            totalTimeMs: Date.now() - startTime
          }
        };
      } finally {
        activeSwarms.delete(sessionRef.id);
        for (const s of sessions) {
          if (!s.sessionId) continue;
          try {
            await sessionManager.stop(s.sessionId);
            await sessionManager.delete(s.sessionId);
          } catch { /* best effort */ }
        }
      }
    }
  });

  return [cacoSessionSwarm];
}
