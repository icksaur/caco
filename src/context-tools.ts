/**
 * Context Tools
 * 
 * Tools for managing session context - files, applets, endpoints, etc.
 * Context persists across session resume, helping agents remember what
 * they were working on.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { getSessionMeta, setSessionMeta } from './storage.js';
import type { SessionIdRef } from './types.js';

/** Known set names for validation (typos trigger warning) */
export const KNOWN_SET_NAMES = new Set(['files', 'applet', 'endpoints', 'ports']);

/** Max items per set */
const MAX_ITEMS_PER_SET = 10;

/** Max total items across all sets */
const MAX_TOTAL_ITEMS = 50;

/**
 * Merge context set items based on mode.
 * Pure function for testability.
 */
export function mergeContextSet(
  existing: string[],
  items: string[],
  mode: 'replace' | 'merge'
): string[] {
  if (mode === 'replace') {
    return items.slice(0, MAX_ITEMS_PER_SET);
  }
  return [...new Set([...existing, ...items])].slice(0, MAX_ITEMS_PER_SET);
}

/** Callback type for broadcasting events */
export type BroadcastFn = (sessionId: string, event: { type: string; data?: Record<string, unknown> }) => void;

/**
 * Create context tools with a session ID reference.
 * The reference can be updated after session creation.
 * @param sessionRef - Mutable session ID reference
 * @param broadcast - Optional callback to broadcast context change events
 */
export function createContextTools(
  sessionRef: SessionIdRef,
  broadcast?: BroadcastFn
) {

  const setRelevantContext = defineTool('set_relevant_context', {
    description: `Track files and resources for session continuity. **Use this frequently** - it's how you remember what you're working on across conversations.

**When to use:**
- When user shares or mentions a file (design doc, spec, config, notes)
- When you read or edit a file that's central to the task
- When working with specific endpoints, ports, or applets
- Before finishing a task - save context for future sessions

**Why it matters:** Sessions resume days or weeks later. Without context, you forget everything. This tool ensures seamless collaboration by preserving your working state.

**Set names:** files (paths), applet (slug + params), endpoints (URLs), ports
**Mode:** "replace" (default) or "merge" (union with existing)

Max 10 items per set, 50 total.`,

    parameters: z.object({
      setName: z.string().describe('Name of context set (files, applet, endpoints, ports)'),
      items: z.array(z.string()).max(MAX_ITEMS_PER_SET).describe('Items for this set'),
      mode: z.enum(['replace', 'merge']).default('replace').describe('replace or merge with existing')
    }),

    handler: async ({ setName, items, mode }) => {
      // Soft validation - warn on unknown set names
      if (!KNOWN_SET_NAMES.has(setName)) {
        console.warn(`[CONTEXT] Unknown set name: "${setName}" (typo?)`);
      }

      const meta = getSessionMeta(sessionRef.id) ?? { name: '' };
      const context = { ...(meta.context ?? {}) };

      const merged = mergeContextSet(context[setName] ?? [], items, mode);
      
      if (merged.length === 0) {
        delete context[setName];
      } else {
        context[setName] = merged;
      }

      // Enforce total cap
      const total = Object.values(context).reduce((sum, arr) => sum + arr.length, 0);
      if (total > MAX_TOTAL_ITEMS) {
        return {
          textResultForLlm: `Context too large (${total} items, max ${MAX_TOTAL_ITEMS}). Remove some items first.`,
          resultType: 'error' as const
        };
      }

      setSessionMeta(sessionRef.id, { ...meta, context });

      // Broadcast context change to connected clients
      if (broadcast) {
        broadcast(sessionRef.id, {
          type: 'caco.context',
          data: { reason: 'changed', context, setName }
        });
      }

      const action = mode === 'merge' ? 'Merged' : 'Set';
      const count = context[setName]?.length ?? 0;
      
      return {
        textResultForLlm: items.length
          ? `${action} ${setName}: ${count} items`
          : `Cleared ${setName}`,
        toolTelemetry: { contextChanged: true, setName }
      };
    }
  });

  const getRelevantContext = defineTool('get_relevant_context', {
    description: `Retrieve saved session context. Check what files/resources were being worked on.

**When to use:**
- At session start to recall previous work
- When user asks "what were we working on?"
- To verify context before making changes

Call with no arguments for all context, or specify setName for a specific set.`,

    parameters: z.object({
      setName: z.string().optional().describe('Specific set to retrieve, or omit for all')
    }),

    handler: async ({ setName }) => {
      const meta = getSessionMeta(sessionRef.id);
      const context = meta?.context ?? {};

      const result = setName ? { [setName]: context[setName] ?? [] } : context;

      return {
        textResultForLlm: Object.keys(result).length
          ? JSON.stringify(result, null, 2)
          : 'No context stored for this session'
      };
    }
  });

  return [setRelevantContext, getRelevantContext];
}
