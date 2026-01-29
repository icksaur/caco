import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Parse message source markers from content
 * Extracted from src/routes/applet-ws.ts streamHistory for testability
 */
export type MessageSource = 'user' | 'applet' | 'agent';

export interface ParsedMessage {
  source: MessageSource;
  appletSlug?: string;
  fromSession?: string;
  cleanContent: string;
}

export function parseMessageSource(content: string): ParsedMessage {
  // Parse applet marker: [applet:slug]
  const appletMatch = content.match(/^\[applet:([^\]]+)\]\s*/);
  if (appletMatch) {
    return {
      source: 'applet',
      appletSlug: appletMatch[1],
      cleanContent: content.slice(appletMatch[0].length)
    };
  }
  
  // Parse agent marker: [agent:sessionId]
  const agentMatch = content.match(/^\[agent:([^\]]+)\]\s*/);
  if (agentMatch) {
    return {
      source: 'agent',
      fromSession: agentMatch[1],
      cleanContent: content.slice(agentMatch[0].length)
    };
  }
  
  return { source: 'user', cleanContent: content };
}

/**
 * Extract output IDs from tool result content
 * Pattern: [output:id]
 */
export function extractOutputIds(content: string): string[] {
  const matches = content.matchAll(/\[output:([^\]]+)\]/g);
  return [...matches].map(m => m[1]);
}

/**
 * Build a ChatMessage from parsed history event
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: MessageSource;
  appletSlug?: string;
  fromSession?: string;
  outputs?: string[];
}

export function buildChatMessage(
  role: 'user' | 'assistant',
  content: string,
  pendingOutputs: string[] = []
): ChatMessage | null {
  if (role === 'user') {
    const parsed = parseMessageSource(content);
    if (!parsed.cleanContent) return null;
    
    return {
      id: 'test-id',
      role: 'user',
      content: parsed.cleanContent,
      source: parsed.source,
      appletSlug: parsed.appletSlug,
      fromSession: parsed.fromSession
    };
  } else {
    if (!content && pendingOutputs.length === 0) return null;
    
    return {
      id: 'test-id',
      role: 'assistant',
      content,
      outputs: pendingOutputs.length > 0 ? [...pendingOutputs] : undefined
    };
  }
}

// ============================================================
// Tests
// ============================================================

describe('parseMessageSource', () => {
  it('parses plain user messages', () => {
    const result = parseMessageSource('Hello world');
    expect(result.source).toBe('user');
    expect(result.cleanContent).toBe('Hello world');
    expect(result.appletSlug).toBeUndefined();
    expect(result.fromSession).toBeUndefined();
  });

  it('parses applet messages', () => {
    const result = parseMessageSource('[applet:file-browser] Show files');
    expect(result.source).toBe('applet');
    expect(result.appletSlug).toBe('file-browser');
    expect(result.cleanContent).toBe('Show files');
  });

  it('parses agent messages', () => {
    const result = parseMessageSource('[agent:session-abc] Query data');
    expect(result.source).toBe('agent');
    expect(result.fromSession).toBe('session-abc');
    expect(result.cleanContent).toBe('Query data');
  });

  it('handles whitespace after marker', () => {
    const result = parseMessageSource('[applet:test]   Multiple spaces');
    expect(result.cleanContent).toBe('Multiple spaces');
  });

  it('handles marker with no trailing content', () => {
    const result = parseMessageSource('[applet:test] ');
    expect(result.source).toBe('applet');
    expect(result.cleanContent).toBe('');
  });

  it('does not match markers in middle of message', () => {
    const result = parseMessageSource('Check the [applet:test] value');
    expect(result.source).toBe('user');
    expect(result.cleanContent).toBe('Check the [applet:test] value');
  });
});

describe('extractOutputIds', () => {
  it('extracts single output ID', () => {
    const result = extractOutputIds('Created file [output:abc123]');
    expect(result).toEqual(['abc123']);
  });

  it('extracts multiple output IDs', () => {
    const result = extractOutputIds('[output:a] and [output:b] done');
    expect(result).toEqual(['a', 'b']);
  });

  it('returns empty array for no outputs', () => {
    const result = extractOutputIds('No outputs here');
    expect(result).toEqual([]);
  });

  it('handles complex IDs with hyphens', () => {
    const result = extractOutputIds('[output:file-abc-123]');
    expect(result).toEqual(['file-abc-123']);
  });

  it('handles UUIDs', () => {
    const result = extractOutputIds('[output:550e8400-e29b-41d4-a716-446655440000]');
    expect(result).toEqual(['550e8400-e29b-41d4-a716-446655440000']);
  });
});

describe('buildChatMessage', () => {
  describe('user messages', () => {
    it('builds plain user message', () => {
      const msg = buildChatMessage('user', 'Hello world');
      expect(msg).toEqual({
        id: 'test-id',
        role: 'user',
        content: 'Hello world',
        source: 'user',
        appletSlug: undefined,
        fromSession: undefined
      });
    });

    it('builds applet user message', () => {
      const msg = buildChatMessage('user', '[applet:browser] Navigate');
      expect(msg).toEqual({
        id: 'test-id',
        role: 'user',
        content: 'Navigate',
        source: 'applet',
        appletSlug: 'browser',
        fromSession: undefined
      });
    });

    it('builds agent user message', () => {
      const msg = buildChatMessage('user', '[agent:sess-1] Delegate task');
      expect(msg).toEqual({
        id: 'test-id',
        role: 'user',
        content: 'Delegate task',
        source: 'agent',
        appletSlug: undefined,
        fromSession: 'sess-1'
      });
    });

    it('returns null for empty content after parsing', () => {
      const msg = buildChatMessage('user', '[applet:test] ');
      expect(msg).toBeNull();
    });
  });

  describe('assistant messages', () => {
    it('builds assistant message with content', () => {
      const msg = buildChatMessage('assistant', 'Here is the response');
      expect(msg).toEqual({
        id: 'test-id',
        role: 'assistant',
        content: 'Here is the response',
        outputs: undefined
      });
    });

    it('builds assistant message with outputs', () => {
      const msg = buildChatMessage('assistant', 'Created files', ['out1', 'out2']);
      expect(msg).toEqual({
        id: 'test-id',
        role: 'assistant',
        content: 'Created files',
        outputs: ['out1', 'out2']
      });
    });

    it('builds assistant message with only outputs', () => {
      const msg = buildChatMessage('assistant', '', ['output-id']);
      expect(msg).toEqual({
        id: 'test-id',
        role: 'assistant',
        content: '',
        outputs: ['output-id']
      });
    });

    it('returns null for empty content and no outputs', () => {
      const msg = buildChatMessage('assistant', '', []);
      expect(msg).toBeNull();
    });
  });
});

describe('message filtering by sessionId', () => {
  // These test the client-side filtering logic conceptually
  
  function shouldProcessMessage(
    msgSessionId: string | undefined,
    activeSessionId: string | null
  ): boolean {
    // Filter logic from applet-ws.ts handleMessage
    if (msgSessionId && activeSessionId && msgSessionId !== activeSessionId) {
      return false;
    }
    return true;
  }

  it('processes message when sessionIds match', () => {
    expect(shouldProcessMessage('session-1', 'session-1')).toBe(true);
  });

  it('ignores message for different session', () => {
    expect(shouldProcessMessage('session-2', 'session-1')).toBe(false);
  });

  it('processes message when no activeSessionId set', () => {
    expect(shouldProcessMessage('session-1', null)).toBe(true);
  });

  it('processes message with no sessionId (legacy)', () => {
    expect(shouldProcessMessage(undefined, 'session-1')).toBe(true);
  });
});
