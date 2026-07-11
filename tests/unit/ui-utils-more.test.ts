import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, formatAge, formatContextFiles, formatStatusParts, fuzzyScore, sortSessions } from '../../public/ts/ui-utils.js';

describe('escapeHtml additional entities', () => {
  it('escapes every special HTML character in one pass', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
  });
});

describe('formatContextFiles', () => {
  it('returns display names for POSIX, Windows, and bare paths without mutating order', () => {
    expect(formatContextFiles(['src/app.ts', 'C:\\repo\\main.ts', 'README.md'], 5)).toEqual([
      { name: 'app.ts', path: 'src/app.ts' },
      { name: 'main.ts', path: 'C:\\repo\\main.ts' },
      { name: 'README.md', path: 'README.md' },
    ]);
  });

  it('limits the rendered file list to the requested count', () => {
    expect(formatContextFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 2)).toEqual([
      { name: 'a.ts', path: 'a.ts' },
      { name: 'b.ts', path: 'b.ts' },
    ]);
  });
});

describe('formatStatusParts', () => {
  it('formats both model and cwd directory name', () => {
    expect(formatStatusParts('Claude', '/work/caco')).toEqual({
      model: 'Claude',
      dirName: 'caco/',
      fullCwd: '/work/caco',
    });
  });

  it('omits empty model and cwd parts independently', () => {
    expect(formatStatusParts('', '')).toEqual({});
    expect(formatStatusParts('GPT', '')).toEqual({ model: 'GPT' });
    expect(formatStatusParts('', 'C:\\repo\\caco')).toEqual({ dirName: 'caco/', fullCwd: 'C:\\repo\\caco' });
  });
});

describe('formatAge compact mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses compact relative units below one week', () => {
    expect(formatAge('2026-01-25T11:59:45Z', true)).toBe('just now');
    expect(formatAge('2026-01-25T11:45:00Z', true)).toBe('15m ago');
    expect(formatAge('2026-01-25T09:00:00Z', true)).toBe('3h ago');
    expect(formatAge('2026-01-23T12:00:00Z', true)).toBe('2d ago');
  });

  it('uses the locale date for compact ages of at least one week', () => {
    expect(formatAge('2026-01-18T12:00:00Z', true)).toBe(new Date('2026-01-18T12:00:00Z').toLocaleDateString());
  });

  it('uses singular non-compact labels for one year, month, week, and minute', () => {
    expect(formatAge('2025-01-25T12:00:00Z')).toBe('1 year');
    expect(formatAge('2025-12-25T12:00:00Z')).toBe('1 month');
    expect(formatAge('2026-01-18T12:00:00Z')).toBe('1 week');
    expect(formatAge('2026-01-25T11:59:00Z')).toBe('1 min');
  });
});

describe('fuzzyScore', () => {
  it('scores consecutive word-boundary matches higher than spread out matches', () => {
    expect(fuzzyScore('session', 'se')).toBeGreaterThan(fuzzyScore('slow-e', 'se'));
  });

  it('returns zero for an empty query and -1 when the query cannot match', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
    expect(fuzzyScore('', 'a')).toBe(-1);
    expect(fuzzyScore('abc', 'az')).toBe(-1);
  });

  it('is case-sensitive because callers normalize before scoring', () => {
    expect(fuzzyScore('Session Model', 'sm')).toBe(-1);
    expect(fuzzyScore('session model', 'sm')).toBe(12);
  });
});

describe('sortSessions', () => {
  it('orders unobserved sessions first, then kind priority, then newest update', () => {
    const sessions = [
      { id: 'old-interactive', kind: 'interactive', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'new-interactive', kind: 'interactive', updatedAt: '2026-01-02T00:00:00Z' },
      { id: 'scheduled', kind: 'scheduled', updatedAt: '2026-01-03T00:00:00Z' },
      { id: 'unobserved', kind: 'swarm', isUnobserved: true, updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'agent', kind: 'agent', updatedAt: '2026-01-04T00:00:00Z' },
    ];

    expect(sortSessions(sessions).map(session => session.id)).toEqual([
      'unobserved',
      'new-interactive',
      'old-interactive',
      'scheduled',
      'agent',
    ]);
  });

  it('puts sessions with timestamps before same-kind sessions without timestamps', () => {
    const sessions = [
      { id: 'missing-a', kind: 'interactive' },
      { id: 'dated', kind: 'interactive', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'missing-b', kind: 'interactive' },
    ];

    expect(sortSessions(sessions).map(session => session.id)).toEqual(['dated', 'missing-a', 'missing-b']);
  });
});
