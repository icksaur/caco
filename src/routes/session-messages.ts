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
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { setAppletUserState, setAppletNavigation, consumeReloadSignal, type NavigationContext } from '../applet-state.js';
import { parseImageDataUrl } from '../image-utils.js';
import { updateUsage } from '../usage-state.js';
import { broadcastEvent, broadcastGlobalEvent, type MessageSource, type SessionEvent } from './websocket.js';
import { transformForClient, shouldEmitReload } from '../event-transformer.js';
import { dispatchStarted, dispatchComplete } from '../restart-manager.js';
import { getQueue, isFlushTrigger } from '../caco-event-queue.js';
import { setSessionIntent, getSessionMeta, setSessionMeta } from '../storage.js';
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
  const requestId = (req.headers['x-request-id'] as string) || `srv-${Date.now().toString(36)}`;
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
  
  // Agent calls must include correlationId (passed by tool, invisible to agent)
  if (fromSession && !correlationId) {
    res.status(400).json({ error: 'correlationId required for agent-initiated calls' });
    return;
  }
  
  // Generate correlationId for non-agent messages (user/applet/scheduler)
  // This allows agent tools to inherit it for agent-to-agent communication
  const effectiveCorrelationId = correlationId || randomUUID();
  
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
    setAppletUserState(sessionId, appletState);
  }
  
  // Store navigation context if provided
  if (appletNavigation && typeof appletNavigation === 'object') {
    setAppletNavigation(sessionId, appletNavigation);
  }
  
  const tempFilePaths: string[] = [];
  
  // Pre-process images (multiple supported, newline-separated)
  if (imageData) {
    const imageStrings = imageData.split('\n').filter(Boolean);
    for (const imgStr of imageStrings) {
      const parsed = parseImageDataUrl(imgStr);
      if (parsed) {
        const path = join(tmpdir(), `copilot-image-${Date.now()}-${tempFilePaths.length}.${parsed.extension}`);
        await writeFile(path, Buffer.from(parsed.base64Data, 'base64'));
        tempFilePaths.push(path);
      }
    }
  }
  
  // NOTE: We don't broadcast user.message here. SDK echoes it back with prefixed content,
  // and broadcastEvent() enriches it with source metadata by parsing the prefix.
  // This ensures ONE code path for enrichment (both live and history).
  
  // Ensure session is active BEFORE returning success
  // This surfaces resume failures as HTTP errors instead of swallowing them
  if (!sessionManager.isActive(sessionId)) {
    try {
      console.log(`[DISPATCH:${requestId}] Resuming session ${sessionId}`);
      await sessionManager.resume(sessionId, sessionState.getSessionConfig());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DISPATCH] Resume failed for ${sessionId}:`, message);
      res.status(500).json({ error: `Failed to resume session: ${message}` });
      return;
    }
  }
  
  // Only record agent-to-agent calls in correlation chain (not user/applet/scheduler messages)
  if (correlationId) {
    sessionManager.recordAgentCall(effectiveCorrelationId, sessionId);
  }
  
  // Dispatch to SDK — waits for send to succeed before returning HTTP 200.
  // The streaming response continues in the background after the POST returns.
  let promptToSend = prompt;
  if (source === 'applet' && appletSlug) {
    promptToSend = prefixMessageSource('applet', appletSlug, prompt);
  } else if (source === 'agent' && fromSession) {
    promptToSend = prefixMessageSource('agent', fromSession, prompt);
  } else if (source === 'scheduler' && scheduleSlug) {
    promptToSend = prefixMessageSource('scheduler', scheduleSlug, prompt);
  }
  
  try {
    await dispatchMessage(
      sessionId, 
      promptToSend, 
      { tempFilePaths, clientId, correlationId: effectiveCorrelationId, requestId },
      {
        onEvent: (evt) => broadcastEvent(sessionId, evt)
      }
    );
    
    console.log(`[DISPATCH:${requestId}] Accepted for session ${sessionId}`);
    res.json({ ok: true, sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DISPATCH:${requestId}] Failed for session ${sessionId}:`, message);
    res.status(500).json({ error: `Dispatch failed: ${message}` });
  }
});

/**
 * Callback types for dispatch observers
 */
export type EventCallback = (event: SessionEvent) => void;

export interface DispatchCallbacks {
  onEvent?: EventCallback;
}

/**
 * Dispatch a message to a session and forward SDK events.
 * 
 * Resolves after the message is successfully sent to the SDK.
 * Event streaming continues in the background after resolution.
 * Rejects if the send fails (session expired, SDK error).
 */
export async function dispatchMessage(
  sessionId: string,
  prompt: string,
  options?: { tempFilePaths?: string[]; clientId?: string; correlationId?: string; requestId?: string },
  callbacks?: DispatchCallbacks
): Promise<void> {
  
  const { tempFilePaths, correlationId, requestId } = options || {};
  const rid = requestId || `dispatch-${Date.now().toString(36)}`;
  const onEvent = callbacks?.onEvent || (() => {});
  
  // Track active dispatch for graceful restart
  dispatchStarted();
  
  // Guard against double cleanup (inner cleanupAndComplete vs outer catch)
  let dispatchCompleted = false;
  
  try {
    // Ensure session is active (defensive - route handler should have done this)
    if (!sessionManager.isActive(sessionId)) {
      await sessionManager.resume(sessionId, sessionState.getSessionConfig());
    }
    
    await sessionManager.ensureClientHealthy();
    
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
    
    if (tempFilePaths && tempFilePaths.length > 0) {
      messageOptions.attachments = tempFilePaths.map(p => ({ type: 'file', path: p }));
    }
    
    // Subscribe to SDK events and forward them
    type SDKEventCallback = (event: SessionEvent) => void;
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const cleanupAndComplete = (reason: string) => {
      if (dispatchCompleted) return;
      dispatchCompleted = true;
      
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      
      // End dispatch - clears busy state and correlation context atomically
      sessionManager.endDispatch(sessionId);
      
      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
      if (tempFilePaths) {
        for (const p of tempFilePaths) unlink(p).catch(() => {});
      }
      dispatchComplete();
      console.log(`[DISPATCH:${rid}] Completed: ${reason}`);
    };
    
    const INITIAL_TIMEOUT_MS = 60_000;
    let receivedFirstEvent = false;
    let toolExecuting = false;
    
    const pauseWatchdog = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    };
    
    const resetWatchdog = () => {
      if (toolExecuting) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const timeout = receivedFirstEvent ? DISPATCH_TIMEOUT_MS : INITIAL_TIMEOUT_MS;
      timeoutHandle = setTimeout(() => {
        if (!dispatchCompleted) {
          const label = receivedFirstEvent ? `${DISPATCH_TIMEOUT_MS / 1000}s between events` : `${INITIAL_TIMEOUT_MS / 1000}s waiting for first event`;
          console.warn(`[DISPATCH:${rid}] Watchdog: ${label}, timing out session ${sessionId}`);
          onEvent({ type: 'session.error', data: { message: receivedFirstEvent ? `No response for ${DISPATCH_TIMEOUT_MS / 1000 / 60} minutes` : 'Session not responding (connection may be stale)' } });
          cleanupAndComplete('timeout');
          unsubscribe();
        }
      }, timeout);
    };
    resetWatchdog();
    
    const unsubscribe = (session as unknown as { on: (cb: SDKEventCallback) => () => void }).on((event: SessionEvent) => {
      receivedFirstEvent = true;
      
      if (event.type === 'tool.execution_start') {
        toolExecuting = true;
        pauseWatchdog();
      } else if (event.type === 'tool.execution_complete') {
        toolExecuting = false;
        resetWatchdog();
      } else {
        resetWatchdog();
      }
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
        
        // Auto-populate context footer from file-modifying tools only
        if (args?.path && typeof args.path === 'string') {
          if (toolName === 'create' || toolName === 'edit') {
            autoAddFileContext(sessionId, args.path);
          }
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
      if (shouldEmitReload(event) && consumeReloadSignal(sessionId)) {
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
    
    // Send message — this is the critical step. If it fails, the caller
    // gets an error. If it succeeds, streaming continues in the background.
    sessionManager.startDispatch(sessionId, correlationId!);
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: true } });
    
    console.log(`[DISPATCH:${rid}] Sending to SDK for session ${sessionId}`);
    try {
      sessionManager.sendStream(sessionId, prompt, messageOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DISPATCH:${rid}] Send error:`, message);
      
      if (message.includes('Session not found') || message.includes('session.send failed')) {
        onEvent({ type: 'session.error', data: { message: 'Session expired - please start a new session' } });
        sessionManager.stop(sessionId).catch(() => {});
      } else {
        onEvent({ type: 'session.error', data: { message } });
      }
      
      cleanupAndComplete('send error');
      unsubscribe();
      throw err;
    }
    
    // Send succeeded — function resolves. Event streaming continues in background.
    
  } catch (error) {
    if (!dispatchCompleted) {
      dispatchCompleted = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DISPATCH:${rid}] Outer error:`, message);
      onEvent({ type: 'session.error', data: { message } });
      
      sessionManager.endDispatch(sessionId);
      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
      if (tempFilePaths) {
        for (const p of tempFilePaths) await unlink(p).catch(() => {});
      }
      dispatchComplete();
    }
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

const MAX_CONTEXT_FILES = 3;

/**
 * Auto-add file paths to session context when agent uses edit/create tools.
 * Keeps the last 3 files in the context footer. Newest at end, oldest evicted.
 */
function autoAddFileContext(
  sessionId: string,
  path: string
): void {
  const meta = getSessionMeta(sessionId);
  if (!meta) return;
  
  const context = { ...(meta.context ?? {}) };
  let files = context.files ?? [];
  
  // Move to end if already present, otherwise append
  files = files.filter(f => f !== path);
  files.push(path);
  
  // Keep only the last N files
  if (files.length > MAX_CONTEXT_FILES) {
    files = files.slice(-MAX_CONTEXT_FILES);
  }
  
  context.files = files;
  setSessionMeta(sessionId, { ...meta, context });
  
  broadcastEvent(sessionId, {
    type: 'caco.context',
    data: { reason: 'changed', context, setName: 'files' }
  } as unknown as SessionEvent);
}

