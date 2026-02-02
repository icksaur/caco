/**
 * Caco Event Queue
 * 
 * Queues caco.* synthetic events and flushes them on trigger events.
 * This ensures embeds appear after tool completion, not during.
 * 
 * Used by both live streaming (session-messages.ts) and history (websocket.ts).
 * 
 * @remarks Unit test all changes - see tests/unit/caco-event-queue.test.ts
 */

import type { CacoEmbedEvent } from './display-tools.js';

// Union type for all caco events (extend as more are added)
export type CacoEvent = CacoEmbedEvent;

/**
 * Event types that trigger queue flush.
 * Consistent for both live streaming and history replay.
 * 
 * SDK Response Structure (one user.message can have multiple turns):
 *   Turn: reasoning → tool calls → assistant.message_delta... → assistant.message
 *   
 * Embeds should appear BEFORE assistant response starts (delta or final).
 * This ensures embed div is created before response div, maintaining order.
 */
const FLUSH_TRIGGERS = new Set([
  'assistant.message_delta',  // Response starting (live) = emit embeds first
  'assistant.message',        // Response complete (history) = emit embeds first  
  'session.error',            // Error ends session
]);

/**
 * Check if an event type should trigger queue flush
 * Used by both live streaming and history replay
 */
export function isFlushTrigger(eventType: string): boolean {
  return FLUSH_TRIGGERS.has(eventType);
}

/**
 * Caco event queue for a single session.
 * Simple FIFO queue with flush operation.
 */
export class CacoEventQueue {
  private pending: CacoEvent[] = [];
  
  /**
   * Add event to pending queue
   */
  queue(event: CacoEvent): void {
    this.pending.push(event);
  }
  
  /**
   * Return and clear all pending events
   */
  flush(): CacoEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }
  
  /**
   * Check if queue has pending events
   */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
  
  /**
   * Get count of pending events (for logging)
   */
  get length(): number {
    return this.pending.length;
  }
}

/**
 * Session ID → Queue mapping
 * Each session has its own queue to avoid cross-contamination
 */
const sessionQueues = new Map<string, CacoEventQueue>();

/**
 * Get or create queue for a session
 */
export function getQueue(sessionId: string): CacoEventQueue {
  let queue = sessionQueues.get(sessionId);
  if (!queue) {
    queue = new CacoEventQueue();
    sessionQueues.set(sessionId, queue);
  }
  return queue;
}

/**
 * Clean up queue for a session
 */
export function deleteQueue(sessionId: string): void {
  sessionQueues.delete(sessionId);
}
