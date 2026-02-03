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

router.get('/sessions', (_req: Request, res: Response) => {
  const grouped = sessionManager.listAllGrouped();
  const models = sessionManager.getModels();
  
  res.json({
    activeSessionId: sessionState.activeSessionId,
    currentCwd: process.cwd(),
    grouped,
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      cost: m.billing?.multiplier ?? 1
    }))
  });
});

router.post('/sessions', async (req: Request, res: Response) => {
  const { cwd, model } = req.body as { cwd?: string; model?: string };
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
    const newSessionId = await sessionState.switchSession(sessionId, clientId);
    const cwd = sessionState.preferences.lastCwd;
    res.json({ success: true, sessionId: newSessionId, cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
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
    res.json({ success: true, wasActive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

/**
 * GET /api/sessions/:sessionId/state
 * Get session state (for agent-to-agent polling)
 * Returns: status (idle/inactive), cwd
 */
router.get('/sessions/:sessionId/state', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  const cwd = sessionManager.getSessionCwd(sessionId);
  if (!cwd) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }
  
  const isActive = sessionManager.isActive(sessionId);
  
  res.json({
    sessionId,
    status: isActive ? 'idle' : 'inactive',
    cwd,
    isActive
  });
});

export default router;
