/**
 * Applet WebSocket Client
 * 
 * Client-side WebSocket connection for applet ↔ server communication.
 * Provides real-time state sync and future agent invocation support.
 */

// Connection state
let socket: WebSocket | null = null;
let sessionId: string | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

// Callbacks
type StateCallback = (state: Record<string, unknown>) => void;
const stateCallbacks: Set<StateCallback> = new Set();

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
  if (socket?.readyState === WebSocket.OPEN && sessionId === session) {
    return; // Already connected to this session
  }
  
  // Close existing connection if different session
  if (socket) {
    socket.close();
  }
  
  sessionId = session;
  reconnectAttempts = 0;
  
  doConnect();
}

/**
 * Internal connect logic
 */
function doConnect(): void {
  if (!sessionId) return;
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/applet?session=${encodeURIComponent(sessionId)}`;
  
  console.log(`[WS] Connecting: ${url}`);
  socket = new WebSocket(url);
  
  socket.onopen = () => {
    console.log('[WS] Connected');
    reconnectAttempts = 0;
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
