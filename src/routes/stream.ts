/**
 * Stream Routes
 * 
 * Separated concerns:
 * - POST /api/message - Accept message+image, return streamId
 * - GET /api/stream/:streamId - SSE connection for response streaming
 * 
 * This separation allows:
 * - Large image uploads via POST body (not URL params)
 * - Lightweight SSE connections via GET
 * - htmx-friendly patterns
 */

import { Router, Request, Response } from 'express';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import sessionManager from '../session-manager.js';
import { sessionState } from '../session-state.js';
import { getOutput } from '../storage.js';
import { getApplet } from '../applet-state.js';
import { DEFAULT_MODEL } from '../preferences.js';
import { parseImageDataUrl } from '../image-utils.js';

const router = Router();

// Pending message storage (streamId -> message data)
interface PendingMessage {
  prompt: string;
  model: string;
  imageData?: string;
  newChat?: boolean;
  cwd?: string;
  tempFilePath?: string;
  createdAt: number;
}

const pendingMessages = new Map<string, PendingMessage>();

// Clean up old pending messages (older than 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, msg] of pendingMessages.entries()) {
    if (now - msg.createdAt > 5 * 60 * 1000) {
      pendingMessages.delete(id);
      if (msg.tempFilePath) {
        unlink(msg.tempFilePath).catch(() => {});
      }
    }
  }
}, 60 * 1000);

// Session event type
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * POST /api/message - Accept message with optional image, return streamId
 * 
 * This is the "send" endpoint. It:
 * 1. Validates the request
 * 2. Saves any image to a temp file
 * 3. Returns a streamId for SSE connection
 * 
 * The actual message is sent when the client connects to GET /api/stream/:streamId
 */
router.post('/message', async (req: Request, res: Response) => {
  const { prompt, model, imageData, newChat, cwd } = req.body as {
    prompt?: string;
    model?: string;
    imageData?: string;
    newChat?: boolean;
    cwd?: string;
  };
  
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  
  let tempFilePath: string | undefined;
  
  // Pre-process image if present (save to temp file now)
  const parsed = parseImageDataUrl(imageData);
  if (parsed) {
    tempFilePath = join(tmpdir(), `copilot-image-${Date.now()}.${parsed.extension}`);
    await writeFile(tempFilePath, Buffer.from(parsed.base64Data, 'base64'));
  }
  
  // Generate streamId and store pending message
  const streamId = randomUUID();
  pendingMessages.set(streamId, {
    prompt,
    model: model || DEFAULT_MODEL,
    imageData,
    newChat,
    cwd,
    tempFilePath,
    createdAt: Date.now()
  });
  
  console.log(`[STREAM] Created streamId ${streamId} for prompt: ${prompt.substring(0, 50)}...`);
  
  res.json({ streamId });
});

/**
 * GET /api/stream/:streamId - SSE connection for response streaming
 * 
 * This is the "receive" endpoint. It:
 * 1. Looks up the pending message by streamId
 * 2. Sends the message to the SDK
 * 3. Streams events back to the client
 */
router.get('/stream/:streamId', async (req: Request, res: Response) => {
  const streamId = req.params.streamId as string;
  
  const pending = pendingMessages.get(streamId);
  if (!pending) {
    res.status(404).json({ error: 'Stream not found or expired' });
    return;
  }
  
  // Remove from pending (one-time use)
  pendingMessages.delete(streamId);
  
  const { prompt, model, newChat, cwd, tempFilePath } = pending;
  
  console.log(`[STREAM] Connecting to stream ${streamId}, model: ${model || '(undefined)'}`);
  if (newChat) console.log(`[NEW CHAT] Creating new session with cwd: ${cwd}`);
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  try {
    // Ensure session exists (explicit newChat flag, optional cwd)
    const sessionId = await sessionState.ensureSession(model, newChat, cwd);
    
    // Get session
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No active session' })}\n\n`);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }
    
    const messageOptions: { 
      prompt: string; 
      attachments?: Array<{ type: string; path: string }> 
    } = { prompt };
    
    // Add image attachment if present
    if (tempFilePath) {
      messageOptions.attachments = [{ type: 'file', path: tempFilePath }];
    }
    
    // Subscribe to events
    type EventCallback = (event: SessionEvent) => void;
    const unsubscribe = (session as unknown as { on: (cb: EventCallback) => () => void }).on((event: SessionEvent) => {
      let eventData: Record<string, unknown> = event.data || {};
      
      // Handle tool output references
      if (event.type === 'tool.execution_complete') {
        // toolTelemetry is at the top level of eventData (SDK puts it there)
        const toolTelemetry = eventData.toolTelemetry as { 
          outputId?: string;
          appletSet?: boolean;
        } | undefined;
        
        // Display tool output reference
        if (toolTelemetry?.outputId) {
          const storedOutput = getOutput(toolTelemetry.outputId);
          const outputMeta = storedOutput?.metadata;
          if (outputMeta) {
            eventData = {
              ...eventData,
              _output: {
                id: toolTelemetry.outputId,
                ...outputMeta
              }
            };
          }
        }
        
        // Applet content set - include full content for client-side execution
        if (toolTelemetry?.appletSet) {
          const appletContent = getApplet();
          if (appletContent) {
            eventData = {
              ...eventData,
              _applet: appletContent
            };
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

export default router;

