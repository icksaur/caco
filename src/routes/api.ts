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
import { readdir, readFile, stat, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname, resolve, extname, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import ignore from 'ignore';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../storage.js';
import { setAppletUserState, getAppletUserState, clearAppletUserState, getActiveAppletSlug, setActiveAppletSlug } from '../applet-state.js';
import { listApplets, loadApplet } from '../applet-store.js';
import { listExtensions, getExtension } from '../extension-store.js';
import { getUsage } from '../usage-state.js';
import { MAX_FILE_SIZE_BYTES, MIME_TYPES } from '../config.js';
import { apiError } from '../api-error.js';
import { fuzzyScore } from '../utils/fuzzy-score.js';

const router = Router();

const TEMP_DIR = join(homedir(), '.caco', 'tmp');

router.get('/models', (_req: Request, res: Response) => {
  const models = sessionManager.getModels();
  res.json({
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      multiplier: m.billing?.multiplier ?? 1
    }))
  });
});

router.get('/usage', (_req: Request, res: Response) => {
  const usage = getUsage();
  res.json({ usage });
});

router.get('/themes', async (_req: Request, res: Response) => {
  try {
    const themesDir = join(process.cwd(), 'public', 'themes');
    const files = await readdir(themesDir);
    const themes = files
      .filter(f => f.endsWith('.css'))
      .map(f => {
        const id = f.replace('.css', '');
        const name = id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return { id, name };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ themes });
  } catch {
    res.json({ themes: [] });
  }
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
    
    // Determine file extension from mime type (reverse lookup from MIME_TYPES)
    const ext = Object.entries(MIME_TYPES).find(([, mime]) => mime === detectedMime)?.[0] || 'bin';
    
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
  const sessionId = req.query.sessionId as string | undefined;
  setAppletUserState(sessionId, state);
  res.json({ ok: true });
});

/**
 * GET /api/applet/state - Get current applet state (for debugging)
 */
router.get('/applet/state', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  res.json({ state: getAppletUserState(sessionId) });
});

const programCwd = process.cwd();

/**
 * GET /api/applets - List all saved applets
 * Used by applet browser to show available applets
 * Returns params schema for constructing applet URLs
 */
router.get('/applets', async (_req: Request, res: Response) => {
  try {
    const applets = await listApplets();
    res.json({
      applets: applets.map(a => ({
        slug: a.slug,
        name: a.name,
        description: a.description || null,
        params: a.params || {},
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
    
    const sessionId = req.query.sessionId as string | undefined;

    // Only clear user state if switching to a different applet
    const currentSlug = getActiveAppletSlug(sessionId);
    if (slug !== currentSlug) {
      clearAppletUserState(sessionId);
    }
    setActiveAppletSlug(sessionId, slug);
    
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

router.get('/applets/:slug/assets/:filename', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const filename = req.params.filename as string;
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }
  const { resolveAppletAsset } = await import('../applet-store.js');
  const filePath = await resolveAppletAsset(slug, filename);
  if (!filePath) { res.status(404).end(); return; }
  const ext = filename.split('.').pop()?.toLowerCase();
  const mime: Record<string, string> = { js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
  res.setHeader('Content-Type', mime[ext || ''] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const { createReadStream } = await import('fs');
  createReadStream(filePath).pipe(res);
});

/**
 * GET /api/files - List files in a directory
 * Query params:
 *   path: absolute path or relative path from programCwd (default: programCwd)
 * Returns: { path, files: [{ name, type, size }] }
 * 
 * Note: This is personal software - allows any filesystem path.
 * The agent already has full filesystem access via Copilot tools.
 */
router.get('/files', async (req: Request, res: Response) => {
  const requestedPath = (req.query.path as string) || '';
  const showDotfiles = req.query.dotfiles === '1';
  
  try {
    // Allow absolute paths directly, resolve relative paths from cwd
    const resolvedDir = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(programCwd, requestedPath || '.');
    
    const entries = await readdir(resolvedDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(e => showDotfiles || !e.name.startsWith('.'))
        .map(async (entry) => {
          const entryPath = join(resolvedDir, entry.name);
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
      path: resolvedDir,
      files 
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiError.notFound(res, 'Directory not found');
    }
    console.error('[API] Failed to list files:', error);
    return apiError.internal(res, 'Failed to list directory');
  }
});

/**
 * GET /api/file - Serve file content with proper Content-Type
 * Query params:
 *   path: absolute path or relative path from cwd
 * Returns: raw file content with appropriate Content-Type header
 * 
 * Note: This is personal software - allows any filesystem path.
 * The agent already has full filesystem access via Copilot tools.
 */
router.get('/file', async (req: Request, res: Response) => {
  const requestedPath = req.query.path as string;
  
  if (!requestedPath) {
    return apiError.badRequest(res, 'path parameter required');
  }
  
  try {
    // Allow absolute paths directly, resolve relative paths from cwd
    const resolvedPath = isAbsolute(requestedPath) 
      ? requestedPath 
      : resolve(programCwd, requestedPath);
    
    const stats = await stat(resolvedPath);
    
    if (stats.isDirectory()) {
      return apiError.badRequest(res, 'Cannot serve directory');
    }
    
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({ ok: false, error: `File too large (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)` });
      return;
    }
    
    const ext = resolvedPath.split('.').pop()?.toLowerCase() || '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isText = contentType.startsWith('text/') || contentType === 'application/json';
    
    const fileData = await readFile(resolvedPath);
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
 * PUT /api/files/*path - Write file content
 * Path: file path relative to workspace (e.g., PUT /api/files/src/app.ts)
 *       or absolute path (e.g., PUT /api/files//home/user/file.txt)
 * Body: raw file content (text/plain)
 * 
 * Note: This is personal software - allows any filesystem path.
 * The agent already has full filesystem access via Copilot tools.
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
    // Allow absolute paths directly, resolve relative paths from cwd
    const resolvedPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(programCwd, requestedPath);
    
    // Ensure parent directory exists
    const parentDir = dirname(resolvedPath);
    await mkdir(parentDir, { recursive: true });
    
    await writeFile(resolvedPath, content, 'utf-8');
    res.json({ ok: true, path: resolvedPath, size: content.length });
  } catch (error) {
    console.error('[API] Failed to write file:', error);
    return apiError.internal(res, 'Failed to write file');
  }
});

// --- Project Files API ---

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.cache',
  'dist', 'build', 'coverage', '.next', '.nuxt', 'target', 'vendor',
  '.tox', '.venv', 'env', '.mypy_cache', '.pytest_cache'
]);

const BINARY_EXTENSIONS = new Set([
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.bz2',
  '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.db', '.sqlite', '.o', '.a', '.pyc'
]);

const FILE_LIST_TTL_MS = 30_000;
const FILE_LIST_CAP = 10_000;
const fileListCache = new Map<string, { files: string[]; timestamp: number }>();

async function walkProjectFiles(rootDir: string, showDotfiles = false, respectGitignore = true): Promise<string[]> {
  const cacheKey = `${rootDir}\0${showDotfiles ? '1' : '0'}\0${respectGitignore ? '1' : '0'}`;
  const cached = fileListCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < FILE_LIST_TTL_MS) {
    return cached.files;
  }

  let ig: ReturnType<typeof ignore> | null = null;
  if (respectGitignore) {
    try {
      const gitignoreContent = await readFile(join(rootDir, '.gitignore'), 'utf-8');
      ig = ignore().add(gitignoreContent);
    } catch { /* no .gitignore */ }
  }

  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= FILE_LIST_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (files.length >= FILE_LIST_CAP) return;
      if (!showDotfiles && entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (ig?.ignores(relPath + '/')) continue;
        await walk(fullPath);
      } else {
        if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        if (ig?.ignores(relPath)) continue;
        files.push(relPath);
      }
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));

  fileListCache.set(cacheKey, { files, timestamp: Date.now() });
  return files;
}

router.get('/project-files', async (req: Request, res: Response) => {
  const cwd = (req.query.cwd as string) || programCwd;
  const q = (req.query.q as string) || '';
  const showDotfiles = req.query.dotfiles === '1';
  const respectGitignore = req.query.noignore !== '1';

  try {
    const resolvedCwd = resolve(cwd);
    await access(resolvedCwd);
    const files = await walkProjectFiles(resolvedCwd, showDotfiles, respectGitignore);

    if (!q) {
      return res.json({ files });
    }

    const scored = files
      .map(f => ({ path: f, score: fuzzyScore(q, f) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(s => s.path);

    res.json({ files: scored });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiError.notFound(res, 'Directory not found');
    }
    console.error('[API] Failed to list project files:', error);
    return apiError.internal(res, 'Failed to list project files');
  }
});

// --- Prompts API ---

async function scanPromptDir(dir: string): Promise<Map<string, { name: string; description: string; path: string }>> {
  const prompts = new Map<string, { name: string; description: string; path: string }>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return prompts; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    const filePath = join(dir, entry.name);
    try {
      const content = await readFile(filePath, 'utf-8');
      const firstLine = content.split('\n').find(l => l.trim()) || '';
      prompts.set(name, {
        name,
        description: firstLine.trim().slice(0, 80),
        path: filePath
      });
    } catch { /* skip unreadable */ }
  }
  return prompts;
}

router.get('/prompts', async (_req: Request, res: Response) => {
  try {
    const globalDir = join(homedir(), '.caco', 'prompts');
    const localDir = join(programCwd, '.caco', 'prompts');

    const globalPrompts = await scanPromptDir(globalDir);
    const localPrompts = await scanPromptDir(localDir);

    // Local overrides global on name collision
    const merged = new Map([...globalPrompts, ...localPrompts]);
    const prompts = [...merged.values()].map(({ name, description }) => ({ name, description }));

    res.json({ prompts });
  } catch (error) {
    console.error('[API] Failed to list prompts:', error);
    return apiError.internal(res, 'Failed to list prompts');
  }
});

router.get('/prompts/:name', async (req: Request, res: Response) => {
  const { name } = req.params;

  try {
    const localPath = join(programCwd, '.caco', 'prompts', `${name}.md`);
    const globalPath = join(homedir(), '.caco', 'prompts', `${name}.md`);

    for (const filePath of [localPath, globalPath]) {
      try {
        const content = await readFile(filePath, 'utf-8');
        return res.json({ name, content });
      } catch { /* try next */ }
    }

    return apiError.notFound(res, `Prompt '${name}' not found`);
  } catch (error) {
    console.error('[API] Failed to read prompt:', error);
    return apiError.internal(res, 'Failed to read prompt');
  }
});

router.get('/extensions', async (_req: Request, res: Response) => {
  try {
    const extensions = await listExtensions();
    res.json({ extensions });
  } catch (error) {
    console.error('[API] Failed to list extensions:', error);
    res.status(500).json({ error: 'Failed to list extensions' });
  }
});

router.get('/extensions/:slug/style.css', async (req: Request, res: Response) => {
  const ext = await getExtension(req.params.slug as string);
  if (!ext || !ext.provides.includes('css')) return apiError.notFound(res, 'Extension CSS not found');
  try {
    const css = await readFile(join(ext.dir, 'style.css'), 'utf-8');
    res.type('text/css').send(css);
  } catch {
    return apiError.notFound(res, 'style.css not found');
  }
});

router.get('/extensions/:slug/client.js', async (req: Request, res: Response) => {
  const ext = await getExtension(req.params.slug as string);
  if (!ext || !ext.provides.includes('client')) return apiError.notFound(res, 'Extension client not found');
  const clientPath = join(ext.dir, 'client.ts');
  try {
    const s = await stat(clientPath);
    const cached = clientJsCache.get(ext.slug);
    if (cached && cached.mtime === s.mtimeMs) {
      return res.type('application/javascript').send(cached.js);
    }
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [clientPath],
      bundle: true,
      format: 'esm',
      write: false,
      target: 'es2020',
    });
    const js = result.outputFiles?.[0]?.text;
    if (!js) return apiError.internal(res, 'esbuild produced no output');
    clientJsCache.set(ext.slug, { js, mtime: s.mtimeMs });
    res.type('application/javascript').send(js);
  } catch {
    return apiError.notFound(res, 'client.ts not found or failed to compile');
  }
});

const clientJsCache = new Map<string, { js: string; mtime: number }>();

router.post('/restart', async (_req: Request, res: Response) => {
  const { requestRestart, getActiveDispatches } = await import('../restart-manager.js');
  requestRestart();
  const active = getActiveDispatches();
  res.json({
    ok: true,
    activeDispatches: active,
    message: active > 0
      ? `Restart scheduled. Waiting for ${active} active session(s) to complete.`
      : 'Restart initiated.'
  });
});

export default router;
