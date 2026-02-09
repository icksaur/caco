/**
 * Streaming Markdown Renderer
 * 
 * Handles incremental markdown rendering during message streaming.
 * Accumulates deltas, renders periodically, shows unrendered tail.
 * 
 * Architecture note: Uses module-level Map for session state because:
 * 1. Event handlers are stateless (called fresh per event)
 * 2. Timer references can't be stored in DOM dataset
 * 3. State is properly scoped by messageId and cleaned up on finalize
 * A class wrapper would add ceremony without changing these constraints.
 */

/** Streaming state per message */
interface StreamingState {
  rawContent: string;
  lastRenderedLength: number;
  timer: ReturnType<typeof setTimeout> | null;
  element: HTMLElement;
  maxHeight: number;
}

/** Render after this many new chars */
const MIN_CHARS_BEFORE_RENDER = 50;
/** Or render after this timeout (catches pauses) */
const RENDER_INTERVAL_MS = 200;
/** Small delay to batch rapid deltas */
const BATCH_DELAY_MS = 50;

/** Active streaming sessions keyed by messageId */
const sessions = new Map<string, StreamingState>();

/**
 * Render markdown and update state
 */
function render(state: StreamingState): void {
  const { element, rawContent } = state;
  
  // Lock height before re-render to prevent jitter.
  // Content height oscillates between raw tail text and rendered markdown;
  // min-height ensures the element never shrinks mid-stream.
  const h = element.offsetHeight;
  if (h > state.maxHeight) {
    state.maxHeight = h;
    element.style.minHeight = `${h}px`;
  }
  
  // Remove tail before setting textContent
  element.querySelector('.streaming-tail')?.remove();
  
  element.textContent = rawContent;
  window.renderMarkdownElement?.(element);
  state.lastRenderedLength = rawContent.length;
  state.timer = null;
}

/**
 * Show unrendered content after rendered HTML
 */
function showTail(state: StreamingState): void {
  const { element, rawContent, lastRenderedLength } = state;
  
  if (rawContent.length <= lastRenderedLength) return;
  
  const tail = rawContent.slice(lastRenderedLength);
  
  // Update existing tail or create new one
  let tailSpan = element.querySelector('.streaming-tail') as HTMLSpanElement | null;
  if (!tailSpan) {
    tailSpan = document.createElement('span');
    tailSpan.className = 'streaming-tail';
    element.appendChild(tailSpan);
  }
  tailSpan.textContent = tail;
}

/**
 * Schedule render based on content accumulation
 */
function scheduleRender(state: StreamingState): void {
  const charsSinceRender = state.rawContent.length - state.lastRenderedLength;
  
  if (charsSinceRender >= MIN_CHARS_BEFORE_RENDER) {
    // Enough content - render soon (batch rapid deltas)
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => render(state), BATCH_DELAY_MS);
  } else if (!state.timer) {
    // Schedule timeout render in case stream pauses
    state.timer = setTimeout(() => render(state), RENDER_INTERVAL_MS);
  }
  // Existing timer with < threshold chars: let it fire naturally
}

/**
 * Handle incoming delta content
 * 
 * @param element - Target element for content
 * @param messageId - Unique message identifier
 * @param delta - New content to append
 */
export function handleDelta(
  element: HTMLElement,
  messageId: string,
  delta: string
): void {
  // Get or create session
  let state = sessions.get(messageId);
  if (!state) {
    state = {
      rawContent: '',
      lastRenderedLength: 0,
      timer: null,
      element,
      maxHeight: 0
    };
    sessions.set(messageId, state);
  }
  
  // Append content
  state.rawContent += delta;
  
  // Show tail immediately, schedule render
  showTail(state);
  scheduleRender(state);
}

/**
 * Finalize streaming - render complete content and cleanup
 * 
 * @param element - Target element
 * @param messageId - Unique message identifier  
 * @param finalContent - Complete message content
 */
export function finalize(
  element: HTMLElement,
  messageId: string,
  finalContent: string
): void {
  // Cleanup any pending timer
  const state = sessions.get(messageId);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  sessions.delete(messageId);
  
  // Release height lock and render final content
  element.style.minHeight = '';
  element.querySelector('.streaming-tail')?.remove();
  element.textContent = finalContent;
  window.renderMarkdownElement?.(element);
}
