/**
 * Surface tools — agent-facing wrappers over the surface store.
 *
 * Four tools for V1:
 *   caco_get_surface
 *   caco_get_surface_changes
 *   caco_mutate_surface
 *   caco_clear_surface_changes
 *
 * All tools auto-inject the current sessionId from sessionRef. Direct calls
 * to the store keep the protocol identical to the HTTP routes.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import {
  getSurface,
  mutate,
  clearChanges,
  patchStyle,
  notifySurfaceUpdate,
  INITIAL_DATA_TOKEN,
  type SurfaceItem,
  type MutateResult,
  type SurfaceStyle,
} from './surface-store.js';
import { broadcastEvent } from './event-bus.js';
import type { SessionIdRef } from './types.js';

const ITEM_SCHEMA = z.object({
  id: z.string(),
  type: z.string(),
}).passthrough();

function notify(sessionId: string, result: MutateResult): void {
  notifySurfaceUpdate(sessionId, 'agent', result, broadcastEvent);
}

export function createSurfaceTools(sessionRef: SessionIdRef) {
  const cacoGetSurface = defineTool('caco_get_surface', {
    description: `Read the full session-surface document. Returns { exists, dataToken, style, items, changes, customScript, customStyle }.

When 'exists' is false the doc was never written; the returned dataToken is the initial token — use it in your first caco_mutate_surface call.

Use for the complete item list (e.g. after a stale-token retry, or before the first mutate). Otherwise prefer the cheaper caco_get_surface_changes.`,
    parameters: z.object({}),
    handler: async () => {
      const doc = getSurface(sessionRef.id);
      if (!doc) {
        return {
          exists: false,
          dataToken: INITIAL_DATA_TOKEN,
          style: 'roadmap',
          items: [],
          changes: {},
          customScript: null,
          customStyle: null,
        };
      }
      return { exists: true, ...doc };
    },
  });

  const cacoGetSurfaceChanges = defineTool('caco_get_surface_changes', {
    description: `Read pending human-side edits. Returns { exists, dataToken, changes }; 'changes' maps item id -> latest post-edit item.

When 'exists' is false the doc was never created; the returned dataToken is the initial token for your first caco_mutate_surface call.

Call at the start of each turn. If 'changes' is non-empty, integrate the user's edits, then call caco_mutate_surface (atomic write + ack) or caco_clear_surface_changes (ack only).`,
    parameters: z.object({}),
    handler: async () => {
      const doc = getSurface(sessionRef.id);
      if (!doc) {
        return { exists: false, dataToken: INITIAL_DATA_TOKEN, changes: {} };
      }
      return { exists: true, dataToken: doc.dataToken, changes: doc.changes };
    },
  });

  const cacoMutateSurface = defineTool('caco_mutate_surface', {
    description: `Apply create/update/delete AND atomically clear the human-side changes map. Returns { ok: true, dataToken }.

On { ok: false, reason: "stale", currentDataToken }: call caco_get_surface, rebase, retry. Give up after two stale rounds and tell the user. Other failures: "invalid" (bad item shape), "limit" (>200 items).

Items need { id, type } plus any style-defined fields. 'update' shallow-merges by id; 'delete' takes ids. Item shapes per layout: \`caco_dev_docs section="surface-cookbook"\`. To ack edits without writing, use caco_clear_surface_changes.`,
    parameters: z.object({
      dataToken: z.string().describe('Current dataToken from caco_get_surface or caco_get_surface_changes'),
      create: z.array(ITEM_SCHEMA).optional().describe('New items to add'),
      update: z.array(ITEM_SCHEMA).optional().describe('Items to shallow-merge by id'),
      delete: z.array(z.string()).optional().describe('Item ids to remove'),
    }),
    handler: async ({ dataToken, create, update, delete: del }) => {
      const result = mutate(sessionRef.id, dataToken, {
        create: create as SurfaceItem[] | undefined,
        update: update as SurfaceItem[] | undefined,
        delete: del,
      });
      notify(sessionRef.id, result);
      return result;
    },
  });

  const cacoClearSurfaceChanges = defineTool('caco_clear_surface_changes', {
    description: `Mark the user's edits as seen without writing items. Returns { ok: true, dataToken }, or { ok: false, reason: "stale", currentDataToken } if another writer raced.

Use after caco_get_surface_changes when no structural mutation is needed.`,
    parameters: z.object({
      dataToken: z.string().describe('Current dataToken from caco_get_surface_changes'),
    }),
    handler: async ({ dataToken }) => {
      const result = clearChanges(sessionRef.id, dataToken);
      notify(sessionRef.id, result);
      return result;
    },
  });

  const cacoSetSurfaceStyle = defineTool('caco_set_surface_style', {
    description: `Set the surface's style, customScript, and/or customStyle. customScript is JS that must define a render(surface) function; customStyle is CSS scoped to the applet.

Before authoring either from scratch, read \`caco_dev_docs section="surface-cookbook"\` for copy-pasteable layouts (list, form, kanban, table), the \`merged = { ...item, ...changes[id] }\` pattern, and Caco CSS custom properties (\`--color-*\`, \`--text-*\`, \`--space-*\`, \`--font-sans\`, \`--font-mono\`).

Requires the current dataToken. Returns { ok: true, dataToken }, or { ok: false, reason: "stale" } on token mismatch.`,
    parameters: z.object({
      dataToken: z.string().describe('Current dataToken from caco_get_surface'),
      style: z.enum(['roadmap', 'custom']).optional().describe('Style identifier'),
      customScript: z.string().nullable().optional().describe('Agent-authored JS. Must define render(surface). Set null to clear.'),
      customStyle: z.string().nullable().optional().describe('Agent-authored CSS scoped to the applet. Set null to clear.'),
    }),
    handler: async ({ dataToken, style, customScript, customStyle }) => {
      const result = patchStyle(sessionRef.id, dataToken, {
        style: style as SurfaceStyle | undefined,
        customScript,
        customStyle,
      });
      notify(sessionRef.id, result);
      return result;
    },
  });

  return [cacoGetSurface, cacoGetSurfaceChanges, cacoMutateSurface, cacoClearSurfaceChanges, cacoSetSurfaceStyle];
}
