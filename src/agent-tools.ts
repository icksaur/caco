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
import type { SessionIdRef } from './types.js';

export type GetCorrelationId = (sessionId: string) => string | undefined;

export function createAgentTools(sessionRef: SessionIdRef, getCorrelationId: GetCorrelationId) {
  
  const sendCacoMessage = defineTool('send_caco_message', {
    description: `Send a message to another Caco session. The target session works independently — do NOT poll or wait for a response.

Use this to dispatch work to an existing session, such as:
- Sending follow-up instructions to a session you created
- Coordinating across projects (e.g., "update the API client after the schema change")
- Notifying a session of state changes

The target session receives your message and works on it autonomously. The user can watch its progress in the Caco session list.`,

    parameters: z.object({
      sessionId: z.string().describe('Target session ID to send the message to'),
      message: z.string().describe('The message/prompt to send to the target session')
    }),

    handler: async ({ sessionId, message }) => {
      try {
        const correlationId = getCorrelationId(sessionRef.id);
        
        if (!correlationId) {
          return { 
            textResultForLlm: 'Cannot send message: no correlationId in dispatch context.',
            resultType: 'error' as const
          };
        }
        
        const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: message,
            source: 'agent',
            fromSession: sessionRef.id,
            correlationId
          })
        });
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: response.statusText }));
          return { 
            textResultForLlm: `Failed to send message: ${error.error || response.statusText}`,
            resultType: 'error' as const
          };
        }

        await response.json();
        return { 
          textResultForLlm: `Message sent to session ${sessionId}. It will work independently — the user can watch its progress in the session list.`,
          resultType: 'text' as const
        };
      } catch (err) {
        return { 
          textResultForLlm: `Error sending message: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const getSessionState = defineTool('get_session_state', {
    description: 'Check the current state of a Caco session (idle, busy, or inactive). Use to verify a session exists before sending messages.',

    parameters: z.object({
      sessionId: z.string().describe('Target session ID to check')
    }),

    handler: async ({ sessionId }) => {
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

  const listModels = defineTool('list_models', {
    description: `List available models for creating Caco sessions. Use before create_caco_session to see model options.

**Quick guide (no need to call this if you know what you need):**
- \`claude-opus-4.6-1m\` - Reasoning, documents, analysis, complex planning
- \`claude-sonnet-4.6\` - General-purpose engineering: edit/compile/test/fix cycles
- \`gpt-4.1\` - Simple automation tasks (fast and cheap)`,

    parameters: z.object({}),

    handler: async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/models`);
        if (!response.ok) {
          return {
            textResultForLlm: `Failed to list models: ${response.statusText}`,
            resultType: 'error' as const
          };
        }
        const models = await response.json();
        return {
          textResultForLlm: JSON.stringify(models, null, 2),
          resultType: 'text' as const
        };
      } catch (err) {
        return {
          textResultForLlm: `Error listing models: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const createCacoSession = defineTool('create_caco_session', {
    description: `Create a new persistent Caco session. The session appears in the user's session list and can be watched or resumed later.

**When to use (instead of the \`task\` tool):**
- Dispatching work to a **different project/directory** that the user will review separately
- Creating a **long-running session** the user wants to watch in real-time
- Triaging work into **independent sessions** (e.g., "fix the tests" + "update the docs")

For quick sub-tasks that report results back to you, use the built-in \`task\` tool instead.

Provide \`initialMessage\` to create and prompt in one step. The session works autonomously — do not poll or wait.`,

    parameters: z.object({
      cwd: z.string().describe('Working directory for the new session'),
      model: z.string().describe('Model ID (e.g., claude-sonnet-4.6, claude-opus-4.6-1m). Use list_models to see options.'),
      initialMessage: z.string().optional().describe('Optional first message to send immediately after creation'),
      description: z.string().optional().describe('Short description for the session list (e.g., "Fix auth tests", "Update API docs")')
    }),

    handler: async ({ cwd, model, initialMessage, description }) => {
      try {
        const createResponse = await fetch(`${SERVER_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, model, parentSessionId: sessionRef.id, description })
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
          textResultForLlm: `Created Caco session ${newSessionId} in ${cwd}. Use send_caco_message('${newSessionId}', '...') to send work to it.`,
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

  return [sendCacoMessage, getSessionState, listModels, createCacoSession];
}
