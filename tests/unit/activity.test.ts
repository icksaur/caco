/**
 * Tests for message-streaming.ts - Tool argument/result formatting
 */
import { describe, it, expect } from 'vitest';
import { formatToolArgs, formatToolResult } from '../../public/ts/message-streaming.js';

describe('formatToolArgs', () => {
  it('returns empty string for undefined/empty', () => {
    expect(formatToolArgs(undefined)).toBe('');
    expect(formatToolArgs({})).toBe('');
  });

  it('formats key-value pairs', () => {
    expect(formatToolArgs({ query: 'hello', path: '/src' }))
      .toBe('query: hello, path: /src');
  });

  it('truncates long strings at 80 chars', () => {
    const result = formatToolArgs({ content: 'a'.repeat(100) });
    expect(result).toBe(`content: ${'a'.repeat(80)}...`);
  });

  it('formats objects as truncated JSON', () => {
    const result = formatToolArgs({ options: { a: 1 } });
    expect(result).toContain('options:');
    expect(result).toContain('...');
  });

  it('formats primitives directly', () => {
    expect(formatToolArgs({ count: 42, enabled: true }))
      .toBe('count: 42, enabled: true');
  });
});

describe('formatToolResult', () => {
  it('returns empty string for undefined/null', () => {
    expect(formatToolResult(undefined)).toBe('');
    expect(formatToolResult(null as unknown as undefined)).toBe('');
  });

  it('extracts and returns content field', () => {
    expect(formatToolResult({ content: 'Hello world' })).toBe('Hello world');
  });

  it('truncates long content at 500 chars', () => {
    const result = formatToolResult({ content: 'x'.repeat(600) });
    expect(result).toBe('x'.repeat(500) + '...');
  });

  it('stringifies result without content field', () => {
    expect(formatToolResult({ success: true })).toBe('{"success":true}');
  });
});
