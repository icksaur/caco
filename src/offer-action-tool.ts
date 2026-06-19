import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionMeta, setSessionMeta } from './storage.js';
import type { SessionIdRef } from './types.js';

const MAX_OPTIONS = 4;
const MAX_OPTION_LENGTH = 50;

export function createOfferActionTool(sessionRef: SessionIdRef) {
  const tool = defineTool('caco_offer_action', {
    description: `Show 1-4 clickable next-step buttons. Clicking one sends that exact text as the next message.

Each option must be a complete, self-contained instruction the agent can act on immediately (not "next bug" or "tell me more" — ask in prose for those). Omit stop/pause/done/cancel options. Max 4 options, max 50 chars each.`,

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
