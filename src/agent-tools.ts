/**
 * Caco Session Tools
 * 
 * Tools for creating and messaging independent Caco sessions.
 * These create full persistent sessions visible in the user's session list,
 * suitable for dispatching long-running work to different projects or
 * triaging tasks that the user will review separately.
 * 
 * For quick sub-tasks that report back inline, use the built-in `task` tool instead.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { SERVER_URL } from './config.js';
import { sessionManager } from './session-manager.js';
import type { SessionIdRef } from './types.js';

export type GetCorrelationId = (sessionId: string) => string | undefined;

export function createAgentTools(sessionRef: SessionIdRef, getCorrelationId: GetCorrelationId) {
  const modelIds = sessionManager.getModels().map(m => m.id);

  const getSessionState = defineTool('get_session_state', {
    description: 'Check the current state of a Caco session (idle, busy, or inactive). Use to verify a session exists before sending messages.',

    parameters: z.object({
      sessionId: z.string().describe('Target session ID to check')
    }),

    handler: async ({ sessionId: rawSessionId }) => {
      const sessionId = rawSessionId.replace(/^caco-session:/, '');
      try {
        const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/state`);
        
        if (!response.ok) {
          if (response.status === 404) {
            return { 
              textResultForLlm: `Session ${sessionId} not found`,
              resultType: 'error' as const
            };
          }
          return { 
            textResultForLlm: `Failed to get session state: ${response.statusText}`,
            resultType: 'error' as const
          };
        }
        
        const state = await response.json();
        return { 
          textResultForLlm: JSON.stringify(state, null, 2),
          resultType: 'text' as const
        };
      } catch (err) {
        return { 
          textResultForLlm: `Error getting session state: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const createCacoSession = defineTool('create_caco_session', {
    description: `Create a new persistent Caco session (appears in the session list, watchable/resumable). Use for work in a separate project/directory the user reviews separately, long-running watched sessions, or triaging into independent sessions. For quick sub-tasks that report back inline, use the built-in \`task\` tool. Provide \`initialMessage\` to create and prompt in one step. Runs autonomously — do not poll or wait.\n\nModel IDs: ${modelIds.join(', ') || '(none loaded)'}.`,

    parameters: z.object({
      cwd: z.string().describe('Working directory for the new session'),
      model: z.string().describe('Model ID (e.g. claude-sonnet-4.6). See this tool\'s description for the available IDs.'),
      initialMessage: z.string().optional().describe('Optional first message'),
      description: z.string().optional().describe('Short label for the session list'),
      pluginDirectories: z.array(z.string()).optional().describe('Absolute paths to Open Plugins directories to load into the NEW session only (never installed into ~/.copilot). Plugin agents/MCP tools/skills become available to that session and its task sub-agents. Sticky: stays set for the session\'s lifetime.')
    }),

    handler: async ({ cwd, model, initialMessage, description, pluginDirectories }) => {
      if (modelIds.length > 0 && !modelIds.includes(model)) {
        return {
          textResultForLlm: `Unknown model "${model}". Available: ${modelIds.join(', ')}.`,
          resultType: 'error' as const
        };
      }
      try {
        const createResponse = await fetch(`${SERVER_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, model, parentSessionId: sessionRef.id, description, kind: 'agent', ...(pluginDirectories?.length && { pluginDirectories }) })
        });
        
        if (!createResponse.ok) {
          const error = await createResponse.json().catch(() => ({ error: createResponse.statusText }));
          return { 
            textResultForLlm: `Failed to create session: ${error.error || createResponse.statusText}`,
            resultType: 'error' as const
          };
        }
        
        const { sessionId: newSessionId } = await createResponse.json();
        
        if (initialMessage) {
          const correlationId = getCorrelationId(sessionRef.id);
          const msgResponse = await fetch(`${SERVER_URL}/api/sessions/${newSessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: initialMessage,
              source: 'agent',
              fromSession: sessionRef.id,
              correlationId
            })
          });
          
          if (!msgResponse.ok) {
            return { 
              textResultForLlm: `Session created (${newSessionId}) but failed to send initial message: ${msgResponse.statusText}`,
              resultType: 'text' as const
            };
          }
          
          return { 
            textResultForLlm: `Created Caco session ${newSessionId} in ${cwd}. It will work independently — the user can watch its progress in the session list.`,
            resultType: 'text' as const
          };
        }
        
        return { 
          textResultForLlm: `Created Caco session ${newSessionId} in ${cwd}. Use caco_session_delegate to send it work and await its reply.`,
          resultType: 'text' as const
        };
      } catch (err) {
        return { 
          textResultForLlm: `Error creating session: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  return [getSessionState, createCacoSession];
}
