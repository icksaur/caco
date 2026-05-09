import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionMeta, setSessionMeta } from './storage.js';
import type { SessionIdRef } from './types.js';

const MAX_OPTIONS = 4;
const MAX_OPTION_LENGTH = 50;

export function createOfferOptionsTool(sessionRef: SessionIdRef) {
  const tool = defineTool('caco_offer_options', {
    description: `Present clickable response options to the user. Call at the end of your response when the user's next action is one of a few discrete choices.

The user sees buttons above the chat input. Clicking one sends that exact text as their next message.

Good uses: approval ("Proceed" / "Modify first"), binary ("Yes" / "No"), workflow steps ("Run tests" / "Deploy" / "Skip").
Do not use for open-ended questions. Each option is both the button label and the exact text sent — keep them brief and unambiguous. Max 4 options, max 50 characters each.`,

    parameters: z.object({
      options: z.array(z.string()).min(1).max(MAX_OPTIONS)
        .describe('1-4 short prompts shown as clickable buttons'),
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
