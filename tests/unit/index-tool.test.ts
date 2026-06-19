import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { treeSitterAdapter, TreeSitterAdapter } from '../../src/index/tree-sitter-adapter.js';
import { TreeSitterRuntime } from '../../src/index/runtime.js';
import { formatIndex } from '../../src/index/format.js';
import { languageForExtension } from '../../src/index/extractors.js';
import { type IndexItem, type IndexResult } from '../../src/index/types.js';
import { createIndexTool } from '../../src/index-tool.js';

const SAMPLES: Record<string, { file: string; source: string }> = {
  typescript: {
    file: 'a.ts',
    source: `import { z } from 'zod';
export interface Shape { area(): number; }
export type Id = string;
export enum Color { Red, Green }
export class Circle implements Shape {
  r = 1;
  area(): number { return 3.14 * this.r; }
  async load(id: string) { return id; }
}
export function helper(x: number) { return x; }
describe('Circle', () => {
  it('has area', () => {});
});`,
  },
  javascript: {
    file: 'b.js',
    source: `import fs from 'fs';
export class Animal {
  speak() { return 'hi'; }
}
export function run(n) { return n; }`,
  },
  cpp: {
    file: 'c.cpp',
    source: `#include <vector>
namespace geo {
class Point {
public:
  Point(int x, int y);
  int dist() const;
};
struct Box { Point a, b; };
int area(const Box& b) { return 0; }
}`,
  },
  csharp: {
    file: 'd.cs',
    source: `using System;
namespace Geo {
  public record struct Vec(int X, int Y);
  public interface IShape { double Area(); }
  public class Circle : IShape {
    public double R { get; set; }
    public double Area() => Math.PI * R * R;
    [Fact] public void Test() {}
  }
}`,
  },
};

const SKIP_NAME_KINDS = new Set(['import', 'include', 'using', 'test']);

function flatten(items: IndexItem[]): IndexItem[] {
  const out: IndexItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.children) out.push(...flatten(item.children));
  }
  return out;
}

function allItems(result: IndexResult): IndexItem[] {
  return result.sections.flatMap((s) => flatten(s.items));
}

describe('tree-sitter adapter — line-range oracle', () => {
  for (const [lang, sample] of Object.entries(SAMPLES)) {
    it(`${lang}: every declaration's name lies within its reported range`, async () => {
      const result = await treeSitterAdapter.index({
        path: sample.file,
        language: lang,
        source: sample.source,
        options: { maxEntries: 200 },
      });
      const lines = sample.source.split('\n');
      const items = allItems(result);
      expect(items.length).toBeGreaterThan(0);

      for (const item of items) {
        // Range validity (1-based inclusive, within file).
        expect(item.startLine).toBeGreaterThanOrEqual(1);
        expect(item.endLine).toBeGreaterThanOrEqual(item.startLine);
        expect(item.endLine).toBeLessThanOrEqual(result.totalLines);

        if (SKIP_NAME_KINDS.has(item.kind)) continue;
        // Independent oracle: the declared name must appear in the claimed span.
        const name = item.label.split('(')[0].trim();
        const span = lines.slice(item.startLine - 1, item.endLine).join('\n');
        expect(span, `${lang} ${item.kind} "${name}" not in lines ${item.startLine}-${item.endLine}`).toContain(name);
      }
    });
  }

  it('reports 1-based start line for a single-line declaration', async () => {
    const result = await treeSitterAdapter.index({
      path: 'x.ts', language: 'typescript', source: 'class A {}', options: { maxEntries: 200 },
    });
    const cls = allItems(result).find((i) => i.kind === 'class');
    expect(cls?.startLine).toBe(1);
  });

  it('produces deterministic output across repeated calls', async () => {
    const args = { path: 'c.cpp', language: 'cpp', source: SAMPLES.cpp.source, options: { maxEntries: 200 } };
    const a = formatIndex(await treeSitterAdapter.index(args));
    const b = formatIndex(await treeSitterAdapter.index(args));
    expect(a).toBe(b);
  });
});

describe('budgets and unsupported input', () => {
  it('truncates at maxEntries and flags it', async () => {
    const source = Array.from({ length: 6 }, (_, i) => `function f${i}() {}`).join('\n');
    const result = await treeSitterAdapter.index({
      path: 'many.ts', language: 'typescript', source, options: { maxEntries: 2 },
    });
    expect(allItems(result).length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/truncat/i);
  });

  it('detect() returns null for unsupported extensions', () => {
    expect(languageForExtension('.py')).toBeNull();
    expect(treeSitterAdapter.detect('foo.py')).toBeNull();
    expect(treeSitterAdapter.detect('foo.ts')).toBe('typescript');
  });

  it('unsupported language id yields a diagnostic, not a throw', async () => {
    const result = await treeSitterAdapter.index({
      path: 'x.py', language: 'python', source: 'print(1)', options: { maxEntries: 200 },
    });
    expect(result.sections).toHaveLength(0);
    expect(result.diagnostics.join(' ')).toMatch(/unsupported/i);
  });
});

describe('runtime — init and grammar cache', () => {
  it('is single-flight: concurrent first-calls init and load once', async () => {
    const initSpy = vi.fn(() => Promise.resolve());
    const loadSpy = vi.fn(() => Promise.resolve({} as never));
    const rt = new TreeSitterRuntime(initSpy, loadSpy);
    await Promise.all([rt.getLanguage('cpp'), rt.getLanguage('cpp'), rt.getLanguage('cpp')]);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing grammar without affecting others, and does not retry', async () => {
    const loadSpy = vi.fn((wasmPath: string) =>
      wasmPath.includes('tree-sitter-cpp')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({} as never),
    );
    const rt = new TreeSitterRuntime(() => Promise.resolve(), loadSpy);

    await expect(rt.getLanguage('cpp')).rejects.toThrow('boom');
    await expect(rt.getLanguage('cpp')).rejects.toThrow('boom'); // cached rejection
    await expect(rt.getLanguage('c_sharp')).resolves.toBeDefined(); // sibling unaffected

    const cppLoads = loadSpy.mock.calls.filter((c) => (c[0] as string).includes('tree-sitter-cpp'));
    expect(cppLoads).toHaveLength(1); // no retry
  });

  it('adapter surfaces a load failure as a diagnostic, not a throw', async () => {
    const rt = new TreeSitterRuntime(() => Promise.resolve(), () => Promise.reject(new Error('boom')));
    const adapter = new TreeSitterAdapter(rt);
    const result = await adapter.index({ path: 'c.cpp', language: 'cpp', source: 'int x;', options: { maxEntries: 200 } });
    expect(result.diagnostics.join(' ')).toMatch(/boom/);
  });
});

describe('index tool handler — path and size safety', () => {
  let dir: string;
  let handler: (args: { path: string; language?: string; maxEntries?: number }) => Promise<{ textResultForLlm: string }>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caco-index-'));
    await writeFile(join(dir, 'a.ts'), SAMPLES.typescript.source);
    await writeFile(join(dir, 'big.ts'), 'x'.repeat(1024 * 1024 + 16));
    handler = createIndexTool(dir)[0].handler as typeof handler;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('indexes a real file in the session directory', async () => {
    const res = await handler({ path: 'a.ts' });
    expect(res.textResultForLlm).toContain('classes:');
    expect(res.textResultForLlm).toMatch(/Circle \[\d+-\d+\]/);
  });

  it('rejects paths outside the session directory', async () => {
    const res = await handler({ path: '../../../etc/passwd' });
    expect(res.textResultForLlm).toMatch(/escapes|denied/i);
  });

  it('reports missing files', async () => {
    const res = await handler({ path: 'nope.ts' });
    expect(res.textResultForLlm).toMatch(/not found/i);
  });

  it('rejects unsupported file types before reading', async () => {
    const res = await handler({ path: 'script.py' });
    expect(res.textResultForLlm).toMatch(/unsupported file type/i);
  });

  it('refuses to parse files over the parse cap, recommending ranged reads', async () => {
    const res = await handler({ path: 'big.ts' });
    expect(res.textResultForLlm).toMatch(/parse cap/i);
    expect(res.textResultForLlm).toMatch(/view_range/);
  });
});
