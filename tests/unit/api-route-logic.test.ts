import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { walkProjectFiles, scanPromptDir } from '../../src/routes/api.js';

// Sort both sides with a fixed comparator so membership is asserted exactly without
// depending on the impl's localeCompare ordering (locale punctuation-sort is fragile).
const norm = (a: string[]) => [...a].sort();

describe('walkProjectFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'walk-'));
    // Files at root
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, 'b.md'), 'x');
    writeFileSync(join(root, '.hidden.ts'), 'x');   // dotfile
    writeFileSync(join(root, 'font.woff'), 'x');     // binary extension
    // Nested included dir
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'c.ts'), 'x');
    // Always-excluded dir (not a dotfile, so independent of the dotfile rule)
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.ts'), 'x');
    // .gitignore with a file pattern and a directory pattern
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\nskipdir/\n');
    writeFileSync(join(root, 'ignored.ts'), 'x');
    mkdirSync(join(root, 'skipdir'));
    writeFileSync(join(root, 'skipdir', 'd.ts'), 'x');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('defaults: excludes dotfiles, binaries, excluded dirs, and gitignored file+dir', async () => {
    const files = await walkProjectFiles(root);
    // exact sorted output (no punctuation ambiguity in this set)
    expect(files).toEqual(['a.ts', 'b.md', 'sub/c.ts']);
  });

  it('showDotfiles=true reveals dotfiles but still honors excluded dirs + gitignore', async () => {
    const files = await walkProjectFiles(root, true, true);
    // .gitignore + .hidden.ts now appear; node_modules/.git still excluded; gitignore still applies
    expect(norm(files)).toEqual(norm(['.gitignore', '.hidden.ts', 'a.ts', 'b.md', 'sub/c.ts']));
  });

  it('respectGitignore=false includes the previously-ignored file and directory', async () => {
    const files = await walkProjectFiles(root, false, false);
    expect(norm(files)).toEqual(norm(['a.ts', 'b.md', 'sub/c.ts', 'ignored.ts', 'skipdir/d.ts']));
  });

  it('a missing/unreadable directory yields an empty list (does not throw)', async () => {
    const missing = join(tmpdir(), 'walk-does-not-exist-xyz-123');
    await expect(walkProjectFiles(missing)).resolves.toEqual([]);
  });
});

describe('scanPromptDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    writeFileSync(join(dir, 'hello.md'), 'Hello prompt\nmore text');
    writeFileSync(join(dir, 'blank-first.md'), '\n\n   Second line desc\nrest');
    writeFileSync(join(dir, 'long.md'), 'x'.repeat(100) + '\nrest');  // first line 100 chars
    writeFileSync(join(dir, 'empty.md'), '');
    writeFileSync(join(dir, 'notprompt.txt'), 'ignored, not a .md');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps each .md file to {name, description, path}, excluding non-.md files', async () => {
    const map = await scanPromptDir(dir);
    expect([...map.keys()].sort()).toEqual(['blank-first', 'empty', 'hello', 'long']);
    expect(map.has('notprompt')).toBe(false);
  });

  it('derives the description from the first non-blank line, trimmed', async () => {
    const map = await scanPromptDir(dir);
    expect(map.get('hello')!.description).toBe('Hello prompt');
    expect(map.get('blank-first')!.description).toBe('Second line desc');
  });

  it('truncates the description to 80 chars', async () => {
    const map = await scanPromptDir(dir);
    expect(map.get('long')!.description).toBe('x'.repeat(80));
  });

  it('gives an empty description when the file is empty', async () => {
    const map = await scanPromptDir(dir);
    expect(map.get('empty')!.description).toBe('');
  });

  it('sets path to the absolute file path', async () => {
    const map = await scanPromptDir(dir);
    expect(map.get('hello')!.path).toBe(join(dir, 'hello.md'));
  });

  it('returns an empty map for a missing directory', async () => {
    const map = await scanPromptDir(join(tmpdir(), 'prompts-missing-xyz-123'));
    expect(map.size).toBe(0);
  });
});
