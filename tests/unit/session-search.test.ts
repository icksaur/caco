import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/sdk-session-store.js';

describe('extractSnippet', () => {
  it('finds match and returns context', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const result = extractSnippet(text, 'fox', 10);
    expect(result).not.toBeNull();
    expect(result!.snippet).toContain('fox');
    expect(result!.snippet.slice(result!.matchStart, result!.matchEnd)).toBe('fox');
  });

  it('is case-insensitive', () => {
    const result = extractSnippet('Hello World', 'hello', 40);
    expect(result).not.toBeNull();
    expect(result!.snippet).toContain('Hello');
  });

  it('returns null when no match', () => {
    const result = extractSnippet('Hello World', 'missing', 40);
    expect(result).toBeNull();
  });

  it('adds ellipsis when truncated at start', () => {
    const text = 'a'.repeat(100) + 'TARGET' + 'b'.repeat(100);
    const result = extractSnippet(text, 'TARGET', 10);
    expect(result).not.toBeNull();
    expect(result!.snippet.startsWith('...')).toBe(true);
    expect(result!.snippet.endsWith('...')).toBe(true);
  });

  it('no ellipsis when match is at start', () => {
    const text = 'TARGET rest of text';
    const result = extractSnippet(text, 'TARGET', 40);
    expect(result).not.toBeNull();
    expect(result!.snippet.startsWith('...')).toBe(false);
  });

  it('matchStart/matchEnd correctly locate the match in snippet', () => {
    const text = 'prefix NEEDLE suffix';
    const result = extractSnippet(text, 'NEEDLE', 40);
    expect(result).not.toBeNull();
    expect(result!.snippet.slice(result!.matchStart, result!.matchEnd)).toBe('NEEDLE');
  });

  it('matchStart/matchEnd correct with ellipsis', () => {
    const text = 'a'.repeat(80) + 'FIND' + 'b'.repeat(80);
    const result = extractSnippet(text, 'FIND', 10);
    expect(result).not.toBeNull();
    expect(result!.snippet.slice(result!.matchStart, result!.matchEnd)).toBe('FIND');
  });

  it('handles empty query', () => {
    const result = extractSnippet('Hello', '', 40);
    expect(result).not.toBeNull();
  });
});
