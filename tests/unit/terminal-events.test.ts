/**
 * Tests for terminal-events.ts
 */
import { describe, it, expect } from 'vitest';
import { isTerminalEvent } from '../../public/ts/terminal-events.js';

describe('isTerminalEvent', () => {
  it('returns true for session.idle', () => {
    expect(isTerminalEvent('session.idle')).toBe(true);
  });

  it('returns true for session.error', () => {
    expect(isTerminalEvent('session.error')).toBe(true);
  });

  it('returns false for assistant.message', () => {
    expect(isTerminalEvent('assistant.message')).toBe(false);
  });

  it('returns false for assistant.message_delta', () => {
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
