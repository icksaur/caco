import express from 'express';
import { CopilotClient } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Initialize Copilot client
let copilotClient;
let copilotSession;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize Copilot on startup
async function initCopilot() {
  try {
    copilotClient = new CopilotClient();
    copilotSession = await copilotClient.createSession({
      model: 'gpt-4.1',
      streaming: false
    });
    console.log('✓ Copilot SDK initialized');
  } catch (error) {
    console.error('✗ Failed to initialize Copilot:', error.message);
    process.exit(1);
  }
}

// Serve chat interface
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Handle chat messages from htmx
app.post('/api/message', async (req, res) => {
  const userMessage = req.body.message;
  const imageData = req.body.imageData;
  let tempFilePath = null;

  if (!userMessage) {
    return res.send('<div class="error">Message cannot be empty</div>');
  }

  try {
    const messageOptions = { prompt: userMessage };

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

    // Send message to Copilot
    const response = await copilotSession.sendAndWait(messageOptions);

    // Clean up temp file
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {}); // Ignore errors
    }

    // Return HTML fragment for htmx to insert
    const reply = response?.data?.content || 'No response';
    const imageIndicator = imageData ? ' 📎' : '';
    res.send(`
      <div class="message user">
        <strong>You${imageIndicator}:</strong> ${escapeHtml(userMessage)}
      </div>
      <div class="message assistant">
        <strong>Copilot:</strong> ${escapeHtml(reply)}
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
  await initCopilot();
  
  app.listen(PORT, () => {
    console.log(`✓ Server running at http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n✓ Shutting down gracefully...');
  if (copilotClient) {
    await copilotClient.stop();
  }
  process.exit(0);
});

start().catch(console.error);
