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

// Global connection pool - all clients, not per-session
const allConnections = new Set<WebSocket>();

/**
 * Message source identifies who sent a message.
 * Extensible: add new sources here (e.g., 'agent' for agent-to-agent).
 */
export type MessageSource = 'user' | 'applet' | 'agent';

// Message types from client
interface ClientMessage {
  type: 'setState' | 'getState' | 'sendMessage' | 'requestHistory' | 'ping';
  id?: string;  // For request/response correlation
  sessionId?: string;  // For requestHistory
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
}

// Activity item for tool calls, intents, errors
export interface ActivityItem {
  type: 'turn' | 'intent' | 'tool' | 'tool-result' | 'error' | 'info';
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
    console.log(`[WS] Client connected`);
    
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
      console.log(`[WS] Client disconnected`);
      allConnections.delete(ws);
    });
    
    ws.on('error', (err) => {
      console.error(`[WS] Error:`, err.message);
    });
  });

  console.log('[WS] WebSocket server ready on /ws');
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
  
  if (sent > 0) {
    console.log(`[WS] Pushed state to ${sent} connections`);
  } else {
    console.log(`[WS] No connections available`);
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
  console.log(`[WS] Broadcast user message for session ${sessionId}`);
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
    let messageCount = 0;
    
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
        messageCount++;
      }
    }
    
    send(ws, { type: 'historyComplete', sessionId });
    console.log(`[WS] Streamed ${messageCount} history messages for session ${sessionId}`);
    
  } catch (error) {
    console.error(`[WS] Error streaming history for ${sessionId}:`, error);
    send(ws, { type: 'historyComplete' });
  }
}

/**
 * Broadcast a message update to all connected clients
 * Used for streaming assistant responses - can create, append, or finalize
 * All clients receive the message; they filter by sessionId
 */
export function broadcastMessage(
  sessionId: string,
  message: ChatMessage
): void {
  if (allConnections.size === 0) {
    console.log(`[WS] No connections to broadcast to for session ${sessionId}`);
    return;
  }
  
  const now = Date.now();
  console.log(`[WS:${now}] Broadcasting to ${allConnections.size} sockets (session ${sessionId}): ${message.role} ${message.status || '-'} ${message.deltaContent ? `delta(${message.deltaContent.length})` : (message.source ? `source=${message.source}` : '')}`);
  
  // Include sessionId so clients can filter
  const msg: ServerMessage = { type: 'message', sessionId, message };
  const data = JSON.stringify(msg);
  
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Broadcast an activity item to all connected clients
 * Used for tool calls, intents, errors during agent response
 * All clients receive the activity; they filter by sessionId
 */
export function broadcastActivity(
  sessionId: string,
  item: ActivityItem
): void {
  if (allConnections.size === 0) return;
  
  // Include sessionId so clients can filter
  const msg: ServerMessage = { type: 'activity', sessionId, item };
  const data = JSON.stringify(msg);
  
  for (const ws of allConnections) {
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
  if (allConnections.size === 0) return;
  
  const msg: ServerMessage = { type: 'output', sessionId, outputId };
  const data = JSON.stringify(msg);
  
  for (const ws of allConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
