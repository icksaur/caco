/**
 * Tests for ElementInserter class
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simple mock element with dataset support
function createMockElement(className: string = ''): HTMLElement & { _children: HTMLElement[] } {
  const children: HTMLElement[] = [];
  const dataset: Record<string, string> = {};
  
  const el = {
    _children: children,
    className,
    dataset,
    classList: {
      contains: (c: string) => className.split(' ').includes(c),
      add: (c: string) => { className += ' ' + c; }
    },
    appendChild: vi.fn((child: HTMLElement) => {
      children.push(child);
      return child;
    }),
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    querySelector: vi.fn((selector: string) => {
      // Simple data-key selector support
      const match = selector.match(/\[data-key="([^"]+)"\]/);
      if (match) {
        const keyValue = match[1];
        return children.find(c => (c as unknown as { dataset: Record<string, string> }).dataset?.key === keyValue) || null;
      }
      return null;
    }),
    querySelectorAll: vi.fn(() => [])  // Auto-collapse - no activity boxes to collapse in tests
  };
  
  return el as unknown as HTMLElement & { _children: HTMLElement[] };
}

describe('ElementInserter', () => {
  it('creates new element when parent is empty', async () => {
    const mockParent = createMockElement();
    const map = { 'test.event': 'test-class' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test');
    
    const el = inserter.getElement('test.event', mockParent);
    
    expect(el).not.toBeNull();
    expect(mockParent.appendChild).toHaveBeenCalled();
  });

  it('returns null for unmapped event type', async () => {
    const mockParent = createMockElement();
    const map = { 'test.event': 'test-class' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test');
    
    const el = inserter.getElement('unknown.event', mockParent);
    
    expect(el).toBeNull();
  });

  it('returns null for null-mapped event type (omit)', async () => {
    const mockParent = createMockElement();
    const map: Record<string, string | null> = { 'test.event': null };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test');
    
    const el = inserter.getElement('test.event', mockParent);
    
    expect(el).toBeNull();
  });

  it('reuses last child if class matches', async () => {
    const existingChild = createMockElement('test-class');
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'test.event': 'test-class' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test');
    
    const el = inserter.getElement('test.event', mockParent);
    
    expect(el).toBe(existingChild);
    expect(mockParent.appendChild).not.toHaveBeenCalled();
  });

  it('creates new element if last child class differs', async () => {
    const existingChild = createMockElement('other-class');
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'test.event': 'test-class' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test');
    
    const el = inserter.getElement('test.event', mockParent);
    
    expect(el).not.toBe(existingChild);
    expect(mockParent.appendChild).toHaveBeenCalled();
  });
});

describe('ElementInserter keyed lookup', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('creates new element with data-key when keyProperty is set', async () => {
    const mockParent = createMockElement();
    const map = { 'tool.execution_start': 'tool-text' };
    const keyProperty = { 'tool.execution_start': 'toolCallId' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement('tool-text')
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test', undefined, keyProperty);
    
    const el = inserter.getElement('tool.execution_start', mockParent, { toolCallId: 'tool_123' });
    
    expect(el).not.toBeNull();
    expect((el as unknown as { dataset: Record<string, string> }).dataset.key).toBe('tool_123');
    expect(mockParent.appendChild).toHaveBeenCalled();
  });

  it('finds existing element by data-key', async () => {
    const existingChild = createMockElement('tool-text');
    (existingChild as unknown as { dataset: Record<string, string> }).dataset.key = 'tool_123';
    
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'tool.execution_complete': 'tool-text' };
    const keyProperty = { 'tool.execution_complete': 'toolCallId' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test', undefined, keyProperty);
    
    const el = inserter.getElement('tool.execution_complete', mockParent, { toolCallId: 'tool_123' });
    
    expect(el).toBe(existingChild);
    expect(mockParent.appendChild).not.toHaveBeenCalled();
  });

  it('creates new element when data-key does not match', async () => {
    const existingChild = createMockElement('tool-text');
    (existingChild as unknown as { dataset: Record<string, string> }).dataset.key = 'tool_456';
    
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'tool.execution_start': 'tool-text' };
    const keyProperty = { 'tool.execution_start': 'toolCallId' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement('tool-text')
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test', undefined, keyProperty);
    
    const el = inserter.getElement('tool.execution_start', mockParent, { toolCallId: 'tool_789' });
    
    expect(el).not.toBe(existingChild);
    expect(mockParent.appendChild).toHaveBeenCalled();
  });

  it('falls back to last-child matching when no keyProperty for event type', async () => {
    const existingChild = createMockElement('user-text');
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'user.message': 'user-text' };
    const keyProperty = { 'tool.execution_start': 'toolCallId' }; // Not for user.message
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test', undefined, keyProperty);
    
    const el = inserter.getElement('user.message', mockParent, { content: 'hello' });
    
    expect(el).toBe(existingChild);
    expect(mockParent.appendChild).not.toHaveBeenCalled();
  });

  it('falls back to last-child matching when data has no key value', async () => {
    const existingChild = createMockElement('tool-text');
    const mockParent = createMockElement();
    mockParent._children.push(existingChild);
    
    const map = { 'tool.execution_start': 'tool-text' };
    const keyProperty = { 'tool.execution_start': 'toolCallId' };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/element-inserter.js');
    const inserter = new ElementInserter(map, 'test', undefined, keyProperty);
    
    // data without toolCallId
    const el = inserter.getElement('tool.execution_start', mockParent, { toolName: 'bash' });
    
    expect(el).toBe(existingChild);
    expect(mockParent.appendChild).not.toHaveBeenCalled();
  });
});
