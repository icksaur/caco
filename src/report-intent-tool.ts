/**
 * Caco `report_intent` tool
 *
 * Captures the USER's goal for this session (not the agent's current activity)
 * and latches it into `meta.autoName` via the existing write-once machinery in
 * `setSessionIntent`. Feeds the session-title fallback ladder specified by
 * `spec-auto-name-sessions` and this tool's own spec `spec-report-intent-tool`.
 *
 * Historical note: an SDK-native `report_intent` tool once fed the same channel,
 * but was removed upstream. The Caco tool restores the capability without
 * depending on model-behavior classification of reasoning tokens.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { hasValidText, setSessionIntent, getSessionMeta } from './session-meta-store.js';
import type { SessionIdRef } from './types.js';

const MAX_INTENT_CHARS = 200;

export function createReportIntentTool(sessionRef: SessionIdRef | undefined) {
  const reportIntent = defineTool('report_intent', {
    description:
      'Record what the USER wants accomplished in this session (their goal, not your current activity). ' +
      'Call this ONCE on the first turn of a new session with a short phrase — target ~5 words, e.g. ' +
      '"fix routing bug", "triage email", "capacity planning". This becomes the session title in the ' +
      'session list. It is USER intent, not agent intent: describe the destination, not the step you are ' +
      'about to take. If User Memory contains an `intent-style` preference (e.g. "prefix with a domain ' +
      'emoji"), apply it to the phrase. The first valid call sets the title permanently for this session; ' +
      'later calls only update the transient sub-line and do not shimmer the title.',

    parameters: z.object({
      intent: z
        .string()
        .describe(
          "Short phrase describing the user's goal (~5 words, max 200 chars). USER intent, not agent activity.",
        ),
    }),

    handler: async ({ intent }) => {
      if (!hasValidText(intent)) {
        return {
          textResultForLlm:
            'Error: intent must be a non-empty phrase. Pass a short description of what the user wants accomplished.',
          resultType: 'error' as const,
        };
      }
      const trimmed = intent.trim();
      if (trimmed.length > MAX_INTENT_CHARS) {
        return {
          textResultForLlm: `Error: intent must be <= ${MAX_INTENT_CHARS} chars (received ${trimmed.length}). Shorten to a phrase.`,
          resultType: 'error' as const,
        };
      }
      const sessionId = sessionRef?.id;
      if (!sessionId) {
        return {
          textResultForLlm: 'Error: no active session — report_intent must be called within a session context.',
          resultType: 'error' as const,
        };
      }

      const before = getSessionMeta(sessionId);
      const alreadyLatched = hasValidText(before?.autoName);
      setSessionIntent(sessionId, trimmed);

      if (alreadyLatched) {
        return {
          textResultForLlm: `Updated current intent to "${trimmed}". Session title stays "${before?.autoName}" (locked on first call).`,
        };
      }
      return {
        textResultForLlm: `Recorded session intent: "${trimmed}". This is now the session title.`,
      };
    },
  });

  return [reportIntent];
}
