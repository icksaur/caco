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
import express from 'express';
import { CopilotClient } from '@github/copilot-sdk';
import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../storage.js';
import { setAppletUserState, getAppletUserState, clearAppletUserState } from '../applet-state.js';
import { listApplets, loadApplet } from '../applet-store.js';
import { getUsage } from '../usage-state.js';
import { MODEL_CACHE_TTL_MS, MAX_FILE_SIZE_BYTES, MAX_LEGACY_FILE_SIZE_BYTES } from '../config.js';
import { validatePath } from '../path-utils.js';
import { apiError } from '../api-error.js';

const router = Router();

const TEMP_DIR = join(homedir(), '.caco', 'tmp');

let cachedModels: Array<{ id: string; name: string; multiplier: number }> | null = null;
let modelsCacheTime = 0;

router.get('/models', async (_req: Request, res: Response) => {
  try {
    // Return cached models if fresh
    if (cachedModels && Date.now() - modelsCacheTime < MODEL_CACHE_TTL_MS) {
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

router.get('/usage', (_req: Request, res: Response) => {
  const usage = getUsage();
  res.json({ usage });
});

/**
 * POST /api/tmpfile - Write temporary file to ~/.caco/tmp/
 * Body: { data: string, mimeType?: string, filename?: string }
 *
 * For applets to save images/files that the agent can then view.
 * Returns absolute path for use with agent's view tool.
 */
router.post('/tmpfile', express.json({ limit: '10mb' }), async (req: Request, res: Response) => {
  const { data, mimeType, filename } = req.body as { data?: string; mimeType?: string; filename?: string };
  
  if (!data) {
    res.status(400).json({ error: 'data is required' });
    return;
  }
  
  try {
    // Parse data URL or use raw base64
    let base64Data: string;
    let detectedMime: string;
    
    if (data.startsWith('data:')) {
      // Parse data URL: data:image/png;base64,iVBOR...
      const matches = data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        res.status(400).json({ error: 'Invalid data URL format' });
        return;
      }
      detectedMime = matches[1];
      base64Data = matches[2];
    } else {
      // Raw base64, require mimeType
      base64Data = data;
      detectedMime = mimeType || 'application/octet-stream';
    }
    
    // Determine file extension from mime type
    const extMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'application/json': 'json',
    };
    const ext = extMap[detectedMime] || 'bin';
    
    // Generate filename if not provided
    const finalFilename = filename || `${randomUUID()}.${ext}`;
    
    // Ensure tmp directory exists
    await mkdir(TEMP_DIR, { recursive: true });
    
    // Write file
    const fullPath = join(TEMP_DIR, finalFilename);
    const buffer = Buffer.from(base64Data, 'base64');
    await writeFile(fullPath, buffer);
    
    res.json({ 
      ok: true, 
      path: fullPath,
      filename: finalFilename,
      size: buffer.length,
      mimeType: detectedMime
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TMPFILE] Error:', message);
    res.status(500).json({ error: message });
  }
});

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

router.get('/preferences', (_req: Request, res: Response) => {
  res.json(sessionState.preferences);
});

router.post('/preferences', async (req: Request, res: Response) => {
  const updated = await sessionState.updatePreferences(req.body);
  res.json(updated);
});

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

const programCwd = process.cwd();

/**
 * GET /api/applets - List all saved applets
 * Used by applet browser to show available applets
 */
router.get('/applets', async (_req: Request, res: Response) => {
  try {
    const applets = await listApplets();
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
    const stored = await loadApplet(slug);
    
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
 * POST /api/applets/:slug/load - Load applet content
 * Called by applet browser to switch to a different applet
 * Clears user state since applet is changing
 */
router.post('/applets/:slug/load', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  
  try {
    const stored = await loadApplet(slug);
    
    if (!stored) {
      res.status(404).json({ error: `Applet "${slug}" not found` });
      return;
    }
    
    // Clear user state since applet is changing
    clearAppletUserState();
    
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
  const requestedPath = (req.query.path as string) || '.';
  
  try {
    const validation = validatePath(programCwd, requestedPath);
    if (!validation.valid) {
      return apiError.forbidden(res, validation.error);
    }
    
    const entries = await readdir(validation.resolved, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(e => !e.name.startsWith('.')) // Hide hidden files
        .map(async (entry) => {
          const entryPath = join(validation.resolved, entry.name);
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
      path: validation.relative,
      cwd: programCwd,
      files 
    });
  } catch (error) {
    console.error('[API] Failed to list files:', error);
    return apiError.internal(res, 'Failed to list directory');
  }
});

/**
 * GET /api/file - Serve file content with proper Content-Type
 * Query params:
 *   path: relative path from programCwd
 * Returns: raw file content with appropriate Content-Type header
 */
router.get('/file', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    return apiError.badRequest(res, 'path parameter required');
  }
  
  try {
    const validation = validatePath(programCwd, requestedPath);
    if (!validation.valid) {
      return apiError.forbidden(res, validation.error);
    }
    
    const stats = await stat(validation.resolved);
    
    if (stats.isDirectory()) {
      return apiError.badRequest(res, 'Cannot serve directory');
    }
    
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({ ok: false, error: `File too large (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)` });
      return;
    }
    
    // Determine content type from extension
    const ext = validation.resolved.split('.').pop()?.toLowerCase() || '';
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
    
    const fileData = await readFile(validation.resolved);
    res.setHeader('Content-Type', contentType + (isText ? '; charset=utf-8' : ''));
    res.setHeader('Content-Length', stats.size);
    res.send(fileData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiError.notFound(res, 'File not found');
    } else {
      console.error('[API] Failed to serve file:', error);
      return apiError.internal(res, 'Failed to serve file');
    }
  }
});

/**
 * GET /api/files/read - Read file content (LEGACY - use GET /api/file instead)
 * Query params:
 *   path: relative path from programCwd
 * Returns: { path, content, size }
 * @deprecated Use GET /api/file instead
 */
router.get('/files/read', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    return apiError.badRequest(res, 'path parameter required');
  }
  
  try {
    const validation = validatePath(programCwd, requestedPath);
    if (!validation.valid) {
      return apiError.forbidden(res, validation.error);
    }
    
    const stats = await stat(validation.resolved);
    
    if (stats.isDirectory()) {
      return apiError.badRequest(res, 'Cannot read directory');
    }
    
    if (stats.size > MAX_LEGACY_FILE_SIZE_BYTES) {
      return apiError.badRequest(res, `File too large (max ${MAX_LEGACY_FILE_SIZE_BYTES / 1024}KB)`);
    }
    
    const content = await readFile(validation.resolved, 'utf-8');
    res.json({ ok: true, path: validation.relative, content, size: stats.size });
  } catch (error) {
    console.error('[API] Failed to read file:', error);
    return apiError.internal(res, 'Failed to read file');
  }
});

/**
 * PUT /api/files/*path - Write file content
 * Path: file path relative to workspace (e.g., PUT /api/files/src/app.ts)
 * Body: raw file content (text/plain)
 * Locked to programCwd - cannot escape
 */
router.put('/files/*path', express.text({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response) => {
  // Extract path from URL (everything after /files/)
  const pathSegments = req.params.path as unknown as string[];
  const requestedPath = pathSegments.join('/');
  
  if (!requestedPath) {
    return apiError.badRequest(res, 'file path required in URL');
  }
  
  const content = req.body;
  if (typeof content !== 'string') {
    return apiError.badRequest(res, 'request body required');
  }
  
  try {
    const validation = validatePath(programCwd, requestedPath);
    if (!validation.valid) {
      return apiError.forbidden(res, validation.error);
    }
    
    // Ensure parent directory exists
    const parentDir = dirname(validation.resolved);
    await mkdir(parentDir, { recursive: true });
    
    await writeFile(validation.resolved, content, 'utf-8');
    res.json({ ok: true, path: validation.relative, size: content.length });
  } catch (error) {
    console.error('[API] Failed to write file:', error);
    return apiError.internal(res, 'Failed to write file');
  }
});

/**
 * POST /api/files/write - Write file content (LEGACY - use PUT /api/files/* instead)
 * Body: { path: string, content: string }
 * @deprecated Use PUT /api/files/* instead
 */
router.post('/files/write', async (req: Request, res: Response) => {
  const { path: requestedPath, content } = req.body;
  
  if (!requestedPath) {
    return apiError.badRequest(res, 'path parameter required');
  }
  
  if (typeof content !== 'string') {
    return apiError.badRequest(res, 'content parameter required');
  }
  
  try {
    const validation = validatePath(programCwd, requestedPath);
    if (!validation.valid) {
      return apiError.forbidden(res, validation.error);
    }
    
    await writeFile(validation.resolved, content, 'utf-8');
    res.json({ ok: true, path: validation.relative, size: content.length });
  } catch (error) {
    console.error('[API] Failed to write file:', error);
    return apiError.internal(res, 'Failed to write file');
  }
});

export default router;
