import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { formatDeferredTools } from './session-tool-state.js';

/**
 * `caco_enable_tools` — the reveal + discovery half of on-demand tools
 * (spec-tool-reveal B2, spec-enable-tools-discovery). The SOLE always-on escape
 * hatch: called with no `names` it lists this session's deferred tools; called
 * with `names` it re-enables them. Delegates state + the sole success-gated SDK
 * mutation to SessionManager; this file is a thin adapter.
 */
export function createToolRevealTool(sessionRef: SessionIdRef) {
  const enableTools = defineTool('caco_enable_tools', {
    description: `Discover and re-enable DEFERRED tools for this session. Deferred tools are excluded from every turn's tool list to save tokens.

- Call with NO arguments (\`{}\`) to list every deferred tool (name + description) you can re-enable — this is how you discover what's available, including \`caco_docs\`.
- Call with \`names\` to re-enable them; Caco automatically continues in a new request where they become available (you cannot call them later in THIS response).

COST: enabling changes the tool block, which busts the prompt cache for ONE turn (a one-time cost, then normal). So batch ALL the tools you expect to need into a SINGLE call. Listing (no args) is free and never mutates.

Names may be the bare display name (e.g. "list_issues") or the full key (e.g. "github-mcp-server/list_issues"); use the full key if a bare name is ambiguous.`,

    parameters: z.object({
      names: z.array(z.string()).optional().describe('Tool names (or full keys) to enable. Omit to LIST all deferred tools instead. When enabling, batch everything you expect to need in ONE call — each separate call is another cache-bust.'),
    }),

    handler: async ({ names }) => {
      const sessionId = sessionRef.id;
      if (!sessionId) {
        return { textResultForLlm: 'caco_enable_tools: no active session.' };
      }
      // No names → discovery mode: list the session's deferred tools. Pure read,
      // no exclusion mutation, no cache-bust.
      if (!names || names.length === 0) {
        const { catalog, excluded, policyDisabled } = await sessionManager.getToolCatalog(sessionId);
        return { textResultForLlm: formatDeferredTools(catalog, excluded, policyDisabled) };
      }
      const result = await sessionManager.enableTools(sessionId, names);
      if (!result.ok) {
        return { textResultForLlm: `caco_enable_tools failed: ${result.error}. Nothing was changed. Call caco_enable_tools with no arguments to list the exact names of tools you can enable.` };
      }
      const parts: string[] = [];
      if (result.enabled.length > 0) {
        parts.push(`Enabled ${result.enabled.length} tool(s): ${result.enabled.join(', ')}. They are NOT callable later in this response — finish your turn and Caco will automatically continue in a new request where they are available. This incurs a one-time prompt-cache write; subsequent requests are normal.`);
      }
      if (result.alreadyEnabled.length > 0) {
        parts.push(`Already enabled (no change): ${result.alreadyEnabled.join(', ')}.`);
      }
      if (parts.length === 0) parts.push('No tools to enable.');
      return { textResultForLlm: parts.join(' ') };
    },
  });

  return [enableTools];
}
