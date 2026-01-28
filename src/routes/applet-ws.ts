/**
 * Applet WebSocket Channel
 * 
 * Unified bidirectional channel for applet ↔ server communication.
 * Handles both server-local operations (state, files) and agent-routed messages.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { setAppletUserState, getAppletUserState } from '../applet-state.js';

// Track connections by sessionId
const connections = new Map<string, Set<WebSocket>>();

// Message types from client
interface ClientMessage {
  type: 'setState' | 'getState' | 'ping';
  id?: string;  // For request/response correlation
  data?: Record<string, unknown>;
}

// Message types to client
interface ServerMessage {
  type: 'stateUpdate' | 'state' | 'pong' | 'error';
  id?: string;
  data?: unknown;
  error?: string;
}

/**
 * Setup WebSocket server on existing HTTP server
 */
export function setupAppletWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ 
    server, 
    path: '/ws/applet' 
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('session') || 'default';
    
    console.log(`[WS] Applet connected: session=${sessionId}`);
    
    // Track connection
    if (!connections.has(sessionId)) {
      connections.set(sessionId, new Set());
    }
    connections.get(sessionId)!.add(ws);
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleMessage(ws, sessionId, msg);
      } catch (err) {
        sendError(ws, undefined, 'Invalid JSON message');
      }
    });
    
    ws.on('close', () => {
      console.log(`[WS] Applet disconnected: session=${sessionId}`);
      connections.get(sessionId)?.delete(ws);
      if (connections.get(sessionId)?.size === 0) {
        connections.delete(sessionId);
      }
    });
    
    ws.on('error', (err) => {
      console.error(`[WS] Error: session=${sessionId}`, err.message);
    });
  });

  console.log('[WS] Applet WebSocket server ready on /ws/applet');
  return wss;
}

/**
 * Handle incoming message from client
 */
function handleMessage(ws: WebSocket, sessionId: string, msg: ClientMessage): void {
  switch (msg.type) {
    case 'setState':
      if (msg.data) {
        setAppletUserState(msg.data);
        // Broadcast to other connections on same session (for multi-tab sync)
        broadcastToSession(sessionId, { type: 'stateUpdate', data: msg.data }, ws);
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
 * Broadcast to all connections in a session (except sender)
 */
function broadcastToSession(sessionId: string, msg: ServerMessage, exclude?: WebSocket): void {
  const sockets = connections.get(sessionId);
  if (!sockets) return;
  
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Push state to applet connections
 * If sessionId is provided, targets that session. Otherwise broadcasts to all.
 * Called from set_applet_state MCP tool
 */
export function pushStateToApplet(sessionId: string | null, state: Record<string, unknown>): boolean {
  const msg: ServerMessage = { type: 'stateUpdate', data: state };
  const data = JSON.stringify(msg);
  
  let sent = 0;
  
  if (sessionId) {
    // Target specific session
    const sockets = connections.get(sessionId);
    if (sockets) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          sent++;
        }
      }
    }
  } else {
    // Broadcast to all sessions (localhost single-user mode)
    for (const [sid, sockets] of connections) {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          sent++;
        }
      }
    }
  }
  
  if (sent > 0) {
    console.log(`[WS] Pushed state to ${sent} connections`);
  } else {
    console.log(`[WS] No applet connections available`);
  }
  
  return sent > 0;
}

/**
 * Check if session has active applet connections
 */
export function hasAppletConnection(sessionId: string): boolean {
  const sockets = connections.get(sessionId);
  if (!sockets) return false;
  
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}
