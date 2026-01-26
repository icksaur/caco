/**
 * Tests for sse-parser.ts
 */
import { describe, it, expect } from 'vitest';
import { parseSSEBuffer, isTerminalEvent } from '../../public/ts/sse-parser.js';

describe('parseSSEBuffer', () => {
  describe('complete events', () => {
    it('parses single complete event', () => {
      const buffer = 'event: message\ndata: {"text":"hello"}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'message', data: '{"text":"hello"}' });
      expect(remainingBuffer).toBe('');
    });

    it('parses multiple complete events', () => {
      const buffer = 'event: start\ndata: {}\n\nevent: delta\ndata: {"content":"hi"}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'start', data: '{}' });
      expect(events[1]).toEqual({ type: 'delta', data: '{"content":"hi"}' });
      expect(remainingBuffer).toBe('');
    });

    it('handles events separated by multiple blank lines', () => {
      const buffer = 'event: a\ndata: 1\n\n\nevent: b\ndata: 2\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'a', data: '1' });
      expect(events[1]).toEqual({ type: 'b', data: '2' });
    });
  });

  describe('incomplete events', () => {
    it('keeps incomplete data line in remaining buffer', () => {
      // No trailing newline means line might be incomplete
      const buffer = 'event: message\ndata: {"text":"he';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('event: message\ndata: {"text":"he');
    });

    it('keeps partial event type line in remaining buffer', () => {
      const buffer = 'event: done\ndata: {}\n\nevent: next';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'done', data: '{}' });
      expect(remainingBuffer).toBe('event: next');
    });

    it('keeps event type waiting for data in remaining buffer', () => {
      const buffer = 'event: pending\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('event: pending\n');
    });
  });

  describe('edge cases', () => {
    it('handles empty buffer', () => {
      const { events, remainingBuffer } = parseSSEBuffer('');
      
      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('');
    });

    it('handles only blank lines', () => {
      const { events, remainingBuffer } = parseSSEBuffer('\n\n\n');
      
      expect(events).toHaveLength(0);
      expect(remainingBuffer).toBe('');
    });

    it('handles data with colons', () => {
      const buffer = 'event: url\ndata: {"url":"http://example.com:8080/path"}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('{"url":"http://example.com:8080/path"}');
    });

    it('handles event type with dots', () => {
      const buffer = 'event: assistant.message_delta\ndata: {"deltaContent":"x"}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant.message_delta');
    });

    it('handles event type with underscores', () => {
      const buffer = 'event: tool.execution_complete\ndata: {}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool.execution_complete');
    });

    it('handles empty data', () => {
      const buffer = 'event: ping\ndata: \n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('');
    });

    it('handles data without event type', () => {
      const buffer = 'data: {"orphan":true}\n';
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('');
      expect(events[0].data).toBe('{"orphan":true}');
    });
  });

  describe('real-world SSE patterns', () => {
    it('parses typical streaming response sequence', () => {
      const buffer = [
        'event: assistant.turn_start',
        'data: {"turnId":"0"}',
        '',
        'event: assistant.message_delta',
        'data: {"deltaContent":"Hello"}',
        '',
        'event: assistant.message_delta',
        'data: {"deltaContent":" world"}',
        '',
        'event: assistant.message',
        'data: {"content":"Hello world"}',
        '',
        'event: done',
        'data: {}',
        ''
      ].join('\n');
      
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('assistant.turn_start');
      expect(events[1].type).toBe('assistant.message_delta');
      expect(events[2].type).toBe('assistant.message_delta');
      expect(events[3].type).toBe('assistant.message');
      expect(events[4].type).toBe('done');
      expect(remainingBuffer).toBe('');
    });

    it('parses tool execution events', () => {
      const buffer = [
        'event: tool.execution_start',
        'data: {"toolName":"read_file","arguments":{"path":"/test.txt"}}',
        '',
        'event: tool.execution_complete',
        'data: {"toolName":"read_file","success":true,"result":{"content":"file contents"}}',
        ''
      ].join('\n');
      
      const { events, remainingBuffer } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool.execution_start');
      expect(JSON.parse(events[0].data)).toEqual({
        toolName: 'read_file',
        arguments: { path: '/test.txt' }
      });
    });

    it('handles error events', () => {
      const buffer = 'event: session.error\ndata: {"message":"Rate limit exceeded"}\n';
      const { events } = parseSSEBuffer(buffer);
      
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session.error');
      expect(JSON.parse(events[0].data).message).toBe('Rate limit exceeded');
    });
  });
});

describe('isTerminalEvent', () => {
  it('returns true for done', () => {
    expect(isTerminalEvent('done')).toBe(true);
  });

  it('returns true for session.idle', () => {
    expect(isTerminalEvent('session.idle')).toBe(true);
  });

  it('returns true for session.error', () => {
    expect(isTerminalEvent('session.error')).toBe(true);
  });

  it('returns false for message events', () => {
    expect(isTerminalEvent('assistant.message')).toBe(false);
    expect(isTerminalEvent('assistant.message_delta')).toBe(false);
  });

  it('returns false for tool events', () => {
    expect(isTerminalEvent('tool.execution_start')).toBe(false);
    expect(isTerminalEvent('tool.execution_complete')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTerminalEvent('')).toBe(false);
  });
});
