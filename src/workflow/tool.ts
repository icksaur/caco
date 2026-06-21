import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { storeOutput } from '../output-store.js';
import { shapeOutput } from '../observe/shape.js';
import { createLogger } from '../logger.js';
import { recordWorkflowSavings, recordWorkflowCode } from '../session-throughput.js';
import { WORKFLOW_EMIT_CAP_BYTES, WORKFLOW_TIMEOUT_CAP_MS } from '../config.js';
import { runWorkflow } from './runner.js';
import { estimateSavedTokens } from './savings.js';
import { FACADE_API_SUMMARY } from './facade.js';
import type { SessionIdRef } from '../types.js';
import { requireSessionId } from '../session-id-ref.js';

const workflowLog = createLogger('WORKFLOW');

const DESCRIPTION = `Run ONE TypeScript workflow that reads/aggregates across many files in-process and returns only a compact result. **This executes arbitrary code on the host, auto-approved (no per-action confirmation).** Use it ONLY for fan-out read+aggregate tasks where a single bounded result replaces many individual tool calls — never for a single read (use \`view\`/\`index\`) or to make edits.

PREFER this whenever you are about to issue 3+ read/grep/glob/index calls across files to compute one answer (e.g. "which files import X", "count TODOs per dir", "find every test that calls Y"): one workflow keeps the intermediate file contents out of your context and returns just the summary.

Your code is the body of an async function with two globals:
- \`emit(value)\` — call EXACTLY ONCE with the compact JSON result. Aggregate locally and emit a small summary; do NOT console.log intermediate data.
- \`caco\` — a read-oriented facade (see below).

Top-level \`import\` statements are not supported (the code runs as a function body); use dynamic \`await import(...)\` if you must.

${FACADE_API_SUMMARY}

Example:
\`\`\`ts
const files = await caco.glob('src/**/*.ts');
const offenders = [];
for (const f of files) {
  const hits = await caco.grep('TODO', { path: f });
  if (hits.length) offenders.push({ file: f, todos: hits.length });
}
emit(offenders);
\`\`\``;

function capValue(serialized: string, sessionId: string, sessionCwd: string): { text: string; handle?: string } {
  if (Buffer.byteLength(serialized, 'utf8') <= WORKFLOW_EMIT_CAP_BYTES) return { text: serialized };
  const id = storeOutput(sessionId, sessionCwd, serialized, { type: 'raw', command: 'caco_run_workflow:value' });
  const slice = Buffer.from(serialized, 'utf8').subarray(0, WORKFLOW_EMIT_CAP_BYTES).toString('utf8');
  return {
    text: `${slice}\n[emitted value truncated to ${WORKFLOW_EMIT_CAP_BYTES / 1024} KB]`,
    handle: id,
  };
}

function logsSection(logs: string, logsTruncated: boolean, sessionId: string, sessionCwd: string): string {
  if (!logs.trim()) return '';
  const id = storeOutput(sessionId, sessionCwd, logs, { type: 'terminal', command: 'caco_run_workflow' });
  const decision = shapeOutput('bash', logs);
  const body = decision ? decision.shaped : logs;
  const note = logsTruncated ? ' (capture hit the log ceiling — output truncated)' : '';
  return `\n\nLogs${note} [retrieve_output id="${id}"]:\n${body}`;
}

export function createWorkflowTool(sessionCwd: string, sessionRef: SessionIdRef) {
  const tool = defineTool('caco_run_workflow', {
    description: DESCRIPTION,
    parameters: z.object({
      code: z.string().describe('TypeScript workflow body. Uses `caco` and `emit`; aggregate then emit() once.'),
      timeoutMs: z.number().int().optional().describe(`Wall-clock timeout (default 30000, cap ${WORKFLOW_TIMEOUT_CAP_MS}).`),
      description: z.string().optional().describe('One-line description of what this workflow computes.'),
    }),
    handler: async ({ code, timeoutMs, description }) => {
      workflowLog.info('run', { description, codeBytes: Buffer.byteLength(code, 'utf8'), code });
      const sessionId = requireSessionId(sessionRef);
      recordWorkflowCode(sessionId, Buffer.byteLength(code, 'utf8'));
      let result;
      try {
        result = await runWorkflow(sessionCwd, { code, timeoutMs });
      } catch (e) {
        return { textResultForLlm: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }

      const logs = logsSection(result.logs, result.logsTruncated, sessionId, sessionCwd);

      if (result.outcome === 'emitted') {
        const serialized = JSON.stringify(result.value, null, 2);
        const { text, handle } = capValue(serialized ?? 'undefined', sessionId, sessionCwd);
        const handleNote = handle ? ` [retrieve_output id="${handle}"]` : '';
        const killNote = result.timedOut ? ' (note: the workflow was killed by the timeout after emitting)' : '';
        const out = `Workflow emitted${handleNote}${killNote}:\n${text}${logs}`;
        const saved = estimateSavedTokens(result.observedBytes, Buffer.byteLength(out, 'utf8'));
        recordWorkflowSavings(sessionId, saved);
        return { textResultForLlm: out };
      }
      if (result.outcome === 'no-emit') {
        return { textResultForLlm: `Workflow completed without calling emit() — no result was returned.${logs}` };
      }
      return { textResultForLlm: `Workflow failed: ${result.error}${logs}` };
    },
  });

  return [tool];
}
