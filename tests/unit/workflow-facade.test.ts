import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFacade, wrapFacadeForAccounting, type Facade } from '../../src/workflow/facade.js';
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

  it('runs a shell command in the host shell and returns code 0', async () => {
    const caco = createFacade(base);
    const res = await caco.sh('echo hi');
    expect(res.stdout.trim()).toBe('hi');
    expect(res.code).toBe(0);
  });

  it('propagates a non-zero exit code without throwing', async () => {
    const caco = createFacade(base);
    const res = await caco.sh('exit 3');
    expect(res.code).toBe(3);
  });

  it('returns a non-zero code for an unknown command without throwing', async () => {
    const caco = createFacade(base);
    const res = await caco.sh('this-command-does-not-exist-xyz');
    expect(res.code).not.toBe(0);
  });

  it('advertises the host shell dialect in the facade summary', async () => {
    const { FACADE_API_SUMMARY } = await import('../../src/workflow/facade.js');
    const { getHostShell } = await import('../../src/workflow/shell.js');
    expect(FACADE_API_SUMMARY).toContain(getHostShell().label);
  });

  it('runs a pipeline scoped to the session dir', async () => {
    const caco = createFacade(base);
    const res = await caco.sh('ls | grep one');
    expect(res.stdout).toContain('one.ts');
    expect(res.code).toBe(0);
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

describe('wrapFacadeForAccounting', () => {
  it('passes each resolved value to account and returns it unchanged', async () => {
    const seen: unknown[] = [];
    const wrapped = wrapFacadeForAccounting(createFacade(base), (v) => { seen.push(v); });

    const read = await wrapped.read('one.ts', [1, 1]);
    expect(read.text).toBe('export const x = 1;');

    const list = await wrapped.list('.');
    expect(list).toContain('one.ts');

    expect(seen).toEqual([read, list]);
  });

  it('accounts the resolved value, not the promise', async () => {
    const accounted: unknown[] = [];
    const fake: Facade = {
      index: async () => ({ language: 'x', declarations: [] }) as never,
      frames: async () => ({ symbol: 's', definitions: [], incoming: [], truncated: false, notes: [] }),
      read: async () => ({ path: 'p', totalLines: 0, range: [1, 1], text: 'BODY' }),
      grep: async () => [{ file: 'f', line: 1, text: 't' }],
      rg: async () => 'RG',
      glob: async () => ['g'],
      list: async () => ['l'],
      retrieve: async () => 'R',
      sh: async () => ({ stdout: 'o', stderr: '', code: 0 }),
    };
    const wrapped = wrapFacadeForAccounting(fake, (v) => { accounted.push(v); });

    const grep = await wrapped.grep('x');
    expect(grep).toEqual([{ file: 'f', line: 1, text: 't' }]);
    expect(accounted[0]).toBe(grep);
  });
});
