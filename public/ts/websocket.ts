/**
 * WebSocket Client
 * 
 * Single persistent WebSocket connection for all client-server communication:
 * - Chat message streaming (user & assistant)
 * - Activity items (tool calls, intents, errors)
 * - History loading
 * - State sync
 * - Agent-to-agent messages
 * 
 * Connect once on page load. Server broadcasts ALL messages with sessionId.
 * Client filters by active session.
 */

import { showToast } from './toast.js';
import { getActiveSessionId } from './app-state.js';
import type { SessionEvent } from './types.js';

/**
 * Message source identifies who sent a message.
 * Extensible: add new sources here (e.g., 'agent' for agent-to-agent).
 */
export type MessageSource = 'user' | 'applet' | 'agent';

// Re-export SessionEvent for consumers that import from websocket.ts
export type { SessionEvent };

let socket: WebSocket | null = null;
let connectionId = 0;  // Incremented on each new connection
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

type StateCallback = (state: Record<string, unknown>) => void;
type EventCallback = (event: SessionEvent) => void;
type HistoryCompleteCallback = () => void;
type ConnectCallback = () => void;
type GlobalEventCallback = (event: SessionEvent) => void;
const stateCallbacks: Set<StateCallback> = new Set();
const eventCallbacks: Set<EventCallback> = new Set();
const historyCompleteCallbacks: Set<HistoryCompleteCallback> = new Set();
const connectCallbacks: Set<ConnectCallback> = new Set();
const globalEventCallbacks: Set<GlobalEventCallback> = new Set();

const pendingRequests = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}>();
let requestId = 0;

/**
 * Connect to the WebSocket server (call once on page load).
 * No session parameter - server broadcasts all, client filters.
 */
export function connectWs(): void {
  console.log(`[WS] connectWs called, socket state: ${socket?.readyState ?? 'null'}`);
  
  // Already connected or connecting
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log(`[WS] Already connected/connecting`);
    return;
  }
  
  connectionId++;
  reconnectAttempts = 0;
  doConnect(connectionId);
}

/**
 * Subscribe to a session on the server.
 * Only messages for subscribed sessions are received.
 * Note: Does NOT store session state - use app-state.ts for that.
 */
export function subscribeToSession(sessionId: string | null): void {
  console.log(`[WS] subscribeToSession: ${sessionId}`);
  
  // Subscribe on server so we only receive messages for this session
  if (sessionId) {
    send({ type: 'subscribe', sessionId });
  }
}

/**
 * Request history for a session. Server streams messages with that sessionId.
 */
export function requestHistory(sessionId: string): void {
  console.log(`[WS] requestHistory for session: ${sessionId}`);
  send({ type: 'requestHistory', sessionId });
}

/**
 * Internal connect logic.
 * @param myConnectionId - The connection ID when this was called.
 *   All callbacks capture this and bail if it's stale.
 */
function doConnect(myConnectionId: number): void {
  // Bail if a newer connection has been started
  if (myConnectionId !== connectionId) {
    console.log(`[WS] doConnect bailing, stale connection ID ${myConnectionId} vs current ${connectionId}`);
    return;
  }
  
  // Guard for Node.js test environment
  if (typeof window === 'undefined') {
    return;
  }
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;
  
  console.log(`[WS] Connecting: ${url} (connectionId: ${myConnectionId})`);
  const ws = new WebSocket(url);
  socket = ws;
  
  ws.onopen = () => {
    // Bail if stale
    if (myConnectionId !== connectionId) {
      console.log(`[WS] onopen bailing, stale connection ID`);
      ws.close();
      return;
    }
    
    // Show connected toast on reconnect (not initial connect)
    const wasReconnect = reconnectAttempts > 0;
    reconnectAttempts = 0;
    
    if (wasReconnect) {
      showToast('✔ Connected', { type: 'success', autoHideMs: 2000 });
    }
    
    // Re-subscribe to active session after reconnect
    const currentSessionId = getActiveSessionId();
    if (currentSessionId) {
      console.log(`[WS] Re-subscribing to session ${currentSessionId} after connect`);
      send({ type: 'subscribe', sessionId: currentSessionId });
    }
    
    // Fire connect callbacks
    for (const cb of connectCallbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[WS] Connect callback error:', err);
      }
    }
  };
  
  ws.onmessage = (event) => {
    // Bail if stale
    if (myConnectionId !== connectionId) return;
    
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[WS] Invalid message:', err);
    }
  };
  
  ws.onclose = () => {
    console.log(`[WS] Disconnected (connectionId: ${myConnectionId}, current: ${connectionId})`);
    
    // Bail if stale - another connection is active
    if (myConnectionId !== connectionId) {
      return;
    }
    
    socket = null;
    
    // Auto-reconnect with backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = RECONNECT_DELAY_MS * reconnectAttempts;
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      setTimeout(() => doConnect(myConnectionId), delay);
    }
  };
  
  ws.onerror = (err) => {
    // Bail if stale
    if (myConnectionId !== connectionId) return;
    console.error('[WS] Error:', err);
  };
}

/**
 * Handle incoming message from server
 * - globalEvent: dispatched to all global handlers (no session filtering)
 * - event: filtered by active session, then dispatched to session handlers
 */
function handleMessage(msg: { type: string; id?: string; sessionId?: string; data?: unknown; error?: string }): void {
  // Handle request/response messages (no session filtering)
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject } = pendingRequests.get(msg.id)!;
    pendingRequests.delete(msg.id);
    
    if (msg.type === 'error') {
      reject(new Error(msg.error || 'Unknown error'));
    } else {
      resolve(msg.data);
    }
    return;
  }
  
  // Handle global events (no session filtering - affects all clients)
  if (msg.type === 'globalEvent') {
    const msgWithEvent = msg as unknown as { event?: SessionEvent };
    if (msgWithEvent.event) {
      for (const cb of globalEventCallbacks) {
        try {
          cb(msgWithEvent.event);
        } catch (err) {
          console.error('[WS] GlobalEvent callback error:', err);
        }
      }
    }
    return;
  }
  
  // Filter by active session for session-scoped broadcasts
  const msgSessionId = msg.sessionId;
  const currentSessionId = getActiveSessionId();
  if (msgSessionId && currentSessionId && msgSessionId !== currentSessionId) {
    // Message for a different session - ignore
    return;
  }
  
  // Handle broadcast messages
  switch (msg.type) {
    case 'stateUpdate':
      if (msg.data && typeof msg.data === 'object') {
        for (const cb of stateCallbacks) {
          try {
            cb(msg.data as Record<string, unknown>);
          } catch (err) {
            console.error('[WS] State callback error:', err);
          }
        }
      }
      break;
    
    case 'event': {
      // SDK event - pass through to handlers
      const msgWithEvent = msg as unknown as { event?: SessionEvent };
      if (msgWithEvent.event) {
        for (const cb of eventCallbacks) {
          try {
            cb(msgWithEvent.event);
          } catch (err) {
            console.error('[WS] Event callback error:', err);
          }
        }
      }
      break;
    }
    
    case 'historyComplete':
      // History streaming complete
      for (const cb of historyCompleteCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error('[WS] HistoryComplete callback error:', err);
        }
      }
      break;
    

      
    case 'pong':
      // Heartbeat response - no action needed
      break;
      
    default:
      // Unknown message type - ignore
  }
}

/**
 * Send message to server
 */
function send(msg: object): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    console.warn('[WS] Not connected, message dropped:', msg);
  }
}

/**
 * Send request and wait for response
 */
function request<T = unknown>(type: string, data?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `req-${++requestId}`;
    pendingRequests.set(id, { 
      resolve: resolve as (data: unknown) => void, 
      reject 
    });
    
    send({ type, id, data });
    
    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

/**
 * Push state to server (replaces HTTP batch)
 * Called by applet JS to make state queryable by agent
 */
export function wsSetState(state: Record<string, unknown>): void {
  send({ type: 'setState', data: state });
}

/**
 * Get current state from server
 */
export function wsGetState(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('getState');
}

/**
 * Subscribe to state updates from server
 * Returns unsubscribe function
 */
export function onStateUpdate(callback: StateCallback): () => void {
  stateCallbacks.add(callback);
  return () => stateCallbacks.delete(callback);
}

/**
 * Subscribe to global events (not filtered by session)
 * Used for events that affect UI outside of active session (e.g., session list updates)
 * Returns unsubscribe function
 */
export function onGlobalEvent(callback: GlobalEventCallback): () => void {
  globalEventCallbacks.add(callback);
  return () => globalEventCallbacks.delete(callback);
}

/**
 * Check if WebSocket is connected
 */
export function isWsConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/**
 * Disconnect WebSocket
 */
export function disconnectWs(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
}

/**
 * Send a chat message via WebSocket
 * Used instead of HTTP POST for unified rendering path
 */
export function wsSendMessage(content: string, imageData?: string, source: MessageSource = 'user', appletSlug?: string): void {
  send({ 
    type: 'sendMessage', 
    content, 
    imageData,
    source,
    appletSlug 
  });
}

/**
 * Subscribe to SDK events
 * Returns unsubscribe function
 */
export function onEvent(callback: EventCallback): () => void {
  eventCallbacks.add(callback);
  return () => eventCallbacks.delete(callback);
}

/**
 * Subscribe to history complete event
 * Returns unsubscribe function
 */
export function onHistoryComplete(callback: HistoryCompleteCallback): () => void {
  historyCompleteCallbacks.add(callback);
  return () => historyCompleteCallbacks.delete(callback);
}

/**
 * Subscribe to connect event
 * If already connected, fires immediately
 * Returns unsubscribe function
 */
export function onConnect(callback: ConnectCallback): () => void {
  connectCallbacks.add(callback);
  // If already connected, fire immediately
  if (socket?.readyState === WebSocket.OPEN) {
    try { callback(); } catch (e) { console.error('[WS] Connect callback error:', e); }
  }
  return () => connectCallbacks.delete(callback);
}

/**
 * Wait for WebSocket connection
 * Returns immediately if already connected
 */
export function waitForConnect(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsub = onConnect(() => {
      unsub();
      resolve();
    });
  });
}

/**
 * Reconnect to WebSocket (e.g., on visibility change)
 */
export function reconnectIfNeeded(): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    console.log(`[WS] reconnectIfNeeded - reconnecting`);
    reconnectAttempts = 0;
    connectionId++;
    doConnect(connectionId);
  }
}
