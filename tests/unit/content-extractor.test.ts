/**
 * Tests for content-extractor.ts
 */
import { describe, it, expect } from 'vitest';
import { extractContent, hasExtractor } from '../../public/ts/content-extractor.js';

describe('extractContent', () => {
  describe('simple path extraction', () => {
    it('extracts user.message content', () => {
      const result = extractContent('user.message', { content: 'Hello world' }, '');
      expect(result).toBe('Hello world');
    });

    it('extracts assistant.message content', () => {
      const result = extractContent('assistant.message', { content: 'Response text' }, '');
      expect(result).toBe('Response text');
    });

    it('returns empty string for missing content', () => {
      const result = extractContent('user.message', {}, '');
      expect(result).toBe('');
    });
  });

  describe('delta append mode', () => {
    it('appends assistant.message_delta to existing', () => {
      const result = extractContent('assistant.message_delta', { deltaContent: ' world' }, 'Hello');
      expect(result).toBe('Hello world');
    });

    it('appends assistant.reasoning_delta to existing', () => {
      const result = extractContent('assistant.reasoning_delta', { deltaContent: 'thinking...' }, 'I am ');
      expect(result).toBe('I am thinking...');
    });

    it('returns existing if delta is missing', () => {
      const result = extractContent('assistant.message_delta', {}, 'Hello');
      expect(result).toBe('Hello');
    });
  });

  describe('tool events', () => {
    it('formats tool.execution_start with emoji', () => {
      const result = extractContent('tool.execution_start', { toolName: 'bash' }, '');
      expect(result).toBe('🔧 bash');
    });

    it('formats successful tool.execution_complete', () => {
      const result = extractContent('tool.execution_complete', { 
        toolName: 'bash', 
        success: true,
        result: { content: 'output here' }
      }, '');
      expect(result).toBe('✓ bash: output here');
    });

    it('formats failed tool.execution_complete with error', () => {
      const result = extractContent('tool.execution_complete', { 
        toolName: 'bash', 
        success: false,
        error: 'command not found'
      }, '');
      expect(result).toBe('✗ bash: command not found');
    });

    it('formats tool.execution_complete without result content', () => {
      const result = extractContent('tool.execution_complete', { 
        toolName: 'report_intent', 
        success: true,
        result: {}
      }, '');
      expect(result).toBe('✓ report_intent');
    });
  });

  describe('intent events', () => {
    it('formats assistant.intent with emoji', () => {
      const result = extractContent('assistant.intent', { intent: 'Testing the system' }, '');
      expect(result).toBe('💡 Testing the system');
    });
  });

  describe('session events', () => {
    it('returns compaction start message', () => {
      const result = extractContent('session.compaction_start', {}, '');
      expect(result).toBe('📦 Compacting conversation...');
    });

    it('returns compaction complete message', () => {
      const result = extractContent('session.compaction_complete', {}, '');
      expect(result).toBe('📦 Conversation compacted');
    });
  });

  describe('unknown events', () => {
    it('returns null for unmapped event type', () => {
      const result = extractContent('unknown.event', { content: 'test' }, '');
      expect(result).toBeNull();
    });
  });
});

describe('hasExtractor', () => {
  it('returns true for mapped event types', () => {
    expect(hasExtractor('user.message')).toBe(true);
    expect(hasExtractor('assistant.message')).toBe(true);
    expect(hasExtractor('tool.execution_start')).toBe(true);
  });

  it('returns false for unmapped event types', () => {
    expect(hasExtractor('unknown.event')).toBe(false);
    expect(hasExtractor('session.idle')).toBe(false);
  });
});
