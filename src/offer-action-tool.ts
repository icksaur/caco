import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { updateSessionMeta } from './storage.js';
import { normalizeOptions, MAX_OPTIONS } from './offer-action-parse.js';
import type { SessionIdRef } from './types.js';

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

      const normalized = normalizeOptions(options);
      if (normalized.length === 0) {
        return { textResultForLlm: 'Error: at least one non-empty option required' };
      }

      updateSessionMeta(sessionId, meta => { meta.responseOptions = normalized; });

      return {
        textResultForLlm: JSON.stringify({ ok: true, options: normalized }),
      };
    },
  });

  return [tool];
}
