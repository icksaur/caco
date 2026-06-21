import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { storeOutput } from '../output-store.js';
import { shapeOutput } from '../observe/shape.js';
import { createLogger } from '../logger.js';
import { recordWorkflowSavings, recordWorkflowCode } from '../session-throughput.js';
import { WORKFLOW_EMIT_CAP_BYTES, WORKFLOW_TIMEOUT_ADVERTISED_MS } from '../config.js';
import { runWorkflow } from './runner.js';
import { estimateSavedTokens } from './savings.js';
import { FACADE_API_SUMMARY } from './facade.js';
import type { SessionIdRef } from '../types.js';
import { requireSessionId } from '../session-id-ref.js';

const workflowLog = createLogger('WORKFLOW');

const DESCRIPTION = `Run ONE TypeScript workflow on the host and return only a compact result. **Executes arbitrary code, auto-approved.** This is also how you run SHELL: \`bash\`/\`powershell\` are not separate tools — use \`caco.sh('<command>')\`, which returns { stdout, stderr, code } and never throws on non-zero exit.

Use it for: (a) running shell commands (a single command is a one-line workflow: \`emit(await caco.sh('git status'))\`); (b) fan-out read+aggregate over many files, returning a summary instead of dumping every file into context. Do NOT use it for a single file read (use \`view\`/\`index\`) or to edit (use the edit tool).

Why: shell/fan-out output is bounded here — you emit only the slice that matters, keeping unbounded command output and intermediate file contents out of your context.

**Batch aggressively — prefer ONE workflow over several calls.** When you have multiple independent steps (run tests AND check git status AND count files), do them ALL in a single workflow: chain shell with \`&&\`/\`;\`, or make several \`caco.sh\` calls and \`emit\` one combined object. Each separate \`caco_run_workflow\` call is a wasted round trip. Only split when a later step depends on reasoning about an earlier step's output, or when one command may approach the timeout.

The code is an async function body with two globals: \`emit(value)\` — call EXACTLY ONCE with the compact result (don't console.log intermediate data); \`caco\` — the facade below. Top-level \`import\` is unsupported; use \`await import(...)\`. Set \`timeoutMs\` (up to 120000) for slow commands like tests/builds; for runs longer than that, detach (\`caco.sh('setsid <cmd> >log 2>&1 < /dev/null &')\`) and poll the logfile in a later call.

${FACADE_API_SUMMARY}

Examples:
\`\`\`ts
// one shell command
emit((await caco.sh('npm test 2>&1')).stdout);
\`\`\`
\`\`\`ts
// MANY independent steps batched into one call — not three workflows
emit({
  tests: (await caco.sh('npm test 2>&1 | tail -3')).stdout,
  branch: (await caco.sh('git rev-parse --abbrev-ref HEAD')).stdout.trim(),
  todoCount: (await caco.grep('TODO', { glob: 'src/**/*.ts' })).length,
});
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
      timeoutMs: z.number().int().optional().describe(`Wall-clock timeout (default 30000, cap ${WORKFLOW_TIMEOUT_ADVERTISED_MS}).`),
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
