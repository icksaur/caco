import { describe, it, expect } from 'vitest';
import { parseMessageSource, prefixMessageSource } from '../../src/prompts.js';

describe('parseMessageSource', () => {
  describe('user messages', () => {
    it('returns user source for plain messages', () => {
      const result = parseMessageSource('Hello world');
      expect(result.source).toBe('user');
      expect(result.identifier).toBeUndefined();
      expect(result.cleanContent).toBe('Hello world');
    });

    it('returns user source for messages with brackets in middle', () => {
      const result = parseMessageSource('Check the [config] file');
      expect(result.source).toBe('user');
      expect(result.cleanContent).toBe('Check the [config] file');
    });
  });

  describe('applet messages', () => {
    it('parses [applet:slug] prefix', () => {
      const result = parseMessageSource('[applet:file-browser] Show files in /src');
      expect(result.source).toBe('applet');
      expect(result.identifier).toBe('file-browser');
      expect(result.cleanContent).toBe('Show files in /src');
    });

    it('handles applet slug with hyphens', () => {
      const result = parseMessageSource('[applet:my-complex-applet] Do something');
      expect(result.source).toBe('applet');
      expect(result.identifier).toBe('my-complex-applet');
      expect(result.cleanContent).toBe('Do something');
    });

    it('handles applet slug with underscores', () => {
      const result = parseMessageSource('[applet:code_editor] Edit file');
      expect(result.source).toBe('applet');
      expect(result.identifier).toBe('code_editor');
      expect(result.cleanContent).toBe('Edit file');
    });
  });

  describe('agent messages', () => {
    it('parses [agent:sessionId] prefix', () => {
      const result = parseMessageSource('[agent:abc-123-def] Analyze the codebase');
      expect(result.source).toBe('agent');
      expect(result.identifier).toBe('abc-123-def');
      expect(result.cleanContent).toBe('Analyze the codebase');
    });

    it('handles UUID-style session IDs', () => {
      const result = parseMessageSource('[agent:550e8400-e29b-41d4-a716-446655440000] Task complete');
      expect(result.source).toBe('agent');
      expect(result.identifier).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.cleanContent).toBe('Task complete');
    });

    it('handles short session IDs', () => {
      const result = parseMessageSource('[agent:sess1] Quick task');
      expect(result.source).toBe('agent');
      expect(result.identifier).toBe('sess1');
      expect(result.cleanContent).toBe('Quick task');
    });
  });

  describe('scheduler messages', () => {
    it('parses [scheduler:slug] prefix', () => {
      const result = parseMessageSource('[scheduler:daily-standup] Generate standup summary');
      expect(result.source).toBe('scheduler');
      expect(result.identifier).toBe('daily-standup');
      expect(result.cleanContent).toBe('Generate standup summary');
    });

    it('handles scheduler slug with underscores', () => {
      const result = parseMessageSource('[scheduler:weekly_report] Create report');
      expect(result.source).toBe('scheduler');
      expect(result.identifier).toBe('weekly_report');
      expect(result.cleanContent).toBe('Create report');
    });
  });

  describe('edge cases', () => {
    it('handles empty content after prefix', () => {
      const result = parseMessageSource('[applet:test] ');
      expect(result.source).toBe('applet');
      expect(result.cleanContent).toBe('');
    });

    it('does not match [applet:] without slug', () => {
      const result = parseMessageSource('[applet:] message');
      expect(result.source).toBe('user');
      expect(result.cleanContent).toBe('[applet:] message');
    });

    it('handles content with newlines', () => {
      const result = parseMessageSource('[agent:sess1] Line 1\nLine 2');
      expect(result.source).toBe('agent');
      expect(result.cleanContent).toBe('Line 1\nLine 2');
    });

    it('only matches at start of content', () => {
      const result = parseMessageSource('prefix [applet:test] message');
      expect(result.source).toBe('user');
      expect(result.cleanContent).toBe('prefix [applet:test] message');
    });
  });
});

describe('prefixMessageSource', () => {
  it('returns content unchanged for user source', () => {
    const result = prefixMessageSource('user', '', 'Hello world');
    expect(result).toBe('Hello world');
  });

  it('prefixes applet messages', () => {
    const result = prefixMessageSource('applet', 'file-browser', 'Show files');
    expect(result).toBe('[applet:file-browser] Show files');
  });

  it('prefixes agent messages', () => {
    const result = prefixMessageSource('agent', 'sess-123', 'Query data');
    expect(result).toBe('[agent:sess-123] Query data');
  });

  it('prefixes scheduler messages', () => {
    const result = prefixMessageSource('scheduler', 'daily-standup', 'Run task');
    expect(result).toBe('[scheduler:daily-standup] Run task');
  });

  it('round-trips with parseMessageSource', () => {
    const original = 'Some message';
    const prefixed = prefixMessageSource('applet', 'my-app', original);
    const parsed = parseMessageSource(prefixed);
    expect(parsed.source).toBe('applet');
    expect(parsed.identifier).toBe('my-app');
    expect(parsed.cleanContent).toBe(original);
  });
});
