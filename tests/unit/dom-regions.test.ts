/**
 * Tests for dom-regions.ts
 *
 * Merged from element-inserter.test.ts and event-inserter.test.ts.
 * Adds lifecycle tests for ChatRegion (removeThinking, finalizeReasoning, etc.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock element factory ────────────────────────────────────────

/** Create a mock HTMLElement with dataset, classList, and children support */
function createMockElement(className: string = ''): HTMLElement & { _children: HTMLElement[] } {
  const children: HTMLElement[] = [];
  const dataset: Record<string, string> = {};
  let _className = className;

  const el = {
    _children: children,
    get className() { return _className; },
    set className(v: string) { _className = v; },
    dataset,
    classList: {
      contains: (c: string) => _className.split(' ').includes(c),
      add: (c: string) => { if (!_className.split(' ').includes(c)) _className += (_className ? ' ' : '') + c; },
      remove: (c: string) => { _className = _className.split(' ').filter(x => x !== c).join(' '); },
      toggle: (c: string) => {
        if (_className.split(' ').includes(c)) {
          _className = _className.split(' ').filter(x => x !== c).join(' ');
        } else {
          _className += (_className ? ' ' : '') + c;
        }
      },
    },
    appendChild: vi.fn((child: HTMLElement) => {
      children.push(child);
      (child as unknown as { parentElement: unknown }).parentElement = el;
      return child;
    }),
    get children() { return children; },
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    get firstChild() {
      return children[0] || null;
    },
    insertBefore: vi.fn((newChild: HTMLElement, refChild: HTMLElement | null) => {
      if (refChild === null) {
        children.push(newChild);
      } else {
        const idx = children.indexOf(refChild);
        if (idx >= 0) children.splice(idx, 0, newChild);
        else children.push(newChild);
      }
      (newChild as unknown as { parentElement: unknown }).parentElement = el;
      return newChild;
    }),
    remove: vi.fn(function(this: { parentElement?: { _children: HTMLElement[] } }) {
      if (this.parentElement && (this.parentElement as { _children: HTMLElement[] })._children) {
        const arr = (this.parentElement as { _children: HTMLElement[] })._children;
        const idx = arr.indexOf(this as unknown as HTMLElement);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }),
    parentElement: null as unknown,
    querySelector: vi.fn((selector: string) => {
      // Simple data-key selector support
      const keyMatch = selector.match(/\[data-key="([^"]+)"\]/);
      if (keyMatch) {
        const keyValue = keyMatch[1];
        return children.find(c => (c as unknown as { dataset: Record<string, string> }).dataset?.key === keyValue) || null;
      }
      // Simple class selector support
      const classMatch = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
      if (classMatch) {
        const cls = classMatch[1];
        return findByClass(children, cls);
      }
      return null;
    }),
    querySelectorAll: vi.fn((selector: string) => {
      const classMatch = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
      if (classMatch) {
        return findAllByClass(children, classMatch[1]);
      }
      return [];
    }),
    addEventListener: vi.fn(),
    get innerHTML() { return ''; },
    set innerHTML(v: string) {
      if (v === '') children.length = 0;
    },
    textContent: null as string | null,
  };

  return el as unknown as HTMLElement & { _children: HTMLElement[] };
}

/** Recursively find first element with given class */
function findByClass(elements: HTMLElement[], cls: string): HTMLElement | null {
  for (const el of elements) {
    if ((el as unknown as { className: string }).className?.split(' ').includes(cls)) return el;
    const child = findByClass((el as unknown as { _children: HTMLElement[] })._children || [], cls);
    if (child) return child;
  }
  return null;
}

/** Recursively find all elements with given class */
function findAllByClass(elements: HTMLElement[], cls: string): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const el of elements) {
    if ((el as unknown as { className: string }).className?.split(' ').includes(cls)) result.push(el);
    result.push(...findAllByClass((el as unknown as { _children: HTMLElement[] })._children || [], cls));
  }
  return result;
}

// ── Mock element for InserterElement tests ──────────────────────

interface InserterElement {
  textContent: string | null;
  dataset: Record<string, string | undefined>;
  classList?: { add(name: string): void; remove(name: string): void };
}

function mockElement(textContent: string = '', dataset: Record<string, string> = {}): InserterElement {
  return { textContent, dataset };
}

// ── ElementInserter tests (from element-inserter.test.ts) ───────

describe('ElementInserter (via config tables)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = createMockElement();
        (el as unknown as { tagName: string }).tagName = tag.toUpperCase();
        return el;
      },
    });
  });

  it('creates new element when parent is empty', async () => {
    const { EVENT_TO_OUTER } = await import('../../public/ts/dom-regions.js');

    // Verify config table correctness
    expect(EVENT_TO_OUTER['user.message']).toBe('user-message');
    expect(EVENT_TO_OUTER['assistant.message']).toBe('assistant-message');
  });

  it('maps all activity events to assistant-activity', async () => {
    const { EVENT_TO_OUTER } = await import('../../public/ts/dom-regions.js');
    const activityEvents = [
      'assistant.turn_start', 'assistant.intent', 'assistant.reasoning',
      'tool.execution_start', 'tool.execution_complete', 'session.error',
    ];
    for (const evt of activityEvents) {
      expect(EVENT_TO_OUTER[evt]).toBe('assistant-activity');
    }
  });

  it('maps caco synthetic types to correct outer classes', async () => {
    const { EVENT_TO_OUTER } = await import('../../public/ts/dom-regions.js');
    expect(EVENT_TO_OUTER['caco.agent']).toBe('agent-message');
    expect(EVENT_TO_OUTER['caco.applet']).toBe('applet-message');
    expect(EVENT_TO_OUTER['caco.scheduler']).toBe('scheduler-message');
    expect(EVENT_TO_OUTER['caco.embed']).toBe('embed-message');
  });
});

describe('EVENT_TO_INNER', () => {
  it('maps inner classes correctly', async () => {
    const { EVENT_TO_INNER } = await import('../../public/ts/dom-regions.js');
    expect(EVENT_TO_INNER['user.message']).toBe('user-text');
    expect(EVENT_TO_INNER['assistant.message']).toBe('assistant-text');
    expect(EVENT_TO_INNER['assistant.turn_start']).toBe('thinking-text');
    expect(EVENT_TO_INNER['session.error']).toBeNull();
    expect(EVENT_TO_INNER['caco.info']).toBeNull();
  });
});

describe('EVENT_KEY_PROPERTY', () => {
  it('includes caco.embed with outputId key', async () => {
    const { EVENT_KEY_PROPERTY } = await import('../../public/ts/dom-regions.js');
    expect(EVENT_KEY_PROPERTY['caco.embed']).toBe('outputId');
  });

  it('includes tool events with toolCallId key', async () => {
    const { EVENT_KEY_PROPERTY } = await import('../../public/ts/dom-regions.js');
    expect(EVENT_KEY_PROPERTY['tool.execution_start']).toBe('toolCallId');
    expect(EVENT_KEY_PROPERTY['tool.execution_complete']).toBe('toolCallId');
  });

  it('includes reasoning events with reasoningId key', async () => {
    const { EVENT_KEY_PROPERTY } = await import('../../public/ts/dom-regions.js');
    expect(EVENT_KEY_PROPERTY['assistant.reasoning']).toBe('reasoningId');
    expect(EVENT_KEY_PROPERTY['assistant.reasoning_delta']).toBe('reasoningId');
  });
});

// ── Event inserter tests (from event-inserter.test.ts) ──────────

describe('insertEvent', () => {
  describe('simple path insertion', () => {
    it('sets user.message content', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'user.message', data: { content: 'Hello world' } }, el);
      expect(el.textContent).toBe('Hello world');
    });

    it('sets assistant.message content', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.message', data: { content: 'Response text' } }, el);
      expect(el.textContent).toBe('Response text');
    });

    it('sets empty string for missing content', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('old');
      insertEvent({ type: 'user.message', data: {} }, el);
      expect(el.textContent).toBe('');
    });
  });

  describe('delta append mode', () => {
    it('appends assistant.message_delta to existing', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('Hello');
      insertEvent({ type: 'assistant.message_delta', data: { deltaContent: ' world' } }, el);
      expect(el.textContent).toBe('Hello world');
    });

    it('appends assistant.reasoning_delta to existing', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('I am ');
      insertEvent({ type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking...' } }, el);
      expect(el.textContent).toBe('I am thinking...');
    });

    it('preserves existing if delta is missing', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('Hello');
      insertEvent({ type: 'assistant.message_delta', data: {} }, el);
      expect(el.textContent).toBe('Hello');
    });
  });

  describe('tool events with data storage', () => {
    it('sets tool.execution_start with name only and stores data', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'tool.execution_start', data: { toolName: 'report_intent' } }, el);
      expect(el.textContent).toBe('🔧 report_intent');
      expect(el.dataset.toolName).toBe('report_intent');
      expect(el.dataset.toolInput).toBeUndefined();
    });

    it('sets tool.execution_start with command input and stores data', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'tool.execution_start', data: { 
        toolName: 'bash',
        arguments: { command: 'ls -la' }
      } }, el);
      expect(el.textContent).toBe('🔧 bash\n`ls -la`');
      expect(el.dataset.toolName).toBe('bash');
      expect(el.dataset.toolInput).toBe('ls -la');
    });

    it('formats successful tool.execution_complete reading stored data', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('', { toolName: 'bash', toolInput: 'ls -la' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: { content: 'output here' }
      } }, el);
      expect(el.textContent).toBe('*bash*\n\n```bash\nls -la\noutput here\n```');
    });

    it('formats failed tool.execution_complete with error', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('', { toolName: 'bash', toolInput: 'badcmd' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: false,
        error: 'command not found'
      } }, el);
      expect(el.textContent).toBe('*bash*\n\n```bash\nbadcmd\ncommand not found\n```');
    });

    it('formats tool.execution_complete without result content', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('', { toolName: 'read_file' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: {}
      } }, el);
      expect(el.textContent).toBe('*read_file*\n\n```read_file\n\n```');
    });

    it('report_intent keeps intent display on complete (no change)', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement('💡 Testing intent', { toolName: 'report_intent' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: {}
      } }, el);
      expect(el.textContent).toBe('💡 Testing intent');
    });
  });

  describe('intent events', () => {
    it('formats assistant.intent with emoji', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.intent', data: { intent: 'Testing the system' } }, el);
      expect(el.textContent).toBe('💡 Testing the system');
    });
  });

  describe('thinking indicator', () => {
    it('formats assistant.turn_start with thinking message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: { turnId: 'turn_123' } }, el);
      expect(el.textContent).toBe('💭 Thinking...');
    });

    it('formats assistant.turn_start with empty data', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: {} }, el);
      expect(el.textContent).toBe('💭 Thinking...');
    });
  });

  describe('session events', () => {
    it('sets compaction start message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'session.compaction_start', data: {} }, el);
      expect(el.textContent).toBe('📦 Compacting conversation...');
    });

    it('sets compaction complete message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'session.compaction_complete', data: {} }, el);
      expect(el.textContent).toBe('📦 Conversation compacted');
    });
  });

  describe('return value', () => {
    it('returns true for mapped event type', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      expect(insertEvent({ type: 'user.message', data: { content: 'test' } }, el)).toBe(true);
    });

    it('returns false for unmapped event type', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      expect(insertEvent({ type: 'unknown.event', data: { content: 'test' } }, el)).toBe(false);
    });
  });
});

describe('hasInserter', () => {
  it('returns true for mapped event types', async () => {
    const { hasInserter } = await import('../../public/ts/dom-regions.js');
    expect(hasInserter('user.message')).toBe(true);
    expect(hasInserter('assistant.message')).toBe(true);
    expect(hasInserter('tool.execution_start')).toBe(true);
  });

  it('returns false for unmapped event types', async () => {
    const { hasInserter } = await import('../../public/ts/dom-regions.js');
    expect(hasInserter('unknown.event')).toBe(false);
    expect(hasInserter('session.idle')).toBe(false);
  });
});

// ── scopedRoot tests ────────────────────────────────────────────

describe('scopedRoot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('query scopes to the root element', async () => {
    const { scopedRoot } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const child = createMockElement('target');
    root._children.push(child);

    const scoped = scopedRoot(root);
    scoped.query('.target');
    expect(root.querySelector).toHaveBeenCalledWith('.target');
  });

  it('queryAll scopes to the root element', async () => {
    const { scopedRoot } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();

    const scoped = scopedRoot(root);
    scoped.queryAll('.streaming-cursor');
    expect(root.querySelectorAll).toHaveBeenCalledWith('.streaming-cursor');
  });

  it('clear empties the root element', async () => {
    const { scopedRoot } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const child = createMockElement('child');
    root._children.push(child);

    const scoped = scopedRoot(root);
    scoped.clear();
    expect(root._children.length).toBe(0);
  });

  it('el provides direct access to root element', async () => {
    const { scopedRoot } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const scoped = scopedRoot(root);
    expect(scoped.el).toBe(root);
  });
});

// ── ChatRegion lifecycle tests ──────────────────────────────────

describe('ChatRegion.removeThinking', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = createMockElement();
        (el as unknown as { tagName: string }).tagName = tag.toUpperCase();
        return el;
      },
    });
  });

  it('removes thinking-text element', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const activity = createMockElement('assistant-activity');
    const thinking = createMockElement('thinking-text');
    root.appendChild(activity);
    activity.appendChild(thinking);

    const region = new ChatRegion(scopedRoot(root));
    region.removeThinking();

    expect(activity._children).not.toContain(thinking);
  });

  it('removes empty parent activity div', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const activity = createMockElement('assistant-activity');
    const thinking = createMockElement('thinking-text');
    root.appendChild(activity);
    activity.appendChild(thinking);

    const region = new ChatRegion(scopedRoot(root));
    region.removeThinking();

    // Parent should be removed since it's now empty
    expect(root._children).not.toContain(activity);
  });

  it('preserves parent activity div when siblings exist', async () => {
    // THE BUG — this test would have caught the regression
    // Setup: activity div with thinking-text AND intent-text
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const activity = createMockElement('assistant-activity');
    const thinking = createMockElement('thinking-text');
    const intent = createMockElement('intent-text');
    root.appendChild(activity);
    activity.appendChild(thinking);
    activity.appendChild(intent);

    const region = new ChatRegion(scopedRoot(root));
    region.removeThinking();

    // Thinking removed, but intent and activity still exist
    expect(activity._children).not.toContain(thinking);
    expect(activity._children).toContain(intent);
    expect(root._children).toContain(activity);
  });

  it('is scoped to chat element, not global document', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();

    const region = new ChatRegion(scopedRoot(root));
    region.removeThinking();

    // Should query scoped root, not document
    expect(root.querySelector).toHaveBeenCalledWith('.thinking-text');
  });

  it('is no-op when no thinking element exists', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const activity = createMockElement('assistant-activity');
    const intent = createMockElement('intent-text');
    root.appendChild(activity);
    activity.appendChild(intent);

    const region = new ChatRegion(scopedRoot(root));
    region.removeThinking();

    // Nothing should change
    expect(root._children).toContain(activity);
    expect(activity._children).toContain(intent);
  });
});

describe('ChatRegion.removeStreamingCursors', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: () => createMockElement(),
    });
  });

  it('removes streaming-cursor class from all elements', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const el1 = createMockElement('assistant-text streaming-cursor');
    const el2 = createMockElement('user-text streaming-cursor');
    root._children.push(el1, el2);
    // Override querySelectorAll to return our elements
    (root.querySelectorAll as ReturnType<typeof vi.fn>).mockReturnValue([el1, el2]);

    const region = new ChatRegion(scopedRoot(root));
    region.removeStreamingCursors();

    expect(el1.classList.contains('streaming-cursor')).toBe(false);
    expect(el2.classList.contains('streaming-cursor')).toBe(false);
  });

  it('is no-op when no cursors exist', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    (root.querySelectorAll as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const region = new ChatRegion(scopedRoot(root));
    // Should not throw
    region.removeStreamingCursors();
  });
});

describe('ChatRegion.finalizeReasoning', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = createMockElement();
        (el as unknown as { tagName: string }).tagName = tag.toUpperCase();
        return el;
      },
    });
  });

  it('finds existing reasoning element by data-key and returns true', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const existing = createMockElement('reasoning-text');
    existing.dataset.key = 'reason_1';
    root.appendChild(existing);

    const region = new ChatRegion(scopedRoot(root));
    const result = region.finalizeReasoning({
      type: 'assistant.reasoning',
      data: { reasoningId: 'reason_1', content: 'I thought about it' }
    });

    expect(result).toBe(true);
  });

  it('adds reasoning header as first child', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const existing = createMockElement('reasoning-text');
    existing.dataset.key = 'reason_1';
    root.appendChild(existing);

    const region = new ChatRegion(scopedRoot(root));
    region.finalizeReasoning({
      type: 'assistant.reasoning',
      data: { reasoningId: 'reason_1', content: 'thought' }
    });

    // First child should be the reasoning header
    const header = existing._children[0];
    expect(header).toBeDefined();
    expect((header as unknown as { className: string }).className).toBe('reasoning-header');
    expect(header.textContent).toBe('reasoning');
  });

  it('adds collapsed class', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    const existing = createMockElement('reasoning-text');
    existing.dataset.key = 'reason_1';
    root.appendChild(existing);

    const region = new ChatRegion(scopedRoot(root));
    region.finalizeReasoning({
      type: 'assistant.reasoning',
      data: { reasoningId: 'reason_1', content: 'thought' }
    });

    expect(existing.classList.contains('collapsed')).toBe(true);
  });

  it('returns false when no matching element exists', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();

    const region = new ChatRegion(scopedRoot(root));
    const result = region.finalizeReasoning({
      type: 'assistant.reasoning',
      data: { reasoningId: 'nonexistent', content: 'thought' }
    });

    expect(result).toBe(false);
  });

  it('returns false when no reasoningId in data', async () => {
    const { scopedRoot, ChatRegion } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();

    const region = new ChatRegion(scopedRoot(root));
    const result = region.finalizeReasoning({
      type: 'assistant.reasoning',
      data: { content: 'no id' }
    });

    expect(result).toBe(false);
  });
});

describe('ChatRegion.clear (via scopedRoot)', () => {
  it('removes all children from chat element', async () => {
    const { scopedRoot } = await import('../../public/ts/dom-regions.js');
    const root = createMockElement();
    root._children.push(createMockElement('a'), createMockElement('b'));

    const scoped = scopedRoot(root);
    scoped.clear();
    expect(root._children.length).toBe(0);
  });
});

describe('CONTENT_EVENTS', () => {
  it('includes expected content events', async () => {
    const { CONTENT_EVENTS } = await import('../../public/ts/dom-regions.js');
    expect(CONTENT_EVENTS.has('assistant.intent')).toBe(true);
    expect(CONTENT_EVENTS.has('assistant.message')).toBe(true);
    expect(CONTENT_EVENTS.has('tool.execution_start')).toBe(true);
    expect(CONTENT_EVENTS.has('session.idle')).toBe(true);
    expect(CONTENT_EVENTS.has('session.error')).toBe(true);
  });

  it('does not include non-content events', async () => {
    const { CONTENT_EVENTS } = await import('../../public/ts/dom-regions.js');
    expect(CONTENT_EVENTS.has('assistant.turn_start')).toBe(false);
    expect(CONTENT_EVENTS.has('user.message')).toBe(false);
  });
});
