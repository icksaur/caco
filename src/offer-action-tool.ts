import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionMeta, setSessionMeta } from './storage.js';
import type { SessionIdRef } from './types.js';

const MAX_OPTIONS = 4;
const MAX_OPTION_LENGTH = 50;

export function createOfferActionTool(sessionRef: SessionIdRef) {
  const tool = defineTool('caco_offer_action', {
    description: `Offer the user 1-4 clickable buttons for the next step of work. Use at the end of your response when there are a few discrete next actions you could take.

The user sees buttons above the chat input. Clicking one sends that exact text as the next message — so each option must read as an instruction the agent can act on immediately, without further information from the user.

If a button would require the user to supply details before you could act ("next bug", "tell me what to do", "another question"), do NOT offer it — just ask in prose instead. The tool is for branching between concrete paths you could already take.

Only offer actions that move work forward. Do NOT include options like "Stop", "Pause", "Done", "Cancel", or anything that ends the session — the user has the chat input and the slash menu for those. The whole purpose of this tool is to accelerate productive next steps.

Good uses: "Run the tests" / "Commit and push", "Refactor for clarity" / "Add unit tests" / "Move on", "Apply review feedback" / "Push back on the reviewer".
Each option must be brief, unambiguous, and a complete instruction. Max 4 options, max 50 characters each.`,

    parameters: z.object({
      options: z.array(z.string()).min(1).max(MAX_OPTIONS)
        .describe('1-4 short next-step instructions shown as clickable buttons'),
    }),

    handler: async ({ options }) => {
      const sessionId = sessionRef.id;
      if (!sessionId) {
        return { textResultForLlm: 'Error: no active session' };
      }

      const trimmed = options.map(o => o.trim()).filter(Boolean);
      if (trimmed.length === 0) {
        return { textResultForLlm: 'Error: at least one non-empty option required' };
      }

      const truncated = trimmed.slice(0, MAX_OPTIONS).map(o =>
        o.length > MAX_OPTION_LENGTH ? o.slice(0, MAX_OPTION_LENGTH) : o
      );

      const meta = getSessionMeta(sessionId) ?? { name: '' };
      meta.responseOptions = truncated;
      setSessionMeta(sessionId, meta);

      return {
        textResultForLlm: JSON.stringify({ ok: true, options: truncated }),
      };
    },
  });

  return [tool];
}
