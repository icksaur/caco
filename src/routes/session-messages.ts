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
import { sessionManager } from '../session-manager.js';
import { setAutoContinuePrefProvider } from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { setAppletUserState, setAppletNavigation, type NavigationContext } from '../applet-state.js';
import { parseImageDataUrl } from '../image-utils.js';
import { broadcastEvent, broadcastGlobalEvent, type SessionEvent } from './websocket.js';
import { getSessionMeta, updateSessionMeta } from '../storage.js';
import { unobservedTracker } from '../unobserved-tracker.js';
import { DISPATCH_TIMEOUT_MS } from '../config.js';
import { prefixMessageSource, type MessageSource } from '../message-source.js';
import { createWatchdog } from '../dispatch-watchdog.js';
import { dispatchState } from '../dispatch-state.js';
import { retryWithFreshClient } from '../dispatch-retry.js';
import { applyDispatchEventEffects } from '../dispatch-events.js';
import { resetRequest, snapshot, markRequestComplete } from '../session-throughput.js';
import { appendRequestMetrics } from '../request-metrics-log.js';
import { buildUsageRecord, emitUsageRecord, resolveUsageRates, type UsageRates } from '../usage-metrics.js';
import { modelCostSummary } from '../model-billing.js';
import { maybeAutoContinue, AUTOCONTINUE_IDENTIFIER, AUTO_CONTINUE_CAP } from '../auto-continue-runtime.js';
import { isAutoContinueEnabled } from '../preferences.js';
import { onSessionIdle } from '../herd-runtime.js';
import { handleSessionIdle } from '../idle-authority.js';
import { getLastAssistantMessage } from '../session-history.js';
import { idleFeed } from '../idle-feed.js';

const router = Router();

// Wire the auto-continue preference into SessionManager's hasPendingAutoContinue
// predicate (spec-idle-authority) — injection so SessionManager needs no
// session-state/preferences import. One registration at module load.
setAutoContinuePrefProvider(() => isAutoContinueEnabled(sessionState.preferences));

/**
 * Drive the auto-continue runtime for a session (spec-enable-tools-autocontinue):
 * fires a continuation for revealed tools, or at cap emits the terminal cap
 * message. Builds the effect deps around SessionManager + dispatchMessage. Called
 * by the idle authority only when a pending reveal exists. Resolves `true` iff a
 * continuation dispatch actually started.
 */
function runAutoContinue(sessionId: string): Promise<boolean> {
  return maybeAutoContinue(sessionId, {
    getPendingTools: id => sessionManager.getPendingTools(id),
    getAttempts: id => sessionManager.getAutoContinueAttempts(id),
    isBusy: id => sessionManager.isBusy(id),
    reassert: async (id, tools) => { await sessionManager.enableTools(id, tools); },
    clearPendingTools: id => sessionManager.clearPendingTools(id),
    markContinuing: id => sessionManager.markContinuationInFlight(id),
    clearContinuing: id => sessionManager.clearContinuationInFlight(id),
    bumpAttempts: id => sessionManager.bumpAutoContinueAttempts(id),
    dispatch: async (id, text) => {
      const prompt = prefixMessageSource('system', AUTOCONTINUE_IDENTIFIER, text);
      // Broadcast the continuation's events to WS viewers (same as the HTTP route),
      // otherwise the operator sees nothing live until a page refresh replays history.
      await dispatchMessage(
        id,
        prompt,
        { needsObservation: false, requestId: `autocontinue-${Date.now().toString(36)}` },
        { onEvent: (evt) => broadcastEvent(id, evt) }
      );
    },
    emitSystem: (id, text) => broadcastEvent(id, { type: 'session.info', data: { message: text } }),
    enabled: () => isAutoContinueEnabled(sessionState.preferences),
    cap: AUTO_CONTINUE_CAP,
  });
}

/**
 * The single idle seam (spec-idle-authority): classify a session.idle and
 * dispatch its effects. A pending-reveal idle (about to auto-continue) is a FALSE
 * idle — it fires the continuation and suppresses herd-wake, delegate-completion
 * (via the shared `hasPendingAutoContinue` predicate, consumed by dispatch-state),
 * and unobserved-marking. A real idle propagates to all three as before.
 */
export function handleIdle(sessionId: string, needsObservation: boolean, correlationId?: string): void {
  void handleSessionIdle(sessionId, { needsObservation }, {
    hasPendingAutoContinue: id => sessionManager.hasPendingAutoContinue(id),
    pendingToolCount: id => sessionManager.getPendingTools(id).length,
    runAutoContinue,
    markIdle: id => unobservedTracker.markIdle(id),
    herdOnSessionIdle: id => { void onSessionIdle(id); },
    pollQuota: () => { void sessionManager.pollQuota(); },
    signalDispatchIdle: id => dispatchState.signalIdle(id),
    // Publish to the external idle feed (spec-idle-notifications). The idle
    // authority calls this only inside its needsObservation branch, so herd
    // children / delegates / auto-continuations never reach the feed. The final
    // response text is read here (same source as delegate/herd) and size-capped
    // by the feed.
    notifyExternalIdle: id => {
      void getLastAssistantMessage(id).then(response => {
        const kind = getSessionMeta(id)?.kind ?? 'interactive';
        idleFeed.append(id, response, kind, correlationId);
      });
    },
  });
}

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

  // Any human/agent/applet/scheduler message re-arms auto-continuation: clear a
  // stale pending reveal + reset the consecutive-continuation counter (spec-
  // enable-tools-autocontinue P5). The continuation dispatch itself calls
  // dispatchMessage directly (not this route), so it never resets its own budget.
  sessionManager.resetAutoContinue(sessionId);
  
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
    updateSessionMeta(sessionId, meta => {
      if (meta.responseOptions) meta.responseOptions = undefined;
    }, { createIfMissing: false });
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
  updateSessionMeta(sessionId, meta => {
    if (meta.responseOptions) meta.responseOptions = undefined;
  }, { createIfMissing: false });
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
  } else if (source === 'system') {
    promptToSend = prefixMessageSource('system', 'herd', prompt);
  }
  
  try {
    if (!source) {
      updateSessionMeta(sessionId, meta => { meta.lastUsedAt = new Date().toISOString(); }, { createIfMissing: false });
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
    if (err instanceof DispatchHttpError) {
      res.status(err.status).json({ error: err.message, ...(err.code && { code: err.code }) });
      return;
    }
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

export class DispatchHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'DispatchHttpError';
    this.status = status;
    this.code = code;
  }
}

/** Snapshot the pricing context for a request at dispatch start: the session's
 *  model slug + its resolved per-MTOK rates + context window. Frozen here so a
 *  concurrent model change can never re-price the in-flight request's usage
 *  record (spec-usage-metrics). Unknown/unpriced model → null rates. */
function capturePriceContext(sessionId: string): { model: string | null; rates: UsageRates | null; contextWindow: number | null } {
  const model = getSessionMeta(sessionId)?.model ?? null;
  const priced = sessionManager.getModels().map(m => ({ id: m.id, ...modelCostSummary(m) }));
  return resolveUsageRates(priced, model);
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
  options?: { tempFilePaths?: string[]; clientId?: string; correlationId?: string; requestId?: string; needsObservation?: boolean; displayPrompt?: string; beforeSend?: () => Promise<void> },
  callbacks?: DispatchCallbacks
): Promise<void> {
  
  const { tempFilePaths, correlationId, requestId, needsObservation, displayPrompt, beforeSend } = options || {};
  const rid = requestId || `dispatch-${Date.now().toString(36)}`;
  const onEvent = callbacks?.onEvent || (() => {});

  if (sessionManager.isBusy(sessionId)) {
    throw new DispatchHttpError(409, 'Session is busy processing another message', 'SESSION_BUSY');
  }

  // Register the dispatch with dispatch-state up-front. This is what
  // restart-manager watches; it must cover the full lifetime of dispatchMessage
  // so a restart requested during session-resume waits for us. The actual
  // send-to-SDK happens later but the busy state is already true here.
  const effectiveCorrelationId = correlationId || randomUUID();
  sessionManager.startDispatch(sessionId, effectiveCorrelationId);

  // Fresh user send → reset request-scoped throughput counters and push
  // the cleared snapshot so the footer zeroes at send. Accumulation then
  // runs across the whole multi-turn request and persists after idle
  // until the next send. (Steering uses sendStream, not dispatchMessage,
  // so it accumulates into the ongoing request rather than resetting.)
  resetRequest(sessionId);
  onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> } as unknown as SessionEvent);

  // Capture the pricing context at dispatch START — the model that actually
  // produces this request's tokens. A model change mid-request is rejected by
  // the busy guard on PATCH /sessions/:id, so this stays valid to completion;
  // freezing it here means the durable usage record can never be mispriced by a
  // later swap (spec-usage-metrics).
  const priceCtx = capturePriceContext(sessionId);

  // Guard against double cleanup (completeDispatch vs outer catch)
  let dispatchCompleted = false;
  let sendStarted = false;
  let watchdog: ReturnType<typeof createWatchdog> | null = null;

  // Single dispatch-teardown owner. Every exit path routes through this so no
  // branch can forget part of the cleanup contract. Idempotent
  // (dispatchCompleted is set synchronously) and awaitable so pre-send paths
  // delete temp files before returning/throwing. It does NOT own unsubscribe():
  // the retry helper manages subscription teardown for its own paths.
  const completeDispatch = async (reason: string): Promise<void> => {
    if (dispatchCompleted) return;
    dispatchCompleted = true;
    watchdog?.cancel();
    sessionManager.endDispatch(sessionId);
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
    if (tempFilePaths) await Promise.all(tempFilePaths.map(p => unlink(p).catch(() => {})));
    // Stamp wall-clock + persist a benchmark row for requests that ran a model
    // turn (skip pre-send aborts, which have no turns). Best-effort.
    const metrics = markRequestComplete(sessionId);
    if (metrics && metrics.requestTurns > 0) {
      appendRequestMetrics(sessionId, metrics);
      // Durable usage record — one per completed request, priced by the
      // dispatch-start model. Best-effort (emitUsageRecord swallows sink errors).
      emitUsageRecord(buildUsageRecord({
        sessionId,
        model: priceCtx.model,
        tokens: {
          inputTokens: metrics.requestIn,
          cachedTokens: metrics.requestCache,
          outputTokens: metrics.requestOut,
          turns: metrics.requestTurns,
        },
        rates: priceCtx.rates,
        contextWindow: priceCtx.contextWindow,
      }));
    }
    onEvent({ type: 'caco.throughput', data: snapshot(sessionId) as unknown as Record<string, unknown> } as unknown as SessionEvent);
    console.log(`[DISPATCH:${rid}] Completed: ${reason}`);
  };

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
      await completeDispatch('no-session');
      return;
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }>;
      displayPrompt?: string;
    } = { prompt };

    if (displayPrompt) {
      messageOptions.displayPrompt = displayPrompt;
    }
    
    if (tempFilePaths && tempFilePaths.length > 0) {
      messageOptions.attachments = tempFilePaths.map(p => ({ type: 'file', path: p }));
    }
    
    type SDKEventCallback = (event: SessionEvent) => void;

    const SWARM_TIMEOUT_MS = 15 * 60 * 1000;
    const meta = getSessionMeta(sessionId);
    const baseTimeout = meta?.kind === 'swarm' || meta?.kind === 'agent'
      ? SWARM_TIMEOUT_MS
      : DISPATCH_TIMEOUT_MS;

    let retried = false;
    let unsubscribe: () => void = () => {};

    watchdog = createWatchdog({
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
            abortOriginal: () => sessionManager.abortStaleGeneration(sessionId),
            isCompleted: () => dispatchCompleted,
            dropStaleSession: (id) => sessionManager.dropStaleSession(id),
            ensureClientHealthy: () => sessionManager.ensureClientHealthy(),
            resume: () => sessionManager.resume(sessionId, sessionState.getSessionConfig()).then(() => {}),
            getSession: (id) => sessionManager.getSession(id),
            beforeSend,
            resetWatchdog: () => watchdog?.reset(),
            unsubscribe,
          }).then((newUnsubscribe) => {
            if (newUnsubscribe) {
              unsubscribe = newUnsubscribe;
            } else if (!dispatchCompleted) {
              // A null result means we did NOT resend. If the dispatch already
              // completed, the original finished on its own — nothing to report.
              console.error(`[DISPATCH:${rid}] Retry failed`);
              onEvent({ type: 'session.error', data: { message: 'Session not responding after retry', restorePrompt: true } });
              void completeDispatch('retry-failed');
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
        void completeDispatch('timeout');
        unsubscribe();
      },
    });
    
    const handleEvent = (event: SessionEvent) => {
      if (dispatchCompleted) return;
      watchdog?.notifyEvent(event.type);
      dispatchState.notifyActivity(sessionId, event.type);

      // Forward the SDK event to the client (no transformation — caco.* events
      // are emitted directly by their tool handlers).
      onEvent(event);

      // Server-side side-effects: intent capture, auto-context, usage,
      // reload signal. Extracted so each event hook stays inspectable.
      applyDispatchEventEffects(sessionId, event, {
        autoAddFileContext,
        onEvent,
        cacoToolNames: () => new Set(sessionManager.getCacoToolCatalog().map(t => t.name)),
      });

      if (event.type === 'session.idle' || event.type === 'session.error') {
        const wasIdle = event.type === 'session.idle';
        void completeDispatch(event.type).then(() => {
          // After the dispatch is fully torn down (session no longer busy), route
          // the idle through the single idle authority (spec-idle-authority): it
          // classifies false idle (reveal → auto-continue, suppress completion
          // signals) vs real idle (mark unobserved + herd wake + quota). An
          // errored dispatch is never an idle, so nothing propagates.
          if (wasIdle) handleIdle(sessionId, needsObservation ?? false, effectiveCorrelationId);
        });
        unsubscribe();
      }
    };

    unsubscribe = (session as unknown as { on: (cb: SDKEventCallback) => () => void }).on(handleEvent);
    watchdog?.reset();
    
    // Send message — fire-and-forget. The send RPC may outlive the actual
    // session processing (SDK can be slow to ack), so we don't await it.
    // Events stream via session.on(handleEvent) regardless.
    // Note: startDispatch is already done at the top of this function.
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: true } });
    
    console.log(`[DISPATCH:${rid}] Sending to SDK for session ${sessionId}`);
    try {
      if (beforeSend) await beforeSend();
      const sendPromise = sessionManager.sendStream(sessionId, prompt, messageOptions);
      sendStarted = true;

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
            abortOriginal: () => sessionManager.abortStaleGeneration(sessionId),
            isCompleted: () => dispatchCompleted,
            dropStaleSession: (id) => sessionManager.dropStaleSession(id),
            ensureClientHealthy: () => sessionManager.ensureClientHealthy(),
            resume: () => sessionManager.resume(sessionId, sessionState.getSessionConfig()).then(() => {}),
            getSession: (id) => sessionManager.getSession(id),
            beforeSend,
            resetWatchdog: () => watchdog?.reset(),
            unsubscribe,
          }).then((newUnsubscribe) => {
            if (newUnsubscribe) {
              unsubscribe = newUnsubscribe;
            } else if (!dispatchCompleted) {
              // A null result means we did NOT resend. If the dispatch already
              // completed, the original finished on its own — nothing to report.
              console.error(`[DISPATCH:${rid}] Retry failed`);
              onEvent({ type: 'session.error', data: { message: 'Session not responding after retry', restorePrompt: true } });
              void completeDispatch('retry-failed');
            }
          });
          return;
        }

        if (isSessionLost) {
          onEvent({ type: 'session.error', data: { message: 'Session expired - please start a new session', restorePrompt: true } });
        } else {
          onEvent({ type: 'session.error', data: { message, restorePrompt: true } });
        }

        void completeDispatch('send error');
        unsubscribe();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DISPATCH:${rid}] Send error:`, message);
      onEvent({ type: 'session.error', data: { message, restorePrompt: true } });
      void completeDispatch('send error');
      unsubscribe();
      throw err;
    }
    
    // Send succeeded — function resolves. Event streaming continues in background.
    
  } catch (error) {
    if (!dispatchCompleted) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DISPATCH:${rid}] Outer error:`, message);
      onEvent({ type: 'session.error', data: { message, restorePrompt: true } });
      await completeDispatch('outer-error');
      if (!sendStarted) throw error;
    }
  }
}

/**
 * POST /api/sessions/:sessionId/cancel - Cancel current streaming
 */
router.post('/sessions/:sessionId/cancel', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  updateSessionMeta(sessionId, meta => {
    if (meta.responseOptions) meta.responseOptions = undefined;
  }, { createIfMissing: false });
  
  const { forced } = await sessionManager.cancelSession(sessionId);
  if (forced) {
    broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
  }
  
  res.json({ ok: true, forced });
});

export { router };

const MAX_CONTEXT_FILES = 10;

/**
 * Auto-add file paths to session context when agent uses edit/create tools.
 * Keeps the last 3 files in the context footer. Newest at end, oldest evicted.
 */
function autoAddFileContext(
  sessionId: string,
  path: string
): void {
  let broadcastContext: Record<string, string[]> | undefined;
  const persisted = updateSessionMeta(sessionId, meta => {
    const context = { ...((meta.context as Record<string, string[]> | undefined) ?? {}) };
    let files = context.files ?? [];

    // Move to end if already present, otherwise append
    files = files.filter(f => f !== path);
    files.push(path);

    // Keep only the last N files
    if (files.length > MAX_CONTEXT_FILES) {
      files = files.slice(-MAX_CONTEXT_FILES);
    }

    context.files = files;
    broadcastContext = context;
    meta.context = context;
  }, { createIfMissing: false });
  if (!persisted || !broadcastContext) return;

  broadcastEvent(sessionId, {
    type: 'caco.context',
    data: { reason: 'changed', context: broadcastContext, setName: 'files' }
  } as unknown as SessionEvent);
}
