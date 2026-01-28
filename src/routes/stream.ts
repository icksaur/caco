/**
 * Stream Routes
 * 
 * POST /api/sessions/:id/messages - Send message, stream response via WebSocket
 * 
 * The response streams via WebSocket (not SSE):
 * - Client sends message via POST
 * - Server broadcasts events via WS to all session connections
 */

import { Router, Request, Response } from 'express';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../storage.js';
import { setAppletUserState, setAppletNavigation, consumeReloadSignal, type NavigationContext } from '../applet-state.js';
import { parseImageDataUrl } from '../image-utils.js';
import { broadcastUserMessageFromPost, broadcastMessage, broadcastActivity, type ActivityItem } from './applet-ws.js';
import { randomUUID } from 'crypto';

const router = Router();

// Session event type
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * POST /api/sessions/:sessionId/messages - Send message to specific session
 * 
 * Response streams via WebSocket (not returned here).
 * Returns immediately with { ok: true, sessionId }.
 */
router.post('/sessions/:sessionId/messages', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { prompt, imageData, appletState, appletNavigation } = req.body as {
    prompt?: string;
    imageData?: string;
    appletState?: Record<string, unknown>;
    appletNavigation?: NavigationContext;
  };
  
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  
  // Verify session exists (getSessionCwd returns null if not found)
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  // Store applet state if provided
  if (appletState && typeof appletState === 'object') {
    setAppletUserState(appletState);
  }
  
  // Store navigation context if provided
  if (appletNavigation && typeof appletNavigation === 'object') {
    setAppletNavigation(appletNavigation);
  }
  
  let tempFilePath: string | undefined;
  
  // Pre-process image if present
  const parsed = parseImageDataUrl(imageData);
  if (parsed) {
    tempFilePath = join(tmpdir(), `copilot-image-${Date.now()}.${parsed.extension}`);
    await writeFile(tempFilePath, Buffer.from(parsed.base64Data, 'base64'));
  }
  
  // Broadcast user message to WS clients for unified rendering
  broadcastUserMessageFromPost(sessionId, prompt, !!tempFilePath, 'user');
  
  // Return immediately - streaming happens via WebSocket
  res.json({ ok: true, sessionId });
  
  // Start streaming in background
  streamToWebSocket(sessionId, prompt, tempFilePath, clientId).catch(err => {
    console.error(`[STREAM] Error streaming to WS:`, err);
  });
});

/**
 * Stream agent response via WebSocket
 * Uses unified message protocol:
 * - message with status:'streaming' to start
 * - message with deltaContent to append
 * - message with status:'complete' to finalize
 * - activity for tool calls, intents, errors
 */
async function streamToWebSocket(
  sessionId: string,
  prompt: string,
  tempFilePath?: string,
  clientId?: string
): Promise<void> {
  console.log(`[STREAM] Starting WS stream for session ${sessionId}`);
  
  // Generate message ID for the assistant response
  const messageId = `msg_${randomUUID()}`;
  let messageContent = '';
  let hasStarted = false;
  
  try {
    // Ensure session is active
    if (!sessionManager.isActive(sessionId)) {
      await sessionState.switchSession(sessionId, clientId);
    }
    
    // Get session
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      broadcastActivity(sessionId, { type: 'error', text: 'No active session' });
      return;
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt };
    
    // Add image attachment if present
    if (tempFilePath) {
      messageOptions.attachments = [{ type: 'file', path: tempFilePath }];
    }
    
    // Subscribe to events and broadcast via WS
    type EventCallback = (event: SessionEvent) => void;
    const unsubscribe = (session as unknown as { on: (cb: EventCallback) => () => void }).on((event: SessionEvent) => {
      const eventData: Record<string, unknown> = event.data || {};
      
      switch (event.type) {
        case 'assistant.message_delta': {
          // Start streaming message if first delta
          if (!hasStarted) {
            broadcastMessage(sessionId, {
              id: messageId,
              role: 'assistant',
              content: '',
              status: 'streaming'
            });
            hasStarted = true;
          }
          // Append delta content
          const delta = (eventData.deltaContent as string) || '';
          messageContent += delta;
          broadcastMessage(sessionId, {
            id: messageId,
            role: 'assistant',
            deltaContent: delta
          });
          break;
        }
        
        case 'assistant.message': {
          // Final message content
          const content = (eventData.content as string) || messageContent;
          broadcastMessage(sessionId, {
            id: messageId,
            role: 'assistant',
            content,
            status: 'complete'
          });
          break;
        }
        
        case 'assistant.turn_start': {
          const turnNum = parseInt(String(eventData.turnId || 0)) + 1;
          broadcastActivity(sessionId, { type: 'turn', text: `Turn ${turnNum}...` });
          break;
        }
        
        case 'assistant.intent': {
          const intent = eventData.intent as string;
          if (intent) {
            broadcastActivity(sessionId, { type: 'intent', text: `Intent: ${intent}` });
          }
          break;
        }
        
        case 'tool.execution_start': {
          const toolName = (eventData.toolName || eventData.name || 'tool') as string;
          const args = eventData.arguments ? JSON.stringify(eventData.arguments) : undefined;
          broadcastActivity(sessionId, { 
            type: 'tool', 
            text: `▶ ${toolName}`,
            details: args ? `Arguments: ${args}` : undefined
          });
          break;
        }
        
        case 'tool.execution_complete': {
          const toolName = (eventData.toolName || eventData.name || 'tool') as string;
          const success = eventData.success as boolean;
          const status = success ? '✓' : '✗';
          const result = eventData.result ? JSON.stringify(eventData.result) : undefined;
          
          // Handle output references
          const toolTelemetry = eventData.toolTelemetry as { 
            outputId?: string;
            reloadTriggered?: boolean;
          } | undefined;
          
          let details = result;
          if (toolTelemetry?.outputId) {
            const storedOutput = getOutput(toolTelemetry.outputId);
            const outputMeta = storedOutput?.metadata;
            if (outputMeta) {
              // TODO: Handle display output rendering via activity or message
              details = `[Output: ${toolTelemetry.outputId}]`;
            }
          }
          
          broadcastActivity(sessionId, { 
            type: 'tool-result', 
            text: `${status} ${toolName}`,
            details
          });
          
          if (toolTelemetry?.reloadTriggered && consumeReloadSignal()) {
            broadcastActivity(sessionId, { type: 'info', text: 'Reload triggered' });
          }
          break;
        }
        
        case 'session.error': {
          const msg = (eventData.message as string) || 'Unknown error';
          broadcastActivity(sessionId, { type: 'error', text: `Error: ${msg}` });
          // Fall through to cleanup
        }
        // eslint-disable-next-line no-fallthrough
        case 'session.idle': {
          // Ensure message is finalized if we haven't sent complete
          if (hasStarted && messageContent) {
            broadcastMessage(sessionId, {
              id: messageId,
              role: 'assistant',
              content: messageContent,
              status: 'complete'
            });
          }
          unsubscribe();
          if (tempFilePath) {
            unlink(tempFilePath).catch(() => {});
          }
          break;
        }
      }
    });
    
    // Send message (non-blocking)
    sessionManager.sendStream(sessionId, prompt, messageOptions);
    
  } catch (error) {
    console.error('Stream error:', error);
    const message = error instanceof Error ? error.message : String(error);
    broadcastActivity(sessionId, { type: 'error', text: `Error: ${message}` });
    
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
  }
}

export default router;

