/**
 * Tests for activity.ts pure functions
 */
import { describe, it, expect } from 'vitest';
import { formatToolArgs, formatToolResult } from '../../public/ts/activity.js';

describe('formatToolArgs', () => {
  describe('empty/undefined input', () => {
    it('returns empty string for undefined', () => {
      expect(formatToolArgs(undefined)).toBe('');
    });

    it('returns empty string for empty object', () => {
      expect(formatToolArgs({})).toBe('');
    });
  });

  describe('string values', () => {
    it('formats single string argument', () => {
      expect(formatToolArgs({ query: 'hello' })).toBe('query: hello');
    });

    it('formats multiple string arguments', () => {
      const result = formatToolArgs({ name: 'test', path: '/src' });
      expect(result).toBe('name: test, path: /src');
    });

    it('truncates strings longer than 80 chars', () => {
      const longString = 'a'.repeat(100);
      const result = formatToolArgs({ content: longString });
      expect(result).toBe(`content: ${'a'.repeat(80)}...`);
    });

    it('does not truncate strings exactly 80 chars', () => {
      const exactString = 'a'.repeat(80);
      const result = formatToolArgs({ content: exactString });
      expect(result).toBe(`content: ${exactString}`);
    });

    it('preserves strings shorter than 80 chars', () => {
      const shortString = 'a'.repeat(50);
      const result = formatToolArgs({ content: shortString });
      expect(result).toBe(`content: ${shortString}`);
    });
  });

  describe('object values', () => {
    it('formats object as JSON and truncates', () => {
      const result = formatToolArgs({ options: { a: 1, b: 2 } });
      expect(result).toMatch(/^options: \{"a":1,"b":2\}\.\.\.$/);
    });

    it('truncates long object JSON to 60 chars', () => {
      const bigObject = { key: 'a'.repeat(100) };
      const result = formatToolArgs({ data: bigObject });
      // Should be "data: " + 60 chars of JSON + "..."
      expect(result).toMatch(/^data: .{60}\.\.\.$/);
    });

    it('formats nested objects', () => {
      const nested = { outer: { inner: { deep: 'value' } } };
      const result = formatToolArgs(nested);
      expect(result).toContain('outer:');
      expect(result).toContain('...');
    });

    it('formats arrays as objects', () => {
      const result = formatToolArgs({ items: [1, 2, 3] });
      expect(result).toMatch(/^items: \[1,2,3\]\.\.\.$/);
    });
  });

  describe('primitive values', () => {
    it('formats number values', () => {
      expect(formatToolArgs({ count: 42 })).toBe('count: 42');
    });

    it('formats boolean values', () => {
      expect(formatToolArgs({ enabled: true })).toBe('enabled: true');
      expect(formatToolArgs({ enabled: false })).toBe('enabled: false');
    });

    it('formats null values as object (typeof null is object)', () => {
      // null is typeof 'object' in JS, so it goes through JSON.stringify path
      expect(formatToolArgs({ value: null })).toBe('value: null...');
    });
  });

  describe('mixed types', () => {
    it('formats mixed argument types', () => {
      const args = {
        name: 'test',
        count: 5,
        active: true,
        config: { x: 1 }
      };
      const result = formatToolArgs(args);
      expect(result).toContain('name: test');
      expect(result).toContain('count: 5');
      expect(result).toContain('active: true');
      expect(result).toContain('config:');
    });
  });
});

describe('formatToolResult', () => {
  describe('empty/undefined input', () => {
    it('returns empty string for undefined', () => {
      expect(formatToolResult(undefined)).toBe('');
    });

    it('returns empty string for null', () => {
      expect(formatToolResult(null as unknown as undefined)).toBe('');
    });
  });

  describe('string content', () => {
    it('returns short content as-is', () => {
      const result = formatToolResult({ content: 'Hello world' });
      expect(result).toBe('Hello world');
    });

    it('truncates content longer than 500 chars', () => {
      const longContent = 'x'.repeat(600);
      const result = formatToolResult({ content: longContent });
      expect(result).toBe('x'.repeat(500) + '...');
    });

    it('does not truncate content exactly 500 chars', () => {
      const exactContent = 'x'.repeat(500);
      const result = formatToolResult({ content: exactContent });
      expect(result).toBe(exactContent);
    });

    it('preserves newlines in content', () => {
      const multiline = 'line1\nline2\nline3';
      const result = formatToolResult({ content: multiline });
      expect(result).toBe(multiline);
    });
  });

  describe('object content', () => {
    it('stringifies object content', () => {
      const result = formatToolResult({ content: { key: 'value' } });
      expect(result).toBe('{"key":"value"}');
    });

    it('truncates long stringified object content', () => {
      const bigContent = { data: 'x'.repeat(600) };
      const result = formatToolResult({ content: bigContent });
      expect(result.length).toBe(503); // 500 + "..."
      expect(result.endsWith('...')).toBe(true);
    });

    it('handles array content', () => {
      const result = formatToolResult({ content: [1, 2, 3] });
      expect(result).toBe('[1,2,3]');
    });

    it('handles nested object content', () => {
      const nested = { a: { b: { c: 'd' } } };
      const result = formatToolResult({ content: nested });
      expect(result).toBe('{"a":{"b":{"c":"d"}}}');
    });
  });

  describe('result without content', () => {
    it('stringifies result without content field', () => {
      const result = formatToolResult({ success: true });
      expect(result).toBe('{"success":true}');
    });

    it('truncates long result without content to 200 chars', () => {
      const bigResult = { data: 'y'.repeat(300) };
      const result = formatToolResult(bigResult);
      expect(result.length).toBe(200);
      // No ellipsis - just truncated
    });

    it('handles empty object result', () => {
      const result = formatToolResult({});
      expect(result).toBe('{}');
    });
  });

  describe('edge cases', () => {
    it('treats empty string as falsy (falls through to stringify)', () => {
      // if (result.content) is false for empty string
      const result = formatToolResult({ content: '' });
      expect(result).toBe('{"content":""}');
    });

    it('treats 0 as falsy (falls through to stringify)', () => {
      // if (result.content) is false for 0
      const result = formatToolResult({ content: 0 });
      expect(result).toBe('{"content":0}');
    });

    it('treats false as falsy (falls through to stringify)', () => {
      // if (result.content) is false for false
      const result = formatToolResult({ content: false });
      expect(result).toBe('{"content":false}');
    });
  });
});
