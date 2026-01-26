/**
 * Stream Routes
 * 
 * SSE streaming endpoints for chat:
 * - GET /api/stream - Stream chat response
 * - POST /api/message - Non-streaming fallback
 */

import { Router, Request, Response } from 'express';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../output-cache.js';
import { DEFAULT_MODEL } from '../preferences.js';

const router = Router();

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

// Session event type
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

// Streaming SSE endpoint
router.get('/stream', async (req: Request, res: Response) => {
  const { prompt, model, imageData, cwd } = req.query as { 
    prompt?: string; 
    model?: string; 
    imageData?: string;
    cwd?: string;
  };
  
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  
  // Definitive model logging
  console.log(`[MODEL] Route received model: ${model || '(undefined)'}`);
  if (cwd) console.log(`[CWD] Route received cwd for new session: ${cwd}`);
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  let tempFilePath: string | null = null;
  
  try {
    // Ensure session exists (pass cwd for new session creation)
    const sessionId = await sessionState.ensureSession(model, cwd);
    
    // Get session
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active session' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt };
    
    // Handle image attachment
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
    type EventCallback = (event: SessionEvent) => void;
    const unsubscribe = (session as unknown as { on: (cb: EventCallback) => () => void }).on((event: SessionEvent) => {
      let eventData: Record<string, unknown> = event.data || {};
      
      // Handle tool output references
      if (event.type === 'tool.execution_complete') {
        const result = (eventData.result as { content?: string }) || {};
        if (result.content) {
          try {
            const parsed = JSON.parse(result.content) as { toolTelemetry?: { outputId?: string } };
            if (parsed.toolTelemetry?.outputId) {
              const outputMeta = getOutput(parsed.toolTelemetry.outputId)?.metadata || {};
              eventData = {
                ...eventData,
                _output: {
                  id: parsed.toolTelemetry.outputId,
                  type: outputMeta.type,
                  ...outputMeta
                }
              };
            }
          } catch {
            // Not JSON, ignore
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
    sessionManager.sendStream(sessionId, prompt, messageOptions);
    
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

// Non-streaming fallback
router.post('/message', async (req: Request, res: Response) => {
  const userMessage = req.body.message as string;
  const imageData = req.body.imageData as string | undefined;
  const model = (req.body.model as string) || DEFAULT_MODEL;
  let tempFilePath: string | null = null;

  if (!userMessage) {
    return res.send('<div class="error">Message cannot be empty</div>');
  }

  try {
    const sessionId = await sessionState.ensureSession(model);
    
    const messageOptions: { 
      prompt: string; 
      model: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt: userMessage, model };

    // Handle image attachment
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

    const response = await sessionManager.send(sessionId, userMessage, messageOptions) as { 
      data?: { content?: string } 
    };

    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }

    const reply = response?.data?.content || 'No response';
    res.send(`
      <div class="message user">${escapeHtml(userMessage)}${imageData ? ' <span class="image-indicator">[img]</span>' : ''}</div>
      <div class="message assistant" data-markdown>
        <div class="markdown-content">${escapeHtml(reply)}</div>
      </div>
    `);
  } catch (error) {
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

export default router;
