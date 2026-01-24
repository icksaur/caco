import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import sessionManager from './src/session-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Current active session for this server instance
let activeSessionId = null;

// System message for sessions
const SYSTEM_MESSAGE = {
  mode: 'replace',
  content: `You are an AI assistant running in a local web application on the user's machine.

Environment:
- Platform: Web-based chat interface (browser UI, not the Copilot CLI terminal interface)
- Host: Node.js Express server using Copilot SDK
- Working Directory: ${process.cwd()}

Capabilities:
- Text conversations and problem-solving
- Image understanding (users can paste images into the chat)
- File system access (read, search, analyze files in the workspace)
- Terminal command execution (when appropriate)
- Code analysis and understanding
- General knowledge and reasoning

Interface Notes:
- This is a web chat UI, not the CLI terminal interface
- Slash commands like /help, @workspace are CLI UI features and don't apply here
- Users interact through natural conversation in the browser

Behavior:
- Provide direct, helpful answers
- Use tools when needed to access files or execute commands
- Use markdown formatting when appropriate
- Be concise unless detail is requested`
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize: discover sessions and auto-resume or create
async function initSession() {
  await sessionManager.init();
  
  const cwd = process.cwd();
  
  // Try to resume most recent session for this cwd
  const recentSessionId = sessionManager.getMostRecentForCwd(cwd);
  
  if (recentSessionId) {
    try {
      activeSessionId = await sessionManager.resume(recentSessionId);
      console.log(`✓ Resumed session ${activeSessionId}`);
      return;
    } catch (e) {
      console.warn(`Could not resume session ${recentSessionId}: ${e.message}`);
    }
  }
  
  // No existing session or resume failed - create new
  activeSessionId = await sessionManager.create(cwd, {
    model: 'gpt-4.1',
    streaming: true,
    systemMessage: SYSTEM_MESSAGE
  });
  console.log(`✓ Created new session ${activeSessionId}`);
}

// Serve chat interface
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Get session info
app.get('/api/session', (req, res) => {
  res.json({
    sessionId: activeSessionId,
    cwd: process.cwd(),
    isActive: sessionManager.isActive(activeSessionId)
  });
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
      const label = isUser ? 'You' : 'Copilot';
      const content = evt.data?.content || '';
      
      if (!content) return ''; // Skip empty messages
      
      if (isUser) {
        return `<div class="message user"><strong>${label}:</strong> ${escapeHtml(content)}</div>`;
      } else {
        return `<div class="message assistant" data-markdown><strong>${label}:</strong><div class="markdown-content">${escapeHtml(content)}</div></div>`;
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
    
    // Resume the requested one
    activeSessionId = await sessionManager.resume(sessionId);
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
    const { existsSync, statSync } = await import('fs');
    if (!existsSync(cwd)) {
      return res.status(400).json({ error: `Path does not exist: ${cwd}` });
    }
    if (!statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `Path is not a directory: ${cwd}` });
    }
    
    // Stop current session first
    if (activeSessionId) {
      await sessionManager.stop(activeSessionId);
    }
    
    // Create new with specified cwd
    activeSessionId = await sessionManager.create(cwd, {
      model: 'gpt-4.1',
      streaming: true,
      systemMessage: SYSTEM_MESSAGE
    });
    res.json({ success: true, sessionId: activeSessionId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Streaming SSE endpoint
app.get('/api/stream', async (req, res) => {
  const { prompt, model, imageData } = req.query;
  
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
    // Get session
    const session = sessionManager.getSession(activeSessionId);
    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active session' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    
    const messageOptions = { prompt, model: model || 'claude-sonnet-4' };
    
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
      // Send event to client
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data || {})}\n\n`);
      
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
});

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
      <div class="message user">
        <strong>You${imageIndicator}:</strong> ${escapeHtml(userMessage)}
      </div>
      <div class="message assistant" data-markdown>
        <strong>Copilot:</strong>
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
