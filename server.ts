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
import { isBenignWatcherFault } from './src/watch-fault-classifier.js';
import { createAppletTools } from './src/applet-tools.js';
import { createAgentTools } from './src/agent-tools.js';
import { createMcpAuthTools } from './src/mcp-auth-tools.js';
import { createDocsTool } from './src/dev-docs-tool.js';
import { createDelegateTool } from './src/delegate-tool.js';
import { createHerdTools } from './src/herd-tools.js';
import { scanHerdsOnBoot, onSessionDeleted } from './src/herd-runtime.js';
import { startAutoArchiveReaper } from './src/session-archive-reaper.js';
import { createSessionHistoryTool } from './src/session-history-tool.js';
import { verifySdkProseSections } from './src/prompts.js';
import { createMemoryTools } from './src/memory-tool.js';
import { createReportIntentTool } from './src/report-intent-tool.js';
import { createIndexTool } from './src/index-tool.js';
import { createRetrieveOutputTool } from './src/observe/retrieve-tool.js';
import { createWorkflowTool } from './src/workflow/tool.js';
import { disabledToolNames, filterDisabledTools, excludedBuiltinNames } from './src/tool-registry.js';
import { isWorkflowRunnerAvailable, sweepWorkflowScratch } from './src/workflow/runner.js';
import { createSurfaceTools } from './src/surface-tools.js';
import { createBrowserTools } from './src/browser-tools.js';
import { createToolRevealTool } from './src/tool-reveal-tool.js';
import type { SessionIdRef, ToolFactory } from './src/types.js';
import { sessionRoutes, apiRoutes, sessionMessageRoutes, workspaceRoutes, mcpAuthRoutes, scheduleRoutes, shellRoutes, surfaceRoutes, watchRoutes, fileEditsRoutes, draftRoutes, memoryRoutes, usageRoutes, idleRoutes, pagerRoutes } from './src/routes/index.js';
import { initWatchRoutes } from './src/routes/watch.js';
import { flushAll as flushAllFileEditsCardLists } from './src/file-edits-store.js';
import { initFileEditsRoutes, flushFileEditsCardList } from './src/routes/file-edits.js';
import { legacyAppletRedirectTarget } from './src/legacy-applet-redirects.js';
import { createGitEditPoller } from './src/git-edit-poller.js';
import { setGitEditPoller } from './src/dispatch-events.js';
import { setupWebSocket } from './src/routes/websocket.js';
import { idleFeed } from './src/idle-feed.js';
import { initTerminalManager } from './src/terminal-manager.js';
import { startRotationSweeper, startQuietMaintenance } from './src/session-history-rotation.js';
import { requireSameOrigin } from './src/security/same-origin.js';
import { loadUsageCache } from './src/usage-state.js';
import { startScheduleManager, stopScheduleManager } from './src/schedule-manager.js';
import { registerUsageSink } from './src/usage-metrics.js';
import { appendUsageRecord } from './src/usage-store.js';
import { loadServerExtensions } from './src/extension-runtime.js';
import { onAllIdle } from './src/restart-manager.js';
import { PORT, HOST, WORKFLOW_ENABLED, setBoundPort, serverUrlFor } from './src/config.js';
import { listenWithFallback, formatStartupFailure, StartupPortError, EXIT_STARTUP_FAILED } from './src/server-listen.js';
import {
  acquireServerLock, markServerReady, releaseServerLock, formatLockRefusal,
  ServerLockHeldError, EXIT_ALREADY_RUNNING,
} from './src/server-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Mark child processes as running inside Caco (stop.sh checks this)
process.env.CACO_SESSION = '1';

const programCwd = process.cwd();

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
app.use('/api', pagerRoutes);

// Server Lifecycle

/** Startup progress, stamped with seconds since the process began (module load included). */
function bootLog(message: string): void {
  console.log(`[BOOT +${process.uptime().toFixed(1)}s] ${message}`);
}

async function start(): Promise<void> {
  // Snapshot and drop the restart handoff marker before anything can spawn a
  // child that would inherit it.
  const handoffParentPid = Number(process.env.CACO_RESTART_HANDOFF) || undefined;
  delete process.env.CACO_RESTART_HANDOFF;

  bootLog(`Caco starting: pid ${process.pid}, node ${process.version}, requested ${serverUrlFor(HOST, PORT)}`);

  // CONTRACT: take the single-instance lock before anything below runs.
  // Initialization repairs session files, and starts the scheduler, sweepers,
  // and child processes. A process that can't own the session state must do
  // none of it. Do not move work above this line.
  //
  // Rejected: binding a throwaway listener before init to choose the port (the
  // lock already keeps a non-owner from touching state, and a preflight adds a
  // close-and-rebind gap), and binding first with a not-ready 503 gate (it
  // changes what an open tab sees during every restart).
  await acquireServerLock({ handoffParentPid });
  process.on('exit', () => releaseServerLock());

  loadUsageCache();

  bootLog('loading extensions');
  const extensionTools = await loadServerExtensions(app);
  
  const server = createServer(app);
  
  const { wss, pushStateToApplet } = setupWebSocket(server);

  bootLog('checking the workflow runner');
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
    const reportIntentTools = createReportIntentTool(sessionRef);
    const indexTools = createIndexTool(sessionCwd);
    const retrieveTools = createRetrieveOutputTool(sessionCwd, sessionRef);
    const workflowTools = workflowAvailable ? createWorkflowTool(sessionCwd, sessionRef) : [];
    const surfaceTools = createSurfaceTools(sessionRef);
    const browserTools = createBrowserTools(sessionRef);
    const toolRevealTools = createToolRevealTool(sessionRef);
    
    const allTools = [...appletTools, ...agentTools, ...mcpAuthTools, ...docs, ...extensionTools, ...delegateTools, ...herdTools, ...sessionHistoryTools, ...memoryTools, ...reportIntentTools, ...indexTools, ...retrieveTools, ...workflowTools, ...surfaceTools, ...browserTools, ...toolRevealTools];
    // Capture the full Caco tool catalog (pre-filter, incl. hard-disabled) once, for
    // the mcp-servers applet. See docs/spec-tool-reveal.md Phase A.
    if (sessionManager.getCacoToolCatalog().length === 0) {
      // Extension tools are catalogued but never auto-deferred: a fixed name
      // blocklist cannot protect a dynamic, third-party tool set.
      const extensionNames = new Set((extensionTools as Array<{ name: string }>).map(t => t.name));
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
            origin: extensionNames.has(t.name) ? 'extension' as const : 'builtin' as const,
            parameters,
          };
        }),
      );
    }
    const { kept, removed } = filterDisabledTools(allTools as Array<{ name: string }>, disabledTools);
    if (removed.length) console.log(`[TOOLS] Disabled ${removed.length}: ${removed.join(', ')}`);
    return kept as typeof allTools;
  };
  
  bootLog('starting the session manager');
  await createSessionState({
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
  
  bootLog('starting background services');
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

  // Quiet-period maintenance (spec-rotation-windows): for servers that run for weeks
  // and never see a boot, rotate an over-pressure session once the whole server has
  // been idle long enough. Uses dispatchState's 'idle' event — NOT onAllIdle, which is
  // restart-only and a single-slot callback already owned by the restart cleanup above.
  startQuietMaintenance();
  
  sessionManager.snapshotSessionOrder();
  const msToMidnight = new Date().setHours(24, 0, 0, 0) - Date.now();
  setTimeout(function midnightSnapshot() {
    sessionManager.snapshotSessionOrder();
    setTimeout(midnightSnapshot, 24 * 60 * 60 * 1000);
  }, msToMidnight);
  
  // Bind the requested port, or one of the next few if it is reserved or taken.
  // Another Caco was already excluded by the lock above, so a held port here
  // is just an unavailable port.
  bootLog(`binding ${serverUrlFor(HOST, PORT)}`);
  const { port, skipped } = await listenWithFallback(server, { host: HOST, port: PORT }, {
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });
  setBoundPort(port);
  const url = serverUrlFor(HOST, port);
  markServerReady(url, port);

  // An SDK upgrade that renames a prompt section makes our section removals
  // silent no-ops, so the SDK's prose returns alongside Caco's. Nothing
  // errors, so say so here or nobody finds out.
  const drift = verifySdkProseSections();
  if (drift && (drift.missing.length || drift.unexpected.length)) {
    console.error(
      '[PROMPT] SDK prompt sections have drifted; Caco sessions may carry duplicated SDK prose. '
      + `Update SDK_PROSE_SECTIONS in src/prompts.ts. Missing: [${drift.missing.join(', ')}] `
      + `Unhandled: [${drift.unexpected.join(', ')}]`,
    );
  }
  // Post-listen herd boot scan: rebuild the membership index, self-heal
  // orphaned children, and re-wake any parent with a non-active child. Must
  // run after listen() because the wake POSTs the message route.
  void scanHerdsOnBoot();
  // Start the soft-archive reaper: periodically archive sessions parked in the
  // auto-archive folder that have been idle past the threshold (spec-soft-archive-folder).
  startAutoArchiveReaper();

  for (const s of skipped) {
    bootLog(`${serverUrlFor(HOST, s.port)} unavailable (${s.code}); using port ${port} instead`);
  }
  console.log('  Press Ctrl+C to stop');
  // CONTRACT: the ready URL is the last line start() prints, so the start
  // scripts and a terminal user find it at the bottom. Startup work goes above.
  console.log(`Caco ready: ${url}`);
}

// Crash logging: persist fatal errors to a dedicated dir that start
// scripts never overwrite (server.log gets clobbered each startup).
// Writes are synchronous so the record is flushed to disk before the
// process exits. See start.ps1 / start.sh log archival for the
// complementary half (preserving the last server.log on restart).
const CRASH_LOG_DIR = join(process.env.CACO_HOME || join(homedir(), '.caco'), 'logs');
const CRASH_LOG_MAX_BYTES = 2 * 1024 * 1024;  // rotate at 2 MB

// Rate-limit BOTH the console line and the crash-log persist for survived watch
// faults, so a thrashing watcher can't spam stderr or churn crash.log (which
// keeps only one rotated generation — a storm could evict real fatal history).
// Every fault still increments a suppressed count that is surfaced on the next
// emitted record, so nothing is silently lost.
const WATCH_FAULT_LOG_INTERVAL_MS = 60_000;
let lastWatchFaultLogMs = 0;
let suppressedWatchFaults = 0;

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
  // A benign filesystem-watch fault (e.g. Windows EPERM from OneDrive sync churn,
  // or ENOSPC) can come from a watcher we don't own (chokidar/SDK internals) and
  // otherwise kills every session in this process. It is self-contained and
  // survivable: record it (rate-limited log) and keep running, mirroring the
  // unhandledRejection policy below. See spec-server-resilience.
  if (isBenignWatcherFault(err)) {
    const e = err as NodeJS.ErrnoException;
    const now = Date.now();
    suppressedWatchFaults++;
    if (now - lastWatchFaultLogMs > WATCH_FAULT_LOG_INTERVAL_MS) {
      const n = suppressedWatchFaults;
      suppressedWatchFaults = 0;
      lastWatchFaultLogMs = now;
      // Log/persist code + syscall ONLY (never err.message/stack — it may carry a
      // path/PII), with the count of faults since the last emitted record.
      console.warn(`[WATCH-FAULT survived] ${e.code} ${e.syscall} x${n} (server continues)`);
      recordCrash('uncaughtException:watch-survived', `${e.code} ${e.syscall} (x${n} since last record)`);
    }
    return;
  }
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

// CONTRACT: a failed start exits the process. Lingering would keep the
// scheduler and sweepers alive in a process with no port, which the stop
// scripts cannot find or kill.
start().catch((err: unknown) => {
  if (err instanceof ServerLockHeldError) {
    // Expected, not a crash: another Caco owns the session state.
    console.error(formatLockRefusal(err));
    process.exit(EXIT_ALREADY_RUNNING);
  }
  console.error(err instanceof StartupPortError ? formatStartupFailure(err, process.platform) : err);
  recordCrash('startup', err);
  process.exit(EXIT_STARTUP_FAILED);
});
