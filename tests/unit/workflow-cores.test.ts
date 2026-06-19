import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileRangeCore, grepCore, globCore } from '../../src/workflow/cores.js';
import { WorkflowInputError, type GrepMatch } from '../../src/workflow/types.js';

const execFileAsync = promisify(execFile);

let base: string;

const FILE_BODY = 'alpha\nbeta TARGET\ngamma\ndelta TARGET\nepsilon\n';

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-cores-'));
  await writeFile(join(base, 'a.txt'), FILE_BODY);
  await mkdir(join(base, 'sub'), { recursive: true });
  await writeFile(join(base, 'sub', 'b.txt'), 'no match here\nTARGET deep\n');
  await writeFile(join(base, 'sub', 'weird name.txt'), 'TARGET spaced\n');
  await writeFile(join(base, 'sub', 'co:lon.txt'), 'TARGET coloned\n');
  await writeFile(join(base, 'uni\u00e9.txt'), 'TARGET unicode\n');
  await writeFile(join(base, 'notrailing.txt'), 'TARGET last line no newline');
  await writeFile(join(base, 'skip.md'), 'TARGET but markdown\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('readFileRangeCore', () => {
  it('returns a line-sliced range byte-identical to an independent fs read', async () => {
    const content = await readFile(join(base, 'a.txt'), 'utf8');
    const res = await readFileRangeCore(base, 'a.txt', [2, 4]);
    expect(res.text).toBe(content.split('\n').slice(1, 4).join('\n'));
    expect(res.range).toEqual([2, 4]);
    expect(res.totalLines).toBe(content.split('\n').length);
    expect(res.path).toBe('a.txt');
  });

  it('returns the whole file (reconstructed exactly) with no range', async () => {
    const content = await readFile(join(base, 'a.txt'), 'utf8');
    const res = await readFileRangeCore(base, 'a.txt');
    expect(res.text).toBe(content);
  });

  it('clamps an over-wide range to the file bounds', async () => {
    const res = await readFileRangeCore(base, 'a.txt', [3, 9999]);
    expect(res.range).toEqual([3, res.totalLines]);
  });

  it('rejects a path that escapes the base', async () => {
    await expect(readFileRangeCore(base, '../../etc/passwd')).rejects.toBeInstanceOf(WorkflowInputError);
  });

  it('rejects a missing file', async () => {
    await expect(readFileRangeCore(base, 'nope.txt')).rejects.toBeInstanceOf(WorkflowInputError);
  });
});

async function directRg(pattern: string): Promise<GrepMatch[]> {
  const { stdout } = await execFileAsync('rg', ['--json', '-e', pattern, '--', '.'], { cwd: base });
  const out: GrepMatch[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const evt = JSON.parse(raw);
    if (evt.type !== 'match') continue;
    const text: string = evt.data.lines.text;
    const file: string = evt.data.path.text;
    out.push({ file: file.startsWith('./') ? file.slice(2) : file, line: evt.data.line_number, text: text.endsWith('\n') ? text.slice(0, -1) : text });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

describe('grepCore', () => {
  it('matches a direct `rg --json` invocation over a tricky-filename tree', async () => {
    const expected = await directRg('TARGET');
    const actual = await grepCore(base, 'TARGET');
    expect(actual).toEqual(expected);
  });

  it('JS fallback (rg forced absent) matches the rg path', async () => {
    const viaRg = await grepCore(base, 'TARGET');
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    let viaFallback: GrepMatch[];
    try {
      viaFallback = await grepCore(base, 'TARGET');
    } finally {
      process.env.PATH = savedPath;
    }
    expect(viaFallback).toEqual(viaRg);
  });

  it('honors a glob include filter', async () => {
    const res = await grepCore(base, 'TARGET', { glob: '*.md' });
    expect(res).toEqual([{ file: 'skip.md', line: 1, text: 'TARGET but markdown' }]);
  });

  it('JS fallback honors an include glob (exercises globForRgGlob)', async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    let res: GrepMatch[];
    try {
      res = await grepCore(base, 'TARGET', { glob: '*.md' });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(res).toEqual([{ file: 'skip.md', line: 1, text: 'TARGET but markdown' }]);
  });

  it('restricts to a subtree via path', async () => {
    const res = await grepCore(base, 'TARGET', { path: 'sub' });
    expect(res.every((m) => m.file.startsWith('sub/'))).toBe(true);
    expect(res.length).toBeGreaterThan(0);
  });

  it('returns base-relative paths even when opts.path is absolute (rg/fallback parity)', async () => {
    const res = await grepCore(base, 'TARGET', { path: join(base, 'sub') });
    expect(res.every((m) => m.file.startsWith('sub/'))).toBe(true);
    expect(res.every((m) => !m.file.startsWith('/'))).toBe(true);
    expect(res.length).toBeGreaterThan(0);
  });
});

describe('globCore', () => {
  it('expands a recursive glob to sorted scoped relative paths', async () => {
    const res = await globCore(base, '**/*.txt');
    expect(res).toContain('a.txt');
    expect(res).toContain(join('sub', 'b.txt'));
    expect([...res]).toEqual([...res].sort());
  });
});
