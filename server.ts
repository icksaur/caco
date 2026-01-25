import express, { Request, Response } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import sessionManager from './src/session-manager.js';
import { createDisplayTools } from './src/display-tools.js';
import { storeOutput, getOutput, detectLanguage } from './src/output-cache.js';
import { loadPreferences, savePreferences, getDefaultPreferences } from './src/preferences.js';
import type { UserPreferences, SystemMessage } from './src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Current preferences (loaded on startup)
let preferences: UserPreferences = getDefaultPreferences();

// Current active session for this server instance
let activeSessionId: string | null = null;

// Create display-only tools (use output cache for zero-context display)
const displayTools = createDisplayTools(storeOutput, detectLanguage);

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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security: Content Security Policy
app.use((_req: Request, res: Response, next: () => void) => {
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self'; " +
    "font-src 'self'; " +
    // Allow iframe embeds from media providers
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://w.soundcloud.com https://player.vimeo.com https://open.spotify.com https://platform.twitter.com;'
  );
  next();
});
app.use(express.static('public'));

// Initialize: discover sessions and auto-resume or create
async function initSession(): Promise<void> {
  await sessionManager.init();
  
  // Load saved preferences
  preferences = await loadPreferences();
  
  const cwd = process.cwd();
  
  // Config for session resume
  const sessionConfig = {
    tools: displayTools,
    excludedTools: ['view']
  };
  
  // Try to resume last session from preferences first
  if (preferences.lastSessionId) {
    try {
      activeSessionId = await sessionManager.resume(preferences.lastSessionId, sessionConfig);
      console.log(`✓ Resumed last session ${activeSessionId}`);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Could not resume last session: ${message}`);
    }
  }
  
  // If lastSessionId was explicitly null (new chat), don't auto-resume
  // Just wait for first message to create session with selected model
  if (preferences.lastSessionId === null) {
    console.log('✓ No existing session - will create on first message');
    return;
  }
  
  // Try to resume most recent session for this cwd (only if no preference set)
  const recentSessionId = sessionManager.getMostRecentForCwd(cwd);
  
  if (recentSessionId) {
    try {
      activeSessionId = await sessionManager.resume(recentSessionId, sessionConfig);
      preferences.lastSessionId = activeSessionId;
      await savePreferences(preferences);
      console.log(`✓ Resumed session ${activeSessionId}`);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`Could not resume session ${recentSessionId}: ${message}`);
    }
  }
  
  // No existing session - will create lazily on first message
  console.log('✓ No existing session - will create on first message');
}

// Helper to create session lazily with specified model
async function ensureSession(model?: string): Promise<string> {
  if (activeSessionId && sessionManager.isActive(activeSessionId)) {
    return activeSessionId;
  }
  
  const cwd = preferences.lastCwd || process.cwd();
  
  activeSessionId = await sessionManager.create(cwd, {
    model: model || 'claude-sonnet-4',
    streaming: true,
    systemMessage: SYSTEM_MESSAGE,
    tools: displayTools,
    excludedTools: ['view']
  });
  
  preferences.lastSessionId = activeSessionId;
  await savePreferences(preferences);
  console.log(`✓ Created session ${activeSessionId} with model ${model || 'claude-sonnet-4'}`);
  
  return activeSessionId;
}

// Serve chat interface
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Get session info
app.get('/api/session', async (_req: Request, res: Response) => {
  let hasMessages = false;
  
  // Check if session has messages
  if (activeSessionId && sessionManager.isActive(activeSessionId)) {
    try {
      const history = await sessionManager.getHistory(activeSessionId);
      hasMessages = history.some(e => e.type === 'user.message');
    } catch {
      // Session not active or error - no messages
    }
  }
  
  res.json({
    sessionId: activeSessionId,
    cwd: process.cwd(),
    isActive: activeSessionId ? sessionManager.isActive(activeSessionId) : false,
    hasMessages
  });
});

// ============================================================
// Display Output API
// ============================================================

// Get display output by ID
app.get('/api/outputs/:id', (req: Request, res: Response) => {
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
      createdAt: output.createdAt
    });
  }
  
  // Raw data response
  res.send(data);
});

// Get preferences
app.get('/api/preferences', (_req: Request, res: Response) => {
  res.json(preferences);
});

// Update preferences
app.post('/api/preferences', async (req: Request, res: Response) => {
  const updates = req.body as Partial<UserPreferences>;
  
  // Only allow updating specific fields
  if (updates.lastModel) preferences.lastModel = updates.lastModel;
  if (updates.lastCwd) preferences.lastCwd = updates.lastCwd;
  if (updates.lastSessionId) preferences.lastSessionId = updates.lastSessionId;
  
  await savePreferences(preferences);
  res.json(preferences);
});

// Debug: raw message structure
app.get('/api/debug/messages', async (_req: Request, res: Response) => {
  try {
    if (!activeSessionId) {
      return res.json({ count: 0, messages: [] });
    }
    const events = await sessionManager.getHistory(activeSessionId);
    // Get just user and assistant messages with content
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

// Get conversation history
app.get('/api/history', async (_req: Request, res: Response) => {
  try {
    if (!activeSessionId) {
      return res.send('');
    }
    const events = await sessionManager.getHistory(activeSessionId);
    
    // Filter to user.message and assistant.message events only
    const messages = events.filter(e => 
      e.type === 'user.message' || e.type === 'assistant.message'
    );
    
    // Convert to HTML fragments
    const html = messages.map(evt => {
      const isUser = evt.type === 'user.message';
      const content = (evt.data as { content?: string })?.content || '';
      
      if (!content) return ''; // Skip empty messages
      
      if (isUser) {
        return `<div class="message user">${escapeHtml(content)}</div>`;
      } else {
        return `<div class="message assistant" data-markdown><div class="markdown-content">${escapeHtml(content)}</div></div>`;
      }
    }).filter(Boolean).join('\n');
    
    res.send(html);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.send('');
  }
});

// List all sessions grouped by cwd
app.get('/api/sessions', (_req: Request, res: Response) => {
  const grouped = sessionManager.listAllGrouped();
  res.json({
    activeSessionId,
    currentCwd: process.cwd(),
    grouped
  });
});

// Switch to a different session
app.post('/api/sessions/:sessionId/resume', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  try {
    // Stop current session first
    if (activeSessionId) {
      await sessionManager.stop(activeSessionId);
    }
    
    // Resume the requested one with current tools
    activeSessionId = await sessionManager.resume(sessionId, {
      tools: displayTools,
      excludedTools: ['view']
    });
    
    // Save to preferences
    preferences.lastSessionId = activeSessionId;
    await savePreferences(preferences);
    
    res.json({ success: true, sessionId: activeSessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  
  try {
    // Check if this is the active session
    const wasActive = sessionId === activeSessionId;
    
    // Delete the session (this will stop it if active)
    await sessionManager.delete(sessionId);
    
    // If we deleted the active session, clear our reference
    if (wasActive) {
      activeSessionId = null;
    }
    
    res.json({ success: true, wasActive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Create a new session
app.post('/api/sessions/new', async (req: Request, res: Response) => {
  try {
    // Get cwd from request body, default to process.cwd()
    const cwd = (req.body.cwd as string) || process.cwd();
    
    // Validate the path exists
    if (!existsSync(cwd)) {
      return res.status(400).json({ error: `Path does not exist: ${cwd}` });
    }
    if (!statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `Path is not a directory: ${cwd}` });
    }
    
    // Stop current session first (if any)
    if (activeSessionId) {
      await sessionManager.stop(activeSessionId);
      activeSessionId = null;
    }
    
    // Save cwd to preferences - session will be created lazily on first message
    preferences.lastSessionId = null;
    preferences.lastCwd = cwd;
    await savePreferences(preferences);
    
    console.log(`✓ New chat prepared for ${cwd} - session will create on first message`);
    res.json({ success: true, cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Streaming SSE endpoint
app.get('/api/stream', async (req: Request, res: Response) => {
  const { prompt, model, imageData } = req.query as { prompt?: string; model?: string; imageData?: string };
  
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  
  let tempFilePath: string | null = null;
  
  try {
    // Ensure session exists (create lazily with selected model if needed)
    await ensureSession(model);
    
    // Get session
    const session = sessionManager.getSession(activeSessionId!);
    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active session' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    
    const messageOptions: { prompt: string; attachments?: Array<{ type: string; path: string }> } = { prompt };
    
    // Handle image attachment if present
    if (imageData && imageData.startsWith('data:image/')) {
      const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        const extension = matches[1];
        const base64Data = matches[2];
        tempFilePath = join(tmpdir(), `copilot-image-${Date.now()}.${extension}`);
        await writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));
        messageOptions.attachments = [{ type: 'file', path: tempFilePath }];
      }
    }
    
    // Subscribe to events
    const unsubscribe = (session as unknown as { on: (cb: (event: SessionEvent) => void) => () => void }).on((event: SessionEvent) => {
      // Prepare event data
      let eventData: Record<string, unknown> = (event.data as Record<string, unknown>) || {};
      
      // For tool.execution_complete, check for output references in telemetry
      if (event.type === 'tool.execution_complete') {
        const result = (eventData.result as { content?: string }) || {};
        if (result.content) {
          try {
            const parsed = JSON.parse(result.content) as { toolTelemetry?: { outputId?: string } };
            if (parsed.toolTelemetry?.outputId) {
              const telemetry = parsed.toolTelemetry;
              const outputMeta = getOutput(telemetry.outputId!)?.metadata || {};
              eventData = {
                ...eventData,
                _output: {
                  id: telemetry.outputId,
                  type: outputMeta.type,
                  ...outputMeta
                }
              };
            }
          } catch {
            // result.content is not JSON, ignore
          }
        }
      }
      
      // Send event to client
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
      
      // End stream on terminal events
      if (event.type === 'session.idle' || event.type === 'session.error') {
        res.write('event: done\ndata: {}\n\n');
        res.end();
        unsubscribe();
        
        // Clean up temp file
        if (tempFilePath) {
          unlink(tempFilePath).catch(() => {});
        }
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      unsubscribe();
      if (tempFilePath) {
        unlink(tempFilePath).catch(() => {});
      }
    });
    
    // Send message (non-blocking)
    sessionManager.sendStream(activeSessionId!, prompt, messageOptions);
    
  } catch (error) {
    console.error('Stream error:', error);
    const message = error instanceof Error ? error.message : String(error);
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    res.write('event: done\ndata: {}\n\n');
    res.end();
    
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
  }
});

// Session event type
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

// Handle chat messages from htmx (fallback for non-streaming)
app.post('/api/message', async (req: Request, res: Response) => {
  const userMessage = req.body.message as string;
  const imageData = req.body.imageData as string | undefined;
  const model = (req.body.model as string) || 'claude-sonnet-4';
  let tempFilePath: string | null = null;

  if (!userMessage) {
    return res.send('<div class="error">Message cannot be empty</div>');
  }

  try {
    const messageOptions: { prompt: string; model: string; attachments?: Array<{ type: string; path: string }> } = { 
      prompt: userMessage, 
      model 
    };

    // Handle image attachment if present
    if (imageData && imageData.startsWith('data:image/')) {
      const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        const extension = matches[1];
        const base64Data = matches[2];
        
        tempFilePath = join(tmpdir(), `copilot-image-${Date.now()}.${extension}`);
        await writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));
        
        messageOptions.attachments = [{
          type: 'file',
          path: tempFilePath
        }];
      }
    }

    // Send message via SessionManager
    const response = await sessionManager.send(activeSessionId!, userMessage, messageOptions) as { data?: { content?: string } };

    // Clean up temp file
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }

    // Return HTML fragment for htmx to insert
    const reply = response?.data?.content || 'No response';
    const imageIndicator = imageData ? ' [img]' : '';
    res.send(`
      <div class="message user">${escapeHtml(userMessage)}${imageIndicator ? ' <span class="image-indicator">[img]</span>' : ''}</div>
      <div class="message assistant" data-markdown>
        <div class="markdown-content">${escapeHtml(reply)}</div>
      </div>
    `);
  } catch (error) {
    // Clean up temp file on error
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
    
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    res.send(`
      <div class="message error">
        <strong>Error:</strong> ${escapeHtml(message)}
      </div>
    `);
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

// Start server
async function start(): Promise<void> {
  await initSession();
  
  // Bind to localhost only for security - not exposed to network
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`✓ Server running at http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  if (activeSessionId) {
    await sessionManager.stop(activeSessionId);
  }
  process.exit(0);
});

start().catch(console.error);
