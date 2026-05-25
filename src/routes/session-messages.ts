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
import { setAppletUserState, setAppletNavigation, type NavigationContext } from '../applet-state.js';
import { parseImageDataUrl } from '../image-utils.js';
import { broadcastEvent, broadcastGlobalEvent, type SessionEvent } from './websocket.js';
import { getQueue, isFlushTrigger } from '../caco-event-queue.js';
import { getSessionMeta, setSessionMeta } from '../storage.js';
import { unobservedTracker } from '../unobserved-tracker.js';
import { DISPATCH_TIMEOUT_MS } from '../config.js';
import { prefixMessageSource, type MessageSource } from '../message-source.js';
import { createWatchdog } from '../dispatch-watchdog.js';
import { retryWithFreshClient } from '../dispatch-retry.js';
import { applyDispatchEventEffects } from '../dispatch-events.js';

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
  const { prompt, imageData, appletState, appletNavigation, source, appletSlug, fromSession, scheduleSlug, correlationId, mode } = req.body as {
    prompt?: string;
    imageData?: string;
    appletState?: Record<string, unknown>;
    appletNavigation?: NavigationContext;
    source?: MessageSource;
    appletSlug?: string;
    fromSession?: string;
    scheduleSlug?: string;
    correlationId?: string;
    mode?: 'immediate' | 'enqueue';
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
  
  if (mode === 'immediate') {
    if (fromSession || source === 'agent') {
      res.status(403).json({ error: 'Steering is only available for user input' });
      return;
    }
    if (!sessionManager.isBusy(sessionId)) {
      res.status(400).json({ error: 'Cannot steer: session is not busy' });
      return;
    }
    const steerMeta = getSessionMeta(sessionId);
    if (steerMeta?.responseOptions) {
      steerMeta.responseOptions = undefined;
      setSessionMeta(sessionId, steerMeta);
    }
    try {
      await sessionManager.sendStream(sessionId, prompt!, { mode: 'immediate' });
      broadcastEvent(sessionId, {
        type: 'user.message',
        data: { content: prompt },
      } as unknown as SessionEvent);
      res.json({ ok: true, sessionId, steered: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Steer failed: ${msg}` });
    }
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

  // Clear response options when user sends a message
  const meta = getSessionMeta(sessionId);
  if (meta?.responseOptions) {
    meta.responseOptions = undefined;
    setSessionMeta(sessionId, meta);
  }  
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
    if (!source) {
      const meta = getSessionMeta(sessionId);
      if (meta) setSessionMeta(sessionId, { ...meta, lastUsedAt: new Date().toISOString() });
    }
    
    await dispatchMessage(
      sessionId, 
      promptToSend, 
      { tempFilePaths, clientId, correlationId: effectiveCorrelationId, requestId, needsObservation: !source },
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
  options?: { tempFilePaths?: string[]; clientId?: string; correlationId?: string; requestId?: string; needsObservation?: boolean },
  callbacks?: DispatchCallbacks
): Promise<void> {
  
  const { tempFilePaths, correlationId, requestId, needsObservation } = options || {};
  const rid = requestId || `dispatch-${Date.now().toString(36)}`;
  const onEvent = callbacks?.onEvent || (() => {});

  // Register the dispatch with dispatch-state up-front. This is what
  // restart-manager watches; it must cover the full lifetime of dispatchMessage
  // so a restart requested during session-resume waits for us. The actual
  // send-to-SDK happens later but the busy state is already true here.
  const effectiveCorrelationId = correlationId || randomUUID();
  sessionManager.startDispatch(sessionId, effectiveCorrelationId);

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
      sessionManager.endDispatch(sessionId);
      return;
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt };
    
    if (tempFilePaths && tempFilePaths.length > 0) {
      messageOptions.attachments = tempFilePaths.map(p => ({ type: 'file', path: p }));
    }
    
    type SDKEventCallback = (event: SessionEvent) => void;

    const cleanupAndComplete = (reason: string) => {
      if (dispatchCompleted) return;
      dispatchCompleted = true;
      watchdog.cancel();

      // End dispatch - clears busy state and correlation context atomically.
      // restart-manager listens for the 'idle' event from dispatchState.
      sessionManager.endDispatch(sessionId);

      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
      if (tempFilePaths) {
        for (const p of tempFilePaths) unlink(p).catch(() => {});
      }
      console.log(`[DISPATCH:${rid}] Completed: ${reason}`);
    };
    
    const SWARM_TIMEOUT_MS = 15 * 60 * 1000;
    const meta = getSessionMeta(sessionId);
    const baseTimeout = meta?.kind === 'swarm' || meta?.kind === 'agent'
      ? SWARM_TIMEOUT_MS
      : DISPATCH_TIMEOUT_MS;

    let retried = false;
    let unsubscribe: () => void = () => {};

    const watchdog = createWatchdog({
      initialTimeoutMs: 45_000,
      betweenEventTimeoutMs: baseTimeout,
      longRunningTimeoutMs: SWARM_TIMEOUT_MS,
      onTimeout: (reason) => {
        if (dispatchCompleted) return;

        if (reason.kind === 'no-first-event' && !retried) {
          retried = true;
          console.warn(`[DISPATCH:${rid}] No first event after ${reason.timeoutMs / 1000}s, retrying with fresh client`);
          onEvent({ type: 'session.info', data: { message: 'Reconnecting...' } });
          void retryWithFreshClient({
            sessionId,
            messageOptions,
            handleEvent,
            dropStaleSession: (id) => sessionManager.dropStaleSession(id),
            ensureClientHealthy: () => sessionManager.ensureClientHealthy(),
            resume: () => sessionManager.resume(sessionId, sessionState.getSessionConfig()).then(() => {}),
            getSession: (id) => sessionManager.getSession(id),
            resetWatchdog: () => watchdog.reset(),
            unsubscribe,
          }).then((newUnsubscribe) => {
            if (newUnsubscribe) {
              unsubscribe = newUnsubscribe;
            } else {
              console.error(`[DISPATCH:${rid}] Retry failed`);
              onEvent({ type: 'session.error', data: { message: 'Session not responding after retry', restorePrompt: true } });
              cleanupAndComplete('retry-failed');
            }
          });
          return;
        }

        const label = reason.kind === 'between-events'
          ? `${reason.timeoutMs / 1000}s between events`
          : `${reason.timeoutMs / 1000}s waiting for first event`;
        console.warn(`[DISPATCH:${rid}] Watchdog: ${label}, timing out session ${sessionId}`);
        onEvent({
          type: 'session.error',
          data: {
            message: reason.kind === 'between-events'
              ? `No response for ${reason.timeoutMs / 1000 / 60} minutes`
              : 'Session not responding (connection may be stale)',
            restorePrompt: true,
          },
        });
        cleanupAndComplete('timeout');
        unsubscribe();
      },
    });
    
    const handleEvent = (event: SessionEvent) => {
      watchdog.notifyEvent(event.type);

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

      // Forward the SDK event to the client (no transformation — caco.* events
      // are emitted directly by their tool handlers).
      onEvent(event);

      // Server-side side-effects: intent capture, auto-context, usage,
      // reload signal. Extracted so each event hook stays inspectable.
      applyDispatchEventEffects(sessionId, event, { autoAddFileContext, onEvent });

      if (event.type === 'session.idle' || event.type === 'session.error') {
        if (event.type === 'session.idle' && needsObservation) {
          unobservedTracker.markIdle(sessionId);
        }
        if (event.type === 'session.idle') {
          void sessionManager.pollQuota();
        }
        cleanupAndComplete(event.type);
        unsubscribe();
      }
    };

    unsubscribe = (session as unknown as { on: (cb: SDKEventCallback) => () => void }).on(handleEvent);
    watchdog.reset();
    
    // Send message — fire-and-forget. The send RPC may outlive the actual
    // session processing (SDK can be slow to ack), so we don't await it.
    // Events stream via session.on(handleEvent) regardless.
    // Note: startDispatch is already done at the top of this function.
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: true } });
    
    console.log(`[DISPATCH:${rid}] Sending to SDK for session ${sessionId}`);
    try {
      const sendPromise = sessionManager.sendStream(sessionId, prompt, messageOptions);

      sendPromise.catch((err: unknown) => {
        if (dispatchCompleted) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DISPATCH:${rid}] Async send error:`, message);

        const isSessionLost = message.includes('Session not found') || message.includes('session.send failed');
        if (isSessionLost && !retried) {
          retried = true;
          console.log(`[DISPATCH:${rid}] Session lost by SDK, retrying with fresh resume`);
          onEvent({ type: 'session.info', data: { message: 'Reconnecting...' } });
          void retryWithFreshClient({
            sessionId,
            messageOptions,
            handleEvent,
            dropStaleSession: (id) => sessionManager.dropStaleSession(id),
            ensureClientHealthy: () => sessionManager.ensureClientHealthy(),
            resume: () => sessionManager.resume(sessionId, sessionState.getSessionConfig()).then(() => {}),
            getSession: (id) => sessionManager.getSession(id),
            resetWatchdog: () => watchdog.reset(),
            unsubscribe,
          }).then((newUnsubscribe) => {
            if (newUnsubscribe) {
              unsubscribe = newUnsubscribe;
            } else {
              console.error(`[DISPATCH:${rid}] Retry failed`);
              onEvent({ type: 'session.error', data: { message: 'Session not responding after retry', restorePrompt: true } });
              cleanupAndComplete('retry-failed');
            }
          });
          return;
        }

        if (isSessionLost) {
          onEvent({ type: 'session.error', data: { message: 'Session expired - please start a new session', restorePrompt: true } });
        } else {
          onEvent({ type: 'session.error', data: { message, restorePrompt: true } });
        }

        cleanupAndComplete('send error');
        unsubscribe();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DISPATCH:${rid}] Send error:`, message);
      onEvent({ type: 'session.error', data: { message, restorePrompt: true } });
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
      onEvent({ type: 'session.error', data: { message, restorePrompt: true } });      
      sessionManager.endDispatch(sessionId);
      broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
      if (tempFilePaths) {
        for (const p of tempFilePaths) await unlink(p).catch(() => {});
      }
    }
  }
}

/**
 * POST /api/sessions/:sessionId/cancel - Cancel current streaming
 */
router.post('/sessions/:sessionId/cancel', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  const cancelMeta = getSessionMeta(sessionId);
  if (cancelMeta?.responseOptions) {
    cancelMeta.responseOptions = undefined;
    setSessionMeta(sessionId, cancelMeta);
  }
  
  const { forced } = await sessionManager.cancelSession(sessionId);
  if (forced) {
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
  }
  
  res.json({ ok: true, forced });
});

export default router;

const MAX_CONTEXT_FILES = 10;

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

