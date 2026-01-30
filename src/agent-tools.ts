/**
 * Agent-to-Agent Tools
 * 
 * MCP tools for agent-to-agent communication. Allows one agent session
 * to send messages to other sessions, create new sessions, and check status.
 * 
 * The receiving session sees messages with source: 'agent' and can
 * call back to the originating session when finished using the same tools.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';

// Server base URL for HTTP calls
const SERVER_URL = process.env.COPILOT_SERVER_URL || 'http://localhost:3000';

// Session ID reference - mutable so it can be set after session creation
export interface SessionIdRef {
  id: string;
}

/**
 * Create agent tools with a session ID reference
 * The reference can be updated after session creation for new sessions.
 * @param sessionRef - Mutable reference to session ID
 */
export function createAgentTools(sessionRef: SessionIdRef) {
  
  const sendAgentMessage = defineTool('send_agent_message', {
    description: `Send a message to another agent session. Use this to delegate work to specialist sessions or coordinate with other agents.

The target session receives your message with source: 'agent'. Your session ID is automatically included so the target can call back.

**Callback pattern**: Tell the target to "send_agent_message(requestingSession, 'Results: ...')" when finished.

**Example uses**:
- Delegate: "Analyze the API in /src/api and send_agent_message(requestingSession, 'Analysis: ...') when done"
- Fan-out: Send same analysis task to multiple specialist sessions
- Coordinate: Notify other sessions of state changes`,

    parameters: z.object({
      sessionId: z.string().describe('Target session ID to send the message to'),
      message: z.string().describe('The message/prompt to send to the target session')
    }),

    handler: async ({ sessionId, message }) => {
      try {
        const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: message,
            source: 'agent',
            fromSession: sessionRef.id
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
          textResultForLlm: `Message sent to session ${sessionId}. Target will process asynchronously. Include callback instructions like: "send_agent_message(requestingSession, 'results')" so target can reply.`,
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
    description: `Check the current state of an agent session. Use this to:
- Poll if a session you sent work to is still processing or idle
- Verify a session exists before sending messages
- Get the working directory of a session`,

    parameters: z.object({
      sessionId: z.string().describe('Target session ID to check')
    }),

    handler: async ({ sessionId }) => {
      try {
        const targetId = sessionId;
        
        const response = await fetch(`${SERVER_URL}/api/sessions/${targetId}/state`);
        
        if (!response.ok) {
          if (response.status === 404) {
            return { 
              textResultForLlm: `Session ${targetId} not found`,
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

  const createAgentSession = defineTool('create_agent_session', {
    description: `Create a new agent session with a specific working directory. Use this to spawn specialist agents for subtasks.

Returns the new session ID. Use send_agent_message to send work to it.

**Tip**: After creating, immediately send a message that includes callback instructions so the new session can report back when finished.`,

    parameters: z.object({
      cwd: z.string().describe('Working directory for the new session'),
      initialMessage: z.string().optional().describe('Optional first message to send immediately after creation')
    }),

    handler: async ({ cwd, initialMessage }) => {
      try {
        // Create the session
        const createResponse = await fetch(`${SERVER_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd })
        });
        
        if (!createResponse.ok) {
          const error = await createResponse.json().catch(() => ({ error: createResponse.statusText }));
          return { 
            textResultForLlm: `Failed to create session: ${error.error || createResponse.statusText}`,
            resultType: 'error' as const
          };
        }
        
        const { sessionId: newSessionId } = await createResponse.json();
        
        // If initial message provided, send it
        if (initialMessage) {
          const msgResponse = await fetch(`${SERVER_URL}/api/sessions/${newSessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: initialMessage,
              source: 'agent',
              fromSession: sessionRef.id
            })
          });
          
          if (!msgResponse.ok) {
            return { 
              textResultForLlm: `Session created (${newSessionId}) but failed to send initial message: ${msgResponse.statusText}`,
              resultType: 'text' as const
            };
          }
          
          return { 
            textResultForLlm: `Created session ${newSessionId} in ${cwd} and sent initial message. Include callback instructions like "send_agent_message(requestingSession, 'results')" so the new session can reply.`,
            resultType: 'text' as const
          };
        }
        
        return { 
          textResultForLlm: `Created session ${newSessionId} in ${cwd}. Use send_agent_message('${newSessionId}', '...') to send work to it.`,
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

  return [sendAgentMessage, getSessionState, createAgentSession];
}
