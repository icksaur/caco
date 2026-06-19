import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkflowTool } from '../../src/workflow/tool.js';
import { getOutput } from '../../src/output-store.js';
import { WORKFLOW_EMIT_CAP_BYTES } from '../../src/config.js';

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-tool-'));
  await writeFile(join(base, 'a.txt'), 'NEEDLE here\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function handler(): (args: { code: string; timeoutMs?: number; description?: string }) => Promise<{ textResultForLlm: string }> {
  return createWorkflowTool(base)[0].handler as (args: { code: string; timeoutMs?: number; description?: string }) => Promise<{ textResultForLlm: string }>;
}

describe('createWorkflowTool', () => {
  it('formats an emitted value inline when under the cap', async () => {
    const res = await handler()({ code: 'emit({ ok: true, n: 3 });' });
    expect(res.textResultForLlm).toMatch(/Workflow emitted/);
    expect(res.textResultForLlm).toMatch(/"n": 3/);
  });

  it('spills an over-cap emitted value to a retrievable handle', async () => {
    const big = 'z'.repeat(WORKFLOW_EMIT_CAP_BYTES + 5000);
    const res = await handler()({ code: `emit({ blob: ${JSON.stringify(big)} });` });
    const m = res.textResultForLlm.match(/retrieve_output id="([^"]+)"/);
    expect(m).toBeTruthy();
    const stored = getOutput(m![1]);
    expect(stored).toBeTruthy();
    const data = typeof stored!.data === 'string' ? stored!.data : stored!.data.toString('utf8');
    expect(data).toContain(big);
  }, 15000);

  it('surfaces a no-emit run', async () => {
    const res = await handler()({ code: 'const x = 1;' });
    expect(res.textResultForLlm).toMatch(/without calling emit/);
  });

  it('surfaces a failed run', async () => {
    const res = await handler()({ code: 'throw new Error(\'kaboom\');' });
    expect(res.textResultForLlm).toMatch(/Workflow failed/);
    expect(res.textResultForLlm).toMatch(/kaboom/);
  });
});
