/**
 * Event Inserter
 * 
 * Given a DOM element and SDK event data, make the DOM right.
 * Handles content extraction, data storage, and element manipulation.
 * 
 * @remarks Unit test all changes - see tests/unit/event-inserter.test.ts
 */

import type { SessionEvent } from './types.js';
import { handleDelta, finalize } from './streaming-markdown.js';

declare global {
  interface Window {
    renderMarkdownElement?: (element: Element) => void;
  }
}

/**
 * Element interface for DOM manipulation
 * Subset of HTMLElement to allow testing without real DOM
 */
export interface InserterElement {
  textContent: string | null;
  dataset: Record<string, string | undefined>;
  classList?: { add(name: string): void; remove(name: string): void };
}

/**
 * Event inserter function signature
 * Directly mutates the element - sets textContent, stores dataset values
 * @param element - Element to manipulate
 * @param data - Event data object
 */
type EventInserterFn = (element: InserterElement, data: Record<string, unknown>) => void;

/**
 * Get nested property by dot path (e.g., 'result.content')
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce(
    (o, k) => (o as Record<string, unknown>)?.[k], 
    obj
  );
}

/**
 * Extract outputId from tool result content.
 * Handles both JSON-wrapped and plain text [output:xxx] markers.
 */
function extractOutputId(resultContent: string): string | null {
  // Try JSON parse first (tool handler returns JSON with toolTelemetry)
  try {
    const parsed = JSON.parse(resultContent);
    if (parsed.toolTelemetry?.outputId) {
      return parsed.toolTelemetry.outputId;
    }
    // Also check textResultForLlm for marker
    if (parsed.textResultForLlm) {
      const match = parsed.textResultForLlm.match(/\[output:([^\]]+)\]/);
      if (match) return match[1];
    }
  } catch {
    // Not JSON, try regex on plain text
  }
  
  // Fallback: regex on plain text
  const match = resultContent.match(/\[output:([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Fetch embed output and render into element.
 * Replaces placeholder content with actual embed iframe.
 */
async function fetchAndRenderEmbed(element: HTMLElement, outputId: string): Promise<void> {
  try {
    const res = await fetch(`/api/outputs/${outputId}?format=json`);
    if (!res.ok) {
      element.textContent = '❌ Failed to load embed';
      return;
    }
    
    const { data, metadata } = await res.json();
    
    // Create embed container (matches CSS .output-embed structure)
    const container = document.createElement('div');
    container.className = 'output-embed';
    if (metadata?.provider) {
      container.dataset.provider = metadata.provider.toLowerCase();
    }
    
    // Create frame wrapper
    const frame = document.createElement('div');
    frame.className = 'embed-frame';
    
    // Sanitize and inject HTML (allow iframes for trusted embeds)
    // Note: DOMPurify is available globally from script tag
    const purify = (window as unknown as { DOMPurify?: { sanitize: (html: string, options?: { ADD_TAGS?: string[] }) => string } }).DOMPurify;
    if (purify) {
      frame.innerHTML = purify.sanitize(data, { ADD_TAGS: ['iframe'] });
    } else {
      // Fallback: no sanitization (dev only)
      frame.innerHTML = data;
    }
    
    container.appendChild(frame);
    
    // Replace element content
    element.textContent = '';
    element.appendChild(container);
    
  } catch (err) {
    element.textContent = '❌ Embed failed to load';
    console.error('[embed] Failed to fetch:', err);
  }
}

/**
 * Create a simple path-based inserter (replace mode)
 */
function setPath(p: string): EventInserterFn {
  return (element, data) => {
    const value = getByPath(data, p);
    element.textContent = typeof value === 'string' ? value : '';
  };
}

/**
 * Create an append-mode inserter for delta events
 */
function appendPath(p: string): EventInserterFn {
  return (element, data) => {
    const existing = element.textContent || '';
    const value = getByPath(data, p);
    element.textContent = existing + (typeof value === 'string' ? value : '');
  };
}

/**
 * Event type → inserter function mapping
 * 
 * Simple events use setPath() for direct property access.
 * Delta events use appendPath() to accumulate content.
 * Complex events use custom functions for formatting and data storage.
 */
const EVENT_INSERTERS: Record<string, EventInserterFn> = {
  // User/assistant messages - both render markdown
  'user.message': (element, data) => {
    const value = getByPath(data, 'content');
    element.textContent = typeof value === 'string' ? value : '';
    if (typeof window !== 'undefined' && window.renderMarkdownElement) {
      window.renderMarkdownElement(element as unknown as Element);
    }
  },
  'assistant.message': (element, data) => {
    const content = getByPath(data, 'content');
    const messageId = data.messageId as string | undefined;
    if (messageId && typeof window !== 'undefined') {
      finalize(element as unknown as HTMLElement, messageId, typeof content === 'string' ? content : '');
    } else {
      element.textContent = typeof content === 'string' ? content : '';
      if (typeof window !== 'undefined' && window.renderMarkdownElement) {
        window.renderMarkdownElement(element as unknown as Element);
      }
    }
  },
  'assistant.message_delta': (element, data) => {
    const messageId = data.messageId as string | undefined;
    const delta = getByPath(data, 'deltaContent');
    const deltaStr = typeof delta === 'string' ? delta : '';
    
    if (messageId && typeof window !== 'undefined') {
      handleDelta(element as unknown as HTMLElement, messageId, deltaStr);
    } else {
      // Fallback: no messageId, just append
      element.textContent = (element.textContent || '') + deltaStr;
    }
  },
  
  // Reasoning - render markdown on final event for proper collapse structure
  'assistant.reasoning': (element, data) => {
    const value = getByPath(data, 'content');
    element.textContent = typeof value === 'string' ? value : '';
    // Render markdown in browser (no-op in tests)
    if (typeof window !== 'undefined' && window.renderMarkdownElement) {
      window.renderMarkdownElement(element as unknown as Element);
    }
  },
  'assistant.reasoning_delta': appendPath('deltaContent'),
  
  // Intent
  'assistant.intent': (element, data) => {
    element.textContent = `💡 ${data.intent || ''}`;
  },
  
  // Tool events - richer format with data storage
  'tool.execution_start': (element, data) => {
    const name = (data.toolName || 'tool') as string;
    const args = data.arguments as Record<string, unknown> | undefined;
    
    // Special case: report_intent shows intent as header
    if (name === 'report_intent' && args?.intent) {
      element.textContent = `💡 ${args.intent}`;
      element.dataset.toolName = name;
      return;
    }
    
    const input = (args?.command || args?.description || '') as string;
    
    // Store for later use by tool.execution_complete
    element.dataset.toolName = name;
    if (input) element.dataset.toolInput = input;
    
    // Set content
    element.textContent = input ? `🔧 ${name}\n\`${input}\`` : `🔧 ${name}`;
  },
  
  'tool.execution_complete': (element, data) => {
    const name = element.dataset.toolName || 'tool';
    
    // report_intent keeps its intent display
    if (name === 'report_intent') return;
    
    // embed_media completion is handled by caco.embed event
    if (name === 'embed_media') {
      element.textContent = 'embed_media\n```\nEmbed rendered below\n```';
      if (typeof window !== 'undefined' && window.renderMarkdownElement) {
        window.renderMarkdownElement(element as unknown as Element);
      }
      return;
    }
    
    const input = element.dataset.toolInput || '';
    const success = data.success as boolean;
    const result = (getByPath(data, 'result.content') as string | undefined)?.trim() || '';
    const error = (data.error as string | undefined)?.trim() || '';
    const output = success ? result : error;
    
    // Build: *name* + blank line + code block (blank line prevents Setext heading from --- in output)
    const parts = [input, output].filter(Boolean);
    const content = `*${name}*\n\n\`\`\`${name}\n${parts.join('\n')}\n\`\`\``;
    element.textContent = content;
    
    if (typeof window !== 'undefined' && window.renderMarkdownElement) {
      window.renderMarkdownElement(element as unknown as Element);
    }
  },
  
  'tool.execution_progress': (element, data) => {
    const existing = element.textContent || '';
    const msg = data.progressMessage as string | undefined;
    if (msg) element.textContent = `${existing}\n${msg}`;
  },
  
  'tool.execution_partial_result': (element, data) => {
    const existing = element.textContent || '';
    const output = data.partialOutput as string | undefined;
    if (output) element.textContent = existing + output;
  },
  
  // Session events
  'session.compaction_start': (element) => {
    element.textContent = '📦 Compacting conversation...';
  },
  'session.compaction_complete': (element) => {
    element.textContent = '📦 Conversation compacted';
  },
  
  // Caco synthetic types
  'caco.agent': setPath('content'),
  'caco.applet': setPath('content'),
  'caco.scheduler': setPath('content'),
  
  // Embed media - renders iframe from outputId
  'caco.embed': (element, data) => {
    const outputId = data.outputId as string | undefined;
    if (!outputId) {
      element.textContent = '❌ Missing embed outputId';
      return;
    }
    
    // Set placeholder while loading
    element.textContent = '⏳ Loading embed...';
    
    // Async fetch and render (only in browser)
    if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
      fetchAndRenderEmbed(element as unknown as HTMLElement, outputId);
    }
  },
};

/**
 * Insert event content into element
 * Directly manipulates the element - sets textContent, stores data attributes
 * 
 * @param event - SDK event with type and data
 * @param element - Element to manipulate
 * @returns true if event was handled, false if no inserter exists
 */
export function insertEvent(
  event: SessionEvent,
  element: InserterElement
): boolean {
  const inserter = EVENT_INSERTERS[event.type];
  if (!inserter) return false;
  inserter(element, event.data || {});
  return true;
}

/**
 * Check if an event type has an inserter
 */
export function hasInserter(eventType: string): boolean {
  return eventType in EVENT_INSERTERS;
}
