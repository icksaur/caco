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
  let _textContent: string | null = null;

  const el = {
    _children: children,
    get className() { return _className; },
    set className(v: string) { _className = v; },
    dataset,
    classList: {
      contains: (c: string) => _className.split(' ').filter(Boolean).includes(c),
      add: (c: string) => { if (!_className.split(' ').filter(Boolean).includes(c)) _className += (_className ? ' ' : '') + c; },
      remove: (c: string) => { _className = _className.split(' ').filter(x => x !== c).join(' '); },
      toggle: (c: string) => {
        if (_className.split(' ').filter(Boolean).includes(c)) {
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
    get firstElementChild() { return children[0] || null; },
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
      const keyMatch = selector.match(/\[data-key="([^"]+)"\]/);
      if (keyMatch) {
        const keyValue = keyMatch[1];
        return children.find(c => (c as unknown as { dataset: Record<string, string> }).dataset?.key === keyValue) || null;
      }
      const tagClassMatch = selector.match(/^([a-z]+)\.([a-zA-Z0-9_-]+)$/);
      if (tagClassMatch) {
        const tag = tagClassMatch[1].toUpperCase();
        const cls = tagClassMatch[2];
        return children.find(c =>
          (c as unknown as { tagName: string }).tagName === tag &&
          (c as unknown as { className: string }).className?.split(' ').includes(cls)
        ) || null;
      }
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
    get textContent() { return _textContent; },
    set textContent(v: string | null) {
      _textContent = v;
      if (v === '' || v === null) children.length = 0;
    },
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
    expect(EVENT_TO_INNER['session.error']).toBe('error-text');
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
      expect(el.textContent).toBe('report_intent');
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
      expect(el.textContent).toBe('bash\n`ls -la`');
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
      const el = mockElement('Testing intent', { toolName: 'report_intent' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: {}
      } }, el);
      expect(el.textContent).toBe('Testing intent');
    });
  });

  describe('intent events', () => {
    it('formats assistant.intent with emoji', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.intent', data: { intent: 'Testing the system' } }, el);
      expect(el.textContent).toBe('Testing the system');
    });
  });

  describe('thinking indicator', () => {
    it('formats assistant.turn_start with thinking message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: { turnId: 'turn_123' } }, el);
      expect(el.textContent).toBe('Thinking...');
    });

    it('formats assistant.turn_start with empty data', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: {} }, el);
      expect(el.textContent).toBe('Thinking...');
    });
  });

  describe('session events', () => {
    it('sets compaction start message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'session.compaction_start', data: {} }, el);
      expect(el.textContent).toBe('Compacting conversation...');
    });

    it('sets compaction complete message', async () => {
      const { insertEvent } = await import('../../public/ts/dom-regions.js');
      const el = mockElement();
      insertEvent({ type: 'session.compaction_complete', data: {} }, el);
      expect(el.textContent).toBe('Conversation compacted');
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

// ── Edit event pure-handler tests (spec §7.1) ───────────────────

describe('edit events', () => {
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

  type MockEl = ReturnType<typeof createMockElement>;

  function editEl(dataset: Record<string, string> = {}): MockEl {
    const el = createMockElement('tool-text');
    Object.assign(el.dataset, dataset);
    return el;
  }

  function childSpans(el: MockEl): MockEl[] {
    return (el as unknown as { _children: MockEl[] })._children;
  }

  function findClass(spans: MockEl[], cls: string): MockEl | undefined {
    return spans.find(s => (s as unknown as { className: string }).className === cls);
  }

  function makeEditComplete(
    toolName: string,
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return { toolName, toolCallId: 'tc-1', success: true, arguments: { path: 'file.ts', ...args }, result: { content: 'Updated 1 file' }, ...extra };
  }

  it('0-line diff renders header only, no pre, +0 -0, expanded', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'same', new_string: 'same' }) }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(el.classList.contains('collapsed')).toBe(false);
    expect(childSpans(el)).toHaveLength(1);
    const header = childSpans(el)[0];
    expect((header as unknown as { className: string }).className).toBe('edit-header');
    const hSpans = childSpans(header);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+0');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-0');
  });

  it('1-line add: renders, expanded, +1 -0', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: '', new_string: 'added' }) }, el);
    expect(el.classList.contains('collapsed')).toBe(false);
    const hSpans = childSpans(childSpans(el)[0]);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+1');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-0');
  });

  it('1-line remove: renders, expanded, +0 -1', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'removed', new_string: '' }) }, el);
    expect(el.classList.contains('collapsed')).toBe(false);
    const hSpans = childSpans(childSpans(el)[0]);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+0');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-1');
  });

  it('acceptance §8.1: 3-add 1-remove (edit parser.ts +3 -1), expanded', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', {
      path: 'parser.ts', old_string: 'line1\nold line\nline3', new_string: 'line1\nnew1\nnew2\nnew3\nline3'
    }) }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(el.classList.contains('collapsed')).toBe(false);
    // header is first child (invariant 8)
    expect(childSpans(el)[0]).toBeDefined();
    expect((childSpans(el)[0] as unknown as { className: string }).className).toBe('edit-header');
    const hSpans = childSpans(childSpans(el)[0]);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+3');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-1');
    // body has 4 line spans
    const body = childSpans(el)[1];
    expect((body as unknown as { className: string }).className).toBe('edit-body');
    const bodySpans = childSpans(body);
    expect(bodySpans.filter(s => (s as unknown as { className: string }).className === 'edit-line-add')).toHaveLength(3);
    expect(bodySpans.filter(s => (s as unknown as { className: string }).className === 'edit-line-rem')).toHaveLength(1);
  });

  it('3-add 2-remove: expanded', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'a\nb', new_string: 'c\nd\ne' }) }, el);
    expect(el.classList.contains('collapsed')).toBe(false);
    const hSpans = childSpans(childSpans(el)[0]);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+3');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-2');
  });

  it('exactly 6 changed lines: expanded (boundary)', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'a\nb\nc', new_string: 'd\ne\nf' }) }, el);
    expect(el.classList.contains('collapsed')).toBe(false);
  });

  it('7 changed lines: collapsed', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'a\nb\nc\nd', new_string: 'e\nf\ng' }) }, el);
    expect(el.classList.contains('collapsed')).toBe(true);
  });

  it('100-line add: collapsed', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: '', new_string: lines }) }, el);
    expect(el.classList.contains('collapsed')).toBe(true);
  });

  it('acceptance §8.3: create 50-line add → +50 -0, collapsed', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'create', toolCallId: 'tc-create', success: true,
      arguments: { path: 'new.ts', content },
      result: { content: 'Created file' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(el.classList.contains('collapsed')).toBe(true);
    const hSpans = childSpans(childSpans(el)[0]);
    expect(findClass(hSpans, 'edit-stat-add')?.textContent).toBe('+50');
    expect(findClass(hSpans, 'edit-stat-rem')?.textContent).toBe('-0');
  });

  it('acceptance §8.4: write replacing 5-line file with 5-line file → expanded if ≤6 total changed', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'write', toolCallId: 'tc-write', success: true,
      arguments: { path: 'config.json', content: 'a\nb\nc\nd\ne' },
      result: { content: 'Written' }
    } }, el);
    const hSpans = childSpans(childSpans(el)[0]);
    const added = parseInt(findClass(hSpans, 'edit-stat-add')?.textContent?.slice(1) ?? '0', 10);
    const removed = parseInt(findClass(hSpans, 'edit-stat-rem')?.textContent?.slice(1) ?? '0', 10);
    if (added + removed <= 6) {
      expect(el.classList.contains('collapsed')).toBe(false);
    } else {
      expect(el.classList.contains('collapsed')).toBe(true);
    }
  });

  it('failed edit with data.error string → error header + pre, not collapsed', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'edit', toolCallId: 'tc-fail', success: false,
      error: 'File not found', arguments: { path: 'missing.ts' }, result: {}
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(el.classList.contains('collapsed')).toBe(false);
    expect(childSpans(el)).toHaveLength(2);
    expect((childSpans(el)[0] as unknown as { className: string }).className).toBe('edit-header');
    expect((childSpans(el)[1] as unknown as { className: string }).className).toBe('edit-error');
    expect(childSpans(el)[1].textContent).toBe('File not found');
  });

  it('failed edit with result.content only → error extracted from there (§5.7 step 2)', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'edit', toolCallId: 'tc-fail2', success: false,
      arguments: { path: 'file.ts' },
      result: { content: 'Permission denied by policy' }
    } }, el);
    expect(el.classList.contains('collapsed')).toBe(false);
    expect(childSpans(el)[1].textContent).toBe('Permission denied by policy');
  });

  it('failed edit with no error text → "Unknown edit error"', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'edit', toolCallId: 'tc-fail3', success: false,
      arguments: { path: 'file.ts' }, result: {}
    } }, el);
    expect(childSpans(el)[1].textContent).toBe('Unknown edit error');
  });

  it('unparseable result → falls through to markdown render, collapsed unchanged', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl({ toolName: 'edit', toolInput: 'file.ts' });
    el.classList.add('collapsed');
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'edit', toolCallId: 'tc-opaque', success: true,
      result: { content: 'Updated 1 file' }
    } }, el);
    // rich render not applied → no edit-event class
    expect(el.classList.contains('edit-event')).toBe(false);
    // collapsed unchanged
    expect(el.classList.contains('collapsed')).toBe(true);
    // markdown path ran → textContent set to markdown string
    expect(typeof el.textContent).toBe('string');
    expect((el.textContent ?? '').includes('edit')).toBe(true);
  });

  it('non-edit regression: bash unchanged (invariant 7)', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl({ toolName: 'bash', toolInput: 'ls -la' });
    el.classList.add('collapsed');
    insertEvent({ type: 'tool.execution_complete', data: {
      success: true, result: { content: 'file1\nfile2' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(false);
    expect(el.classList.contains('collapsed')).toBe(true);
    expect(el.textContent).toBe('*bash*\n\n```bash\nls -la\nfile1\nfile2\n```');
  });

  it('non-edit regression: read_file unchanged', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl({ toolName: 'read_file', toolInput: 'src/main.ts' });
    el.classList.add('collapsed');
    insertEvent({ type: 'tool.execution_complete', data: {
      success: true, result: { content: 'file contents' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(false);
    expect(el.classList.contains('collapsed')).toBe(true);
    expect((el.textContent ?? '').startsWith('*read_file')).toBe(true);
  });

  it('header is element.children[0] for every successful rich render (invariant 8)', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();
    insertEvent({ type: 'tool.execution_complete', data: makeEditComplete('edit', { old_string: 'x', new_string: 'y' }) }, el);
    const firstChild = el._children[0];
    expect(firstChild).toBeDefined();
    expect((firstChild as unknown as { className: string }).className).toBe('edit-header');
  });

  it('toolName from data.toolName only', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();  // no dataset
    insertEvent({ type: 'tool.execution_complete', data: {
      toolName: 'write', toolCallId: 'tc-x', success: true,
      arguments: { path: 'f.ts', content: 'hello' }, result: { content: 'ok' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(findClass(childSpans(childSpans(el)[0]), 'edit-tool-name')?.textContent).toBe('write');
  });

  it('toolName from data.name only', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl();  // no dataset, no data.toolName
    insertEvent({ type: 'tool.execution_complete', data: {
      name: 'create', toolCallId: 'tc-y', success: true,
      arguments: { path: 'g.ts', content: 'hi' }, result: { content: 'ok' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(findClass(childSpans(childSpans(el)[0]), 'edit-tool-name')?.textContent).toBe('create');
  });

  it('toolName from element.dataset.toolName only', async () => {
    const { insertEvent } = await import('../../public/ts/dom-regions.js');
    const el = editEl({ toolName: 'edit' });  // no data.toolName or data.name
    insertEvent({ type: 'tool.execution_complete', data: {
      toolCallId: 'tc-z', success: true,
      arguments: { old_string: 'p', new_string: 'q' }, result: { content: 'ok' }
    } }, el);
    expect(el.classList.contains('edit-event')).toBe(true);
    expect(findClass(childSpans(childSpans(el)[0]), 'edit-tool-name')?.textContent).toBe('edit');
  });
});

// ── Edit lifecycle tests through ChatRegion (spec §7.2) ─────────

describe('edit lifecycle', () => {
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

  function buildRegion() {
    return import('../../public/ts/dom-regions.js').then(({ scopedRoot, ChatRegion }) => {
      const root = createMockElement();
      const region = new ChatRegion(scopedRoot(root));
      return { root, region };
    });
  }

  function getInner(root: ReturnType<typeof createMockElement>, key: string): ReturnType<typeof createMockElement> | undefined {
    const outer = root._children[0] as ReturnType<typeof createMockElement>;
    if (!outer) return undefined;
    return outer._children.find(c => (c as unknown as { dataset: { key?: string } }).dataset?.key === key) as ReturnType<typeof createMockElement> | undefined;
  }

  const startEvent = (toolName: string, toolCallId: string, path = 'parser.ts') => ({
    type: 'tool.execution_start' as const,
    data: { toolName, toolCallId, arguments: { path } }
  });

  const completeEvent = (toolName: string, toolCallId: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'tool.execution_complete' as const,
    data: { toolName, toolCallId, success: true, arguments: { path: 'parser.ts', ...args }, result: { content: 'Updated 1 file' }, ...extra }
  });

  it('L1: after start, element has tool-text collapsed, dataset.toolName set', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent(startEvent('edit', 'tc-L1'));
    const inner = getInner(root, 'tc-L1');
    expect(inner).toBeDefined();
    expect(inner!.classList.contains('tool-text')).toBe(true);
    expect(inner!.classList.contains('collapsed')).toBe(true);
    expect(inner!.dataset.toolName).toBe('edit');
  });

  it('L2: ≤6 lines — same element reused, collapsed removed, edit-event added, header is children[0]', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent(startEvent('edit', 'tc-L2'));
    const innerAfterStart = getInner(root, 'tc-L2');
    region.renderEvent(completeEvent('edit', 'tc-L2', { old_string: 'a\nb\nc', new_string: 'd\ne\nf' }));
    const innerAfterComplete = getInner(root, 'tc-L2');
    expect(innerAfterComplete).toBe(innerAfterStart);  // same element instance
    expect(innerAfterComplete!.classList.contains('collapsed')).toBe(false);
    expect(innerAfterComplete!.classList.contains('edit-event')).toBe(true);
    const firstChild = innerAfterComplete!._children[0];
    expect((firstChild as unknown as { className: string }).className).toBe('edit-header');
  });

  it('L3: >6 lines — collapsed retained', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent(startEvent('edit', 'tc-L3'));
    region.renderEvent(completeEvent('edit', 'tc-L3', { old_string: 'a\nb\nc\nd', new_string: 'e\nf\ng' }));
    const inner = getInner(root, 'tc-L3');
    expect(inner!.classList.contains('collapsed')).toBe(true);
  });

  it('L4: unparseable complete — collapsed retained, markdown rendered', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent(startEvent('edit', 'tc-L4', 'src/parser.ts'));
    region.renderEvent({
      type: 'tool.execution_complete',
      data: { toolName: 'edit', toolCallId: 'tc-L4', success: true, result: { content: 'Updated 1 file' } }
    });
    const inner = getInner(root, 'tc-L4');
    expect(inner!.classList.contains('collapsed')).toBe(true);
    expect(inner!.classList.contains('edit-event')).toBe(false);
    expect(typeof inner!.textContent).toBe('string');
    expect((inner!.textContent ?? '').length).toBeGreaterThan(0);
  });

  it('L5: success:false — collapsed removed, error body rendered', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent(startEvent('edit', 'tc-L5'));
    region.renderEvent({
      type: 'tool.execution_complete',
      data: { toolName: 'edit', toolCallId: 'tc-L5', success: false, error: 'denied', arguments: { path: 'parser.ts' } }
    });
    const inner = getInner(root, 'tc-L5');
    expect(inner!.classList.contains('collapsed')).toBe(false);
    const errorPre = inner!._children[1];
    expect((errorPre as unknown as { className: string }).className).toBe('edit-error');
    expect(errorPre.textContent).toBe('denied');
  });

  it('L6: bash start→complete — collapsed kept, markdown rendered (regression invariant 7)', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent({ type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'tc-L6', arguments: { command: 'ls' } } });
    region.renderEvent({
      type: 'tool.execution_complete',
      data: { toolName: 'bash', toolCallId: 'tc-L6', success: true, result: { content: 'output' } }
    });
    const inner = getInner(root, 'tc-L6');
    expect(inner!.classList.contains('collapsed')).toBe(true);
    expect(inner!.classList.contains('edit-event')).toBe(false);
    expect(typeof inner!.textContent).toBe('string');
    expect((inner!.textContent ?? '').includes('bash')).toBe(true);
  });

  it('L7: startless complete — data.toolName used, rich render works', async () => {
    const { root, region } = await buildRegion();
    region.renderEvent({
      type: 'tool.execution_complete',
      data: { toolName: 'edit', toolCallId: 'tc-L7', success: true, arguments: { path: 'new.ts', old_string: 'old', new_string: 'new' }, result: { content: 'Updated' } }
    });
    const inner = getInner(root, 'tc-L7');
    expect(inner).toBeDefined();
    expect(inner!.classList.contains('edit-event')).toBe(true);
    expect(inner!._children[0]).toBeDefined();
    expect((inner!._children[0] as unknown as { className: string }).className).toBe('edit-header');
  });
});
