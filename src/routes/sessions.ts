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
import { existsSync, statSync, createReadStream, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getScheduleForSession } from '../schedule-store.js';
import { getSessionMeta, setSessionMeta, getSessionIconPath, getSessionData, setSessionData, getSessionRoadmap, setSessionRoadmap, getSessionNotes, appendSessionNote, archiveSessionNote, getPeers, setPeers, type CacoPeer, type SessionKind, type Roadmap } from '../storage.js';
import { unobservedTracker } from '../unobserved-tracker.js';
import { broadcastGlobalEvent, broadcastEvent } from './websocket.js';
import { mergeContextSet, KNOWN_SET_NAMES } from '../context-tools.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readGitBranch(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf-8').trim();
    if (head.startsWith('ref: refs/heads/')) return head.slice(16);
    return head.slice(0, 8);
  } catch { return null; }
}

/** Allow cross-origin requests from localhost (for portal session transfers) */
function allowLocalhostCors(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

router.options('/sessions/:sessionId/export', (req, res) => { allowLocalhostCors(req, res); });
router.options('/sessions/import', (req, res) => { allowLocalhostCors(req, res); });

// Peer management
router.get('/peers', (_req: Request, res: Response) => {
  res.json(getPeers());
});

router.post('/peers', (req: Request, res: Response) => {
  const peers = req.body as CacoPeer[];
  if (!Array.isArray(peers)) {
    res.status(400).json({ error: 'Expected array of {url, hostname}' });
    return;
  }
  // Only store remote peers (skip self)
  const remote = peers.filter(p => p.url && p.hostname && !p.url.includes('localhost:53000'));
  setPeers(remote);
  res.json({ ok: true, count: remote.length });
});

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

  // Fetch peer sessions (non-blocking, best-effort)
  const peers = getPeers();
  const peerSessions: Record<string, unknown> = {};
  if (peers.length > 0) {
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const r = await fetch(`${peer.url}/api/sessions`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return null;
        return { peer, data: await r.json() };
      })
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { peer, data } = result.value;
        peerSessions[`${peer.hostname} (${peer.url})`] = data.grouped || {};
      }
    }
  }
  
  res.json({
    activeSessionId: sessionState.activeSessionId,
    currentCwd: process.cwd(),
    grouped,
    unobservedCount,
    peers: peerSessions,
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      cost: m.billing?.multiplier ?? 1
    }))
  });
});

router.post('/sessions', async (req: Request, res: Response) => {
  const { cwd, model, description, parentSessionId, isSwarmSession, kind } = req.body as { cwd?: string; model?: string; description?: string; parentSessionId?: string; isSwarmSession?: boolean; kind?: SessionKind };
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
    
    // Set metadata
    const resolvedKind: SessionKind = kind ?? (isSwarmSession ? 'swarm' : parentSessionId ? 'agent' : 'interactive');
    const meta = getSessionMeta(sessionId) ?? { name: '' };
    meta.kind = resolvedKind;
    if (description) meta.name = description;
    if (parentSessionId) meta.parentSessionId = parentSessionId;
    if (isSwarmSession) meta.isSwarmSession = true;
    setSessionMeta(sessionId, meta);
    
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
    const cwd = sessionManager.getSessionCwd(result.sessionId) || sessionState.preferences.lastCwd;
    const isBusy = sessionManager.isBusy(result.sessionId);
    const model = sessionManager.getSessionModel(result.sessionId);
    
    const hasGit = !!(cwd && existsSync(join(cwd, '.git')));
    const gitBranch = hasGit && cwd ? readGitBranch(cwd) : null;
    const meta = getSessionMeta(result.sessionId);
    
    res.json({ 
      success: true, 
      sessionId: result.sessionId, 
      cwd, 
      isBusy,
      model,
      hasGit,
      gitBranch,
      name: meta?.name || null,
      kind: meta?.kind || 'interactive',
      currentIntent: meta?.currentIntent || null,
      hasIcon: getSessionIconPath(result.sessionId) !== null,
      cwdFallback: result.usedFallbackCwd,
      repairMessage: result.repairMessage || null
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
router.patch('/sessions/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { name, envHint, model, setContext } = req.body as { 
    name?: string; 
    envHint?: string;
    model?: string;
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
  
  // Handle model change via SDK
  if (model) {
    try {
      await sessionManager.setSessionModel(sessionId, model);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: `Failed to change model: ${msg}` });
      return;
    }
  }
  
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
 * POST /api/sessions/:sessionId/compact
 * Force context compaction for a session
 */
router.post('/sessions/:sessionId/compact', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;

  if (!sessionManager.isActive(sessionId)) {
    res.status(404).json({ error: 'Session not active' });
    return;
  }

  try {
    const result = await sessionManager.compactSession(sessionId);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: `Compaction failed: ${msg}` });
  }
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
  const isBusy = sessionManager.isBusy(sessionId);
  const meta = getSessionMeta(sessionId);
  const model = meta?.model || null;
  
  res.json({
    sessionId,
    status: isBusy ? 'busy' : (isActive ? 'idle' : 'inactive'),
    cwd,
    model,
    name: meta?.name || null,
    kind: meta?.kind || 'interactive',
    currentIntent: meta?.currentIntent || null,
    isActive,
    isBusy
  });
});

router.get('/sessions/:sessionId/data/:name', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const name = req.params.name as string;
  const data = getSessionData(sessionId, name);
  res.json(data || {});
});

router.put('/sessions/:sessionId/data/:name', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const name = req.params.name as string;
  if (!setSessionData(sessionId, name, req.body)) {
    res.status(403).json({ error: `Cannot write to reserved name: ${name}` });
    return;
  }
  res.json(req.body);
});

router.get('/sessions/:sessionId/roadmap', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  res.json(getSessionRoadmap(sessionId) || {});
});

router.patch('/sessions/:sessionId/roadmap', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const update = req.body as Partial<Roadmap>;
  
  const existing = getSessionRoadmap(sessionId) || { title: '', steps: [] };
  if (update.title !== undefined) existing.title = update.title;
  if (update.documents !== undefined) existing.documents = update.documents;
  if (update.steps !== undefined) existing.steps = update.steps;
  
  setSessionRoadmap(sessionId, existing);
  res.json(existing);
});

router.get('/sessions/:sessionId/notes', (req: Request, res: Response) => {
  res.json({ notes: getSessionNotes(req.params.sessionId as string) });
});

router.post('/sessions/:sessionId/notes', (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: 'text required' }); return; }
  const entry = appendSessionNote(req.params.sessionId as string, text.trim());
  res.json({ ok: true, entry });
});

router.post('/sessions/:sessionId/notes/archive', (req: Request, res: Response) => {
  const { ts } = req.body as { ts?: number };
  if (!ts) { res.status(400).json({ error: 'ts required' }); return; }
  const ok = archiveSessionNote(req.params.sessionId as string, ts);
  if (!ok) { res.status(404).json({ error: 'Note not found' }); return; }
  res.json({ ok: true });
});

/**
 * GET /api/sessions/:sessionId/icon
 * Serve session icon (icon.gif preferred, falls back to icon.png)
 */
router.get('/sessions/:sessionId/icon', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const iconPath = getSessionIconPath(sessionId);
  if (!iconPath) {
    res.status(404).end();
    return;
  }
  const ext = iconPath.endsWith('.gif') ? 'image/gif' : 'image/png';
  res.setHeader('Content-Type', ext);
  res.setHeader('Cache-Control', 'public, max-age=60');
  createReadStream(iconPath).pipe(res);
});

/**
 * GET /api/sessions/:sessionId/export
 * Export a session as a .tar.gz archive containing both SDK and Caco data.
 * Archive structure: sdk/<sessionId>/... and caco/<sessionId>/...
 * Query params:
 *   ?delete=true - Remove session after export (migration mode)
 */
router.get('/sessions/:sessionId/export', async (req: Request, res: Response) => {
  if (allowLocalhostCors(req, res)) return;
  const sessionId = req.params.sessionId as string;
  const shouldDelete = req.query.delete === 'true';

  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session ID format' });
    return;
  }

  const sdkBase = join(homedir(), '.copilot', 'session-state');
  const cacoBase = join(homedir(), '.caco', 'sessions');

  if (!existsSync(join(sdkBase, sessionId))) {
    res.status(404).json({ error: `Session not found: ${sessionId}` });
    return;
  }

  try {
    const tar = await import('tar');
    const { mkdtempSync, cpSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');

    // Build a staging directory with the archive structure
    const staging = mkdtempSync(join(tmpdir(), 'caco-export-'));
    try {
      cpSync(join(sdkBase, sessionId), join(staging, 'sdk', sessionId), { recursive: true });
      if (existsSync(join(cacoBase, sessionId))) {
        cpSync(join(cacoBase, sessionId), join(staging, 'caco', sessionId), { recursive: true });
      }

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${sessionId}.caco-session.tar.gz"`);

      const stream = tar.create({ gzip: true, cwd: staging }, ['.']);
      stream.on('error', () => rmSync(staging, { recursive: true, force: true }));
      stream.pipe(res);

      stream.on('end', () => {
        rmSync(staging, { recursive: true, force: true });
        if (shouldDelete && !sessionManager.isBusy(sessionId)) {
          void sessionState.deleteSession(sessionId).then(() => {
            broadcastGlobalEvent({ type: 'session.listChanged', data: { reason: 'deleted', sessionId } });
          }).catch(e => console.error(`[EXPORT] Delete after export failed: ${e}`));
        }
      });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: `Export failed: ${msg}` });
    }
  }
});

/**
 * POST /api/sessions/import
 * Import a session from a .tar.gz archive (raw body, not multipart).
 * Usage: curl -X POST --data-binary @session.caco-session.tar.gz http://host/api/sessions/import
 * Query params:
 *   ?cwd=/new/path - Rewrite CWD in session data (for cross-machine migration)
 *   ?force=true - Overwrite if session ID already exists
 */
router.post('/sessions/import', async (req: Request, res: Response) => {
  if (allowLocalhostCors(req, res)) return;
  const newCwd = req.query.cwd as string | undefined;
  const force = req.query.force === 'true';

  try {
    const tar = await import('tar');
    const { mkdtempSync, rmSync, existsSync: ex, readdirSync: rd, cpSync, readFileSync: rf, writeFileSync: wf } = await import('fs');
    const { tmpdir } = await import('os');
    const { parse: parseYaml } = await import('yaml');

    // Extract to temp directory
    const staging = mkdtempSync(join(tmpdir(), 'caco-import-'));
    try {
      await new Promise<void>((resolve, reject) => {
        const extract = tar.extract({ cwd: staging });
        req.pipe(extract);
        extract.on('end', resolve);
        extract.on('error', reject);
      });

      // Find session ID from extracted SDK workspace.yaml
      const sdkDir = join(staging, 'sdk');
      const cacoDir = join(staging, 'caco');

      if (!ex(sdkDir)) {
        res.status(400).json({ error: 'Invalid archive: missing sdk/ directory' });
        return;
      }

      const sessionDirs = rd(sdkDir).filter(d => ex(join(sdkDir, d, 'workspace.yaml')));
      if (sessionDirs.length === 0) {
        res.status(400).json({ error: 'Invalid archive: no session found in sdk/' });
        return;
      }

      const sessionId = sessionDirs[0];

      if (!UUID_RE.test(sessionId)) {
        res.status(400).json({ error: 'Invalid archive: session ID is not a valid UUID' });
        return;
      }

      const targetSdk = join(homedir(), '.copilot', 'session-state', sessionId);
      const targetCaco = join(homedir(), '.caco', 'sessions', sessionId);

      if (ex(targetSdk) && !force) {
        res.status(409).json({ error: `Session ${sessionId} already exists. Use ?force=true to overwrite.` });
        return;
      }

      // Optional CWD rewrite
      if (newCwd) {
        // Rewrite workspace.yaml
        const yamlPath = join(sdkDir, sessionId, 'workspace.yaml');
        if (ex(yamlPath)) {
          const yaml = parseYaml(rf(yamlPath, 'utf-8')) as Record<string, string>;
          const oldCwd = yaml.cwd;
          if (oldCwd && oldCwd !== newCwd) {
            let content = rf(yamlPath, 'utf-8');
            content = content.replaceAll(oldCwd, newCwd);
            wf(yamlPath, content);

            // Rewrite first line of events.jsonl (session.start context)
            const eventsPath = join(sdkDir, sessionId, 'events.jsonl');
            if (ex(eventsPath)) {
              const lines = rf(eventsPath, 'utf-8').split('\n');
              if (lines[0]) {
                lines[0] = lines[0].replaceAll(oldCwd.replace(/\\/g, '\\\\'), newCwd.replace(/\\/g, '\\\\'));
                lines[0] = lines[0].replaceAll(oldCwd, newCwd);
              }
              wf(eventsPath, lines.join('\n'));
            }
          }
        }
      }

      // Copy to target locations
      cpSync(join(sdkDir, sessionId), targetSdk, { recursive: true, force: true });
      if (ex(join(cacoDir, sessionId))) {
        cpSync(join(cacoDir, sessionId), targetCaco, { recursive: true, force: true });
      }

      // Refresh session cache
      sessionManager.refreshCache();
      broadcastGlobalEvent({ type: 'session.listChanged', data: { reason: 'imported', sessionId } });

      res.json({ ok: true, sessionId, message: `Session ${sessionId} imported successfully` });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: `Import failed: ${msg}` });
    }
  }
});

export default router;
