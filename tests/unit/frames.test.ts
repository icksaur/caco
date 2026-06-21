import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFrames } from '../../src/index/frames.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'frames-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<void> {
  const abs = join(dir, rel);
  const slash = rel.lastIndexOf('/');
  if (slash >= 0) await mkdir(join(dir, rel.slice(0, slash)), { recursive: true });
  await writeFile(abs, contents);
}

describe('buildFrames — definition tier', () => {
  it('finds a TS function definition (tree-sitter, exact) and its caller', async () => {
    await write('m.ts', 'function helper(x: number) { return x; }\nfunction caller() { return helper(1); }\n');
    const r = await buildFrames(dir, 'helper', { glob: '**/*.ts' });
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]).toMatchObject({ file: 'm.ts', line: 1, confidence: 'exact' });
    expect(r.definitions[0].code).toContain('function helper');
    expect(r.incoming.map((f) => f.line)).toContain(2);
    expect(r.incoming.find((f) => f.line === 2)?.confidence).toBe('exact');
  });

  it('returns BOTH the C++ .h declaration and the .cpp definition', async () => {
    await write('point.h', 'namespace geo {\nclass Point {\npublic:\n  Point(int x, int y);\n  int dist() const;\n};\n}\n');
    await write('point.cpp', '#include "point.h"\nnamespace geo {\nPoint::Point(int x, int y) {}\nint Point::dist() const { return 42; }\n}\n');
    const r = await buildFrames(dir, 'dist', { glob: '**/*.{h,cpp}' });
    const files = r.definitions.map((d) => d.file).sort();
    expect(files).toContain('point.h');
    expect(files).toContain('point.cpp');
    expect(r.definitions.every((d) => d.confidence === 'exact')).toBe(true);
  });

  it('finds a C# method definition (tree-sitter, exact)', async () => {
    await write('shapes.cs', 'using System;\nnamespace Geo {\n  public class Circle {\n    public double Area() => Math.PI;\n  }\n}\n');
    const r = await buildFrames(dir, 'Area', { glob: '**/*.cs' });
    expect(r.definitions.some((d) => d.file === 'shapes.cs' && d.confidence === 'exact')).toBe(true);
  });

  it('finds a GLSL struct and void main via the regex tier (heuristic + note)', async () => {
    await write('s.frag', 'struct Bone { vec3 p; };\nvoid main() { Bone b; }\n');
    const bone = await buildFrames(dir, 'Bone', { glob: '**/*.frag' });
    expect(bone.definitions).toHaveLength(1);
    expect(bone.definitions[0]).toMatchObject({ line: 1, confidence: 'heuristic' });
    expect(bone.notes.some((n) => n.includes('regex-tier'))).toBe(true);

    const main = await buildFrames(dir, 'main', { glob: '**/*.frag' });
    expect(main.definitions.some((d) => d.line === 2 && d.confidence === 'heuristic')).toBe(true);
  });

  it('returns ALL definitions for a same-name-in-two-classes symbol (no guessing)', async () => {
    await write('two.ts', 'class A { render() { return 1; } }\nclass B { render() { return 2; } }\n');
    const r = await buildFrames(dir, 'render', { glob: '**/*.ts', include: ['definition'] });
    expect(r.definitions).toHaveLength(2);
    expect(r.definitions.map((d) => d.line).sort()).toEqual([1, 2]);
  });

  it('narrows definitions with the file option', async () => {
    await write('a.ts', 'export function widget() { return 1; }\n');
    await write('b.ts', 'export function widget() { return 2; }\n');
    const r = await buildFrames(dir, 'widget', { glob: '**/*.ts', file: 'a.ts', include: ['definition'] });
    expect(r.definitions.map((d) => d.file)).toEqual(['a.ts']);
  });
});

describe('buildFrames — incoming ranking oracle', () => {
  it('returns the call site (exact), excludes import/comment/definition, keeps string as heuristic', async () => {
    await write('rank.ts', [
      'import { target } from \'./dep\';',
      'const label = "target";',
      '// target comment',
      '/* target block */',
      'function target() { return 1; }',
      'function caller() { target(); }',
    ].join('\n') + '\n');
    const r = await buildFrames(dir, 'target', { glob: '**/*.ts' });

    const lines = r.incoming.map((f) => f.line).sort((a, b) => a - b);
    expect(lines).not.toContain(1); // import
    expect(lines).not.toContain(3); // line comment
    expect(lines).not.toContain(4); // block comment
    expect(lines).not.toContain(5); // definition site

    const call = r.incoming.find((f) => f.line === 6);
    expect(call?.confidence).toBe('exact');
    const str = r.incoming.find((f) => f.line === 2);
    expect(str?.confidence).toBe('heuristic');
  });

  it('computes correct line numbers for a CRLF file', async () => {
    await write('crlf.ts', 'const a = 1;\r\nconst b = 2;\r\nfunction widget() { return a + b; }\r\n');
    const r = await buildFrames(dir, 'widget', { glob: '**/crlf.ts' });
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0].line).toBe(3);
    expect(r.definitions[0].code).not.toContain('\r');
    expect(r.definitions[0].code).toContain('function widget');
  });
});

describe('buildFrames — caps and scoping', () => {
  it('sets truncated and bounds work when maxHits is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      await write(`f${i}.ts`, 'function widget() {}\nwidget();\n');
    }
    const r = await buildFrames(dir, 'widget', { glob: '**/*.ts', maxHits: 2 });
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.includes('hits capped'))).toBe(true);
  });

  it('caps total frames at maxFrames', async () => {
    const calls = Array.from({ length: 30 }, (_, i) => `function c${i}() { widget(); }`).join('\n');
    await write('many.ts', `function widget() {}\n${calls}\n`);
    const r = await buildFrames(dir, 'widget', { glob: '**/*.ts', maxFrames: 5 });
    expect(r.definitions.length + r.incoming.length).toBeLessThanOrEqual(5);
    expect(r.truncated).toBe(true);
  });

  it('never descends into excluded dirs (node_modules)', async () => {
    await write('src.ts', 'function widget() { return 1; }\n');
    await write('node_modules/pkg/index.ts', 'function widget() { return 99; }\nwidget();\n');
    const r = await buildFrames(dir, 'widget', { glob: '**/*.ts' });
    const files = [...r.definitions, ...r.incoming].map((f) => f.file);
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    expect(r.definitions.map((d) => d.file)).toEqual(['src.ts']);
  });
});

describe('buildFrames — portability', () => {
  let savedPath: string | undefined;
  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
  });

  it('returns correct frames when rg is absent (forced ENOENT → JS grep)', async () => {
    await write('p.ts', 'function gadget() { return 1; }\nfunction use() { return gadget(); }\n');
    savedPath = process.env.PATH;
    process.env.PATH = join(dir, 'no-such-bin');
    const r = await buildFrames(dir, 'gadget', { glob: '**/*.ts' });
    expect(r.definitions.map((d) => d.line)).toEqual([1]);
    expect(r.incoming.map((f) => f.line)).toContain(2);
  });

  it('emits / separators and accepts a \\-style file input on a nested path', async () => {
    await write('sub/widget.ts', 'export function widget() { return 1; }\n');
    const r = await buildFrames(dir, 'widget', { glob: '**/*.ts', file: 'sub\\widget.ts', include: ['definition'] });
    expect(r.definitions.map((d) => d.file)).toEqual(['sub/widget.ts']);
    expect([...r.definitions, ...r.incoming].every((f) => !f.file.includes('\\'))).toBe(true);
  });
});
