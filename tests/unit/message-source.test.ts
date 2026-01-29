import { describe, it, expect } from 'vitest';

/**
 * Parse message source markers from content
 * Matches the logic in src/routes/applet-ws.ts streamHistory
 */
function parseMessageSource(content: string): {
  source: 'user' | 'applet' | 'agent';
  identifier?: string;
  cleanContent: string;
} {
  // Parse applet marker: [applet:slug]
  const appletMatch = content.match(/^\[applet:([^\]]+)\]\s*/);
  if (appletMatch) {
    return {
      source: 'applet',
      identifier: appletMatch[1],
      cleanContent: content.slice(appletMatch[0].length)
    };
  }
  
  // Parse agent marker: [agent:sessionId]
  const agentMatch = content.match(/^\[agent:([^\]]+)\]\s*/);
  if (agentMatch) {
    return {
      source: 'agent',
      identifier: agentMatch[1],
      cleanContent: content.slice(agentMatch[0].length)
    };
  }
  
  return { source: 'user', cleanContent: content };
}

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

  describe('edge cases', () => {
    it('handles empty content after prefix', () => {
      const result = parseMessageSource('[applet:test] ');
      expect(result.source).toBe('applet');
      expect(result.cleanContent).toBe('');
    });

    it('does not match [applet:] without slug', () => {
      const result = parseMessageSource('[applet:] message');
      // Regex requires at least one character - empty slug doesn't match
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
