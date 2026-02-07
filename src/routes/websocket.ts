/**
 * WebSocket Server
 * 
 * Unified bidirectional channel for all client-server communication:
 * - Chat message streaming (user & assistant)
 * - Activity items (tool calls, intents, errors)
 * - History loading
 * - State sync
 * - Agent-to-agent messages
 * 
 * Single persistent connection - server broadcasts ALL messages, client filters.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { setAppletUserState, getAppletUserState } from '../applet-state.js';
import { registerStatePushHandler } from '../applet-push.js';
import sessionManager from '../session-manager.js';
import { shouldFilter } from '../event-filter.js';
import { transformForClient } from '../event-transformer.js';
import { parseMessageSource, type MessageSource } from '../message-source.js';
import { listEmbedOutputs, parseOutputMarkers } from '../storage.js';
import { CacoEventQueue, isFlushTrigger, type CacoEvent } from '../caco-event-queue.js';
import { normalizeToolComplete, extractToolResultText, type RawSDKEvent } from '../sdk-normalizer.js';
import { unobservedTracker } from '../unobserved-tracker.js';

const allConnections = new Set<WebSocket>();
const sessionSubscribers = new Map<string, Set<WebSocket>>();
const clientSubscription = new Map<WebSocket, string>();

// Re-export MessageSource from shared module for backward compatibility
export type { MessageSource } from '../message-source.js';

interface ClientMessage {
  type: 'setState' | 'getState' | 'sendMessage' | 'requestHistory' | 'ping' | 'subscribe';
  id?: string;  // For request/response correlation
  sessionId?: string;  // For requestHistory and subscribe
  data?: Record<string, unknown>;
  // For sendMessage
  content?: string;
  imageData?: string;
  source?: MessageSource;
  appletSlug?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  timestamp: string;
  source: MessageSource;
  appletSlug?: string;
  hasImage: boolean;
}

export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;  // Allow additional SDK event properties
}

interface ServerMessage {
  type: 'stateUpdate' | 'state' | 'event' | 'globalEvent' | 'historyComplete' | 'pong' | 'error';
  id?: string;
  sessionId?: string;  // For session-scoped broadcasts (client filters by this)
  data?: unknown;
  event?: SessionEvent;
  error?: string;
}

/**
 * Setup WebSocket server on existing HTTP server
 * Single persistent connection - no session in URL
 */
export function setupWebSocket(server: Server): WebSocketServer {
  // Register the push handler so applet-tools can push state without direct import
  registerStatePushHandler(pushStateToAppletInternal);
  
  // Wire up UnobservedTracker broadcast to use global WebSocket broadcast
  unobservedTracker.setBroadcast((event) => {
    broadcastGlobalEvent(event);
  });
  
  const wss = new WebSocketServer({ 
    server, 
    path: '/ws' 
  });

  wss.on('connection', (ws, req) => {
    // Track in global pool
    allConnections.add(ws);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleMessage(ws, msg);
      } catch (err) {
        sendError(ws, undefined, 'Invalid JSON message');
      }
    });
    
    ws.on('close', () => {
      allConnections.delete(ws);
      
      // Clean up subscription
      const oldSessionId = clientSubscription.get(ws);
      if (oldSessionId) {
        sessionSubscribers.get(oldSessionId)?.delete(ws);
        clientSubscription.delete(ws);
      }
    });
    
    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  return wss;
}

/**
 * Handle incoming message from client
 */
function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case 'setState':
      if (msg.data) {
        setAppletUserState(msg.data);
        // Broadcast to all connections (for multi-tab sync)
        broadcastToAll({ type: 'stateUpdate', data: msg.data }, ws);
      }
      break;
    
    case 'sendMessage':
      // This is unused now - messages go via POST
      sendError(ws, msg.id, 'Use POST /api/sessions/:id/messages instead');
      break;
      
    case 'requestHistory':
      if (msg.sessionId) {
        void streamHistory(ws, msg.sessionId);
      } else {
        sendError(ws, msg.id, 'sessionId is required for requestHistory');
      }
      break;
      
    case 'getState':
      send(ws, { type: 'state', id: msg.id, data: getAppletUserState() });
      break;
      
    case 'ping':
      send(ws, { type: 'pong', id: msg.id });
      break;
    
    case 'subscribe':
      if (msg.sessionId) {
        // Unsubscribe from previous session
        const oldSessionId = clientSubscription.get(ws);
        if (oldSessionId && oldSessionId !== msg.sessionId) {
          sessionSubscribers.get(oldSessionId)?.delete(ws);
        }
        
        // Subscribe to new session
        if (!sessionSubscribers.has(msg.sessionId)) {
          sessionSubscribers.set(msg.sessionId, new Set());
        }
        sessionSubscribers.get(msg.sessionId)!.add(ws);
        clientSubscription.set(ws, msg.sessionId);
      }
      break;
      
    default:
      sendError(ws, msg.id, `Unknown message type: ${msg.type}`);
  }
}

/**
 * Send message to a specific WebSocket
 */
function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Send error message
 */
function sendError(ws: WebSocket, id: string | undefined, error: string): void {
  send(ws, { type: 'error', id, error });
}

/**
 * Broadcast to all connections (except optional sender)
 */
function broadcastToAll(msg: ServerMessage, exclude?: WebSocket): void {
  const data = JSON.stringify(msg);
  for (const ws of allConnections) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Broadcast a global event to ALL clients (no session filtering)
 * Used for events that affect the session list UI regardless of active session
 */
export function broadcastGlobalEvent(event: SessionEvent): void {
  const msg: ServerMessage = { type: 'globalEvent', event };
  broadcastToAll(msg);
}

/**
 * Push state to applet connections (internal implementation)
 * Broadcasts to all connections (client filters by active session)
 */
function pushStateToAppletInternal(sessionId: string | null, state: Record<string, unknown>): boolean {
  const msg: ServerMessage = { type: 'stateUpdate', sessionId: sessionId || undefined, data: state };
  const data = JSON.stringify(msg);
  
  let sent = 0;
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      sent++;
    }
  }
  
  return sent > 0;
}

/**
 * Push state to applet connections
 * @deprecated Import from applet-push.js instead
 */
export function pushStateToApplet(sessionId: string | null, state: Record<string, unknown>): boolean {
  return pushStateToAppletInternal(sessionId, state);
}

/**
 * Check if there are any active connections
 */
export function hasAppletConnection(_sessionId: string): boolean {
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * Enrich user.message events with source metadata by parsing content prefix.
 * For history replay: SDK stores [applet:slug], [agent:id], [scheduler:slug] prefixes.
 * This parses them and adds source/identifier to event data, with clean content.
 */
function enrichUserMessageWithSource(event: SessionEvent): SessionEvent {
  if (event.type !== 'user.message') return event;
  
  const data = event.data || {};
  const content = typeof data.content === 'string' ? data.content : '';
  
  // If already has source (live streaming), return as-is
  if (data.source && data.source !== 'user') return event;
  
  const parsed = parseMessageSource(content);
  if (parsed.source === 'user') return event;
  
  // Enrich with parsed source
  return {
    ...event,
    data: {
      ...data,
      content: parsed.cleanContent,
      source: parsed.source,
      // Add identifier to appropriate field based on source
      ...(parsed.source === 'applet' && { appletSlug: parsed.identifier }),
      ...(parsed.source === 'agent' && { fromSession: parsed.identifier }),
      ...(parsed.source === 'scheduler' && { scheduleSlug: parsed.identifier }),
    }
  };
}

/**
 * Stream session history to a client on demand
 * Converts SDK events to ChatMessage format and sends individually
 * All messages include sessionId for client filtering
 */
async function streamHistory(ws: WebSocket, sessionId: string): Promise<void> {
  if (!sessionId || sessionId === 'default') {
    // No session, just send historyComplete
    send(ws, { type: 'historyComplete', sessionId });
    return;
  }
  
  try {
    const events = await sessionManager.getHistory(sessionId);
    
    // Build lookup: outputId → embed metadata
    // Used to queue caco.embed after tool.execution_complete that created it
    const embedLookup = new Map<string, { provider: string; title: string }>();
    for (const { outputId, metadata } of listEmbedOutputs(sessionId)) {
      embedLookup.set(outputId, {
        provider: (metadata.provider as string) || 'unknown',
        title: (metadata.title as string) || 'Embedded content'
      });
    }
    console.log(`[HISTORY] Loaded ${embedLookup.size} embeds for session ${sessionId}`);
    
    // Queue for scheduling caco events - same pattern as live streaming
    const queue = new CacoEventQueue();
    
    // Forward all SDK events
    // Queue caco.embed after tool.execution_complete, flush before assistant.message
    for (const evt of events) {
      // Flush queued embeds before trigger events (same as live stream)
      if (isFlushTrigger(evt.type)) {
        const queued = queue.flush();
        if (queued.length > 0) {
          console.log(`[HISTORY] Flushing ${queued.length} embeds before ${evt.type}`);
          for (const cacoEvent of queued) {
            send(ws, { type: 'event', sessionId, event: cacoEvent as unknown as SessionEvent });
          }
        }
      }
      
      // Send SDK event
      if (!shouldFilter(evt)) {
        for (const transformed of transformForClient(evt)) {
          // Parse user.message content for source prefix (from applet/agent/scheduler)
          const enriched = enrichUserMessageWithSource(transformed);
          send(ws, { type: 'event', sessionId, event: enriched });
        }
      }
      
      // After tool.execution_complete, queue any embeds it created
      // Use normalizer to handle SDK format inconsistencies
      const toolComplete = normalizeToolComplete(evt as RawSDKEvent);
      if (toolComplete) {
        const content = extractToolResultText(toolComplete.resultContent);
        
        if (content) {
          // Parse [output:xxx] markers from tool result
          const outputIds = parseOutputMarkers(content);
          
          for (const outputId of outputIds) {
            const embed = embedLookup.get(outputId);
            if (embed) {
              // Queue caco.embed event (will flush before next assistant.message)
              queue.queue({
                type: 'caco.embed',
                data: {
                  outputId,
                  provider: embed.provider,
                  title: embed.title
                }
              } as CacoEvent);
              
              // Remove from lookup so we don't queue again
              embedLookup.delete(outputId);
            }
          }
        }
      }
    }
    
    // Flush any remaining queued embeds
    const remaining = queue.flush();
    if (remaining.length > 0) {
      console.log(`[HISTORY] Flushing ${remaining.length} remaining embeds at end`);
      for (const cacoEvent of remaining) {
        send(ws, { type: 'event', sessionId, event: cacoEvent as unknown as SessionEvent });
      }
    }
    
    // Log unmatched embeds (shouldn't happen normally)
    if (embedLookup.size > 0) {
      console.log(`[HISTORY] ${embedLookup.size} unmatched embeds (no tool.execution_complete found)`);
    }
    
    send(ws, { type: 'historyComplete', sessionId });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WS] Error streaming history for ${sessionId}:`, error);
    
    // Check if SDK session expired
    if (message.includes('Session not found') || message.includes('session.getMessages failed')) {
      console.log(`[WS] Session ${sessionId} expired on SDK side, cleaning up`);
      await sessionManager.stop(sessionId).catch(() => {});
      send(ws, { type: 'error', error: 'Session expired - please start a new session' });
    }
    
    send(ws, { type: 'historyComplete', sessionId });
  }
}

/**
 * Broadcast an SDK event to subscribed clients only
 * Used for all session events - messages, activity, etc.
 * 
 * user.message events are enriched with source metadata by parsing the
 * [applet:slug], [agent:id], or [scheduler:slug] prefix.
 */
export function broadcastEvent(
  sessionId: string,
  event: SessionEvent
): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0 || shouldFilter(event)) {
    return;
  }
  
  // Enrich user.message with source metadata (same as history replay)
  const enriched = enrichUserMessageWithSource(event);
  
  const msg: ServerMessage = { type: 'event', sessionId, event: enriched };
  const data = JSON.stringify(msg);
  
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
