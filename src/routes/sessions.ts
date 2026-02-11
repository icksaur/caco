/**
 * Session Routes
 * 
 * API endpoints for session management:
 * - GET /api/session - Current session info (accepts ?sessionId for stateless)
 * - GET /api/sessions - List all sessions
 * - POST /api/sessions - Create new session (RESTful)
 * - POST /api/sessions/:id/resume - Switch to existing session
 * - DELETE /api/sessions/:id - Delete session
 */

import { Router, Request, Response } from 'express';
import { existsSync, statSync } from 'fs';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getScheduleForSession } from '../schedule-store.js';
import { getSessionMeta, setSessionMeta } from '../storage.js';
import { unobservedTracker } from '../unobserved-tracker.js';
import { broadcastGlobalEvent, broadcastEvent } from './websocket.js';
import { mergeContextSet, KNOWN_SET_NAMES } from '../context-tools.js';

const router = Router();

router.get('/session', async (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || sessionState.activeSessionId;
  
  if (!sessionId) {
    return res.json({
      sessionId: null,
      cwd: process.cwd(),
      isActive: false,
      hasMessages: false
    });
  }
  
  const isActive = sessionManager.isActive(sessionId);
  const hasMessages = sessionManager.hasMessages(sessionId);
  const cwd = sessionManager.getSessionCwd(sessionId);
  
  res.json({
    sessionId,
    cwd: cwd || process.cwd(),
    isActive,
    hasMessages
  });
});

router.get('/sessions', async (_req: Request, res: Response) => {
  const grouped = sessionManager.listAllGrouped();
  const models = sessionManager.getModels();
  
  // Get unobserved count from tracker (O(1)) and enrich with schedule info
  const unobservedCount = unobservedTracker.getCount();
  for (const sessions of Object.values(grouped)) {
    for (const session of sessions) {
      // Look up schedule info for this session
      const scheduleInfo = await getScheduleForSession(session.sessionId);
      if (scheduleInfo) {
        session.scheduleSlug = scheduleInfo.slug;
        session.scheduleNextRun = scheduleInfo.nextRun;
      } else {
        session.scheduleSlug = null;
        session.scheduleNextRun = null;
      }
    }
  }
  
  res.json({
    activeSessionId: sessionState.activeSessionId,
    currentCwd: process.cwd(),
    grouped,
    unobservedCount,
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      cost: m.billing?.multiplier ?? 1
    }))
  });
});

router.post('/sessions', async (req: Request, res: Response) => {
  const { cwd, model, description } = req.body as { cwd?: string; model?: string; description?: string };
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  const sessionCwd = cwd || process.cwd();
  
  // Validate path
  if (!existsSync(sessionCwd)) {
    return res.status(400).json({ error: `Path does not exist: ${sessionCwd}` });
  }
  if (!statSync(sessionCwd).isDirectory()) {
    return res.status(400).json({ error: `Path is not a directory: ${sessionCwd}` });
  }
  
  try {
    // Create new session (forces new, ignoring any existing active session)
    const sessionId = await sessionState.ensureSession(model, true, sessionCwd, clientId);
    const actualCwd = sessionManager.getSessionCwd(sessionId);
    
    // Set description if provided
    if (description) {
      setSessionMeta(sessionId, { name: description });
    }
    
    // Broadcast session list change for all clients to refresh
    broadcastGlobalEvent({ 
      type: 'session.listChanged', 
      data: { reason: 'created', sessionId } 
    });
    
    res.json({ 
      sessionId, 
      cwd: actualCwd || sessionCwd,
      model: model || 'default'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.post('/sessions/:sessionId/resume', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  try {
    const result = await sessionState.switchSession(sessionId, clientId);
    const cwd = sessionState.preferences.lastCwd;
    const isBusy = sessionManager.isBusy(result.sessionId);
    
    // NOTE: We do NOT mark observed here - that happens when user sees session.idle
    
    res.json({ 
      success: true, 
      sessionId: result.sessionId, 
      cwd, 
      isBusy,
      // If CWD was missing, tell frontend what fallback was used
      cwdFallback: result.usedFallbackCwd
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/sessions/:sessionId/observe
 * Mark session as observed (user has seen the completed response)
 * Called by client when session.idle arrives while viewing that session
 */
router.post('/sessions/:sessionId/observe', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  // Validate session exists
  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  // Mark as observed via tracker (handles persistence and broadcast)
  const wasUnobserved = unobservedTracker.markObserved(sessionId);
  
  res.json({ success: true, wasUnobserved, unobservedCount: unobservedTracker.getCount() });
});

router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  // Prevent deletion of busy sessions
  if (sessionManager.isBusy(sessionId)) {
    return res.status(400).json({ 
      error: 'Cannot delete session while it is processing',
      code: 'SESSION_BUSY'
    });
  }
  
  try {
    const wasActive = await sessionState.deleteSession(sessionId, clientId);
    
    // Broadcast session list change for all clients to refresh
    broadcastGlobalEvent({ 
      type: 'session.listChanged', 
      data: { reason: 'deleted', sessionId } 
    });
    
    res.json({ success: true, wasActive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

/**
 * PATCH /api/sessions/:sessionId
 * Update session metadata (custom name, environment hint, context)
 */
router.patch('/sessions/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { name, envHint, setContext } = req.body as { 
    name?: string; 
    envHint?: string;
    setContext?: { setName: string; items: string[]; mode?: 'replace' | 'merge' };
  };
  
  // Validate session exists
  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  // Merge with existing meta to preserve fields not being updated
  const existing = getSessionMeta(sessionId) ?? { name: '' };
  const updated = {
    ...existing,
    ...(name !== undefined && { name }),
    ...(envHint !== undefined && { envHint }),
  };
  
  // Handle setContext if provided
  if (setContext) {
    const { setName, items, mode = 'replace' } = setContext;
    
    // Warn for unknown set names (but allow them)
    if (!KNOWN_SET_NAMES.has(setName)) {
      console.warn(`[CONTEXT] Unknown set name: ${setName}`);
    }
    
    const context: Record<string, string[]> = updated.context ?? {};
    const merged = mergeContextSet(context[setName] ?? [], items, mode);
    updated.context = { ...context, [setName]: merged };
    
    // Broadcast context change to clients
    broadcastEvent(sessionId, {
      type: 'caco.context',
      data: { reason: 'changed', context: updated.context, setName }
    });
  }
  
  setSessionMeta(sessionId, updated);
  
  // Broadcast session list change if name changed (for clients to refresh)
  if (name !== undefined) {
    broadcastGlobalEvent({ 
      type: 'session.listChanged', 
      data: { reason: 'renamed', sessionId } 
    });
  }
  
  res.json({ success: true });
});

/**
 * GET /api/sessions/:sessionId/state
 * Get session state (for agent-to-agent polling)
 * Returns: status (idle/inactive), cwd, model
 */
router.get('/sessions/:sessionId/state', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  const isActive = sessionManager.isActive(sessionId);
  const meta = getSessionMeta(sessionId);
  const model = meta?.model || null;
  
  res.json({
    sessionId,
    status: isActive ? 'idle' : 'inactive',
    cwd,
    model,
    isActive
  });
});

export default router;
