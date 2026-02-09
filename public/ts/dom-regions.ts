/**
 * DOM Region Ownership
 *
 * Scoped DOM access prevents cross-region queries.
 * All mutations to #chat go through ChatRegion.
 * All region root lookups go through the `regions` registry.
 *
 * Absorbed from: element-inserter.ts, event-inserter.ts
 * Spec: doc/dom-regions.md
 *
 * @remarks Unit test all changes - see tests/unit/dom-regions.test.ts
 */

import type { SessionEvent } from './types.js';
import { handleDelta, finalize } from './streaming-markdown.js';

declare global {
  interface Window {
    renderMarkdownElement?: (element: Element) => void;
  }
}

// ── ScopedRoot ──────────────────────────────────────────────────

/**
 * Scoped DOM access — prevents cross-region queries.
 *
 * No method on this object calls document.querySelector,
 * document.getElementById, or any other global DOM lookup.
 *
 * The invariant is: no global DOM *queries*. document.createElement
 * is allowed — creating a detached element doesn't affect any region.
 */
export type ScopedRoot = {
  readonly el: HTMLElement;
  query(sel: string): HTMLElement | null;
  queryAll(sel: string): NodeListOf<Element>;
  clear(): void;
};

export function scopedRoot(el: HTMLElement): ScopedRoot {
  return {
    el,
    query: (sel) => el.querySelector(sel),
    queryAll: (sel) => el.querySelectorAll(sel),
    clear: () => { el.innerHTML = ''; },
  };
}

// ── Region registry ─────────────────────────────────────────────

type Regions = {
  chat: ScopedRoot;
  footer: ScopedRoot;
  applet: ScopedRoot;
  layout: ScopedRoot;
};

/**
 * Single source of truth for all DOM region roots.
 * Proxy throws on any property access before initRegions() is called.
 * Fail-fast by design — no silent undefined, no stale state.
 */
let _initialized = false;
const _backing = {} as Regions;

export const regions: Regions = new Proxy(_backing, {
  get(target, prop, receiver) {
    if (!_initialized) throw new Error(`regions.${String(prop)} accessed before initRegions()`);
    return Reflect.get(target, prop, receiver);
  },
});

/**
 * Initialize regions. Called once at app startup after DOM is ready.
 */
export function initRegions(): void {
  _backing.chat   = scopedRoot(document.getElementById('chat')!);
  _backing.footer = scopedRoot(document.querySelector('[data-context-footer]')! as HTMLElement);
  _backing.applet = scopedRoot(document.querySelector('[data-applet-view]')! as HTMLElement);
  _backing.layout = scopedRoot(document.getElementById('chatScroll')!);
  _initialized = true;
}

// ── Element inserter config tables ──────────────────────────────

/**
 * Event Type → Outer Div Class Mapping
 * Maps SDK event.type strings to the 5 chat div classes
 */
export const EVENT_TO_OUTER: Record<string, string> = {
  // User message
  'user.message': 'user-message',

  // Assistant messages
  'assistant.message': 'assistant-message',
  'assistant.message_delta': 'assistant-message',

  // Thinking indicator (removed on first content)
  'assistant.turn_start': 'assistant-activity',

  // Activity (all activity goes in same box)
  'assistant.intent': 'assistant-activity',
  'assistant.reasoning': 'assistant-activity',
  'assistant.reasoning_delta': 'assistant-activity',
  'tool.execution_start': 'assistant-activity',
  'tool.execution_progress': 'assistant-activity',
  'tool.execution_partial_result': 'assistant-activity',
  'tool.execution_complete': 'assistant-activity',
  'session.error': 'assistant-activity',
  'session.compaction_start': 'assistant-activity',
  'session.compaction_complete': 'assistant-activity',

  // Caco synthetic types
  'caco.agent': 'agent-message',
  'caco.applet': 'applet-message',
  'caco.scheduler': 'scheduler-message',
  'caco.embed': 'embed-message',
  'caco.info': 'assistant-activity',
};

/**
 * Event Type → Inner Div Class Mapping
 * Maps SDK event.type strings to inner content div classes
 * null means don't render this event type
 */
export const EVENT_TO_INNER: Record<string, string | null> = {
  // User/assistant content
  'user.message': 'user-text',
  'assistant.message': 'assistant-text',
  'assistant.message_delta': 'assistant-text',

  // Thinking indicator (ephemeral - removed on content)
  'assistant.turn_start': 'thinking-text',

  // Activity inner types
  'assistant.intent': 'intent-text',
  'assistant.reasoning': 'reasoning-text',
  'assistant.reasoning_delta': 'reasoning-text',
  'tool.execution_start': 'tool-text',
  'tool.execution_progress': 'tool-text',
  'tool.execution_partial_result': 'tool-text',
  'tool.execution_complete': 'tool-text',
  'session.error': null,         // omit
  'session.compaction_start': 'compact-text',
  'session.compaction_complete': 'compact-text',

  // Caco synthetic types
  'caco.agent': 'agent-text',
  'caco.applet': 'applet-text',
  'caco.scheduler': 'scheduler-text',
  'caco.embed': 'embed-content',
  'caco.info': null,  // omit - internal signal
};

/**
 * Keyed events - events that use data-key for find-and-replace
 * Maps event type → property name to extract key value from event.data
 */
export const EVENT_KEY_PROPERTY: Record<string, string> = {
  // Thinking indicator uses turnId
  'assistant.turn_start': 'turnId',
  // Tool events use toolCallId
  'tool.execution_start': 'toolCallId',
  'tool.execution_progress': 'toolCallId',
  'tool.execution_partial_result': 'toolCallId',
  'tool.execution_complete': 'toolCallId',
  // Reasoning events use reasoningId
  'assistant.reasoning': 'reasoningId',
  'assistant.reasoning_delta': 'reasoningId',
  // Message deltas use messageId
  'assistant.message': 'messageId',
  'assistant.message_delta': 'messageId',
  // Embed events use outputId (each embed gets own element)
  'caco.embed': 'outputId',
};

/**
 * Events that should create pre-collapsed inner children
 * Tool calls start collapsed; reasoning streams visibly then collapses on completion
 */
export const PRE_COLLAPSED_EVENTS = new Set([
  'tool.execution_start',
]);

// ── ElementInserter (private) ───────────────────────────────────

/**
 * Generic element inserter - works with any map and parent.
 * Reuses last child if it matches, otherwise creates new.
 *
 * With keyProperty map: uses data-key attribute for find-and-replace
 * (e.g., multiple tool calls within same activity box)
 */
class ElementInserter {
  private map: Record<string, string | null>;
  private name: string;
  private debug: (msg: string) => void;
  private keyProperty: Record<string, string>;
  private preCollapsed: Set<string>;

  constructor(
    map: Record<string, string | null>,
    name: string,
    debug?: (msg: string) => void,
    keyProperty?: Record<string, string>,
    preCollapsed?: Set<string>
  ) {
    this.map = map;
    this.name = name;
    this.debug = debug || (() => {});
    this.keyProperty = keyProperty || {};
    this.preCollapsed = preCollapsed || new Set();
  }

  /**
   * Get or create element for event type within parent.
   * Returns null if event type maps to null (omit) or undefined (not in map).
   *
   * If event type has a keyProperty, uses data-key attribute for lookup:
   * - Finds existing child with matching data-key, OR
   * - Creates new child with data-key set
   *
   * Otherwise uses simple last-child matching.
   */
  getElement(eventType: string, parent: HTMLElement, data?: Record<string, unknown>): HTMLElement | null {
    const cssClass = this.map[eventType];
    if (cssClass === null || cssClass === undefined) return null;

    // Check if this event type uses keyed lookup
    const keyProp = this.keyProperty[eventType];
    if (keyProp && data) {
      const keyValue = data[keyProp];
      if (typeof keyValue === 'string' && keyValue) {
        return this.getOrCreateKeyed(cssClass, parent, keyValue, eventType);
      }
    }

    // Default: reuse last child if it matches
    const last = parent.lastElementChild as HTMLElement | null;
    if (last?.classList.contains(cssClass)) {
      this.debug(`[INSERTER] "${this.name}" reuse existing div for type "${eventType}"`);
      return last;
    }

    // Create new
    const div = document.createElement('div');
    div.className = cssClass;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create new div for type "${eventType}"`);
    return div;
  }

  /**
   * Get or create element by data-key attribute
   * Tool calls start collapsed; other keyed elements do not
   */
  private getOrCreateKeyed(cssClass: string, parent: HTMLElement, keyValue: string, eventType: string): HTMLElement {
    // Search for existing child with matching data-key
    const existing = parent.querySelector(`[data-key="${keyValue}"]`) as HTMLElement | null;
    if (existing) {
      this.debug(`[INSERTER] "${this.name}" found keyed div for "${eventType}" key="${keyValue}"`);
      return existing;
    }

    // Create new with data-key
    const div = document.createElement('div');
    const shouldCollapse = this.preCollapsed.has(eventType);
    div.className = shouldCollapse ? cssClass + ' collapsed' : cssClass;
    div.dataset.key = keyValue;
    parent.appendChild(div);
    this.debug(`[INSERTER] "${this.name}" create keyed div for "${eventType}" key="${keyValue}" collapsed=${shouldCollapse}`);
    return div;
  }
}

// ── Event inserter helpers ──────────────────────────────────────

/**
 * Element interface for DOM manipulation
 * Subset of HTMLElement to allow testing without real DOM
 */
export interface InserterElement {
  textContent: string | null;
  dataset: Record<string, string | undefined>;
  classList?: { add(name: string): void; remove(name: string): void };
}

type EventInserterFn = (element: InserterElement, data: Record<string, unknown>) => void;

/**
 * Get nested property by dot path (e.g., 'result.content')
 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o as Record<string, unknown>)?.[k],
    obj
  );
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

    // Sanitize and inject HTML (allow iframes for trusted embeds, strip IDs to prevent collisions)
    const purify = (window as unknown as { DOMPurify?: { sanitize: (html: string, options?: { ADD_TAGS?: string[], FORBID_ATTR?: string[] }) => string } }).DOMPurify;
    if (purify) {
      frame.innerHTML = purify.sanitize(data, { ADD_TAGS: ['iframe'], FORBID_ATTR: ['id'] });
    } else {
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

/** Create a simple path-based inserter (replace mode) */
function setPath(p: string): EventInserterFn {
  return (element, data) => {
    const value = getByPath(data, p);
    element.textContent = typeof value === 'string' ? value : '';
  };
}

/** Create an append-mode inserter for delta events */
function appendPath(p: string): EventInserterFn {
  return (element, data) => {
    const existing = element.textContent || '';
    const value = getByPath(data, p);
    element.textContent = existing + (typeof value === 'string' ? value : '');
  };
}

/** Safely extract a string from unknown SDK data. Returns fallback for non-strings. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ── EVENT_INSERTERS table ───────────────────────────────────────

/**
 * Event type → inserter function mapping
 *
 * Simple events use setPath() for direct property access.
 * Delta events use appendPath() to accumulate content.
 * Complex events use custom functions for formatting and data storage.
 */
export const EVENT_INSERTERS: Record<string, EventInserterFn> = {
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
    const messageId = str(data.messageId) || undefined;
    if (messageId && typeof window !== 'undefined') {
      finalize(element as unknown as HTMLElement, messageId, str(content));
    } else {
      element.textContent = str(content);
      if (typeof window !== 'undefined' && window.renderMarkdownElement) {
        window.renderMarkdownElement(element as unknown as Element);
      }
    }
  },
  'assistant.message_delta': (element, data) => {
    const messageId = str(data.messageId) || undefined;
    const delta = getByPath(data, 'deltaContent');
    const deltaStr = str(delta);

    if (messageId && typeof window !== 'undefined') {
      handleDelta(element as unknown as HTMLElement, messageId, deltaStr);
    } else {
      element.textContent = (element.textContent || '') + deltaStr;
    }
  },

  // Reasoning - render markdown on final event for proper collapse structure
  'assistant.reasoning': (element, data) => {
    const value = getByPath(data, 'content');
    element.textContent = typeof value === 'string' ? value : '';
    if (typeof window !== 'undefined' && window.renderMarkdownElement) {
      window.renderMarkdownElement(element as unknown as Element);
    }
  },
  'assistant.reasoning_delta': appendPath('deltaContent'),

  // Intent
  'assistant.intent': (element, data) => {
    element.textContent = `💡 ${data.intent || ''}`;
  },

  // Thinking indicator (shown on turn_start, removed on content)
  'assistant.turn_start': (element) => {
    element.textContent = '💭 Thinking...';
  },

  // Tool events - richer format with data storage
  'tool.execution_start': (element, data) => {
    const name = str(data.toolName, 'tool');
    const args = data.arguments as Record<string, unknown> | undefined;

    // Special case: report_intent shows intent as header
    if (name === 'report_intent' && args?.intent) {
      element.textContent = `💡 ${args.intent}`;
      element.dataset.toolName = name;
      return;
    }

    const input = str(args?.command || args?.description);

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
    const success = !!data.success;
    const result = str(getByPath(data, 'result.content')).trim();
    const rawError = data.error;
    const error = (typeof rawError === 'string' ? rawError : JSON.stringify(rawError) ?? '').trim();
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
    const msg = str(data.progressMessage);
    if (msg) element.textContent = `${existing}\n${msg}`;
  },

  'tool.execution_partial_result': (element, data) => {
    const existing = element.textContent || '';
    const output = str(data.partialOutput);
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
    const outputId = str(data.outputId);
    if (!outputId) {
      element.textContent = '❌ Missing embed outputId';
      return;
    }

    // Set placeholder while loading
    element.textContent = '⏳ Loading embed...';

    // Async fetch and render (only in browser)
    if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
      void fetchAndRenderEmbed(element as unknown as HTMLElement, outputId);
    }
  },
};

/**
 * Content events that should hide the thinking indicator.
 * When any of these arrive, the "Thinking..." message is replaced by actual content.
 */
export const CONTENT_EVENTS = new Set([
  'assistant.intent',
  'assistant.message',
  'assistant.message_delta',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'tool.execution_start',
  'session.idle',
  'session.error',
]);

// ── Standalone inserter helpers (for tests / external use) ──────

/**
 * Insert event content into element
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

/** Check if an event type has an inserter */
export function hasInserter(eventType: string): boolean {
  return eventType in EVENT_INSERTERS;
}

// ── ChatRegion ──────────────────────────────────────────────────

/**
 * ChatRegion — owns all mutations to #chat children.
 *
 * No other module calls querySelector, remove(), classList, createElement,
 * or insertBefore on elements inside #chat.
 *
 * Invariant: no global DOM *queries*. document.createElement is allowed
 * (creating a detached element doesn't query or modify any region).
 *
 * Lifecycle: create → content → state change → remove
 * All four phases are methods on this class.
 */
export class ChatRegion {
  private root: ScopedRoot;
  private outerInserter: ElementInserter;
  private innerInserter: ElementInserter;

  constructor(root: ScopedRoot) {
    this.root = root;
    this.outerInserter = new ElementInserter(EVENT_TO_OUTER as Record<string, string | null>, 'outer');
    this.innerInserter = new ElementInserter(EVENT_TO_INNER, 'inner', undefined, EVENT_KEY_PROPERTY, PRE_COLLAPSED_EVENTS);
  }

  // ── Render an event (create structure + set content) ──────────

  renderEvent(event: SessionEvent): void {
    let eventType = event.type;
    const data = event.data || {};

    // Transform source-typed user messages
    if (eventType === 'user.message' && data.source && data.source !== 'user') {
      eventType = `caco.${data.source}`;
    }

    // Get outer div
    const outer = this.outerInserter.getElement(eventType, this.root.el);
    if (!outer) return;

    // Get inner div (null = omit this event type)
    const inner = this.innerInserter.getElement(eventType, outer, data);
    if (!inner) return;

    // Insert event content
    this.insertContent({ type: eventType, data }, inner);

    // Post-collapse: reasoning collapses after streaming is complete
    if (eventType === 'assistant.reasoning') {
      inner.classList.add('collapsed');
    }
  }

  // ── Thinking lifecycle ────────────────────────────────────────

  /**
   * Remove thinking indicator. Scoped to this.root, sibling-safe:
   * removes only the thinking element; removes parent only if empty.
   */
  removeThinking(): void {
    const thinking = this.root.query('.thinking-text');
    if (!thinking) return;

    const parent = thinking.parentElement;
    thinking.remove();

    // Remove parent ONLY if now empty
    if (parent && parent !== this.root.el && parent.children.length === 0) {
      parent.remove();
    }
  }

  // ── Reasoning finalization ────────────────────────────────────

  /**
   * Finalize reasoning: find existing streamed element, update content,
   * add header, collapse. Returns true if handled.
   */
  finalizeReasoning(event: SessionEvent): boolean {
    const data = event.data || {};
    if (!data.reasoningId) return false;

    const existing = this.root.query(
      `[data-key="${data.reasoningId}"]`
    ) as HTMLElement | null;
    if (!existing) return false;

    // Update content
    this.insertContent(event, existing);

    // Add header (document.createElement is allowed — creates a detached
    // element, doesn't query or modify any region)
    const header = document.createElement('p');
    header.className = 'reasoning-header';
    header.textContent = 'reasoning';
    existing.insertBefore(header, existing.firstChild);
    existing.classList.add('collapsed');

    return true;  // handled, caller should not fall through
  }

  // ── Terminal cleanup ──────────────────────────────────────────

  removeStreamingCursors(): void {
    const cursors = this.root.queryAll('.streaming-cursor');
    for (const el of cursors) {
      el.classList.remove('streaming-cursor');
    }
  }

  // ── Interaction ───────────────────────────────────────────────

  setupClickHandler(): void {
    this.root.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const activity = target.closest('.assistant-activity');
      if (!activity) return;

      // Find the direct child of activity that was clicked
      let innerItem = target;
      while (innerItem.parentElement && innerItem.parentElement !== activity) {
        innerItem = innerItem.parentElement;
      }

      // Toggle collapse on the inner item
      if (innerItem && innerItem.parentElement === activity) {
        innerItem.classList.toggle('collapsed');
      }
    });
  }

  // ── Private ───────────────────────────────────────────────────

  /** Dispatch to EVENT_INSERTERS table */
  private insertContent(event: SessionEvent, element: InserterElement): void {
    const inserter = EVENT_INSERTERS[event.type];
    if (inserter) {
      inserter(element, event.data || {});
    }
  }
}
