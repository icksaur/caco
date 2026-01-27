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
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
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
    // Group consecutive assistant messages into single bubbles (multi-turn responses)
    const htmlParts: string[] = [];
    let pendingOutputs: string[] = [];
    let pendingAssistantContents: string[] = [];
    let pendingAssistantOutputs: string[] = [];
    
    const flushAssistantBubble = () => {
      if (pendingAssistantContents.length === 0 && pendingAssistantOutputs.length === 0) return;
      
      const outputAttr = pendingAssistantOutputs.length > 0 
        ? ` data-outputs="${pendingAssistantOutputs.join(',')}"` 
        : '';
      
      // Join all turn contents with markdown divs
      const contentDivs = pendingAssistantContents
        .map(c => `<div class="markdown-content">${escapeHtml(c)}</div>`)
        .join('\n');
      
      htmlParts.push(
        `<div class="message assistant" data-markdown${outputAttr}>` +
        contentDivs +
        `</div>`
      );
      
      pendingAssistantContents = [];
      pendingAssistantOutputs = [];
    };
    
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
          // Flush any pending assistant bubble before user message
          flushAssistantBubble();
          htmlParts.push(`<div class="message user">${escapeHtml(content)}</div>`);
        } else {
          // Accumulate assistant content and outputs
          if (content) pendingAssistantContents.push(content);
          pendingAssistantOutputs.push(...pendingOutputs);
          pendingOutputs = [];
        }
      }
    }
    
    // Flush final assistant bubble
    flushAssistantBubble();
    
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

/**
 * GET /api/files - List files in a directory
 * Query params:
 *   path: relative path from programCwd (default: "")
 * Returns: { path, files: [{ name, type, size }] }
 * Locked to programCwd - cannot escape
 */
router.get('/files', async (req: Request, res: Response) => {
  const requestedPath = (req.query.path as string) || '';
  
  try {
    // Resolve and validate path is within programCwd
    const fullPath = resolve(programCwd, requestedPath);
    const relativePath = relative(programCwd, fullPath);
    
    // Security: prevent escaping programCwd
    if (relativePath.startsWith('..') || resolve(programCwd, relativePath) !== fullPath) {
      res.status(403).json({ error: 'Access denied: path outside workspace' });
      return;
    }
    
    const entries = await readdir(fullPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(e => !e.name.startsWith('.')) // Hide hidden files
        .map(async (entry) => {
          const entryPath = join(fullPath, entry.name);
          const stats = await stat(entryPath).catch(() => null);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats?.size || 0
          };
        })
    );
    
    // Sort: directories first, then alphabetically
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    
    res.json({ 
      path: relativePath || '.',
      cwd: programCwd,
      files 
    });
  } catch (error) {
    console.error('[API] Failed to list files:', error);
    res.status(500).json({ error: 'Failed to list directory' });
  }
});

/**
 * GET /api/file - Serve file content with proper Content-Type
 * Query params:
 *   path: relative path from programCwd
 * Returns: raw file content with appropriate Content-Type header
 * Limited to 10MB files
 */
router.get('/file', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    res.status(400).send('path parameter required');
    return;
  }
  
  try {
    // Resolve and validate path
    const fullPath = resolve(programCwd, requestedPath);
    const relativePath = relative(programCwd, fullPath);
    
    if (relativePath.startsWith('..') || resolve(programCwd, relativePath) !== fullPath) {
      res.status(403).send('Access denied: path outside workspace');
      return;
    }
    
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      res.status(400).send('Cannot serve directory');
      return;
    }
    
    if (stats.size > 10 * 1024 * 1024) {
      res.status(413).send('File too large (max 10MB)');
      return;
    }
    
    // Determine content type from extension
    const ext = fullPath.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: Record<string, string> = {
      // Images
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      // Text
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      css: 'text/css',
      js: 'text/javascript',
      ts: 'text/typescript',
      json: 'application/json',
      xml: 'application/xml',
      // Code
      py: 'text/x-python',
      rb: 'text/x-ruby',
      go: 'text/x-go',
      rs: 'text/x-rust',
      java: 'text/x-java',
      c: 'text/x-c',
      cpp: 'text/x-c++',
      h: 'text/x-c',
      sh: 'text/x-shellscript',
      yaml: 'text/yaml',
      yml: 'text/yaml',
      toml: 'text/toml',
      // Documents
      pdf: 'application/pdf',
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isText = contentType.startsWith('text/') || contentType === 'application/json';
    
    const fileData = await readFile(fullPath);
    res.setHeader('Content-Type', contentType + (isText ? '; charset=utf-8' : ''));
    res.setHeader('Content-Length', stats.size);
    res.send(fileData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).send('File not found');
    } else {
      console.error('[API] Failed to serve file:', error);
      res.status(500).send('Failed to serve file');
    }
  }
});

/**
 * GET /api/files/read - Read file content (LEGACY - use GET /api/file instead)
 * Query params:
 *   path: relative path from programCwd
 * Returns: { path, content, size }
 * Limited to 100KB files
 */
router.get('/files/read', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    res.status(400).json({ error: 'path parameter required' });
    return;
  }
  
  try {
    // Resolve and validate path
    const fullPath = resolve(programCwd, requestedPath);
    const relativePath = relative(programCwd, fullPath);
    
    if (relativePath.startsWith('..') || resolve(programCwd, relativePath) !== fullPath) {
      res.status(403).json({ error: 'Access denied: path outside workspace' });
      return;
    }
    
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Cannot read directory' });
      return;
    }
    
    if (stats.size > 100 * 1024) {
      res.status(400).json({ error: 'File too large (max 100KB)' });
      return;
    }
    
    const content = await readFile(fullPath, 'utf-8');
    res.json({ path: relativePath, content, size: stats.size });
  } catch (error) {
    console.error('[API] Failed to read file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

/**
 * GET /api/files/image - Serve image file (LEGACY - use GET /api/file instead)
 * Query params:
 *   path: relative path from programCwd
 * Returns: image binary with correct content-type
 * Limited to 10MB images
 */
router.get('/files/image', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    res.status(400).json({ error: 'path parameter required' });
    return;
  }
  
  try {
    // Resolve and validate path
    const fullPath = resolve(programCwd, requestedPath);
    const relativePath = relative(programCwd, fullPath);
    
    if (relativePath.startsWith('..') || resolve(programCwd, relativePath) !== fullPath) {
      res.status(403).json({ error: 'Access denied: path outside workspace' });
      return;
    }
    
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      res.status(400).json({ error: 'Cannot serve directory' });
      return;
    }
    
    if (stats.size > 10 * 1024 * 1024) {
      res.status(400).json({ error: 'Image too large (max 10MB)' });
      return;
    }
    
    // Determine content type from extension
    const ext = fullPath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon'
    };
    
    const contentType = mimeTypes[ext || ''] || 'application/octet-stream';
    
    const imageData = await readFile(fullPath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.send(imageData);
  } catch (error) {
    console.error('[API] Failed to serve image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

export default router;
