/**
 * API Routes
 * 
 * General API endpoints:
 * - GET /api/preferences - Get preferences
 * - POST /api/preferences - Update preferences
 * - GET /api/outputs/:id - Get display output
 * - GET /api/history - Get conversation history
 * - GET /api/debug/messages - Debug endpoint
 */

import { Router, Request, Response } from 'express';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../output-cache.js';

const router = Router();

// HTML escape helper
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Get preferences
router.get('/preferences', (_req: Request, res: Response) => {
  res.json(sessionState.preferences);
});

// Update preferences
router.post('/preferences', async (req: Request, res: Response) => {
  const updated = await sessionState.updatePreferences(req.body);
  res.json(updated);
});

// Get display output by ID
router.get('/outputs/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const output = getOutput(id);
  
  if (!output) {
    return res.status(404).json({ error: 'Output expired or not found' });
  }
  
  const { data, metadata } = output;
  
  // Set appropriate content type
  if (metadata.mimeType) {
    res.setHeader('Content-Type', metadata.mimeType as string);
  } else if (metadata.type === 'file' || metadata.type === 'terminal') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  
  // For JSON response with metadata
  if (req.query.format === 'json') {
    return res.json({
      id,
      data: typeof data === 'string' ? data : data.toString('base64'),
      metadata,
      createdAt: output.createdAt
    });
  }
  
  // Raw data response
  res.send(data);
});

// Get conversation history
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const activeId = sessionState.activeSessionId;
    if (!activeId) {
      return res.send('');
    }
    
    const events = await sessionManager.getHistory(activeId);
    
    // Filter to user.message and assistant.message events only
    const messages = events.filter(e => 
      e.type === 'user.message' || e.type === 'assistant.message'
    );
    
    // Convert to HTML fragments
    const html = messages.map(evt => {
      const isUser = evt.type === 'user.message';
      const content = (evt.data as { content?: string })?.content || '';
      
      if (!content) return '';
      
      if (isUser) {
        return `<div class="message user">${escapeHtml(content)}</div>`;
      } else {
        return `<div class="message assistant" data-markdown><div class="markdown-content">${escapeHtml(content)}</div></div>`;
      }
    }).filter(Boolean).join('\n');
    
    res.send(html);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.send('');
  }
});

// Debug: raw message structure
router.get('/debug/messages', async (_req: Request, res: Response) => {
  try {
    const activeId = sessionState.activeSessionId;
    if (!activeId) {
      return res.json({ count: 0, messages: [] });
    }
    
    const events = await sessionManager.getHistory(activeId);
    const msgs = events
      .filter(e => e.type === 'user.message' || e.type === 'assistant.message')
      .map(e => ({
        type: e.type,
        content: (e.data as { content?: string })?.content,
        hasToolRequests: !!(e.data as { toolRequests?: unknown[] })?.toolRequests?.length
      }));
    
    res.json({ count: msgs.length, messages: msgs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

export default router;
