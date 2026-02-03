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
import { homedir, hostname } from 'os';
import { readFileSync } from 'fs';
import { sessionState } from './src/session-state.js';
import { createDisplayTools, type CacoEmbedEvent } from './src/display-tools.js';
import { createAppletTools } from './src/applet-tools.js';
import { createAgentTools, type SessionIdRef } from './src/agent-tools.js';
import { storeOutput } from './src/storage.js';
import { sessionRoutes, apiRoutes, sessionMessageRoutes, mcpRoutes, scheduleRoutes, shellRoutes } from './src/routes/index.js';
import { setupWebSocket } from './src/routes/websocket.js';
import { loadUsageCache } from './src/usage-state.js';
import { startScheduleManager, stopScheduleManager } from './src/schedule-manager.js';
import { getQueue } from './src/caco-event-queue.js';
import { getAppletSlugsForPrompt } from './src/applet-store.js';
import type { SystemMessage, ToolFactory } from './src/types.js';
import { PORT } from './src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Tool factory - creates display tools + applet tools with session cwd baked in
// Program CWD for applet storage (fixed at startup)
const programCwd = process.cwd();

const toolFactory: ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => {
  // Queue function for caco.* events - tools queue, events flush on session.idle
  const queueCacoEvent = (event: CacoEmbedEvent) => {
    if (sessionRef.id) {
      const queue = getQueue(sessionRef.id);
      queue.queue(event);
      console.log(`[QUEUE] caco.embed queued for session ${sessionRef.id}, pending: ${queue.length}`);
    } else {
      console.log(`[QUEUE] No sessionRef.id, event not queued`);
    }
  };
  
  // Display tools need sessionCwd for storage scoping and queue for caco events
  const displayTools = createDisplayTools(
    (data, meta) => storeOutput(sessionCwd, data, meta),
    queueCacoEvent
  );
  
  // Applet tools need programCwd for persistent storage
  const appletTools = createAppletTools(programCwd);
  
  // Agent tools need sessionRef for self-identification in callbacks
  // Uses mutable ref so tools work even when sessionId isn't known at creation time
  const agentTools = createAgentTools(sessionRef);
  
  return [...displayTools, ...appletTools, ...agentTools];
};

// System message for sessions - built at startup with applet list
let SYSTEM_MESSAGE: SystemMessage;

async function buildSystemMessage(): Promise<SystemMessage> {
  const appletPrompt = await getAppletSlugsForPrompt();
  
  return {
    mode: 'replace',
    content: `You are an AI assistant in a browser-based chat interface powered by the Copilot SDK.

## Environment
- **Runtime**: Web browser UI connected to Copilot SDK (Node.js backend)
- **Interface**: Rich HTML chat with markdown rendering, syntax highlighting, and media embeds
- **Scope**: Full filesystem access - general-purpose assistant, not limited to any project
- **Home directory**: ${process.env.HOME || process.env.USERPROFILE || homedir()}
- **Current directory**: ${process.cwd()} (but not limited to this)

## Your Capabilities
- **Filesystem**: Read, write, search, and analyze files anywhere
- **Terminal**: Execute commands in any directory  
- **Images**: View pasted images, display image files
- **Media embeds**: Embed YouTube, SoundCloud, Vimeo, Spotify content inline
- **Applets**: Interactive UI panels the user can open via markdown links

## Display Tools
You have a tool that displays content directly to the user:
- \`embed_media\` - Embed YouTube/SoundCloud/Vimeo/Spotify content

Use embed_media when users want to watch or listen to media inline.

## Applets
${appletPrompt || 'No applets installed. Use applet_howto to create one.'}
Provide clickable markdown links: \`[View status](/?applet=git-status&path=/repo)\`
Use \`applet_howto\` tool for creating new applets.

## Agent-to-Agent Tools
You can communicate with other agent sessions:
- \`send_agent_message\` - Send a message to another session
- \`get_session_state\` - Check if a session is idle or streaming  
- \`create_agent_session\` - Create a new session with specific cwd

Use these to delegate subtasks, coordinate work, or fan out parallel tasks.
Include callback instructions so other agents can report back when finished.

## Behavior Guidelines
- Provide direct, helpful answers without unnecessary caveats
- Access any file or directory the user mentions - you have full permission
- Use markdown formatting for better readability
- Be concise unless detail is requested
- When asked to read or show files, just do it - don't ask for confirmation
- When users share media URLs, embed them directly`
  };
}

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
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self'; " +
    "font-src 'self'; " +
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://w.soundcloud.com https://player.vimeo.com https://open.spotify.com https://platform.twitter.com;'
  );
  next();
});

// Routes

// Serve chat interface with injected server hostname (BEFORE static files)
const indexHtmlPath = join(__dirname, 'public', 'index.html');
const serverHostname = hostname();

app.get('/', (_req, res) => {
  const html = readFileSync(indexHtmlPath, 'utf-8');
  const injectedHtml = html.replace(
    '</head>',
    `<script>window.SERVER_HOSTNAME = ${JSON.stringify(serverHostname)};</script></head>`
  );
  res.type('html').send(injectedHtml);
});

// Static files (after index.html route so injection works)
app.use(express.static('public'));

// API routes
app.use('/api', sessionRoutes);
app.use('/api', apiRoutes);
app.use('/api', sessionMessageRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', shellRoutes);

// Server Lifecycle

async function start(): Promise<void> {
  // Load cached usage from disk
  loadUsageCache();
  
  // Build system message with applet discovery
  SYSTEM_MESSAGE = await buildSystemMessage();
  console.log('✓ System message built with applet discovery');
  
  // Initialize session state
  await sessionState.init({
    systemMessage: SYSTEM_MESSAGE,
    toolFactory,
    excludedTools: ['view']
  });
  
  // Create HTTP server from Express app
  const server = createServer(app);
  
  // Attach WebSocket server for unified session channel
  // WS is for server→client push (rendering); POST is for client→server send
  setupWebSocket(server);
  
  // Start schedule manager
  startScheduleManager();
  
  // Start server (0.0.0.0 = all interfaces - TEMPORARY for iOS testing)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running at http://0.0.0.0:${PORT}`);
    console.log(`  Local: http://localhost:${PORT}`);
    console.log(`  Network: http://10.0.1.4:${PORT}`);
    console.log('  Press Ctrl+C to stop');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  stopScheduleManager();
  await sessionState.shutdown();
  process.exit(0);
});

// Handle unhandled rejections (prevents crash from SDK async errors)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Log but don't crash - SDK sometimes throws async errors we can't catch
});

start().catch(console.error);
