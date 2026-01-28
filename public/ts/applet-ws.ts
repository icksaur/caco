/**
 * Applet WebSocket Client
 * 
 * Client-side WebSocket connection for applet ↔ server communication.
 * Provides real-time state sync and future agent invocation support.
 */

// Re-export ChatMessage type (matches server)
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;           // Full content (create or replace)
  deltaContent?: string;      // Append to existing (streaming)
  status?: 'streaming' | 'complete';  // Defaults to 'complete'
  timestamp?: string;
  source?: 'user' | 'applet';
  appletSlug?: string;
  hasImage?: boolean;
  outputs?: string[];
}

// Activity item for tool calls, intents, errors
export interface ActivityItem {
  type: 'turn' | 'intent' | 'tool' | 'tool-result' | 'error' | 'info';
  text: string;
  details?: string;
}

// Connection state
let socket: WebSocket | null = null;
let sessionId: string | null = null;
let reconnectAttempts = 0;
let intentionalClose = false; // Prevent reconnect when switching sessions
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

// Callbacks
type StateCallback = (state: Record<string, unknown>) => void;
type MessageCallback = (msg: ChatMessage) => void;
type ActivityCallback = (item: ActivityItem) => void;
type HistoryCompleteCallback = () => void;
type ConnectCallback = () => void;
const stateCallbacks: Set<StateCallback> = new Set();
const messageCallbacks: Set<MessageCallback> = new Set();
const activityCallbacks: Set<ActivityCallback> = new Set();
const historyCompleteCallbacks: Set<HistoryCompleteCallback> = new Set();
const connectCallbacks: Set<ConnectCallback> = new Set();

// Pending requests (for request/response pattern)
const pendingRequests = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}>();
let requestId = 0;

/**
 * Connect to applet WebSocket
 * Called when an applet is loaded
 */
export function connectAppletWs(session: string): void {
  console.log(`[WS] connectAppletWs called for ${session}, current: ${sessionId}, socket state: ${socket?.readyState}`);
  
  // Already connected or connecting to this session
  if (socket && sessionId === session) {
    const state = socket.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
      console.log(`[WS] Already connected/connecting to session ${session}, skipping`);
      return;
    }
  }
  
  // Close existing connection if different session
  if (socket) {
    console.log(`[WS] Closing existing socket (state: ${socket.readyState})`);
    intentionalClose = true;
    socket.close();
  }
  
  sessionId = session;
  reconnectAttempts = 0;
  intentionalClose = false;
  
  doConnect();
}

/**
 * Internal connect logic
 */
function doConnect(): void {
  if (!sessionId) return;
  
  // Guard for Node.js test environment
  if (typeof window === 'undefined') {
    console.log('[WS] Skipping connect in non-browser environment');
    return;
  }
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/applet?session=${encodeURIComponent(sessionId)}`;
  
  console.log(`[WS] Connecting: ${url}`);
  socket = new WebSocket(url);
  
  socket.onopen = () => {
    console.log('[WS] Connected');
    reconnectAttempts = 0;
    
    // Fire connect callbacks
    for (const cb of connectCallbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[WS] Connect callback error:', err);
      }
    }
  };
  
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[WS] Invalid message:', err);
    }
  };
  
  socket.onclose = () => {
    console.log('[WS] Disconnected');
    socket = null;
    
    // Don't reconnect if we intentionally closed for session switch
    if (intentionalClose) {
      console.log('[WS] Intentional close, not reconnecting');
      return;
    }
    
    // Auto-reconnect with backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = RECONNECT_DELAY_MS * reconnectAttempts;
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      setTimeout(doConnect, delay);
    }
  };
  
  socket.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

/**
 * Handle incoming message from server
 */
function handleMessage(msg: { type: string; id?: string; data?: unknown; error?: string }): void {
  // Handle request/response messages
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
    
    case 'message': {
      // Chat message (user or assistant) - from history or live
      const msgWithData = msg as unknown as { message?: ChatMessage };
      console.log('[WS] message event, callbacks:', messageCallbacks.size, 'msg:', msgWithData.message?.role);
      if (msgWithData.message) {
        for (const cb of messageCallbacks) {
          try {
            cb(msgWithData.message);
          } catch (err) {
            console.error('[WS] Message callback error:', err);
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
    
    case 'activity': {
      // Activity item (tool calls, intents, errors)
      const activityMsg = msg as unknown as { item?: ActivityItem };
      if (activityMsg.item) {
        for (const cb of activityCallbacks) {
          try {
            cb(activityMsg.item);
          } catch (err) {
            console.error('[WS] Activity callback error:', err);
          }
        }
      }
      break;
    }
      
    case 'pong':
      // Heartbeat response - no action needed
      break;
      
    default:
      console.log('[WS] Unknown message type:', msg.type);
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
 * Applet JS calls this to make state queryable by agent
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
 * Check if WebSocket is connected
 */
export function isWsConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/**
 * Disconnect WebSocket
 */
export function disconnectAppletWs(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
  sessionId = null;
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
}

/**
 * Send a chat message via WebSocket
 * Used instead of HTTP POST for unified rendering path
 */
export function wsSendMessage(content: string, imageData?: string, source: 'user' | 'applet' = 'user', appletSlug?: string): void {
  send({ 
    type: 'sendMessage', 
    content, 
    imageData,
    source,
    appletSlug 
  });
}

/**
 * Subscribe to chat messages (user or assistant)
 * Returns unsubscribe function
 */
export function onMessage(callback: MessageCallback): () => void {
  messageCallbacks.add(callback);
  return () => messageCallbacks.delete(callback);
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
 * Subscribe to activity events (tool calls, intents, errors)
 * Returns unsubscribe function
 */
export function onActivity(callback: ActivityCallback): () => void {
  activityCallbacks.add(callback);
  return () => activityCallbacks.delete(callback);
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
 * Get current session ID
 */
export function getWsSessionId(): string | null {
  return sessionId;
}
