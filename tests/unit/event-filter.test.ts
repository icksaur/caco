import { describe, it, expect } from 'vitest';
import { shouldFilter } from '../../src/event-filter.js';

describe('shouldFilter', () => {
  describe('returns true (filter out)', () => {
    it('when data is undefined', () => {
      expect(shouldFilter({ type: 'assistant.message' })).toBe(true);
    });

    it('when data is empty object', () => {
      expect(shouldFilter({ type: 'assistant.message', data: {} })).toBe(true);
    });

    it('when content is empty string', () => {
      expect(shouldFilter({ 
        type: 'assistant.message', 
        data: { content: '' } 
      })).toBe(true);
    });

    it('when only non-whitelisted properties present', () => {
      expect(shouldFilter({ 
        type: 'assistant.message', 
        data: { messageId: '123', toolRequests: [] } 
      })).toBe(true);
    });

    it('when all whitelisted properties are empty', () => {
      expect(shouldFilter({ 
        type: 'assistant.message', 
        data: { content: '', deltaContent: '', intent: '' } 
      })).toBe(true);
    });
  });

  describe('returns false (keep event) - content properties', () => {
    it('when content has text', () => {
      expect(shouldFilter({ 
        type: 'assistant.message', 
        data: { content: 'Hello world' } 
      })).toBe(false);
    });

    it('when deltaContent has text', () => {
      expect(shouldFilter({ 
        type: 'assistant.message_delta', 
        data: { deltaContent: 'Hello' } 
      })).toBe(false);
    });

    it('when content is whitespace only (still valid)', () => {
      expect(shouldFilter({ 
        type: 'assistant.message', 
        data: { content: '   ' } 
      })).toBe(false);
    });
  });

  describe('returns false (keep event) - activity properties', () => {
    it('when intent has text', () => {
      expect(shouldFilter({ 
        type: 'assistant.intent', 
        data: { intent: 'I will help you' } 
      })).toBe(false);
    });

    it('when toolName has text', () => {
      expect(shouldFilter({ 
        type: 'tool.execution_start', 
        data: { toolName: 'bash', toolCallId: '123' } 
      })).toBe(false);
    });

    it('when toolCallId has text', () => {
      expect(shouldFilter({ 
        type: 'tool.execution_complete', 
        data: { toolCallId: 'call_123', success: true } 
      })).toBe(false);
    });

    it('when message has text (error)', () => {
      expect(shouldFilter({ 
        type: 'session.error', 
        data: { message: 'Something went wrong', errorType: 'runtime' } 
      })).toBe(false);
    });

    it('when progressMessage has text', () => {
      expect(shouldFilter({ 
        type: 'tool.execution_progress', 
        data: { toolCallId: '123', progressMessage: 'Working...' } 
      })).toBe(false);
    });

    it('when partialOutput has text', () => {
      expect(shouldFilter({ 
        type: 'tool.execution_partial_result', 
        data: { toolCallId: '123', partialOutput: 'partial result' } 
      })).toBe(false);
    });

    it('when agentName has text', () => {
      expect(shouldFilter({ 
        type: 'subagent.started', 
        data: { agentName: 'coder', toolCallId: '123' } 
      })).toBe(false);
    });
  });
});
