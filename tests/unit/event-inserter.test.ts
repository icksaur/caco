/**
 * Tests for event-inserter.ts
 */
import { describe, it, expect } from 'vitest';
import { insertEvent, hasInserter, InserterElement } from '../../public/ts/event-inserter.js';

/**
 * Create a mock element for testing
 */
function mockElement(textContent: string = '', dataset: Record<string, string> = {}): InserterElement {
  return { textContent, dataset };
}

describe('insertEvent', () => {
  describe('simple path insertion', () => {
    it('sets user.message content', () => {
      const el = mockElement();
      insertEvent({ type: 'user.message', data: { content: 'Hello world' } }, el);
      expect(el.textContent).toBe('Hello world');
    });

    it('sets assistant.message content', () => {
      const el = mockElement();
      insertEvent({ type: 'assistant.message', data: { content: 'Response text' } }, el);
      expect(el.textContent).toBe('Response text');
    });

    it('sets empty string for missing content', () => {
      const el = mockElement('old');
      insertEvent({ type: 'user.message', data: {} }, el);
      expect(el.textContent).toBe('');
    });
  });

  describe('delta append mode', () => {
    it('appends assistant.message_delta to existing', () => {
      const el = mockElement('Hello');
      insertEvent({ type: 'assistant.message_delta', data: { deltaContent: ' world' } }, el);
      expect(el.textContent).toBe('Hello world');
    });

    it('appends assistant.reasoning_delta to existing', () => {
      const el = mockElement('I am ');
      insertEvent({ type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking...' } }, el);
      expect(el.textContent).toBe('I am thinking...');
    });

    it('preserves existing if delta is missing', () => {
      const el = mockElement('Hello');
      insertEvent({ type: 'assistant.message_delta', data: {} }, el);
      expect(el.textContent).toBe('Hello');
    });
  });

  describe('tool events with data storage', () => {
    it('sets tool.execution_start with name only and stores data', () => {
      const el = mockElement();
      insertEvent({ type: 'tool.execution_start', data: { toolName: 'report_intent' } }, el);
      expect(el.textContent).toBe('🔧 report_intent');
      expect(el.dataset.toolName).toBe('report_intent');
      expect(el.dataset.toolInput).toBeUndefined();
    });

    it('sets tool.execution_start with command input and stores data', () => {
      const el = mockElement();
      insertEvent({ type: 'tool.execution_start', data: { 
        toolName: 'bash',
        arguments: { command: 'ls -la' }
      } }, el);
      expect(el.textContent).toBe('🔧 bash\n`ls -la`');
      expect(el.dataset.toolName).toBe('bash');
      expect(el.dataset.toolInput).toBe('ls -la');
    });

    it('formats successful tool.execution_complete reading stored data', () => {
      const el = mockElement('', { toolName: 'bash', toolInput: 'ls -la' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: { content: 'output here' }
      } }, el);
      expect(el.textContent).toBe('*bash*\n\n```bash\nls -la\noutput here\n```');
    });

    it('formats failed tool.execution_complete with error', () => {
      const el = mockElement('', { toolName: 'bash', toolInput: 'badcmd' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: false,
        error: 'command not found'
      } }, el);
      expect(el.textContent).toBe('*bash*\n\n```bash\nbadcmd\ncommand not found\n```');
    });

    it('formats tool.execution_complete without result content', () => {
      const el = mockElement('', { toolName: 'read_file' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: {}
      } }, el);
      expect(el.textContent).toBe('*read_file*\n\n```read_file\n\n```');
    });
    
    it('report_intent keeps intent display on complete (no change)', () => {
      const el = mockElement('💡 Testing intent', { toolName: 'report_intent' });
      insertEvent({ type: 'tool.execution_complete', data: { 
        success: true,
        result: {}
      } }, el);
      expect(el.textContent).toBe('💡 Testing intent');
    });
  });

  describe('intent events', () => {
    it('formats assistant.intent with emoji', () => {
      const el = mockElement();
      insertEvent({ type: 'assistant.intent', data: { intent: 'Testing the system' } }, el);
      expect(el.textContent).toBe('💡 Testing the system');
    });
  });

  describe('thinking indicator', () => {
    it('formats assistant.turn_start with thinking message', () => {
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: { turnId: 'turn_123' } }, el);
      expect(el.textContent).toBe('💭 Thinking...');
    });

    it('formats assistant.turn_start with empty data', () => {
      const el = mockElement();
      insertEvent({ type: 'assistant.turn_start', data: {} }, el);
      expect(el.textContent).toBe('💭 Thinking...');
    });
  });

  describe('session events', () => {
    it('sets compaction start message', () => {
      const el = mockElement();
      insertEvent({ type: 'session.compaction_start', data: {} }, el);
      expect(el.textContent).toBe('📦 Compacting conversation...');
    });

    it('sets compaction complete message', () => {
      const el = mockElement();
      insertEvent({ type: 'session.compaction_complete', data: {} }, el);
      expect(el.textContent).toBe('📦 Conversation compacted');
    });
  });

  describe('return value', () => {
    it('returns true for mapped event type', () => {
      const el = mockElement();
      expect(insertEvent({ type: 'user.message', data: { content: 'test' } }, el)).toBe(true);
    });

    it('returns false for unmapped event type', () => {
      const el = mockElement();
      expect(insertEvent({ type: 'unknown.event', data: { content: 'test' } }, el)).toBe(false);
    });
  });
});

describe('hasInserter', () => {
  it('returns true for mapped event types', () => {
    expect(hasInserter('user.message')).toBe(true);
    expect(hasInserter('assistant.message')).toBe(true);
    expect(hasInserter('tool.execution_start')).toBe(true);
  });

  it('returns false for unmapped event types', () => {
    expect(hasInserter('unknown.event')).toBe(false);
    expect(hasInserter('session.idle')).toBe(false);
  });
});
