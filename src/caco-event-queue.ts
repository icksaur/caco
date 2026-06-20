/**
 * Caco Event Queue
 *
 * Queues caco.* synthetic events and flushes them on trigger events.
 * This ensures embeds appear after tool completion, not during.
 *
 * Per active session, the queue instance is owned by SessionRuntime
 * (src/session-runtime.ts); history replay (websocket.ts) uses a throwaway
 * local instance.
 *
 * @remarks Unit test all changes - see tests/unit/caco-event-queue.test.ts
 */

import type { CacoEmbedEvent } from './display-tools.js';

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

export function isFlushTrigger(eventType: string): boolean {
  return FLUSH_TRIGGERS.has(eventType);
}

export class CacoEventQueue {
  private pending: CacoEvent[] = [];
  
  queue(event: CacoEvent): void {
    this.pending.push(event);
  }
  
  flush(): CacoEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }
  
  hasPending(): boolean {
    return this.pending.length > 0;
  }
  
  get length(): number {
    return this.pending.length;
  }
}
