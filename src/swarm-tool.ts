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
import type { GetCorrelationId } from './agent-tools.js';
import sessionManager from './session-manager.js';

const POLL_INTERVAL_MS = 5000;
const PER_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

let swarmActive = false;

function validateSwarmModel(model: string, count: number): string | null {
  const lower = model.toLowerCase();
  if (count <= 2) return null;
  if (count <= 4 && lower.includes('opus')) {
    return `${model} not allowed for ${count} sessions (max 2 for opus). Use sonnet or cheaper.`;
  }
  if (count <= 6 && (lower.includes('opus') || lower.includes('sonnet'))) {
    return `${model} not allowed for ${count} sessions (max 4 for sonnet). Use gpt-4.1 or cheaper.`;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

export function createSwarmTool(sessionRef: SessionIdRef, getCorrelationId: GetCorrelationId) {
  const cacoSessionSwarm = defineTool('caco_session_swarm', {
    description: `Dispatch 1-6 parallel Caco sessions and wait for all to complete. Returns aggregated results.

Use for fan-out tasks: analyze multiple repos, parallelize independent subtasks, get diverse perspectives.

Each session runs independently with its own prompt. Results are collected and returned as one structured response.

**Model tiers (enforced):**
- 1-2 sessions: any model (opus allowed)
- 3-4 sessions: sonnet or cheaper
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
      if (swarmActive) {
        return {
          textResultForLlm: 'A swarm is already running. Wait for it to complete.',
          resultType: 'error' as const
        };
      }

      const tierError = validateSwarmModel(model, prompts.length);
      if (tierError) {
        return { textResultForLlm: tierError, resultType: 'error' as const };
      }

      swarmActive = true;
      const startTime = Date.now();

      try {
        const sessions: SwarmSession[] = [];

        // Create all sessions
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

        // Send prompts to all created sessions
        const correlationId = getCorrelationId(sessionRef.id);
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          if (!s.sessionId || s.done) continue;
          try {
            const res = await fetch(`${SERVER_URL}/api/sessions/${s.sessionId}/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: prompts[i],
                source: 'agent',
                fromSession: sessionRef.id,
                correlationId
              })
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: res.statusText }));
              s.done = true;
              s.result = `(failed to send: ${err.error})`;
            }
          } catch (e) {
            s.done = true;
            s.result = `(failed to send: ${e instanceof Error ? e.message : e})`;
          }
        }

        // Poll until all complete
        let completed = sessions.filter(s => s.done).length;
        while (completed < sessions.length) {
          await sleep(POLL_INTERVAL_MS);

          for (const s of sessions) {
            if (s.done || !s.sessionId) continue;

            if (Date.now() - s.startedAt > PER_SESSION_TIMEOUT_MS) {
              s.done = true;
              s.result = '(timed out after 10 minutes)';
              completed++;
              continue;
            }

            try {
              const res = await fetch(`${SERVER_URL}/api/sessions/${s.sessionId}/state`);
              if (!res.ok) continue;
              const state = await res.json();
              if (state.status === 'idle' || state.status === 'inactive') {
                s.done = true;
                s.result = await getLastAssistantMessage(s.sessionId);
                completed++;
              }
            } catch {
              // Network error — retry next poll
            }
          }
        }

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
        swarmActive = false;
      }
    }
  });

  return [cacoSessionSwarm];
}
