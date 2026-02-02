/**
 * Event Transformer
 * 
 * Transforms SDK events for client consumption.
 * 
 * Note: caco.embed events are now emitted directly by the embed_media tool handler,
 * not derived from SDK events here. This is cleaner because the tool knows its
 * own identity without needing to parse toolName from SDK events.
 * 
 * This transformer currently just passes events through, but provides a hook
 * for future SDK event transformations if needed.
 */

import { extractToolTelemetry, type ToolExecutionCompleteEvent } from './sdk-event-parser.js';

// Minimal interface for events we can transform
interface BaseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Transform an SDK event for client consumption.
 * Currently passes events through unchanged.
 * 
 * Note: caco.embed is emitted directly by tool handler, not here.
 */
export function* transformForClient(event: BaseEvent): Generator<BaseEvent> {
  yield event;
  // Future SDK event transformations can be added here
}

/**
 * Check if event is a caco.reload trigger.
 * Separated from generator because reload requires external state (consumeReloadSignal).
 */
export function shouldEmitReload(event: BaseEvent): boolean {
  if (event.type !== 'tool.execution_complete') return false;
  const telemetry = extractToolTelemetry(event as unknown as ToolExecutionCompleteEvent);
  return telemetry?.reloadTriggered === true;
}
