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
import { randomUUID } from 'crypto';
import { setAppletUserState, getAppletUserState } from '../applet-state.js';
import sessionManager from '../session-manager.js';
import { shouldFilter } from '../event-filter.js';

// Global connection pool - all clients
const allConnections = new Set<WebSocket>();

// Session subscriptions: sessionId → Set of subscribed WebSockets
const sessionSubscribers = new Map<string, Set<WebSocket>>();

// Reverse lookup: WebSocket → subscribed sessionId (one subscription per client)
const clientSubscription = new Map<WebSocket, string>();

/**
 * Message source identifies who sent a message.
 * Extensible: add new sources here (e.g., 'agent' for agent-to-agent).
 */
export type MessageSource = 'user' | 'applet' | 'agent';

// Message types from client
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

// User message structure (echoed back to client for rendering)
export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  timestamp: string;
  source: MessageSource;
  appletSlug?: string;
  hasImage: boolean;
}

// SDK event - passed through as-is
export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface ServerMessage {
  type: 'stateUpdate' | 'state' | 'event' | 'historyComplete' | 'pong' | 'error';
  id?: string;
  sessionId?: string;  // All broadcasts include sessionId for client filtering
  data?: unknown;
  event?: SessionEvent;
  error?: string;
}

/**
 * Setup WebSocket server on existing HTTP server
 * Single persistent connection - no session in URL
 */
export function setupWebSocket(server: Server): WebSocketServer {
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
      console.error(`[WS] Error:`, err.message);
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
        streamHistory(ws, msg.sessionId);
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
 * Push state to applet connections
 * Broadcasts to all connections (client filters by active session)
 * Called from set_applet_state MCP tool
 */
export function pushStateToApplet(sessionId: string | null, state: Record<string, unknown>): boolean {
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
 * Check if there are any active connections
 */
export function hasAppletConnection(_sessionId: string): boolean {
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * Broadcast user message from HTTP POST handler
 * Called when server receives a message via REST API
 * Broadcasts to ALL clients - they filter by sessionId
 */
export function broadcastUserMessageFromPost(
  sessionId: string,
  content: string,
  hasImage: boolean,
  source: MessageSource = 'user',
  appletSlug?: string,
  fromSession?: string
): void {
  // Create a user.message event
  const event: SessionEvent = {
    type: 'user.message',
    data: {
      content,
      source,
      appletSlug,
      fromSession,
      hasImage
    }
  };
  
  broadcastEvent(sessionId, event);
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
    
    // Forward all SDK events, filtered
    for (const evt of events) {
      if (!shouldFilter(evt)) {
        send(ws, { type: 'event', sessionId, event: evt });
      }
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
 */
export function broadcastEvent(
  sessionId: string,
  event: SessionEvent
): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0 || shouldFilter(event)) {
    return;
  }
  
  const msg: ServerMessage = { type: 'event', sessionId, event };
  const data = JSON.stringify(msg);
  
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
