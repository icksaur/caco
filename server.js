import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import sessionManager from './src/session-manager.js';
import { createDisplayTools } from './src/display-tools.js';
import { storeOutput, getOutput, detectLanguage } from './src/output-cache.js';
import { loadPreferences, savePreferences, getDefaultPreferences } from './src/preferences.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Current preferences (loaded on startup)
let preferences = getDefaultPreferences();

// Current active session for this server instance
let activeSessionId = null;

// Create display-only tools (use output cache for zero-context display)
const displayTools = createDisplayTools(storeOutput, detectLanguage);

// System message for sessions
const SYSTEM_MESSAGE = {
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
app.use((req, res, next) => {
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
async function initSession() {
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
      console.warn(`Could not resume last session: ${e.message}`);
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
      console.warn(`Could not resume session ${recentSessionId}: ${e.message}`);
    }
  }
  
  // No existing session - will create lazily on first message
  console.log('✓ No existing session - will create on first message');
}

// Helper to create session lazily with specified model
async function ensureSession(model) {
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
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Get session info
app.get('/api/session', async (req, res) => {
  let hasMessages = false;
  
  // Check if session has messages
  if (activeSessionId && sessionManager.isActive(activeSessionId)) {
    try {
      const history = await sessionManager.getHistory(activeSessionId);
      hasMessages = history.some(e => e.type === 'user.message');
    } catch (_e) {
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
app.get('/api/outputs/:id', (req, res) => {
  const output = getOutput(req.params.id);
  if (!output) {
    return res.status(404).json({ error: 'Output expired or not found' });
  }
  
  const { data, metadata } = output;
  
  // Set appropriate content type
  if (metadata.mimeType) {
    res.setHeader('Content-Type', metadata.mimeType);
  } else if (metadata.type === 'file' || metadata.type === 'terminal') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  
  // For JSON response with metadata
  if (req.query.format === 'json') {
    return res.json({
      id: req.params.id,
      data: typeof data === 'string' ? data : data.toString('base64'),
      metadata,
      createdAt: output.createdAt
    });
  }
  
  // Raw data response
  res.send(data);
});

// Get preferences
app.get('/api/preferences', (req, res) => {
  res.json(preferences);
});

// Update preferences
app.post('/api/preferences', async (req, res) => {
  const updates = req.body;
  
  // Only allow updating specific fields
  if (updates.lastModel) preferences.lastModel = updates.lastModel;
  if (updates.lastCwd) preferences.lastCwd = updates.lastCwd;
  if (updates.lastSessionId) preferences.lastSessionId = updates.lastSessionId;
  
  await savePreferences(preferences);
  res.json(preferences);
});

// Debug: raw message structure
app.get('/api/debug/messages', async (req, res) => {
  try {
    const events = await sessionManager.getHistory(activeSessionId);
    // Get just user and assistant messages with content
    const msgs = events
      .filter(e => e.type === 'user.message' || e.type === 'assistant.message')
      .map(e => ({
        type: e.type,
        content: e.data?.content,
        hasToolRequests: !!e.data?.toolRequests?.length
      }));
    res.json({ count: msgs.length, messages: msgs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get conversation history
app.get('/api/history', async (req, res) => {
  try {
    const events = await sessionManager.getHistory(activeSessionId);
    
    // Filter to user.message and assistant.message events only
    const messages = events.filter(e => 
      e.type === 'user.message' || e.type === 'assistant.message'
    );
    
    // Convert to HTML fragments
    const html = messages.map(evt => {
      const isUser = evt.type === 'user.message';
      const content = evt.data?.content || '';
      
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
app.get('/api/sessions', (req, res) => {
  const grouped = sessionManager.listAllGrouped();
  res.json({
    activeSessionId,
    currentCwd: process.cwd(),
    grouped
  });
});

// Switch to a different session
app.post('/api/sessions/:sessionId/resume', async (req, res) => {
  const { sessionId } = req.params;
  
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
    res.status(400).json({ error: error.message });
  }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
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
    res.status(400).json({ error: error.message });
  }
});

// Create a new session
app.post('/api/sessions/new', async (req, res) => {
  try {
    // Get cwd from request body, default to process.cwd()
    const cwd = req.body.cwd || process.cwd();
    
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
    res.status(400).json({ error: error.message });
  }
});

// Streaming SSE endpoint (supports both GET and POST)
// POST is required for large payloads like images
app.post('/api/stream', express.json({ limit: '50mb' }), handleStream);
app.get('/api/stream', handleStream);

async function handleStream(req, res) {
  // Support both query params (GET) and body (POST)
  const prompt = req.body?.prompt || req.query.prompt;
  const model = req.body?.model || req.query.model;
  const imageData = req.body?.imageData || req.query.imageData;
  
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  
  let tempFilePath = null;
  
  try {
    // Ensure session exists (create lazily with selected model if needed)
    await ensureSession(model);
    
    // Get session
    const session = sessionManager.getSession(activeSessionId);
    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active session' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    
    const messageOptions = { prompt };
    
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
    const unsubscribe = session.on((event) => {
      // Prepare event data
      let eventData = event.data || {};
      
      // For tool.execution_complete, check for output references in telemetry
      // The SDK wraps our return value as JSON string inside result.content
      if (event.type === 'tool.execution_complete' && eventData.result?.content) {
        try {
          const parsed = JSON.parse(eventData.result.content);
          if (parsed.toolTelemetry?.outputId) {
            const telemetry = parsed.toolTelemetry;
            const outputMeta = getOutput(telemetry.outputId)?.metadata || {};
            // Add output info to event data for UI
            eventData = {
              ...eventData,
              _output: {
                id: telemetry.outputId,
                type: outputMeta.type,
                ...outputMeta
              }
            };
          }
        } catch (_e) {
          // result.content is not JSON, ignore
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
    await sessionManager.sendStream(activeSessionId, prompt, messageOptions);
    
  } catch (error) {
    console.error('Stream error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    res.write('event: done\ndata: {}\n\n');
    res.end();
    
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }
  }
}

// Handle chat messages from htmx (fallback for non-streaming)
app.post('/api/message', async (req, res) => {
  const userMessage = req.body.message;
  const imageData = req.body.imageData;
  const model = req.body.model || 'claude-sonnet-4';
  let tempFilePath = null;

  if (!userMessage) {
    return res.send('<div class="error">Message cannot be empty</div>');
  }

  try {
    const messageOptions = { prompt: userMessage, model };

    // Handle image attachment if present
    if (imageData && imageData.startsWith('data:image/')) {
      // Extract base64 data and image type
      const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        const extension = matches[1];
        const base64Data = matches[2];
        
        // Create temp file
        tempFilePath = join(tmpdir(), `copilot-image-${Date.now()}.${extension}`);
        await writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));
        
        // Add attachment to message
        messageOptions.attachments = [{
          type: 'file',
          path: tempFilePath
        }];
      }
    }

    // Send message via SessionManager
    const response = await sessionManager.send(activeSessionId, userMessage, messageOptions);

    // Clean up temp file
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {}); // Ignore errors
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
    res.send(`
      <div class="message error">
        <strong>Error:</strong> ${escapeHtml(error.message)}
      </div>
    `);
  }
});

// HTML escape helper
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Start server
async function start() {
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
