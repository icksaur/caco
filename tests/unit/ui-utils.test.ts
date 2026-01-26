/**
 * Tests for ui-utils.ts - HTML escaping and time formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { escapeHtml, formatAge } from '../../public/ts/ui-utils.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's fine")).toBe('it&#039;s fine');
  });

  it('escapes all special characters together', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
  });

  it('handles newlines and whitespace', () => {
    expect(escapeHtml('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  });
});

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set "now" to a fixed time for predictable tests
    vi.setSystemTime(new Date('2026-01-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for undefined', () => {
    expect(formatAge(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(formatAge('')).toBe('');
  });

  it('returns "just now" for very recent times', () => {
    const now = new Date('2026-01-25T12:00:00Z').toISOString();
    expect(formatAge(now)).toBe('just now');
  });

  it('returns "just now" for times less than a minute ago', () => {
    const thirtySecsAgo = new Date('2026-01-25T11:59:30Z').toISOString();
    expect(formatAge(thirtySecsAgo)).toBe('just now');
  });

  describe('minutes', () => {
    it('formats 1 minute as "1 min"', () => {
      const oneMinAgo = new Date('2026-01-25T11:59:00Z').toISOString();
      expect(formatAge(oneMinAgo)).toBe('1 min');
    });

    it('formats multiple minutes as "N min"', () => {
      const fiveMinAgo = new Date('2026-01-25T11:55:00Z').toISOString();
      expect(formatAge(fiveMinAgo)).toBe('5 min');
    });

    it('formats 59 minutes', () => {
      const fiftyNineMinAgo = new Date('2026-01-25T11:01:00Z').toISOString();
      expect(formatAge(fiftyNineMinAgo)).toBe('59 min');
    });
  });

  describe('hours', () => {
    it('formats 1 hour as "1 hour"', () => {
      const oneHourAgo = new Date('2026-01-25T11:00:00Z').toISOString();
      expect(formatAge(oneHourAgo)).toBe('1 hour');
    });

    it('formats multiple hours with plural', () => {
      const threeHoursAgo = new Date('2026-01-25T09:00:00Z').toISOString();
      expect(formatAge(threeHoursAgo)).toBe('3 hours');
    });

    it('formats 23 hours', () => {
      const twentyThreeHoursAgo = new Date('2026-01-24T13:00:00Z').toISOString();
      expect(formatAge(twentyThreeHoursAgo)).toBe('23 hours');
    });
  });

  describe('days', () => {
    it('formats 1 day as "1 day"', () => {
      const oneDayAgo = new Date('2026-01-24T12:00:00Z').toISOString();
      expect(formatAge(oneDayAgo)).toBe('1 day');
    });

    it('formats multiple days with plural', () => {
      const threeDaysAgo = new Date('2026-01-22T12:00:00Z').toISOString();
      expect(formatAge(threeDaysAgo)).toBe('3 days');
    });

    it('formats 6 days (before becoming a week)', () => {
      const sixDaysAgo = new Date('2026-01-19T12:00:00Z').toISOString();
      expect(formatAge(sixDaysAgo)).toBe('6 days');
    });
  });

  describe('weeks', () => {
    it('formats 1 week as "1 week"', () => {
      const oneWeekAgo = new Date('2026-01-18T12:00:00Z').toISOString();
      expect(formatAge(oneWeekAgo)).toBe('1 week');
    });

    it('formats multiple weeks with plural', () => {
      const threeWeeksAgo = new Date('2026-01-04T12:00:00Z').toISOString();
      expect(formatAge(threeWeeksAgo)).toBe('3 weeks');
    });
  });

  describe('months', () => {
    it('formats 1 month as "1 month"', () => {
      const oneMonthAgo = new Date('2025-12-25T12:00:00Z').toISOString();
      expect(formatAge(oneMonthAgo)).toBe('1 month');
    });

    it('formats multiple months with plural', () => {
      const threeMonthsAgo = new Date('2025-10-25T12:00:00Z').toISOString();
      expect(formatAge(threeMonthsAgo)).toBe('3 months');
    });
  });

  describe('years', () => {
    it('formats 1 year as "1 year"', () => {
      const oneYearAgo = new Date('2025-01-25T12:00:00Z').toISOString();
      expect(formatAge(oneYearAgo)).toBe('1 year');
    });

    it('formats multiple years with plural', () => {
      const threeYearsAgo = new Date('2023-01-25T12:00:00Z').toISOString();
      expect(formatAge(threeYearsAgo)).toBe('3 years');
    });
  });
});
