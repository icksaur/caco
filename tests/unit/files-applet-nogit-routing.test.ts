import { describe, it, expect } from 'vitest';

/**
 * Inlined mirror of openAnyPath's routing decision (applets/files/script.js) —
 * keep in sync. Regression guard for "the files applet never shows an Edit
 * button for markdown" (spec-files-applet, cwdIsGit): a session whose cwd is
 * NOT a git repo used to route every in-cwd open through the read-only
 * external path (same as a genuinely out-of-cwd path), losing Edit for every
 * file type, not just markdown. The fix adds a third routing bucket —
 * "in-cwd, non-git" — that keeps the file's own (git-independent) viewer and
 * persistence, while only the Diff card becomes unreachable.
 *
 * See files-applet-recent-path.test.ts for the external/in-cwd split this
 * builds on, and files-applet-card-registry.test.ts for the capability-level
 * pin (canEdit:true, canDiff:false → Edit kept, Diff dropped).
 */

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

function isExternal(abs: string, cachedCwd: string): boolean {
  if (!abs || !cachedCwd) return false;
  if (!isAbsolutePath(abs)) return false;
  const normPath = abs.replace(/\\/g, '/');
  const normCwd = cachedCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return !isContainedIn(normPath, normCwd);
}

type Route = 'external' | 'in-cwd-git' | 'in-cwd-no-git';

// Mirror of openAnyPath's three-way routing decision (post-fix).
function routeDecision(input: string, cachedCwd: string, cwdIsGit: boolean): Route {
  if (isAbsolutePath(input) && isExternal(input, cachedCwd)) return 'external';
  return cwdIsGit ? 'in-cwd-git' : 'in-cwd-no-git';
}

const CWD = 'C:\\Users\\someuser\\OneDrive - Example\\Desktop\\workspace';

describe('openAnyPath routing — the non-git-cwd bucket (spec-files-applet, cwdIsGit)', () => {
  it('a markdown file in a non-git cwd routes in-cwd-no-git, NOT external', () => {
    const file = CWD + '\\docs\\notes.md';
    expect(routeDecision(file, CWD, false)).toBe('in-cwd-no-git');
  });

  it('the same file routes in-cwd-git once the cwd is known to be a repo', () => {
    const file = CWD + '\\docs\\notes.md';
    expect(routeDecision(file, CWD, true)).toBe('in-cwd-git');
  });

  it('a path outside the cwd still routes external regardless of cwdIsGit', () => {
    const file = 'C:\\Users\\someuser\\other-repo\\README.md';
    expect(routeDecision(file, CWD, false)).toBe('external');
    expect(routeDecision(file, CWD, true)).toBe('external');
  });
});
