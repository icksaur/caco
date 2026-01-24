import express from 'express';
import { CopilotClient } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

  if (!userMessage) {
    return res.send('<div class="error">Message cannot be empty</div>');
  }

  try {
    // Send message to Copilot
    const response = await copilotSession.sendAndWait({
      prompt: userMessage
    });

    // Return HTML fragment for htmx to insert
    const reply = response?.data?.content || 'No response';
    res.send(`
      <div class="message user">
        <strong>You:</strong> ${escapeHtml(userMessage)}
      </div>
      <div class="message assistant">
        <strong>Copilot:</strong> ${escapeHtml(reply)}
      </div>
    `);
  } catch (error) {
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
