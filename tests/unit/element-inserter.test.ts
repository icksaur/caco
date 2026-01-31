/**
 * Tests for ElementInserter class
 */
import { describe, it, expect, vi } from 'vitest';

// Simple mock element
function createMockElement(className: string = ''): HTMLElement & { _children: HTMLElement[] } {
  const children: HTMLElement[] = [];
  
  const el = {
    _children: children,
    className,
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
    }
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
    
    const { ElementInserter } = await import('../../public/ts/message-streaming.js');
    const inserter = new ElementInserter(map);
    
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
    
    const { ElementInserter } = await import('../../public/ts/message-streaming.js');
    const inserter = new ElementInserter(map);
    
    const el = inserter.getElement('unknown.event', mockParent);
    
    expect(el).toBeNull();
  });

  it('returns null for null-mapped event type (omit)', async () => {
    const mockParent = createMockElement();
    const map: Record<string, string | null> = { 'test.event': null };
    
    vi.stubGlobal('document', {
      createElement: () => createMockElement()
    });
    
    const { ElementInserter } = await import('../../public/ts/message-streaming.js');
    const inserter = new ElementInserter(map);
    
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
    
    const { ElementInserter } = await import('../../public/ts/message-streaming.js');
    const inserter = new ElementInserter(map);
    
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
    
    const { ElementInserter } = await import('../../public/ts/message-streaming.js');
    const inserter = new ElementInserter(map);
    
    const el = inserter.getElement('test.event', mockParent);
    
    expect(el).not.toBe(existingChild);
    expect(mockParent.appendChild).toHaveBeenCalled();
  });
});
