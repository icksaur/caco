/**
 * Streaming Markdown Tests
 * 
 * Tests the incremental markdown rendering module.
 * Uses fake timers and mock DOM elements.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleDelta, finalize } from '../../public/ts/streaming-markdown.js';

// Mock renderMarkdownElement
const mockRender = vi.fn();

// Create mock element with minimal DOM interface
function createMockElement(): HTMLElement {
  const children: HTMLElement[] = [];
  const element = {
    textContent: '',
    innerHTML: '',
    style: {} as CSSStyleDeclaration,
    offsetHeight: 0,
    querySelector: (selector: string) => {
      if (selector === '.streaming-tail') {
        return children.find(c => c.className === 'streaming-tail') ?? null;
      }
      return null;
    },
    appendChild: (child: HTMLElement) => {
      children.push(child);
    },
    // Track children for assertions
    _children: children,
  } as unknown as HTMLElement;
  return element;
}

// Mock document.createElement
const originalCreateElement = global.document?.createElement;

describe('streaming-markdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    
    // Setup window mock
    (global as unknown as { window: { renderMarkdownElement: typeof mockRender } }).window = {
      renderMarkdownElement: mockRender,
    };
    
    // Setup document mock
    (global as unknown as { document: { createElement: (tag: string) => HTMLElement } }).document = {
      createElement: (tag: string) => {
        const el = {
          className: '',
          textContent: '',
          tagName: tag.toUpperCase(),
          remove: vi.fn(),
        };
        return el as unknown as HTMLElement;
      },
    };
    
    mockRender.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCreateElement) {
      global.document.createElement = originalCreateElement;
    }
  });

  describe('handleDelta', () => {
    it('accumulates delta content', () => {
      const element = createMockElement();
      
      handleDelta(element, 'msg1', 'Hello');
      handleDelta(element, 'msg1', ' world');
      
      // Check tail shows accumulated content (before any render)
      const tail = (element as unknown as { _children: { textContent: string }[] })._children[0];
      expect(tail?.textContent).toBe('Hello world');
      
      // Cleanup
      finalize(element, 'msg1', 'Hello world');
    });

    it('shows tail with unrendered content', () => {
      const element = createMockElement();
      
      handleDelta(element, 'msg2', 'Short');
      
      const children = (element as unknown as { _children: { className: string; textContent: string }[] })._children;
      expect(children.length).toBe(1);
      expect(children[0].className).toBe('streaming-tail');
      expect(children[0].textContent).toBe('Short');
      
      // Cleanup
      finalize(element, 'msg2', 'Short');
    });

    it('schedules render after 50+ chars', () => {
      const element = createMockElement();
      const longContent = 'x'.repeat(60);
      
      handleDelta(element, 'msg3', longContent);
      
      // Should schedule 50ms timer for threshold content
      expect(mockRender).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(50);
      expect(mockRender).toHaveBeenCalledTimes(1);
      
      // Cleanup
      finalize(element, 'msg3', longContent);
    });

    it('schedules slower render for small content', () => {
      const element = createMockElement();
      
      handleDelta(element, 'msg4', 'Hi');
      
      // Not enough for fast render
      vi.advanceTimersByTime(50);
      expect(mockRender).not.toHaveBeenCalled();
      
      // Should render at 200ms interval
      vi.advanceTimersByTime(150);
      expect(mockRender).toHaveBeenCalledTimes(1);
      
      // Cleanup
      finalize(element, 'msg4', 'Hi');
    });

    it('handles concurrent streams independently', () => {
      const element1 = createMockElement();
      const element2 = createMockElement();
      
      handleDelta(element1, 'stream1', 'First');
      handleDelta(element2, 'stream2', 'Second');
      
      const tail1 = (element1 as unknown as { _children: { textContent: string }[] })._children[0];
      const tail2 = (element2 as unknown as { _children: { textContent: string }[] })._children[0];
      
      expect(tail1?.textContent).toBe('First');
      expect(tail2?.textContent).toBe('Second');
      
      // Cleanup
      finalize(element1, 'stream1', 'First');
      finalize(element2, 'stream2', 'Second');
    });
  });

  describe('finalize', () => {
    it('clears pending timers', () => {
      const element = createMockElement();
      
      handleDelta(element, 'msg5', 'Content');
      
      // Timer is pending
      finalize(element, 'msg5', 'Final content');
      
      // Advance past when timer would have fired
      vi.advanceTimersByTime(500);
      
      // Render called only once (by finalize, not timer)
      expect(mockRender).toHaveBeenCalledTimes(1);
    });

    it('sets final content and renders', () => {
      const element = createMockElement();
      
      handleDelta(element, 'msg6', 'Partial');
      finalize(element, 'msg6', 'Complete message');
      
      expect(element.textContent).toBe('Complete message');
      expect(mockRender).toHaveBeenCalled();
    });

    it('works without prior handleDelta calls', () => {
      const element = createMockElement();
      
      // Direct finalize (e.g., from history load)
      finalize(element, 'new-msg', 'Full message');
      
      expect(element.textContent).toBe('Full message');
      expect(mockRender).toHaveBeenCalled();
    });
  });
});
