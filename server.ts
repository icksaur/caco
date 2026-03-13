/**
 * Copilot Web Server
 * 
 * Main entry point - sets up Express and mounts routes.
 * Session lifecycle is managed by SessionState.
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { readFileSync } from 'fs';
import { sessionState, createSessionState } from './src/session-state.js';
import sessionManager from './src/session-manager.js';
import { createDisplayTools, type CacoEmbedEvent } from './src/display-tools.js';
import { createAppletTools } from './src/applet-tools.js';
import { createAgentTools } from './src/agent-tools.js';
import { createMcpAuthTools } from './src/mcp-auth-tools.js';
import { createDevDocsTool } from './src/dev-docs-tool.js';
import { createExtensionsTool } from './src/extensions-tool.js';
import { createSwarmTool } from './src/swarm-tool.js';
import { createRoadmapTools } from './src/roadmap-tool.js';
import type { SessionIdRef, SystemMessage, ToolFactory } from './src/types.js';
import { storeOutput } from './src/storage.js';
import { sessionRoutes, apiRoutes, sessionMessageRoutes, mcpRoutes, mcpAuthRoutes, scheduleRoutes, shellRoutes } from './src/routes/index.js';
import { setupWebSocket } from './src/routes/websocket.js';
import { loadUsageCache } from './src/usage-state.js';
import { startScheduleManager, stopScheduleManager } from './src/schedule-manager.js';
import { getQueue } from './src/caco-event-queue.js';
import { buildSystemMessage } from './src/prompts.js';
import { loadServerExtensions } from './src/extension-runtime.js';
import { PORT, HOST } from './src/config.js';

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
    "connect-src 'self' ws: wss:; " +
    "font-src 'self'; " +
    'frame-src \'self\' http://localhost:* https://www.youtube.com https://www.youtube-nocookie.com https://w.soundcloud.com https://player.vimeo.com https://open.spotify.com https://platform.twitter.com;'
  );
  next();
});

// Routes

// Serve chat interface with injected server hostname (BEFORE static files)
// Read and transform once at startup — hostname doesn't change at runtime
const indexHtmlPath = join(__dirname, 'public', 'index.html');
const serverHostname = hostname();
const cachedIndexHtml = readFileSync(indexHtmlPath, 'utf-8').replace(
  '</head>',
  `<script>window.SERVER_HOSTNAME = ${JSON.stringify(serverHostname)};</script></head>`
);

app.get('/', (_req, res) => {
  res.type('html').send(cachedIndexHtml);
});

// Static files (after index.html route so injection works)
app.use(express.static('public'));

// CORS for session transfer endpoints (cross-instance import)
const transferCors: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
};
// CORS for session import endpoint only (cross-instance transfer)
app.use('/api/sessions/import', transferCors);

// API routes
app.use('/api', sessionRoutes);
app.use('/api', apiRoutes);
app.use('/api', sessionMessageRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/mcp/auth', mcpAuthRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', shellRoutes);

// Server Lifecycle

async function start(): Promise<void> {
  loadUsageCache();
  
  SYSTEM_MESSAGE = await buildSystemMessage();
  console.log('✓ System message built with applet discovery');
  
  const extensionTools = await loadServerExtensions(app);
  
  const server = createServer(app);
  
  const { pushStateToApplet } = setupWebSocket(server);
  
  const toolFactory: ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => {
    const queueCacoEvent = (event: CacoEmbedEvent) => {
      if (sessionRef.id) {
        const queue = getQueue(sessionRef.id);
        queue.queue(event);
        console.log(`[QUEUE] caco.embed queued for session ${sessionRef.id}, pending: ${queue.length}`);
      } else {
        console.log('[QUEUE] No sessionRef.id, event not queued');
      }
    };
    
    const displayTools = createDisplayTools(
      (data, meta) => storeOutput(sessionCwd, data, meta),
      queueCacoEvent
    );
    const appletTools = createAppletTools(programCwd, sessionRef, pushStateToApplet);
    const agentTools = createAgentTools(
      sessionRef, 
      (id) => sessionManager.getDispatchCorrelationId(id)
    );
    const mcpAuthTools = createMcpAuthTools();
    const devDocs = createDevDocsTool(programCwd);
    const extIntrospection = createExtensionsTool();
    const swarmTools = createSwarmTool(sessionRef);
    const roadmapTools = createRoadmapTools(sessionRef);
    
    return [...displayTools, ...appletTools, ...agentTools, ...mcpAuthTools, ...devDocs, ...extIntrospection, ...extensionTools, ...swarmTools, ...roadmapTools];
  };
  
  await createSessionState({
    systemMessage: SYSTEM_MESSAGE,
    toolFactory
  });
  
  startScheduleManager();
  
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✓ Shutting down gracefully...');
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

// Handle unhandled rejections (prevents crash from SDK async errors)
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Log but don't crash - SDK sometimes throws async errors we can't catch
});

start().catch(console.error);
