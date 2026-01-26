/**
 * SSE (Server-Sent Events) parsing utilities
 * 
 * Pure functions for parsing SSE event streams from text.
 */

export interface SSEEvent {
  type: string;
  data: string;
}

/**
 * Parse a buffer of SSE text into complete events and remaining buffer.
 * 
 * SSE format:
 *   event: eventType
 *   data: {"json": "payload"}
 *   
 *   event: anotherEvent
 *   data: {"more": "data"}
 * 
 * Events are separated by blank lines. This function handles partial
 * events by returning them in the remainingBuffer.
 */
export function parseSSEBuffer(buffer: string): { events: SSEEvent[]; remainingBuffer: string } {
  const events: SSEEvent[] = [];
  const lines = buffer.split('\n');
  
  // Last line might be incomplete (no trailing newline) - keep it in buffer
  const lastLine = lines.pop() || '';
  
  let currentEventType = '';
  
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEventType = line.slice(7);
    } else if (line.startsWith('data: ')) {
      // We have a complete event
      events.push({
        type: currentEventType,
        data: line.slice(6)
      });
      currentEventType = '';
    }
    // Blank lines are just separators, skip them
  }
  
  // Build remaining buffer from current event type (if any) and last incomplete line
  let remainingBuffer = '';
  if (currentEventType) {
    remainingBuffer = `event: ${currentEventType}\n`;
  }
  remainingBuffer += lastLine;
  
  return { events, remainingBuffer };
}

/**
 * Check if an event type is a terminal event (stream should end)
 */
export function isTerminalEvent(eventType: string): boolean {
  return eventType === 'done' || eventType === 'session.idle' || eventType === 'session.error';
}
