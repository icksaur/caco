import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSkillPrompt, readGitBranch, allowLocalhostCors } from '../../src/routes/sessions.js';

describe('buildSkillPrompt', () => {
  it('appends the input after a space when non-empty', () => {
    expect(buildSkillPrompt('review', 'this PR')).toBe(
      'Use the skill tool to invoke the "review" skill, then follow the skill\'s instructions to help with: this PR',
    );
  });

  it('omits the trailing space when input is empty', () => {
    expect(buildSkillPrompt('review', '')).toBe(
      'Use the skill tool to invoke the "review" skill, then follow the skill\'s instructions to help with:',
    );
  });
});

describe('readGitBranch', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitbranch-')); mkdirSync(join(dir, '.git')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeHead = (content: string) => writeFileSync(join(dir, '.git', 'HEAD'), content);

  it('returns the branch name for a normal ref', () => {
    writeHead('ref: refs/heads/main\n');
    expect(readGitBranch(dir)).toBe('main');
  });

  it('preserves slashes in the branch name', () => {
    writeHead('ref: refs/heads/feature/foo\n');
    expect(readGitBranch(dir)).toBe('feature/foo');
  });

  it('trims surrounding whitespace/newlines before parsing', () => {
    writeHead('  ref: refs/heads/dev  \n');
    expect(readGitBranch(dir)).toBe('dev');
  });

  it('returns the first 8 chars of a detached-HEAD SHA', () => {
    writeHead('0123456789abcdef0123456789abcdef01234567\n');
    expect(readGitBranch(dir)).toBe('01234567');
  });

  it('returns null when HEAD is missing', () => {
    // .git exists but no HEAD file
    expect(readGitBranch(dir)).toBeNull();
  });

  it('returns null when the .git dir is absent entirely', () => {
    const bare = mkdtempSync(join(tmpdir(), 'nogit-'));
    try {
      expect(readGitBranch(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number | null;
  ended: boolean;
  setHeader(k: string, v: string): void;
  status(code: number): FakeRes;
  end(): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    headers: {},
    statusCode: null,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; },
  };
  return res;
}

describe('allowLocalhostCors', () => {
  it('sets CORS headers for a localhost origin (with port)', () => {
    const res = fakeRes();
    const handled = allowLocalhostCors(
      { headers: { origin: 'http://localhost:5173' }, method: 'GET' } as never,
      res as never,
    );
    expect(handled).toBe(false);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(res.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(res.headers['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('accepts https localhost with no port', () => {
    const res = fakeRes();
    allowLocalhostCors({ headers: { origin: 'https://localhost' }, method: 'GET' } as never, res as never);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://localhost');
  });

  it('does NOT set headers for a non-localhost origin', () => {
    const res = fakeRes();
    const handled = allowLocalhostCors(
      { headers: { origin: 'https://evil.example' }, method: 'GET' } as never,
      res as never,
    );
    expect(handled).toBe(false);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('short-circuits an OPTIONS preflight with 204 and returns true', () => {
    const res = fakeRes();
    const handled = allowLocalhostCors(
      { headers: { origin: 'http://localhost:3000' }, method: 'OPTIONS' } as never,
      res as never,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('returns false (does not end) for a non-OPTIONS request even with no origin', () => {
    const res = fakeRes();
    const handled = allowLocalhostCors({ headers: {}, method: 'GET' } as never, res as never);
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });
});
