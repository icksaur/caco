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

// Get current session info
// Stateless: accepts ?sessionId to query specific session
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

// List all sessions grouped by cwd
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

// Create a new session (RESTful replacement for POST /message with newChat: true)
// Returns sessionId that client uses for subsequent POST /sessions/:id/messages
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

// Switch to a different session
// Accepts X-Client-ID header for multi-client isolation
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

// Delete a session
// Accepts X-Client-ID header for multi-client isolation
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const clientId = req.headers['x-client-id'] as string | undefined;
  
  try {
    const wasActive = await sessionState.deleteSession(sessionId, clientId);
    res.json({ success: true, wasActive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

export default router;
