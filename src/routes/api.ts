/**
 * API Routes
 * 
 * General API endpoints:
 * - GET /api/models - Get available models from SDK
 * - GET /api/preferences - Get preferences
 * - POST /api/preferences - Update preferences
 * - GET /api/outputs/:id - Get display output
 * - GET /api/history - Get conversation history
 * - GET /api/debug/messages - Debug endpoint
 */

import { Router, Request, Response } from 'express';
import { CopilotClient } from '@github/copilot-sdk';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../storage.js';
import { setAppletUserState, getAppletUserState, setApplet, setActiveSlug } from '../applet-state.js';
import { listApplets, loadApplet } from '../applet-store.js';

const router = Router();

// Cache models to avoid repeated SDK calls
let cachedModels: Array<{ id: string; name: string; multiplier: number }> | null = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Get available models from SDK
router.get('/models', async (_req: Request, res: Response) => {
  try {
    // Return cached models if fresh
    if (cachedModels && Date.now() - modelsCacheTime < MODELS_CACHE_TTL) {
      return res.json({ models: cachedModels });
    }
    
    // Create temporary client to list models
    const client = new CopilotClient({ cwd: process.cwd() });
    await client.start();
    
    try {
      const sdkModels = await (client as unknown as { listModels(): Promise<Array<{
        id: string;
        name: string;
        billing?: { multiplier: number };
      }>> }).listModels();
      
      // Transform to our format
      cachedModels = sdkModels.map(m => ({
        id: m.id,
        name: m.name,
        multiplier: m.billing?.multiplier ?? 1
      }));
      modelsCacheTime = Date.now();
      
      console.log(`[MODELS] Fetched ${cachedModels.length} models from SDK:`, cachedModels.map(m => m.id));
      
      res.json({ models: cachedModels });
    } finally {
      await client.stop();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[MODELS] Failed to fetch models:', message);
    res.status(500).json({ error: message, models: [] });
  }
});

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
      createdAt: metadata.createdAt
    });
  }
  
  // Raw data response
  res.send(data);
});

// Get conversation history
router.get('/history', async (_req: Request, res: Response) => {
  try {
    // Use sessionIdForHistory - works for both active and pending-resume sessions
    const sessionId = sessionState.sessionIdForHistory;
    if (!sessionId) {
      return res.send('');
    }
    
    const events = await sessionManager.getHistory(sessionId);
    
    // Extract output IDs from tool.execution_complete events
    // Map: index of tool completion → output IDs
    const outputsByIndex = new Map<number, string[]>();
    events.forEach((evt, idx) => {
      if (evt.type === 'tool.execution_complete') {
        const result = (evt.data as { result?: { content?: string } })?.result;
        if (result?.content) {
          // Parse [output:xxx] markers from tool result
          const matches = result.content.matchAll(/\[output:([^\]]+)\]/g);
          const ids = [...matches].map(m => m[1]);
          if (ids.length > 0) {
            outputsByIndex.set(idx, ids);
          }
        }
      }
    });
    
    // Build HTML with output markers injected
    const htmlParts: string[] = [];
    let pendingOutputs: string[] = [];
    
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      
      // Collect outputs from tool completions
      if (outputsByIndex.has(i)) {
        pendingOutputs.push(...outputsByIndex.get(i)!);
      }
      
      // Render messages
      if (evt.type === 'user.message' || evt.type === 'assistant.message') {
        const isUser = evt.type === 'user.message';
        const content = (evt.data as { content?: string })?.content || '';
        
        if (!content && pendingOutputs.length === 0) continue;
        
        if (isUser) {
          htmlParts.push(`<div class="message user">${escapeHtml(content)}</div>`);
        } else {
          // Inject output markers as data attribute for client to restore
          const outputAttr = pendingOutputs.length > 0 
            ? ` data-outputs="${pendingOutputs.join(',')}"` 
            : '';
          htmlParts.push(
            `<div class="message assistant" data-markdown${outputAttr}>` +
            `<div class="markdown-content">${escapeHtml(content)}</div></div>`
          );
          pendingOutputs = []; // Clear after attaching to message
        }
      }
    }
    
    res.send(htmlParts.join('\n'));
  } catch (error) {
    console.error('Error fetching history:', error);
    res.send('');
  }
});

// Debug: raw message structure
router.get('/debug/messages', async (_req: Request, res: Response) => {
  try {
    const sessionId = sessionState.sessionIdForHistory;
    if (!sessionId) {
      return res.json({ count: 0, messages: [] });
    }
    
    const events = await sessionManager.getHistory(sessionId);
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

// ============================================================
// Applet State Endpoints (Phase 2)
// ============================================================

/**
 * POST /api/applet/state - Receive state updates from applet JS
 * Client-side applet calls setAppletState({...}) which hits this endpoint
 */
router.post('/applet/state', (req: Request, res: Response) => {
  const state = req.body;
  if (!state || typeof state !== 'object') {
    res.status(400).json({ error: 'Invalid state object' });
    return;
  }
  setAppletUserState(state);
  res.json({ ok: true });
});

/**
 * GET /api/applet/state - Get current applet state (for debugging)
 */
router.get('/applet/state', (_req: Request, res: Response) => {
  res.json({ state: getAppletUserState() });
});

// ============================================================
// Applet Browser Endpoints (Phase 3)
// ============================================================

const programCwd = process.cwd();

/**
 * GET /api/applets - List all saved applets
 * Used by applet browser to show available applets
 */
router.get('/applets', async (_req: Request, res: Response) => {
  try {
    const applets = await listApplets(programCwd);
    res.json({
      applets: applets.map(a => ({
        slug: a.slug,
        name: a.name,
        description: a.description || null,
        updatedAt: a.updatedAt,
        paths: a.paths
      }))
    });
  } catch (error) {
    console.error('[API] Failed to list applets:', error);
    res.status(500).json({ error: 'Failed to list applets' });
  }
});

/**
 * GET /api/applets/:slug - Get applet content
 * Returns HTML/JS/CSS for client-side execution
 */
router.get('/applets/:slug', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  
  try {
    const stored = await loadApplet(programCwd, slug);
    
    if (!stored) {
      res.status(404).json({ error: `Applet "${slug}" not found` });
      return;
    }
    
    res.json({
      slug,
      title: stored.meta.name,
      html: stored.html,
      js: stored.js || null,
      css: stored.css || null,
      meta: stored.meta
    });
  } catch (error) {
    console.error(`[API] Failed to load applet "${slug}":`, error);
    res.status(500).json({ error: 'Failed to load applet' });
  }
});

/**
 * POST /api/applets/:slug/load - Load applet and update server state
 * Called by applet browser to switch to a different applet
 * Updates server-side activeSlug so get_applet_state reflects correct applet
 */
router.post('/applets/:slug/load', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  
  try {
    const stored = await loadApplet(programCwd, slug);
    
    if (!stored) {
      res.status(404).json({ error: `Applet "${slug}" not found` });
      return;
    }
    
    // Update server-side state
    setApplet({
      html: stored.html,
      js: stored.js,
      css: stored.css,
      title: stored.meta.name
    }, slug);
    
    // Return content for client-side execution
    res.json({
      ok: true,
      slug,
      title: stored.meta.name,
      html: stored.html,
      js: stored.js || null,
      css: stored.css || null
    });
  } catch (error) {
    console.error(`[API] Failed to load applet "${slug}":`, error);
    res.status(500).json({ error: 'Failed to load applet' });
  }
});

export default router;
