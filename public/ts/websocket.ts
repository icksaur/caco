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

/**
 * Message source identifies who sent a message.
 * Extensible: add new sources here (e.g., 'agent' for agent-to-agent).
 */
export type MessageSource = 'user' | 'applet' | 'agent';

// Re-export ChatMessage type (matches server)
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
let connectionId = 0;  // Incremented on each new connection
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

// Active session - messages for other sessions are filtered out
let activeSessionId: string | null = null;

// Callbacks
type StateCallback = (state: Record<string, unknown>) => void;
type MessageCallback = (msg: ChatMessage) => void;
type ActivityCallback = (item: ActivityItem) => void;
type OutputCallback = (outputId: string) => void;
type HistoryCompleteCallback = () => void;
type ConnectCallback = () => void;
const stateCallbacks: Set<StateCallback> = new Set();
const messageCallbacks: Set<MessageCallback> = new Set();
const activityCallbacks: Set<ActivityCallback> = new Set();
const outputCallbacks: Set<OutputCallback> = new Set();
const historyCompleteCallbacks: Set<HistoryCompleteCallback> = new Set();
const connectCallbacks: Set<ConnectCallback> = new Set();

// Pending requests (for request/response pattern)
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
 * Set the active session ID. Messages for other sessions are filtered out.
 */
export function setActiveSession(sessionId: string | null): void {
  console.log(`[WS] setActiveSession: ${sessionId}`);
  activeSessionId = sessionId;
}

/**
 * Get the active session ID.
 */
export function getActiveSessionId(): string | null {
  return activeSessionId;
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
 * Filters messages by activeSessionId - only messages for current session are processed
 * Exception: stateUpdate bypasses session filtering (applets receive state from any session)
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
  
  // stateUpdate bypasses session filtering - applets receive state regardless of which session agent runs in
  if (msg.type === 'stateUpdate') {
    if (msg.data && typeof msg.data === 'object') {
      for (const cb of stateCallbacks) {
        try {
          cb(msg.data as Record<string, unknown>);
        } catch (err) {
          console.error('[WS] State callback error:', err);
        }
      }
    }
    return;
  }
  
  // Filter by active session for other broadcast messages
  const msgSessionId = msg.sessionId;
  if (msgSessionId && activeSessionId && msgSessionId !== activeSessionId) {
    // Message for a different session - ignore
    console.log(`[WS] Filtering out message type ${msg.type} for session ${msgSessionId} (active: ${activeSessionId})`);
    return;
  }
  
  // Handle broadcast messages
  switch (msg.type) {
    case 'message': {
      // Chat message (user or assistant) - from history or live
      const msgWithData = msg as unknown as { message?: ChatMessage };
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
      console.log(`[WS] Received historyComplete for session ${msgSessionId}, firing ${historyCompleteCallbacks.size} callbacks`);
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
    
    case 'output': {
      // Output to render immediately
      console.log('[WS] Received output message:', msg);
      const outputMsg = msg as unknown as { outputId?: string };
      if (outputMsg.outputId) {
        for (const cb of outputCallbacks) {
          try {
            cb(outputMsg.outputId);
          } catch (err) {
            console.error('[WS] Output callback error:', err);
          }
        }
      }
      break;
    }
      
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
  activeSessionId = null;
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
 * Subscribe to output events (display-only tool results)
 * Returns unsubscribe function
 */
export function onOutput(callback: OutputCallback): () => void {
  outputCallbacks.add(callback);
  return () => outputCallbacks.delete(callback);
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
 * After reconnecting, requests history for the active session if one exists.
 */
export function reconnectIfNeeded(): void {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    console.log(`[WS] reconnectIfNeeded - reconnecting (socket state: ${socket?.readyState ?? 'null'})`);
    reconnectAttempts = 0;
    connectionId++;
    
    // Store active session to reload history after reconnect
    const sessionToReload = activeSessionId;
    
    // Set up one-time callback to reload history once connected
    if (sessionToReload) {
      const reloadHistory = () => {
        console.log(`[WS] Reconnected - reloading history for ${sessionToReload}`);
        requestHistory(sessionToReload);
        connectCallbacks.delete(reloadHistory);
      };
      connectCallbacks.add(reloadHistory);
    }
    
    doConnect(connectionId);
  } else {
    console.log(`[WS] reconnectIfNeeded - already connected (state: ${socket.readyState})`);
  }
}
