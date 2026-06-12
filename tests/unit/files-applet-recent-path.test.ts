import { describe, it, expect } from 'vitest';

// Inlined from applets/files/script.js — keep in sync.
// Regression guard: a RECENT-files entry stored as an absolute path
// from another cwd must NOT be double-prefixed and must route as
// external. See the "[files-applet] routeOpen failed … path-not-found"
// bug where a hull/ recent file opened in a caco/ session.

function isAbsolutePath(p: string): boolean {
  return p.charAt(0) === '/'
    || /^[A-Za-z]:[\\/]/.test(p)
    || p.indexOf('\\\\') === 0;
}

function isContainedIn(normPath: string, normCwd: string): boolean {
  const isWin = /^[A-Za-z]:\//.test(normCwd) || normCwd.indexOf('//') === 0;
  const a = isWin ? normPath.toLowerCase() : normPath;
  const c = isWin ? normCwd.toLowerCase() : normCwd;
  if (a === c) return true;
  return a.indexOf(c + '/') === 0;
}

function relativizePath(absOrRel: string, cachedCwd: string): string {
  if (!absOrRel) return '';
  if (!isAbsolutePath(absOrRel)) return absOrRel;
  if (!cachedCwd) return absOrRel;
  const normPath = absOrRel.replace(/\\/g, '/');
  const normCwd = cachedCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!isContainedIn(normPath, normCwd)) return absOrRel;
  const isWin = /^[A-Za-z]:\//.test(normCwd) || normCwd.indexOf('//') === 0;
  const a = isWin ? normPath.toLowerCase() : normPath;
  const c = isWin ? normCwd.toLowerCase() : normCwd;
  if (a === c) return '';
  return normPath.slice(c.length + 1);
}

function isExternal(abs: string, cachedCwd: string): boolean {
  if (!abs || !cachedCwd) return false;
  if (!isAbsolutePath(abs)) return false;
  const normPath = abs.replace(/\\/g, '/');
  const normCwd = cachedCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return !isContainedIn(normPath, normCwd);
}

// The fix under test: idempotent for already-absolute inputs.
function absPathOf(relativePath: string, cachedCwd: string): string {
  if (isAbsolutePath(relativePath)) return relativePath;
  if (!cachedCwd) return relativePath;
  const sep = cachedCwd.indexOf('\\') >= 0 && cachedCwd.indexOf('/') < 0 ? '\\' : '/';
  const trimmed = cachedCwd.replace(/[/\\]+$/, '');
  return trimmed + sep + relativePath;
}

// Mirror of openAnyPath's routing decision.
function routeDecision(input: string, cachedCwd: string): 'external' | 'in-cwd' {
  if (isAbsolutePath(input) && isExternal(input, cachedCwd)) return 'external';
  return 'in-cwd';
}

const CWD = '/home/carl/repo/caco';

describe('recent-file path resolution', () => {
  it('out-of-cwd recent: relativize leaves absolute, absPathOf is idempotent, routes external', () => {
    const stored = '/home/carl/repo/hull/spec-architecture.md';
    const rel = relativizePath(stored, CWD);
    expect(rel).toBe(stored); // unchanged — not in cwd

    const abs = absPathOf(rel, CWD);
    expect(abs).toBe(stored); // NOT double-prefixed

    expect(routeDecision(abs, CWD)).toBe('external');
  });

  it('in-cwd recent: relativize strips cwd, absPathOf rejoins, routes in-cwd', () => {
    const stored = '/home/carl/repo/caco/README.md';
    const rel = relativizePath(stored, CWD);
    expect(rel).toBe('README.md');

    const abs = absPathOf(rel, CWD);
    expect(abs).toBe(stored);

    expect(routeDecision(abs, CWD)).toBe('in-cwd');
  });

  it('absPathOf does not double-prefix an absolute path (the bug)', () => {
    const abs = '/home/carl/repo/hull/spec-architecture.md';
    // Before the fix this produced cwd + '/' + abs.
    expect(absPathOf(abs, CWD)).toBe(abs);
    expect(absPathOf(abs, CWD)).not.toContain('caco//home');
  });

  it('relative picker result still joins to cwd', () => {
    expect(absPathOf('src/foo.ts', CWD)).toBe('/home/carl/repo/caco/src/foo.ts');
  });
});
