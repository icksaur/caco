/**
 * Tests for ui-utils.ts - HTML escaping and time formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { escapeHtml, formatAge } from '../../public/ts/ui-utils.js';

describe('escapeHtml', () => {
  it('escapes XSS-dangerous characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('Hello World 123\nNew line')).toBe('Hello World 123\nNew line');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for undefined/empty', () => {
    expect(formatAge(undefined)).toBe('');
    expect(formatAge('')).toBe('');
  });

  it('formats time ranges correctly', () => {
    const cases: [string, string][] = [
      ['2026-01-25T12:00:00Z', 'just now'],
      ['2026-01-25T11:55:00Z', '5 min'],
      ['2026-01-25T09:00:00Z', '3 hours'],
      ['2026-01-22T12:00:00Z', '3 days'],
      ['2026-01-04T12:00:00Z', '3 weeks'],
      ['2025-10-25T12:00:00Z', '3 months'],
      ['2023-01-25T12:00:00Z', '3 years'],
    ];
    
    for (const [date, expected] of cases) {
      expect(formatAge(date)).toBe(expected);
    }
  });

  it('uses singular for 1 unit', () => {
    expect(formatAge('2026-01-25T11:00:00Z')).toBe('1 hour');
    expect(formatAge('2026-01-24T12:00:00Z')).toBe('1 day');
  });
});
