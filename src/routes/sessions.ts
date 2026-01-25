/**
 * Session Routes
 * 
 * API endpoints for session management:
 * - GET /api/session - Current session info
 * - GET /api/sessions - List all sessions
 * - POST /api/sessions/new - Prepare new chat
 * - POST /api/sessions/:id/resume - Switch session
 * - DELETE /api/sessions/:id - Delete session
 */

import { Router, Request, Response } from 'express';
import { existsSync, statSync } from 'fs';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';

const router = Router();

// Get current session info
router.get('/session', async (_req: Request, res: Response) => {
  const hasMessages = await sessionState.hasMessages();
  
  res.json({
    sessionId: sessionState.activeSessionId,
    cwd: process.cwd(),
    isActive: sessionState.activeSessionId 
      ? sessionManager.isActive(sessionState.activeSessionId) 
      : false,
    hasMessages
  });
});

// List all sessions grouped by cwd
router.get('/sessions', (_req: Request, res: Response) => {
  const grouped = sessionManager.listAllGrouped();
  res.json({
    activeSessionId: sessionState.activeSessionId,
    currentCwd: process.cwd(),
    grouped
  });
});

// Create/prepare a new chat
router.post('/sessions/new', async (req: Request, res: Response) => {
  try {
    const cwd = (req.body.cwd as string) || process.cwd();
    
    // Validate path
    if (!existsSync(cwd)) {
      return res.status(400).json({ error: `Path does not exist: ${cwd}` });
    }
    if (!statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `Path is not a directory: ${cwd}` });
    }
    
    await sessionState.prepareNewChat(cwd);
    res.json({ success: true, cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Switch to a different session
router.post('/sessions/:sessionId/resume', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  try {
    const newSessionId = await sessionState.switchSession(sessionId);
    res.json({ success: true, sessionId: newSessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Delete a session
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  try {
    const wasActive = await sessionState.deleteSession(sessionId);
    res.json({ success: true, wasActive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

export default router;
