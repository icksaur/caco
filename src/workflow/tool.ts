import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { storeOutput } from '../output-store.js';
import { shapeOutput } from '../observe/shape.js';
import { createLogger } from '../logger.js';
import { recordWorkflowSavingsV2, recordWorkflowCode, currentWindowTokens } from '../session-throughput.js';
import { WORKFLOW_EMIT_CAP_BYTES, WORKFLOW_TIMEOUT_ADVERTISED_MS } from '../config.js';
import { runWorkflow } from './runner.js';
import { estimateWorkflowSavings } from './savings-model.js';
import { FACADE_API_SUMMARY } from './facade.js';
import { getHostShell, shellGuidance } from './shell.js';
import type { SessionIdRef } from '../types.js';
import { requireSessionId } from '../session-id-ref.js';

const workflowLog = createLogger('WORKFLOW');

const shellG = shellGuidance(getHostShell());

const DESCRIPTION = `Run ONE TypeScript workflow on the host and return only a compact result. **Executes arbitrary code, auto-approved.** This is also how you run SHELL: \`bash\`/\`powershell\` are not separate tools — use \`caco.sh('<command>')\`, which returns { stdout, stderr, code } and never throws on non-zero exit. ${shellG.banner}

Use it for: (a) running shell commands (a single command is a one-line workflow: \`emit(await caco.sh('git status'))\`); (b) fan-out read+aggregate over many files, returning a summary instead of dumping every file into context. Don't use it for a single file read (use \`view\`/\`index\`) or to edit (use the edit tool).

Why: shell/fan-out output is bounded here — you emit only the slice that matters, keeping unbounded command output and intermediate file contents out of your context.

Batch aggressively — prefer one workflow over several calls. When you have multiple independent steps (run tests, check git status, count files), do them all in a single workflow: chain shell with \`&&\`/\`;\`, or make several \`caco.sh\` calls and \`emit\` one combined object. Each separate \`caco_run_workflow\` call is a wasted round trip. Only split when a later step depends on reasoning about an earlier step's output, or when one command may approach the timeout.

Economy: prefer one workflow that \`caco.read\`/\`caco.grep\`s many files over repeated view/grep turns; don't re-read what's already in context; don't narrate in a turn of its own.

The code is an async function body with two globals: \`emit(value)\` — call EXACTLY ONCE with the compact result (don't console.log intermediate data); \`caco\` — the facade below. Top-level \`import\` is unsupported; use \`await import(...)\`. Set \`timeoutMs\` (up to 120000) for slow commands like tests/builds; for runs longer than that, detach (\`${shellG.detachExample}\`) and poll the logfile in a later call.

Judging success: \`caco.sh\` reports failure via \`code\` (non-zero = failed), NOT via the text. When a command's success matters (tests, build, typecheck, lint, git push), **emit its \`.code\`** and assert it is 0 — never decide pass/fail from \`.stdout\` alone. Do NOT pipe a success-critical command through \`| tail\`/\`| grep\`/\`| head\`: the pipeline's exit status is the LAST stage's, so a non-zero failure (e.g. a failing test run) is hidden behind \`tail\`'s 0. Run the command directly and slice \`.stdout\` in JS if you want fewer lines.

${FACADE_API_SUMMARY}

Examples:
\`\`\`ts
// run a gate — keep the exit code (nonzero = failure) plus a tail; never judge success by text alone
const r = await caco.sh('npm test 2>&1');
emit({ code: r.code, tail: r.stdout.split('\\n').slice(-15).join('\\n') });
\`\`\`
\`\`\`ts
// MANY independent steps batched into one call — not three workflows
emit({
  test: await caco.sh('npm test 2>&1').then(r => ({ code: r.code, tail: r.stdout.split('\\n').slice(-3).join('\\n') })),
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
        const breakdown = estimateWorkflowSavings({
          observedBytes: result.observedBytes,
          injectedBytes: Buffer.byteLength(out, 'utf8'),
          commandCount: result.commandCount,
          codeBytes: Buffer.byteLength(code, 'utf8'),
          windowTokens: currentWindowTokens(sessionId),
        });
        recordWorkflowSavingsV2(sessionId, breakdown);
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
