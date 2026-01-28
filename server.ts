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
import { sessionState } from './src/session-state.js';
import { createDisplayTools } from './src/display-tools.js';
import { createAppletTools } from './src/applet-tools.js';
import { createAgentTools, type SessionIdRef } from './src/agent-tools.js';
import { storeOutput, detectLanguage } from './src/storage.js';
import { sessionRoutes, apiRoutes, streamRoutes } from './src/routes/index.js';
import { setupAppletWebSocket } from './src/routes/applet-ws.js';
import type { SystemMessage, ToolFactory } from './src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Tool factory - creates display tools + applet tools with session cwd baked in
// Program CWD for applet storage (fixed at startup)
const programCwd = process.cwd();

const toolFactory: ToolFactory = (sessionCwd: string, sessionRef: SessionIdRef) => {
  // Display tools need sessionCwd for storage scoping
  const displayTools = createDisplayTools(
    (data, meta) => storeOutput(sessionCwd, data, meta),
    detectLanguage
  );
  
  // Applet tools need programCwd for persistent storage
  const appletTools = createAppletTools(programCwd);
  
  // Agent tools need sessionRef for self-identification in callbacks
  // Uses mutable ref so tools work even when sessionId isn't known at creation time
  const agentTools = createAgentTools(sessionRef);
  
  return [...displayTools, ...appletTools, ...agentTools];
};

// System message for sessions
const SYSTEM_MESSAGE: SystemMessage = {
  mode: 'replace',
  content: `You are an AI assistant in a browser-based chat interface powered by the Copilot SDK.

## Environment
- **Runtime**: Web browser UI connected to Copilot SDK (Node.js backend)
- **Interface**: Rich HTML chat with markdown rendering, syntax highlighting, and media embeds
- **Scope**: Full filesystem access - general-purpose assistant, not limited to any project
- **Home directory**: ${process.env.HOME || '/home/user'}
- **Current directory**: ${process.cwd()} (but not limited to this)

## Your Capabilities
- **Filesystem**: Read, write, search, and analyze files anywhere
- **Terminal**: Execute commands in any directory  
- **Images**: View pasted images, display image files
- **Media embeds**: Embed YouTube, SoundCloud, Vimeo, Spotify content inline
- **Code**: Syntax highlighting for all major languages
- **Applets**: Create custom interactive UI in the applet panel

## Display Tools
You have special tools that display content directly to the user:
- \`render_file_contents\` - Show files with syntax highlighting
- \`run_and_display\` - Run commands and show output
- \`display_image\` - Display image files
- \`embed_media\` - Embed YouTube/SoundCloud/Vimeo/Spotify content

Use display tools when users want to SEE content. Use regular tools when you need to analyze content.

## Applet Tool
You can create custom interactive interfaces using:
- \`set_applet_content\` - Set HTML/JS/CSS content in the applet panel

Use this when users ask for interactive tools, editors, viewers, forms, or dashboards.
The applet runs in a dedicated panel with full JavaScript capabilities.

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

// ============================================================
// Middleware
// ============================================================

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

// Static files
app.use(express.static('public'));

// ============================================================
// Routes
// ============================================================

// Serve chat interface
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// API routes
app.use('/api', sessionRoutes);
app.use('/api', apiRoutes);
app.use('/api', streamRoutes);

// ============================================================
// Server Lifecycle
// ============================================================

async function start(): Promise<void> {
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
  setupAppletWebSocket(server);
  
  // Start server (localhost only for security)
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`✓ Server running at http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  await sessionState.shutdown();
  process.exit(0);
});

start().catch(console.error);
