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
import { broadcastUserMessageFromPost, broadcastMessage, broadcastActivity, type ActivityItem, type MessageSource, type ChatMessage } from './applet-ws.js';
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
  const { prompt, imageData, appletState, appletNavigation, source, appletSlug, fromSession } = req.body as {
    prompt?: string;
    imageData?: string;
    appletState?: Record<string, unknown>;
    appletNavigation?: NavigationContext;
    source?: MessageSource;
    appletSlug?: string;
    fromSession?: string;  // For agent-to-agent: originating session ID
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
  
  // Self-POST prevention: block agent posting to its own session
  if (source === 'agent' && fromSession === sessionId) {
    res.status(400).json({ error: 'Cannot post to own session' });
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
  // Use source from request (defaults to 'user' for normal messages)
  broadcastUserMessageFromPost(sessionId, prompt, !!tempFilePath, source ?? 'user', appletSlug, fromSession);
  
  // Return immediately - dispatch happens in background
  res.json({ ok: true, sessionId });
  
  // Prefix prompt with applet/agent marker for history persistence
  // Format: [applet:slug] or [agent:fromSession] actual prompt
  let promptToSend = prompt;
  if (source === 'applet' && appletSlug) {
    promptToSend = `[applet:${appletSlug}] ${prompt}`;
  } else if (source === 'agent' && fromSession) {
    promptToSend = `[agent:${fromSession}] ${prompt}`;
  }
  
  // Dispatch to SDK with WS broadcast callbacks
  dispatchMessage(
    sessionId, 
    promptToSend, 
    { tempFilePath, clientId },
    {
      onMessage: (msg) => broadcastMessage(sessionId, msg),
      onActivity: (item) => broadcastActivity(sessionId, item)
    }
  ).catch(err => {
    console.error(`[DISPATCH] Error:`, err);
  });
});

/**
 * Callback types for dispatch observers
 */
export type MessageCallback = (message: ChatMessage) => void;
export type ActivityCallback = (item: ActivityItem) => void;

export interface DispatchCallbacks {
  onMessage?: MessageCallback;
  onActivity?: ActivityCallback;
}

/**
 * Dispatch a message to a session and handle SDK events
 * 
 * Core dispatch function - works without WebSocket.
 * Optional callbacks allow observers (like WS broadcast) to receive events.
 * 
 * @param sessionId - Target session
 * @param prompt - Message to send
 * @param options - Optional: tempFilePath for image, clientId for session switching
 * @param callbacks - Optional: onMessage and onActivity callbacks for observers
 */
export async function dispatchMessage(
  sessionId: string,
  prompt: string,
  options?: { tempFilePath?: string; clientId?: string },
  callbacks?: DispatchCallbacks
): Promise<void> {
  console.log(`[DISPATCH] Starting for session ${sessionId}`);
  
  const { tempFilePath, clientId } = options || {};
  const onMessage = callbacks?.onMessage || (() => {});
  const onActivity = callbacks?.onActivity || (() => {});
  
  // Generate message ID for the assistant response
  const messageId = `msg_${randomUUID()}`;
  let messageContent = '';
  let hasStarted = false;
  
  try {
    // Ensure session is active (loads SDK client into memory)
    // Uses resume() directly - doesn't stop other sessions
    if (!sessionManager.isActive(sessionId)) {
      await sessionManager.resume(sessionId);
    }
    
    // Get session
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      onActivity({ type: 'error', text: 'No active session' });
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
    
    // Subscribe to events and call callbacks
    type EventCallback = (event: SessionEvent) => void;
    const unsubscribe = (session as unknown as { on: (cb: EventCallback) => () => void }).on((event: SessionEvent) => {
      const eventData: Record<string, unknown> = event.data || {};
      
      switch (event.type) {
        case 'assistant.message_delta': {
          // Start streaming message if first delta
          if (!hasStarted) {
            onMessage({
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
          onMessage({
            id: messageId,
            role: 'assistant',
            deltaContent: delta
          });
          break;
        }
        
        case 'assistant.message': {
          // Text content from assistant - but DON'T finalize here
          // The agent may do more turns. Finalization happens on session.idle.
          const content = (eventData.content as string) || '';
          console.log(`[DISPATCH] assistant.message event: hasStarted=${hasStarted}, content="${content?.slice(0,50)}", messageContent="${messageContent?.slice(0,50)}"`);
          
          // If we haven't started streaming yet, start now
          if (!hasStarted && content) {
            onMessage({
              id: messageId,
              role: 'assistant',
              content: '',
              status: 'streaming'
            });
            hasStarted = true;
          }
          
          // Update accumulated content (for final message)
          if (content && content.length > messageContent.length) {
            messageContent = content;
          }
          break;
        }
        
        case 'assistant.turn_start': {
          const turnNum = parseInt(String(eventData.turnId || 0)) + 1;
          onActivity({ type: 'turn', text: `Turn ${turnNum}...` });
          break;
        }
        
        case 'assistant.intent': {
          const intent = eventData.intent as string;
          if (intent) {
            onActivity({ type: 'intent', text: `Intent: ${intent}` });
          }
          break;
        }
        
        case 'tool.execution_start': {
          const toolName = (eventData.toolName || eventData.name || 'tool') as string;
          const args = eventData.arguments ? JSON.stringify(eventData.arguments) : undefined;
          onActivity({ 
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
          
          onActivity({ 
            type: 'tool-result', 
            text: `${status} ${toolName}`,
            details
          });
          
          if (toolTelemetry?.reloadTriggered && consumeReloadSignal()) {
            onActivity({ type: 'info', text: 'Reload triggered' });
          }
          break;
        }
        
        case 'session.error': {
          const msg = (eventData.message as string) || 'Unknown error';
          onActivity({ type: 'error', text: `Error: ${msg}` });
          // Fall through to cleanup
        }
        // eslint-disable-next-line no-fallthrough
        case 'session.idle': {
          // Ensure message is finalized if we haven't sent complete
          if (hasStarted && messageContent) {
            onMessage({
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
    console.error('Dispatch error:', error);
    const message = error instanceof Error ? error.message : String(error);
    onActivity({ type: 'error', text: `Error: ${message}` });
    
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
  }
}

export default router;

