/**
 * Copilot Web Server
 * 
 * Main entry point - sets up Express and mounts routes.
 * Session lifecycle is managed by SessionState.
 */

import express from 'express';
import { z } from 'zod';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync } from 'fs';
import { homedir } from 'os';
import { sessionState, createSessionState } from './src/session-state.js';
import { sessionManager } from './src/session-manager.js';
import { createAppletTools } from './src/applet-tools.js';
import { createAgentTools } from './src/agent-tools.js';
import { createMcpAuthTools } from './src/mcp-auth-tools.js';
import { createDocsTool } from './src/dev-docs-tool.js';
import { createDelegateTool } from './src/delegate-tool.js';
import { createHerdTools } from './src/herd-tools.js';
import { scanHerdsOnBoot, onSessionDeleted } from './src/herd-runtime.js';
import { createSessionHistoryTool } from './src/session-history-tool.js';
import { createMemoryTools } from './src/memory-tool.js';
import { createIndexTool } from './src/index-tool.js';
import { createRetrieveOutputTool } from './src/observe/retrieve-tool.js';
import { createWorkflowTool } from './src/workflow/tool.js';
import { disabledToolNames, filterDisabledTools, excludedBuiltinNames } from './src/tool-registry.js';
import { isWorkflowRunnerAvailable, sweepWorkflowScratch } from './src/workflow/runner.js';
import { createSurfaceTools } from './src/surface-tools.js';
import { createBrowserTools } from './src/browser-tools.js';
import { createToolRevealTool } from './src/tool-reveal-tool.js';
import type { SessionIdRef, SystemMessage, ToolFactory } from './src/types.js';
import { sessionRoutes, apiRoutes, sessionMessageRoutes, workspaceRoutes, mcpAuthRoutes, scheduleRoutes, shellRoutes, surfaceRoutes, watchRoutes, fileEditsRoutes, draftRoutes, memoryRoutes, usageRoutes, idleRoutes } from './src/routes/index.js';
import { initWatchRoutes } from './src/routes/watch.js';
import { flushAll as flushAllFileEditsCardLists } from './src/file-edits-store.js';
import { initFileEditsRoutes, flushFileEditsCardList } from './src/routes/file-edits.js';
import { legacyAppletRedirectTarget } from './src/legacy-applet-redirects.js';
import { createGitEditPoller } from './src/git-edit-poller.js';
import { setGitEditPoller } from './src/dispatch-events.js';
import { setupWebSocket } from './src/routes/websocket.js';
import { idleFeed } from './src/idle-feed.js';
import { initTerminalManager } from './src/terminal-manager.js';
import { startRotationSweeper } from './src/session-history-rotation.js';
import { requireSameOrigin } from './src/security/same-origin.js';
import { loadUsageCache } from './src/usage-state.js';
import { startScheduleManager, stopScheduleManager } from './src/schedule-manager.js';
import { registerUsageSink } from './src/usage-metrics.js';
import { appendUsageRecord } from './src/usage-store.js';
import { buildSystemMessage } from './src/prompts.js';
import { loadServerExtensions } from './src/extension-runtime.js';
import { onAllIdle } from './src/restart-manager.js';
import { PORT, HOST, WORKFLOW_ENABLED } from './src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Mark child processes as running inside Caco (stop.sh checks this)
process.env.CACO_SESSION = '1';

const programCwd = process.cwd();

let SYSTEM_MESSAGE: SystemMessage;

// Middleware

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security: Content Security Policy
// Note: 'unsafe-eval' is required for applet JS execution via new Function()
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https: http://localhost:*; " +
    "connect-src 'self' ws: wss: http://localhost:*; " +
    "font-src 'self'; " +
    'frame-src \'self\' http://localhost:* https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com; ' +
    'frame-ancestors *;'
  );
  next();
});

// Routes

function allowLocalhostCorsSimple(req: import('express').Request, res: import('express').Response): void {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

// Serve chat interface with injected server hostname (BEFORE static files)
// Read and transform once at startup — hostname doesn't change at runtime
const indexHtmlPath = join(__dirname, 'public', 'index.html');
const serverHostname = hostname();
const cachedIndexHtml = readFileSync(indexHtmlPath, 'utf-8').replace(
  '</head>',
  `<script>window.SERVER_HOSTNAME = ${JSON.stringify(serverHostname)};</script></head>`
);

app.get('/', (req, res) => {
  // OAuth callback: redirect to /api/mcp/auth/callback with same query params
  if (req.query.code && req.query.state) {
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    res.redirect(`/api/mcp/auth/callback?${qs}`);
    return;
  }
  const slug = typeof req.query.applet === 'string' ? req.query.applet : null;
  if (slug) {
    const cleanQuery = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') cleanQuery.set(k, v);
    }
    const target = legacyAppletRedirectTarget(slug, cleanQuery);
    if (target) {
      res.redirect(302, '/?' + target.toString());
      return;
    }
  }
  res.type('html').send(cachedIndexHtml);
});

app.get('/api/info', (req, res) => {
  allowLocalhostCorsSimple(req, res);
  res.json({ hostname: serverHostname });
});

app.get('/api/favicon', (_req, res) => {
  const bytes = hashHostnameToBytes(serverHostname);
  const colors = bytes.map(b => {
    const h = Math.round((b / 255) * 360);
    return `hsl(${h}, 70%, 50%)`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
<foreignObject width="32" height="32">
<div xmlns="http://www.w3.org/1999/xhtml" style="width:32px;height:32px;border-radius:4px;background:
  radial-gradient(ellipse at 0% 0%, ${colors[0]}, transparent 60%),
  radial-gradient(ellipse at 100% 0%, ${colors[1]}, transparent 60%),
  radial-gradient(ellipse at 0% 100%, ${colors[2]}, transparent 60%),
  radial-gradient(ellipse at 100% 100%, ${colors[3]}, transparent 60%),
  #444;"></div>
</foreignObject>
</svg>`;
  res.type('image/svg+xml').send(svg);
});

function hashHostnameToBytes(h: string): number[] {
  let h1 = 0x811c9dc5, h2 = 0x1000193, h3 = 0xdeadbeef, h4 = 0xcafebabe;
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= c; h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= c; h4 = Math.imul(h4, 0x27d4eb2f);
  }
  return [h1 & 0xFF, h2 & 0xFF, h3 & 0xFF, h4 & 0xFF];
}

// Static files (after index.html route so injection works)
app.use(express.static('public'));

// CORS for session transfer endpoints (cross-instance import/export)
const transferCors: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
};
app.use('/api/sessions/import', transferCors);
app.use('/api/sessions/:sessionId/export', transferCors);

// Same-origin guard: blocks foreign browser pages (CSRF/CSWSH) from driving the
// local server, uniform across every route below. Mounted AFTER the portal transfer
// carve-outs (which it skips) and BEFORE the /api routes. Unscoped so req.path is the
// full path for the carve-out match. See docs/spec-same-origin-guard.md.
app.use(requireSameOrigin);

// API routes
app.use('/api', sessionRoutes);
app.use('/api', apiRoutes);
app.use('/api', sessionMessageRoutes);
app.use('/api/mcp', workspaceRoutes);
app.use('/api/mcp/auth', mcpAuthRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', shellRoutes);
app.use('/api', surfaceRoutes);
app.use('/api', watchRoutes);
app.use('/api', fileEditsRoutes);
app.use('/api', draftRoutes);
app.use('/api', memoryRoutes);
app.use('/api', usageRoutes);
app.use('/api', idleRoutes);

// Server Lifecycle

async function start(): Promise<void> {
  loadUsageCache();
  
  SYSTEM_MESSAGE = await buildSystemMessage();
  console.log('✓ System message built with applet discovery');
  
  const extensionTools = await loadServerExtensions(app);
  
  const server = createServer(app);
  
  const { wss, pushStateToApplet } = setupWebSocket(server);

  const workflowAvailable = WORKFLOW_ENABLED && await isWorkflowRunnerAvailable();
  if (WORKFLOW_ENABLED && !workflowAvailable) {
    console.warn('[WORKFLOW] tsx runner is unavailable; caco_run_workflow not registered');
  } else if (workflowAvailable) {
    console.log('[WORKFLOW] caco_run_workflow registered (auto-runs arbitrary code)');
    void sweepWorkflowScratch();
  }

  // Close the listening socket before the parent exits during a restart, so
  // the child server's first bind attempt succeeds rather than racing the
  // OS-level socket teardown. Best-effort; restart-manager already has a
  // retry loop downstream. Closing the WebSocketServer first fires its 'close'
  // handlers, which release the heartbeat interval and the extension fs
  // watchers — closing the HTTP server alone does not emit that event.
  onAllIdle(() => {
    try {
      wss.close();
      server.close();
      console.log('[RESTART] WebSocketServer + HTTP server.close() called for clean port release');
    } catch (err) {
      console.error('[RESTART] server.close() failed:', err);
    }
  });
  
  const disabledTools = disabledToolNames();
  if (disabledTools.size) console.log(`[TOOLS] Disabled-tool set: ${[...disabledTools].join(', ')}`);
  const excludedBuiltins = excludedBuiltinNames();
  if (excludedBuiltins.length) console.log(`[TOOLS] Excluded built-ins (shell → caco.sh): ${excludedBuiltins.join(', ')}`);
  const toolFactory: ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => {
    const appletTools = createAppletTools(programCwd, sessionRef, pushStateToApplet);
    const agentTools = createAgentTools(
      sessionRef, 
      (id) => sessionManager.getDispatchCorrelationId(id)
    );
    const mcpAuthTools = createMcpAuthTools();
    const docs = createDocsTool(programCwd);
    const delegateTools = createDelegateTool(sessionRef);
    const herdTools = createHerdTools(sessionRef, (id) => sessionManager.getDispatchCorrelationId(id));
    const sessionHistoryTools = createSessionHistoryTool();
    const memoryTools = createMemoryTools();
    const indexTools = createIndexTool(sessionCwd);
    const retrieveTools = createRetrieveOutputTool(sessionCwd, sessionRef);
    const workflowTools = workflowAvailable ? createWorkflowTool(sessionCwd, sessionRef) : [];
    const surfaceTools = createSurfaceTools(sessionRef);
    const browserTools = createBrowserTools(sessionRef);
    const toolRevealTools = createToolRevealTool(sessionRef);
    
    const allTools = [...appletTools, ...agentTools, ...mcpAuthTools, ...docs, ...extensionTools, ...delegateTools, ...herdTools, ...sessionHistoryTools, ...memoryTools, ...indexTools, ...retrieveTools, ...workflowTools, ...surfaceTools, ...browserTools, ...toolRevealTools];
    // Capture the full Caco tool catalog (pre-filter, incl. hard-disabled) once, for
    // the mcp-servers applet. See docs/spec-tool-reveal.md Phase A.
    if (sessionManager.getCacoToolCatalog().length === 0) {
      sessionManager.setCacoToolCatalog(
        (allTools as Array<{ name: string; description?: string; parameters?: unknown }>).map(t => {
          let parameters: Record<string, unknown> | undefined;
          try {
            // Caco tools carry a zod schema; convert to JSON Schema for an accurate
            // token estimate (same conversion as scripts/measure-tools.mts).
            if (t.parameters) parameters = (z as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(t.parameters);
          } catch { /* tool with no/!zod params → no schema */ }
          return {
            name: t.name,
            description: t.description ?? '',
            hardDisabled: disabledTools.has(t.name.toLowerCase()),
            parameters,
          };
        }),
      );
    }
    const { kept, removed } = filterDisabledTools(allTools as Array<{ name: string }>, disabledTools);
    if (removed.length) console.log(`[TOOLS] Disabled ${removed.length}: ${removed.join(', ')}`);
    return kept as typeof allTools;
  };
  
  await createSessionState({
    systemMessage: SYSTEM_MESSAGE,
    toolFactory,
    excludedTools: excludedBuiltins
  });

  // Register session-end listener now that sessionState exists.
  // (Route module is imported eagerly; sessionState is `let` and undefined
  // at module load time, so registration must be deferred to here.)
  initWatchRoutes();

  // Terminal manager registers sessionState.onSessionEnd (to kill a session's
  // pty) + a process 'exit' reaper, so it must run AFTER createSessionState.
  initTerminalManager();

  // File-edits poller: lazy-attach on first triggerPoll/snapshot.
  // Detach via sessionState.onSessionEnd. Flush any pending PUTs to the
  // per-session file-edits-cards.json file at the same time so we don't
  // lose the last gesture.
  const gitEditPoller = createGitEditPoller();
  initFileEditsRoutes(gitEditPoller);
  setGitEditPoller(gitEditPoller);
  sessionState.onSessionEnd((sid) => {
    gitEditPoller.detachFromSession(sid);
    flushFileEditsCardList(sid);
    // Herd cleanup on delete: disown a deleted parent's children AND clear a
    // deleted child's own bond (so it can't linger as a ghost in the index).
    onSessionDeleted(sid);
    // Drop the idle feed's per-session bookkeeping for the deleted session.
    idleFeed.remove(sid);
  });
  
  startScheduleManager();

  // Durable usage metrics: persist one record per completed request to the
  // date-partitioned store (spec-usage-metrics). The record is built + emitted
  // in completeDispatch; this registers the durable sink.
  registerUsageSink({ emit: appendUsageRecord });
  
  // Background history-rotation sweeper (no-op unless CACO_ROTATE_AUTO=1): one
  // delayed boot sweep + every 4h, rotating only cold/unviewed/observed large
  // sessions. Excludes the session the UI auto-opens on load.
  startRotationSweeper({
    getBootExcludeId: () => sessionState.preferences.lastSessionId ?? null,
  });
  
  sessionManager.snapshotSessionOrder();
  const msToMidnight = new Date().setHours(24, 0, 0, 0) - Date.now();
  setTimeout(function midnightSnapshot() {
    sessionManager.snapshotSessionOrder();
    setTimeout(midnightSnapshot, 24 * 60 * 60 * 1000);
  }, msToMidnight);
  
  // Start server with retry (for restart scenarios where port may not be free yet)
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 500;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      
      console.log(`✓ Server running at http://${HOST}:${PORT}`);
      console.log(`  Local: http://localhost:${PORT}`);
      console.log('  Press Ctrl+C to stop');
      // Post-listen herd boot scan: rebuild the membership index, self-heal
      // orphaned children, and re-wake any parent with a non-active child. Must
      // run after listen() because the wake POSTs the message route.
      void scanHerdsOnBoot();
      return; // Success
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE' && attempt < MAX_RETRIES) {
        console.log(`Port ${PORT} in use, retrying (${attempt}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }
  
  throw new Error(`Failed to bind to port ${PORT} after ${MAX_RETRIES} attempts`);
}

// Crash logging: persist fatal errors to a dedicated dir that start
// scripts never overwrite (server.log gets clobbered each startup).
// Writes are synchronous so the record is flushed to disk before the
// process exits. See start.ps1 / start.sh log archival for the
// complementary half (preserving the last server.log on restart).
const CRASH_LOG_DIR = join(process.env.CACO_HOME || join(homedir(), '.caco'), 'logs');
const CRASH_LOG_MAX_BYTES = 2 * 1024 * 1024;  // rotate at 2 MB

function recordCrash(kind: string, err: unknown): void {
  try {
    mkdirSync(CRASH_LOG_DIR, { recursive: true });
    const crashPath = join(CRASH_LOG_DIR, 'crash.log');
    // Size-based rotation so the log can't grow unbounded: when it
    // exceeds the cap, move it to crash.log.1 (one previous generation
    // kept) and start fresh. Synchronous to stay safe in the exit path.
    try {
      if (statSync(crashPath).size > CRASH_LOG_MAX_BYTES) {
        renameSync(crashPath, join(CRASH_LOG_DIR, 'crash.log.1'));
      }
    } catch { /* no existing file, or rotate failed — proceed to append */ }
    const e = err as Error;
    const stack = (e && e.stack) ? e.stack : String(err);
    const entry =
      `\n===== ${kind} @ ${new Date().toISOString()} (pid ${process.pid}) =====\n` +
      `${stack}\n`;
    // Append so multiple crashes across runs accumulate rather than
    // overwrite. Synchronous: must complete before process.exit().
    appendFileSync(crashPath, entry);
  } catch {
    // Last resort: at least surface to stderr (captured in server.log).
    console.error(`[CRASH-LOG FAILED] ${kind}:`, err);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✓ Shutting down gracefully...');
  flushAllFileEditsCardLists();
  stopScheduleManager();
  sessionState.shutdown()
    .then(() => sessionManager.shutdown())
    .then(() => {
      process.exit(0);
    }).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
});

// Fatal uncaught exceptions: log to disk synchronously, then exit.
// Without this handler Node prints the stack to stderr (captured in
// server.log) and exits — but the next startup overwrites server.log,
// losing the stack. Persisting to ~/.caco/logs/crash.log preserves it.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  recordCrash('uncaughtException', err);
  // Best-effort flush of in-memory state before dying.
  try { flushAllFileEditsCardLists(); } catch { /* ignore */ }
  process.exit(1);
});

// Handle unhandled rejections (prevents crash from SDK async errors)
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Log but don't crash - SDK sometimes throws async errors we can't
  // catch. Still persist to the crash log for post-mortem.
  recordCrash('unhandledRejection', reason);
});

start().catch(console.error);
