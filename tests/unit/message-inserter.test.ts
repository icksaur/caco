/**
 * Tests for MessageInserter class in message-streaming.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock DOM elements
function createMockElement(className: string = ''): HTMLElement {
  const children: HTMLElement[] = [];
  const classList = new Set(className.split(' ').filter(Boolean));
  
  const el = {
    className,
    innerHTML: '',
    textContent: '',
    dataset: {} as DOMStringMap,
    classList: {
      contains: (c: string) => classList.has(c),
      add: (c: string) => { classList.add(c); return undefined; },
      remove: (c: string) => classList.delete(c),
      toggle: (c: string) => classList.has(c) ? classList.delete(c) : classList.add(c)
    } as unknown as DOMTokenList,
    setAttribute: vi.fn(),
    getAttribute: vi.fn(() => null),
    appendChild: vi.fn((child: HTMLElement) => {
      children.push(child);
      return child;
    }),
    querySelector: vi.fn((selector: string) => {
      if (selector === '.markdown-content') {
        return { textContent: '', className: 'markdown-content' };
      }
      if (selector === '.activity-box') {
        const box = { 
          textContent: '', 
          className: 'activity-box',
          appendChild: vi.fn(),
          querySelectorAll: vi.fn(() => []),
          scrollTop: 0,
          scrollHeight: 100
        };
        return box;
      }
      if (selector === '.outputs-container') {
        return { className: 'outputs-container' };
      }
      if (selector === '.activity-count') {
        return { textContent: '' };
      }
      return null;
    }),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === '.activity-item') {
        return [];
      }
      if (selector === '.chat-content') {
        return children.filter(c => c.className?.includes('chat-content'));
      }
      return [];
    }),
    scrollTop: 0,
    scrollHeight: 100,
    get lastElementChild() {
      return children[children.length - 1] || null;
    }
  };
  
  return el as unknown as HTMLElement;
}

// Create a mock chat with configurable last child
function createMockChat(lastChild: HTMLElement | null = null): HTMLElement & { _lastChild: HTMLElement | null } {
  const children: HTMLElement[] = lastChild ? [lastChild] : [];
  
  const chat = {
    _lastChild: lastChild,
    className: '',
    appendChild: vi.fn((child: HTMLElement) => {
      children.push(child);
      chat._lastChild = child;
      return child;
    }),
    get lastElementChild() {
      return this._lastChild;
    },
    querySelectorAll: vi.fn(() => children)
  };
  
  return chat as unknown as HTMLElement & { _lastChild: HTMLElement | null };
}

describe('MessageInserter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('ensureOuter', () => {
    it('creates new user div (always new)', async () => {
      const mockChat = createMockChat();
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      
      const div1 = inserter.ensureOuter('user');
      expect(mockChat.appendChild).toHaveBeenCalled();
      expect(div1.className).toContain('user');
      
      // Second user message should also create new
      const div2 = inserter.ensureOuter('user');
      expect(mockChat.appendChild).toHaveBeenCalledTimes(2);
    });

    it('reuses last assistant div if matching', async () => {
      const existingDiv = createMockElement('chat-content');
      const mockChat = createMockChat(existingDiv);
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.ensureOuter('assistant');
      
      // Should return existing div, not create new
      expect(div).toBe(existingDiv);
      expect(mockChat.appendChild).not.toHaveBeenCalled();
    });

    it('creates new assistant div if last is different type', async () => {
      const existingDiv = createMockElement('message user');
      const mockChat = createMockChat(existingDiv);
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.ensureOuter('assistant');
      
      expect(mockChat.appendChild).toHaveBeenCalled();
    });

    it('reuses last activity div if matching', async () => {
      const existingDiv = createMockElement('message activity');
      const mockChat = createMockChat(existingDiv);
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.ensureOuter('activity');
      
      expect(div).toBe(existingDiv);
      expect(mockChat.appendChild).not.toHaveBeenCalled();
    });

    it('creates new activity div if last is assistant', async () => {
      const existingDiv = createMockElement('chat-content');
      const mockChat = createMockChat(existingDiv);
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.ensureOuter('activity');
      
      expect(mockChat.appendChild).toHaveBeenCalled();
    });
  });

  describe('insertUser', () => {
    it('escapes HTML in content', async () => {
      const mockChat = createMockChat();
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.insertUser('<script>alert("xss")</script>');
      
      expect(div.innerHTML).not.toContain('<script>');
      expect(div.innerHTML).toContain('&lt;script&gt;');
    });

    it('adds image indicator when hasImage is true', async () => {
      const mockChat = createMockChat();
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.insertUser('test message', true);
      
      expect(div.innerHTML).toContain('[img]');
    });

    it('adds applet class for applet source', async () => {
      const mockChat = createMockChat();
      
      vi.stubGlobal('document', {
        getElementById: (id: string) => id === 'chat' ? mockChat : null,
        createElement: () => createMockElement()
      });
      vi.stubGlobal('window', { renderMarkdown: vi.fn() });
      
      const { MessageInserter } = await import('../../public/ts/message-streaming.js');
      const inserter = new MessageInserter();
      const div = inserter.insertUser('test', false, 'applet', 'my-applet');
      
      expect(div.classList.contains('applet')).toBe(true);
    });
  });
});
