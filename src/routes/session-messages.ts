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
import { setAppletUserState, setAppletNavigation, consumeReloadSignal, type NavigationContext } from '../applet-state.js';
import { parseImageDataUrl } from '../image-utils.js';
import { updateUsage } from '../usage-state.js';
import { broadcastEvent, broadcastGlobalEvent, type MessageSource, type SessionEvent } from './websocket.js';
import { extractToolTelemetry, type ToolExecutionCompleteEvent } from '../sdk-event-parser.js';
import { transformForClient, shouldEmitReload } from '../event-transformer.js';
import { dispatchStarted, dispatchComplete } from '../restart-manager.js';
import { getQueue, isFlushTrigger } from '../caco-event-queue.js';
import { setSessionIntent } from '../storage.js';
import { unobservedTracker } from '../unobserved-tracker.js';
import { DISPATCH_TIMEOUT_MS } from '../config.js';
import { prefixMessageSource } from '../message-source.js';

const router = Router();

/**
 * POST /api/sessions/:sessionId/messages - Send message to specific session
 * 
 * Response streams via WebSocket (not returned here).
 * Returns immediately with { ok: true, sessionId }.
 */
router.post('/sessions/:sessionId/messages', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { prompt, imageData, appletState, appletNavigation, source, appletSlug, fromSession, scheduleSlug, correlationId } = req.body as {
    prompt?: string;
    imageData?: string;
    appletState?: Record<string, unknown>;
    appletNavigation?: NavigationContext;
    source?: MessageSource;
    appletSlug?: string;
    fromSession?: string;  // For agent-to-agent: originating session ID
    scheduleSlug?: string; // For scheduler: schedule slug for prefix
    correlationId?: string; // For tracking related calls
  };
  
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  
  // Agent calls must include correlationId
  if (fromSession && !correlationId) {
    res.status(400).json({ error: 'correlationId required for agent-initiated calls' });
    return;
  }
  
  // Verify session exists (getSessionCwd returns null if not found)
  if (!sessionManager.getSessionCwd(sessionId)) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  // Check if session is busy processing another message
  if (sessionManager.isBusy(sessionId)) {
    res.status(409).json({ error: 'Session is busy processing another message', code: 'SESSION_BUSY' });
    return;
  }
  
  // Self-POST prevention: block agent posting to its own session
  if (source === 'agent' && fromSession === sessionId) {
    res.status(400).json({ error: 'Cannot post to own session' });
    return;
  }
  
  // Runaway guard: check correlation metrics for agent calls
  if (correlationId) {
    const guardResult = sessionManager.checkAgentCall(correlationId, sessionId);
    if (!guardResult.allowed) {
      res.status(400).json({ error: `Agent call rejected: ${guardResult.reason}` });
      return;
    }
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
  
  // NOTE: We don't broadcast user.message here. SDK echoes it back with prefixed content,
  // and broadcastEvent() enriches it with source metadata by parsing the prefix.
  // This ensures ONE code path for enrichment (both live and history).
  
  // Record agent call for runaway guard
  if (correlationId) {
    sessionManager.recordAgentCall(correlationId, sessionId);
  }
  
  // Return immediately - dispatch happens in background
  res.json({ ok: true, sessionId });
  
  // Prefix prompt with source marker for history persistence and agent context
  // Format: [applet:slug], [agent:sessionId], or [scheduler:slug]
  let promptToSend = prompt;
  if (source === 'applet' && appletSlug) {
    promptToSend = prefixMessageSource('applet', appletSlug, prompt);
  } else if (source === 'agent' && fromSession) {
    promptToSend = prefixMessageSource('agent', fromSession, prompt);
  } else if (source === 'scheduler' && scheduleSlug) {
    promptToSend = prefixMessageSource('scheduler', scheduleSlug, prompt);
  }
  
  // Dispatch to SDK with WS broadcast callbacks
  dispatchMessage(
    sessionId, 
    promptToSend, 
    { tempFilePath, clientId },
    {
      onEvent: (evt) => broadcastEvent(sessionId, evt)
    }
  ).catch(err => {
    console.error(`[DISPATCH] Error:`, err);
  });
});

/**
 * Callback types for dispatch observers
 */
export type EventCallback = (event: SessionEvent) => void;

export interface DispatchCallbacks {
  onEvent?: EventCallback;
}

/**
 * Dispatch a message to a session and forward SDK events
 * 
 * Core dispatch function - just forwards SDK events as-is.
 * Server-side processing (usage tracking, cleanup) happens here.
 * 
 * @param sessionId - Target session
 * @param prompt - Message to send
 * @param options - Optional: tempFilePath for image, clientId for session switching
 * @param callbacks - Optional: onEvent callback for observers
 */
export async function dispatchMessage(
  sessionId: string,
  prompt: string,
  options?: { tempFilePath?: string; clientId?: string },
  callbacks?: DispatchCallbacks
): Promise<void> {
  
  const { tempFilePath } = options || {};
  const onEvent = callbacks?.onEvent || (() => {});
  
  // Track active dispatch for graceful restart
  dispatchStarted();
  
  try {
    // Ensure session is active
    if (!sessionManager.isActive(sessionId)) {
      await sessionManager.resume(sessionId, sessionState.getSessionConfig());
    }
    
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      onEvent({ type: 'session.error', data: { message: 'No active session' } });
      dispatchComplete();
      return;
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt };
    
    if (tempFilePath) {
      messageOptions.attachments = [{ type: 'file', path: tempFilePath }];
    }
    
    // Subscribe to SDK events and forward them
    type SDKEventCallback = (event: SessionEvent) => void;
    let dispatchCompleted = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const cleanupAndComplete = (reason: string) => {
      if (dispatchCompleted) return;
      dispatchCompleted = true;
      
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      
      sessionManager.markIdle(sessionId);
      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
      if (tempFilePath) {
        unlink(tempFilePath).catch(() => {});
      }
      dispatchComplete();
      console.log(`[DISPATCH] Completed: ${reason}`);
    };
    
    // Timeout watchdog - force cleanup if stream hangs
    timeoutHandle = setTimeout(() => {
      if (!dispatchCompleted) {
        console.warn(`[DISPATCH] Timeout after ${DISPATCH_TIMEOUT_MS / 1000}s for session ${sessionId}`);
        onEvent({ type: 'session.error', data: { message: `Request timed out after ${DISPATCH_TIMEOUT_MS / 1000 / 60} minutes` } });
        cleanupAndComplete('timeout');
        unsubscribe();
      }
    }, DISPATCH_TIMEOUT_MS);
    
    const unsubscribe = (session as unknown as { on: (cb: SDKEventCallback) => () => void }).on((event: SessionEvent) => {
      // Flush queued caco events before trigger events (so embeds appear at natural break)
      if (isFlushTrigger(event.type)) {
        const queue = getQueue(sessionId);
        const queued = queue.flush();
        if (queued.length > 0) {
          console.log(`[QUEUE] Flushing ${queued.length} caco events before ${event.type}`);
          for (const cacoEvent of queued) {
            onEvent(cacoEvent as unknown as SessionEvent);
          }
        }
      }
      
      // Transform event and emit all results (original + synthetic caco.* events)
      for (const transformed of transformForClient(event)) {
        onEvent(transformed);
      }
      
      // Server-side processing
      const eventData = event.data || {};
      
      // Capture intent for session state display
      if (event.type === 'assistant.intent' && eventData.intent) {
        setSessionIntent(sessionId, String(eventData.intent));
      }
      // Also capture from report_intent tool
      if (event.type === 'tool.execution_start') {
        const toolName = eventData.toolName || eventData.name;
        const args = eventData.arguments as Record<string, unknown> | undefined;
        if (toolName === 'report_intent' && args?.intent) {
          setSessionIntent(sessionId, String(args.intent));
        }
      }
      
      if (event.type === 'assistant.usage') {
        const quotaSnapshots = eventData.quotaSnapshots as Record<string, {
          isUnlimitedEntitlement: boolean;
          entitlementRequests: number;
          usedRequests: number;
          remainingPercentage: number;
          resetDate?: string;
        }> | undefined;
        updateUsage(quotaSnapshots);
      }
      
      // Reload requires external state (consumeReloadSignal), so handled separately
      if (shouldEmitReload(event) && consumeReloadSignal()) {
        onEvent({ type: 'caco.reload', data: {} });
      }
      
      if (event.type === 'session.idle' || event.type === 'session.error') {
        // Mark session as idle for unobserved tracking (via tracker for single source of truth)
        if (event.type === 'session.idle') {
          unobservedTracker.markIdle(sessionId);
        }
        cleanupAndComplete(event.type);
        unsubscribe();
      }
    });
    
    // Send message
    try {
      sessionManager.markBusy(sessionId);
      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: true } });
      sessionManager.sendStream(sessionId, prompt, messageOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      
      if (message.includes('Session not found') || message.includes('session.send failed')) {
        onEvent({ type: 'session.error', data: { message: 'Session expired - please start a new session' } });
        sessionManager.stop(sessionId).catch(() => {});
      } else {
        onEvent({ type: 'session.error', data: { message } });
      }
      
      cleanupAndComplete('send error');
      unsubscribe();
    }
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent({ type: 'session.error', data: { message } });
    
    sessionManager.markIdle(sessionId);
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
    dispatchComplete();
  }
}

/**
 * POST /api/sessions/:sessionId/cancel - Cancel current streaming
 */
router.post('/sessions/:sessionId/cancel', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  // Get the session and abort it
  const session = sessionManager.getSession(sessionId);
  if (session) {
    try {
      // SDK session has abort() method, but TypeScript types don't expose it
      await (session as unknown as { abort: () => Promise<void> }).abort();
    } catch (error) {
      console.error('Failed to abort session:', error);
    }
  }
  
  res.json({ ok: true });
});

export default router;

