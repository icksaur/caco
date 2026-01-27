/**
 * Copilot Web Server
 * 
 * Main entry point - sets up Express and mounts routes.
 * Session lifecycle is managed by SessionState.
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sessionState } from './src/session-state.js';
import { createDisplayTools } from './src/display-tools.js';
import { storeOutput, detectLanguage } from './src/storage.js';
import { sessionRoutes, apiRoutes, streamRoutes } from './src/routes/index.js';
import type { SystemMessage, ToolFactory } from './src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Tool factory - creates display tools with session cwd baked in for storage
const toolFactory: ToolFactory = (sessionCwd: string) => {
  // storeOutput receives sessionCwd first, then data and metadata
  // The closure captures sessionCwd so each session's tools scope to the right storage
  return createDisplayTools(
    (data, meta) => storeOutput(sessionCwd, data, meta),
    detectLanguage
  );
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

## Display Tools
You have special tools that display content directly to the user:
- \`render_file_contents\` - Show files with syntax highlighting
- \`run_and_display\` - Run commands and show output
- \`display_image\` - Display image files
- \`embed_media\` - Embed YouTube/SoundCloud/Vimeo/Spotify content

Use display tools when users want to SEE content. Use regular tools when you need to analyze content.

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
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
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
  
  // Start server (localhost only for security)
  app.listen(PORT, '127.0.0.1', () => {
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
