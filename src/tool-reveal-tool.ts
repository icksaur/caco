import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';

/**
 * `caco_enable_tools` — the reveal half of on-demand tools (spec-tool-reveal B2).
 * Discover deferred tools with `caco_docs section="tools"`, then re-enable a batch
 * here. Delegates all state + the sole success-gated SDK mutation to
 * SessionManager.enableTools; this file is a thin adapter (names in → result text).
 */
export function createToolRevealTool(sessionRef: SessionIdRef) {
  const enableTools = defineTool('caco_enable_tools', {
    description: `Re-enable one or more DEFERRED tools for this session so you can call them on a later turn. Deferred tools are excluded from every turn's tool list to save tokens; discover them (and their exact names) with \`caco_docs section="tools"\` — anything marked [deferred] can be enabled here. [off] tools cannot.

COST: enabling changes the tool block, which busts the prompt cache for ONE turn (a one-time cost, then normal). So batch ALL the tools you expect to need into a SINGLE call — enabling in one call costs one cache-bust; drip-feeding across turns costs one per turn. This never blocks you; it's only about cost.

Names may be the bare display name (e.g. "bash") or the full key (e.g. "github-mcp-server/list_issues"); use the full key if a bare name is ambiguous. The tools become callable on your NEXT turn, not the current one.`,

    parameters: z.object({
      names: z.array(z.string()).min(1).describe('Tool names (or full keys) to enable. Batch everything you expect to need in ONE call — each separate call is another cache-bust.'),
    }),

    handler: async ({ names }) => {
      const sessionId = sessionRef.id;
      if (!sessionId) {
        return { textResultForLlm: 'caco_enable_tools: no active session to enable tools for.' };
      }
      const result = await sessionManager.enableTools(sessionId, names);
      if (!result.ok) {
        return { textResultForLlm: `caco_enable_tools failed: ${result.error}. Nothing was changed. Use \`caco_docs section="tools"\` to see exact names and which tools are [deferred] (re-enableable) vs [off] (not).` };
      }
      const parts: string[] = [];
      if (result.enabled.length > 0) {
        parts.push(`Enabled ${result.enabled.length} tool(s): ${result.enabled.join(', ')}. They are callable on your NEXT turn (not this one). This turn incurs a one-time prompt-cache write; subsequent turns are normal.`);
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
