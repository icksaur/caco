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

// Message types to client
// ChatMessage for history and live messages
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;           // Full content (create or replace)
  deltaContent?: string;      // Append to existing (streaming)
  status?: 'streaming' | 'complete';  // Defaults to 'complete'
  timestamp?: string;
  source?: MessageSource;
  appletSlug?: string;        // For applet source messages
  fromSession?: string;       // For agent source messages
  hasImage?: boolean;
  // For assistant messages
  outputs?: string[];  // Output IDs
  activityIds?: string[];  // Activity IDs
}

// Activity item for tool calls, intents, errors
export interface ActivityItem {
  type: 'turn' | 'intent' | 'tool' | 'tool-result' | 'error' | 'info' | 'reasoning' | 'reasoning-delta' | 'header-update';
  text: string;
  details?: string;
}

interface ServerMessage {
  type: 'stateUpdate' | 'state' | 'message' | 'activity' | 'output' | 'historyComplete' | 'pong' | 'error';
  id?: string;
  sessionId?: string;  // All broadcasts include sessionId for client filtering
  data?: unknown;
  message?: ChatMessage;
  item?: ActivityItem;
  outputId?: string;   // For output type: ID to fetch and render
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
  const message: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    source,
    appletSlug,
    fromSession,
    hasImage
  };
  
  broadcastMessage(sessionId, message);
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
    
    // Track outputs from tool completions for assistant messages
    const pendingOutputs: string[] = [];
    
    for (const evt of events) {
      // Collect output IDs from tool completions
      if (evt.type === 'tool.execution_complete') {
        const result = (evt.data as { result?: { content?: string } })?.result;
        if (result?.content) {
          const matches = result.content.matchAll(/\[output:([^\]]+)\]/g);
          pendingOutputs.push(...[...matches].map(m => m[1]));
        }
      }
      
      // Convert message events to ChatMessage
      if (evt.type === 'user.message' || evt.type === 'assistant.message') {
        const isUser = evt.type === 'user.message';
        let content = (evt.data as { content?: string })?.content || '';
        
        // Parse applet/agent marker from user messages: [applet:slug] or [agent:sessionId]
        let source: MessageSource = 'user';
        let appletSlug: string | undefined;
        let fromSession: string | undefined;
        
        if (isUser) {
          const appletMatch = content.match(/^\[applet:([^\]]+)\]\s*/);
          const agentMatch = content.match(/^\[agent:([^\]]+)\]\s*/);
          if (appletMatch) {
            source = 'applet';
            appletSlug = appletMatch[1];
            content = content.slice(appletMatch[0].length);
          } else if (agentMatch) {
            source = 'agent';
            fromSession = agentMatch[1];
            content = content.slice(agentMatch[0].length);
          }
        }
        
        if (!content && pendingOutputs.length === 0) continue;
        
        const message: ChatMessage = {
          id: randomUUID(),
          role: isUser ? 'user' : 'assistant',
          content,
          timestamp: new Date().toISOString(),
          source: isUser ? source : undefined,
          appletSlug: isUser ? appletSlug : undefined,
          fromSession: isUser ? fromSession : undefined,
          outputs: isUser ? undefined : [...pendingOutputs]
        };
        
        // Clear pending outputs after assistant message
        if (!isUser) {
          pendingOutputs.length = 0;
        }
        
        // Include sessionId for client filtering
        send(ws, { type: 'message', sessionId, message });
      }
    }
    
    send(ws, { type: 'historyComplete', sessionId });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[WS] Error streaming history for ${sessionId}:`, error);
    
    // Check if SDK session expired
    if (message.includes('Session not found') || message.includes('session.getMessages failed')) {
      // Session expired on SDK side - clean up our state
      console.log(`[WS] Session ${sessionId} expired on SDK side, cleaning up`);
      await sessionManager.stop(sessionId).catch(() => {});
      send(ws, { type: 'error', error: 'Session expired - please start a new session' });
    }
    
    send(ws, { type: 'historyComplete', sessionId });
  }
}

/**
 * Broadcast a message update to subscribed clients only
 * Used for streaming assistant responses - can create, append, or finalize
 */
export function broadcastMessage(
  sessionId: string,
  message: ChatMessage
): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }
  
  const msg: ServerMessage = { type: 'message', sessionId, message };
  const data = JSON.stringify(msg);
  
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Broadcast an activity item to subscribed clients only
 * Used for tool calls, intents, errors during agent response
 */
export function broadcastActivity(
  sessionId: string,
  item: ActivityItem
): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0) return;
  
  const msg: ServerMessage = { type: 'activity', sessionId, item };
  const data = JSON.stringify(msg);
  
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Broadcast an output to render immediately
 * Used for display-only tools (embed_media, render_file_contents, etc.)
 * Client fetches output data and renders into pending response
 */
export function broadcastOutput(
  sessionId: string,
  outputId: string
): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0) return;
  
  const msg: ServerMessage = { type: 'output', sessionId, outputId };
  const data = JSON.stringify(msg);
  
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
