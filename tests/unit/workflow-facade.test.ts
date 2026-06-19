import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFacade } from '../../src/workflow/facade.js';
import { WorkflowInputError } from '../../src/workflow/types.js';

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-facade-'));
  await writeFile(join(base, 'one.ts'), 'export const x = 1;\nexport function f() { return x; }\n');
  await mkdir(join(base, 'sub'), { recursive: true });
  await writeFile(join(base, 'sub', 'two.txt'), 'hello NEEDLE world\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('createFacade', () => {
  it('reads a ranged file', async () => {
    const caco = createFacade(base);
    const res = await caco.read('one.ts', [1, 1]);
    expect(res.text).toBe('export const x = 1;');
  });

  it('greps content', async () => {
    const caco = createFacade(base);
    const res = await caco.grep('NEEDLE');
    expect(res).toEqual([{ file: join('sub', 'two.txt'), line: 1, text: 'hello NEEDLE world' }]);
  });

  it('globs and lists scoped to the session dir', async () => {
    const caco = createFacade(base);
    expect(await caco.glob('**/*.txt')).toContain(join('sub', 'two.txt'));
    expect(await caco.list()).toContain('sub/');
  });

  it('indexes a source file into declarations', async () => {
    const caco = createFacade(base);
    const res = await caco.index('one.ts');
    expect(res.language).toBe('typescript');
    expect(res.sections.length).toBeGreaterThan(0);
  });

  it('sh runs scoped and reports non-zero exit without throwing', async () => {
    const caco = createFacade(base);
    const ok = await caco.sh('echo hi');
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');
    const bad = await caco.sh('exit 3');
    expect(bad.code).toBe(3);
  });

  it('rejects path escapes', async () => {
    const caco = createFacade(base);
    await expect(caco.read('../../etc/passwd')).rejects.toBeInstanceOf(WorkflowInputError);
    await expect(caco.list('..')).rejects.toBeInstanceOf(WorkflowInputError);
  });

  it('retrieve throws for an unknown id', async () => {
    const caco = createFacade(base);
    await expect(caco.retrieve('missing')).rejects.toBeInstanceOf(WorkflowInputError);
  });
});
