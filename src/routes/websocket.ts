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
import { sessionManager } from '../session-manager.js';
import { readLastTurnsResult } from '../sdk-session-store.js';
import { shouldFilter } from '../event-filter.js';
import { parseMessageSource, type MessageSource } from '../message-source.js';
import { listEmbedOutputs, parseOutputMarkers, getSessionMeta } from '../storage.js';
import { CacoEventQueue, isFlushTrigger, type CacoEvent } from '../caco-event-queue.js';
import { normalizeToolComplete, extractToolResultText, type RawSDKEvent } from '../sdk-normalizer.js';
import type { SessionEvent } from '../types.js';

export type { SessionEvent };
import { getClientMessageHandler } from '../extension-runtime.js';
import { watchExtensions } from '../extension-store.js';

const allConnections = new Set<WebSocket>();
const sessionSubscribers = new Map<string, Set<WebSocket>>();
const clientSubscription = new Map<WebSocket, string>();
const wsAlive = new WeakMap<WebSocket, boolean>();
const usageCache = new Map<string, { tokenLimit: number; currentTokens: number }>();



interface ClientMessage {
  type: 'setState' | 'getState' | 'sendMessage' | 'requestHistory' | 'ping' | 'subscribe';
  id?: string;  // For request/response correlation
  sessionId?: string;  // For requestHistory, subscribe, and setState
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
export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ 
    server, 
    path: '/ws' 
  });

  wss.on('connection', (ws, _req) => {
    allConnections.add(ws);
    wsAlive.set(ws, true);
    
    ws.on('pong', () => { wsAlive.set(ws, true); });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleMessage(ws, msg);
      } catch (_err) {
        sendError(ws, undefined, 'Invalid JSON message');
      }
    });
    
    ws.on('close', () => {
      allConnections.delete(ws);
      
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

  // Server-side heartbeat: detect broken connections + send app-level ping.
  // Protocol-level ws.ping() detects dead TCP; app-level serverPing lets
  // the browser client log and monitor connection health.
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (wsAlive.get(ws) === false) {
        console.log('[WS] Terminating unresponsive connection');
        ws.terminate();
        continue;
      }
      wsAlive.set(ws, false);
      ws.ping();
      try {
        ws.send(JSON.stringify({ type: 'serverPing', ts: Date.now() }));
      } catch { /* connection may be closing */ }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  const EXT_EVENT_TYPE: Record<string, string> = {
    css: 'extension.cssChanged',
    client: 'extension.reload',
  };
  watchExtensions((slug, type) => {
    const eventType = EXT_EVENT_TYPE[type];
    if (eventType) broadcastGlobalEvent({ type: eventType, data: { slug } } as SessionEvent);
  });

  return { wss, pushStateToApplet };
}

/**
 * Handle incoming message from client
 */
function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  if (msg.type.startsWith('ext.')) {
    const handler = getClientMessageHandler(msg.type);
    if (handler) {
      try { handler(ws, (msg as unknown as Record<string, unknown>).data); }
      catch (err) { console.error('[EXT] WS handler error:', err); }
    }
    return;
  }

  switch (msg.type) {
    case 'setState':
      if (msg.data) {
        setAppletUserState(msg.sessionId, msg.data);
        // Broadcast to other tabs, tagged with the originating session so
        // the client-side filter drops it for applets on a different session.
        // Without the sessionId tag, every session received every applet's
        // state, causing cross-session apply loops (e.g. files-applet flicker).
        broadcastToAll({ type: 'stateUpdate', sessionId: msg.sessionId, data: msg.data }, ws);
      }
      break;
    
    case 'sendMessage':
      // This is unused now - messages go via POST
      sendError(ws, msg.id, 'Use POST /api/sessions/:id/messages instead');
      break;
      
    case 'requestHistory':
      if (msg.sessionId) {
        console.log(`[WS] requestHistory received for ${msg.sessionId.slice(0, 8)}`);
        void streamHistory(ws, msg.sessionId);
      } else {
        sendError(ws, msg.id, 'sessionId is required for requestHistory');
      }
      break;
      
    case 'getState':
      send(ws, { type: 'state', id: msg.id, data: getAppletUserState(msg.sessionId) });
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

export type StatePushHandler = (sessionId: string | null, state: Record<string, unknown>) => boolean;

/**
 * Push state to all applet connections. The client filters by active session.
 * Used by set_applet_state tool and surface mutation events.
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
  const shortId = sessionId.slice(0, 8);
  console.log(`[HISTORY] streamHistory called for ${shortId}, ws.readyState=${ws.readyState}`);
  
  if (!sessionId || sessionId === 'default') {
    console.log('[HISTORY] No valid session, sending historyComplete');
    send(ws, { type: 'historyComplete', sessionId, data: { isBusy: false } });
    return;
  }
  
  try {
    const fetchStart = Date.now();
    console.log(`[HISTORY] Reading events from disk for ${shortId}...`);
    const turnsResult = readLastTurnsResult(sessionId, 5, 2000);
    if (!turnsResult.ok && turnsResult.kind === 'corrupt') {
      console.error(`[HISTORY] Corrupt history for ${shortId}: ${turnsResult.error.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        send(ws, { type: 'event', sessionId, event: {
          type: 'caco.history_error',
          data: { message: 'Session history could not be read (file is corrupt or unreadable).' }
        } as unknown as SessionEvent });
        send(ws, { type: 'historyComplete', sessionId, data: { isBusy: false } });
      }
      return;
    }
    const { events, totalLines, skipped } = turnsResult.ok
      ? turnsResult.value
      : { events: [], totalLines: 0, skipped: 0 };
    console.log(`[HISTORY] Read ${events.length} events (from ${totalLines} total) for ${shortId} in ${Date.now() - fetchStart}ms, ws.readyState=${ws.readyState}`);
    
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn(`[HISTORY] WebSocket closed before streaming for ${shortId}, aborting`);
      return;
    }
    
    const embedLookup = new Map<string, { provider: string; title: string }>();
    for (const { outputId, metadata } of listEmbedOutputs(sessionId)) {
      embedLookup.set(outputId, {
        provider: (metadata.provider as string) || 'unknown',
        title: (metadata.title as string) || 'Embedded content'
      });
    }
    console.log(`[HISTORY] Loaded ${embedLookup.size} embeds for session ${sessionId}`);
    
    const queue = new CacoEventQueue();
    let sentCount = 0;
    
    if (skipped > 0) {
      console.log(`[HISTORY] Truncated: skipped ${skipped} of ${totalLines} lines`);
      send(ws, { type: 'event', sessionId, event: {
        type: 'caco.truncated',
        data: { skipped, total: totalLines }
      } as unknown as SessionEvent });
      sentCount++;
    }
    
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      // Flush queued embeds before trigger events (same as live stream)
      if (isFlushTrigger(evt.type)) {
        const queued = queue.flush();
        if (queued.length > 0) {
          console.log(`[HISTORY] Flushing ${queued.length} embeds before ${evt.type}`);
          for (const cacoEvent of queued) {
            send(ws, { type: 'event', sessionId, event: cacoEvent as unknown as SessionEvent });
            sentCount++;
          }
        }
      }
      
      // Send SDK event
      if (!shouldFilter(evt)) {
        // Parse user.message content for source prefix (from applet/agent/scheduler)
        const enriched = enrichUserMessageWithSource(evt);
        send(ws, { type: 'event', sessionId, event: enriched });
        sentCount++;
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
    
    // Emit caco.context if session has context (for UI footer)
    const meta = getSessionMeta(sessionId);
    if (meta?.context) {
      send(ws, { 
        type: 'event', 
        sessionId, 
        event: {
          type: 'caco.context',
          data: { reason: 'load', context: meta.context }
        } as unknown as SessionEvent
      });
    }
    
    console.log(`[HISTORY] Streamed ${sentCount} events (from ${events.length} raw) for ${shortId} in ${Date.now() - fetchStart}ms total`);
    const isBusy = sessionManager.isBusy(sessionId);
    const usage = usageCache.get(sessionId);
    send(ws, { type: 'historyComplete', sessionId, data: { isBusy, usage } });
    console.log(`[HISTORY] historyComplete sent for ${shortId}, isBusy=${isBusy}, ws.readyState=${ws.readyState}`);
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[HISTORY] Error streaming history for ${shortId}:`, message);
    send(ws, { type: 'historyComplete', sessionId, data: { isBusy: false } });
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
  if (event.type === 'session.usage_info' && event.data) {
    const d = event.data as { tokenLimit?: number; currentTokens?: number };
    if (d.tokenLimit && d.currentTokens) {
      usageCache.set(sessionId, { tokenLimit: d.tokenLimit, currentTokens: d.currentTokens });
    }
  }
  
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
