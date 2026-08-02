/**
 * Herd orchestration tools (spec-session-orchestration Slice B: B5, B6).
 *
 *  - caco_herd_state  — return every child's status + last response (the parent's
 *    automatic result channel; closes the "no ergonomic result read" gap).
 *  - caco_herd        — create / acquire / resume / disown children.
 *
 * Children are ordinary sessions: they receive normal agent-sourced prompts and
 * are unaware of the herd. All herd logic lives here + in src/herd.ts + the
 * server. Dispatches use the agent-message path (source:'agent' + fromSession)
 * so child prompts render agent-colored.
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SERVER_URL, AUTO_ARCHIVE_FOLDER } from './config.js';
import type { SessionIdRef } from './types.js';
import { sessionManager } from './session-manager.js';
import { getSessionMeta, updateSessionMeta } from './storage.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { getLastAssistantMessage } from './session-history.js';
import { boundDelegateResponse } from './delegate-tool.js';
import { applyPluginDirectories } from './plugin-directories-apply.js';
import {
  registerHerdBond,
  clearHerdBond,
  getHerdChildren,
  deriveChildStatus,
  herdParentActionError,
  herdAcquireError,
  herdMemberError,
  shouldParkOnDisown,
  buildHerdStatePayload,
  type HerdChild,
  type HerdStateEntry,
} from './herd.js';

export type GetCorrelationId = (sessionId: string) => string | undefined;

const stripPrefix = (id: string) => id.replace(/^caco-session:/, '');

/** Live snapshot of a parent's children (status derived from the runtime). */
function gatherHerdChildren(parentId: string): HerdChild[] {
  return getHerdChildren(parentId).map(id => {
    const meta = getSessionMeta(id);
    return {
      sessionId: id,
      name: meta?.name ?? null,
      status: deriveChildStatus(sessionManager.isBusy(id), sessionManager.isActive(id)),
      lastIdleAt: meta?.lastIdleAt ?? null,
    };
  });
}

/** Fire-and-forget a prompt to a child via the agent-message path (agent color). */
async function dispatchToChild(childId: string, prompt: string, fromSession: string, correlationId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${childId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, source: 'agent', fromSession, correlationId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      return { ok: false, error: `HTTP ${res.status} — ${err.error || res.statusText}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function createHerdTools(sessionRef: SessionIdRef, getCorrelationId: GetCorrelationId) {
  const selfCorrelation = () => getCorrelationId(sessionRef.id) ?? randomUUID();

  const cacoHerdState = defineTool('caco_herd_state', {
    description: "Get the current state of ALL your herd children (sessions you started or acquired via caco_herd). Returns each child's status (busy/idle/inactive), last idle time, and its last response — the go-to way to collect results from your herd. You are re-woken with this info whenever a child needs attention; call this for the full detail, then resume or disown each child.",

    parameters: z.object({}),

    handler: async () => {
      const children = gatherHerdChildren(sessionRef.id);
      const entries: HerdStateEntry[] = await Promise.all(children.map(async (c) => ({
        ...c,
        lastResponse: boundDelegateResponse(await getLastAssistantMessage(c.sessionId), c.sessionId.slice(0, 8)),
      })));
      const payload = buildHerdStatePayload(entries);
      return { textResultForLlm: JSON.stringify(payload, null, 2), resultType: 'text' as const };
    },
  });

  const modelIds = sessionManager.getModels().map(m => m.id);

  const cacoHerd = defineTool('caco_herd', {
    description: `Manage your herd of child sessions (durable, non-blocking supervision). Actions:
- create: start a NEW session (cwd, model, prompt) as your child.
- acquire: adopt an EXISTING unowned session (sessionId) into your herd, optionally with a prompt.
- resume: give an existing child (sessionId) more work (prompt).
- disown: remove a child (sessionId) from your herd. A child you CREATED is moved to the "auto-archive" folder, where it is auto-archived after ~24h idle unless you move it out or re-acquire it. A session you ACQUIRED is simply released — it keeps its folder and is never scheduled for archival.
You do NOT wait for children; they run and you are re-woken when one needs attention (use caco_herd_state to collect results). Children are ordinary sessions and are unaware they are in a herd. A child cannot itself create/acquire children (herds are one level deep).${modelIds.length ? `\n\nModel IDs: ${modelIds.join(', ')}.` : ''}`,

    parameters: z.object({
      action: z.enum(['create', 'acquire', 'resume', 'disown']).describe('Herd action'),
      sessionId: z.string().optional().describe('Target session (required for acquire/resume/disown)'),
      cwd: z.string().optional().describe('Working directory (for create)'),
      model: z.string().optional().describe('Model ID (for create)'),
      prompt: z.string().optional().describe('Prompt to dispatch (create/resume; optional for acquire)'),
      pluginDirectories: z.array(z.string()).optional().describe('Absolute paths to Open Plugins directories for the CHILD session (create/acquire only; rejected on resume/disown). Never installed into ~/.copilot. Sticky: stays set for the child\'s lifetime. Omit to leave an acquired session\'s existing dirs untouched; pass [] to clear them.'),
    }),

    handler: async ({ action, sessionId: rawTarget, cwd, model, prompt, pluginDirectories }) => {
      const err = (msg: string) => ({ textResultForLlm: msg, resultType: 'error' as const });
      const ok = (msg: string) => ({ textResultForLlm: msg, resultType: 'text' as const });
      const callerId = sessionRef.id;
      const callerMeta = getSessionMeta(callerId);

      // Silently ignoring a passed parameter is a footgun; resume/disown are pure
      // dispatch/bond verbs, so reject rather than pretend (spec-plugin-directories).
      if (pluginDirectories !== undefined && (action === 'resume' || action === 'disown')) {
        return err(`pluginDirectories is not supported on ${action}; set it via create/acquire or the /caco.plugin-directory command.`);
      }

      if (action === 'create') {
        const g1 = herdParentActionError(callerMeta?.orchestratedBy);
        if (g1) return err(g1);
        if (!cwd || !model) return err('create requires cwd and model.');
        if (modelIds.length > 0 && !modelIds.includes(model)) return err(`Unknown model "${model}". Available: ${modelIds.join(', ')}.`);
        let newId: string;
        try {
          const res = await fetch(`${SERVER_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd, model, description: `herd child of ${callerId.slice(0, 8)}`, kind: 'agent', ...(pluginDirectories?.length && { pluginDirectories }) }),
          });
          if (!res.ok) {
            const e = await res.json().catch(() => ({ error: res.statusText }));
            return err(`Failed to create child: ${e.error || res.statusText}`);
          }
          ({ sessionId: newId } = await res.json());
        } catch (e) {
          return err(`Failed to create child: ${e instanceof Error ? e.message : e}`);
        }
        // Stamp provenance in the SAME write as the bond: this is the one and only
        // path that creates a herd child, so it is the one and only place the
        // write-once origin can be recorded (spec-soft-archive-folder).
        updateSessionMeta(newId, meta => { meta.orchestratedBy = callerId; meta.herdOriginParent = callerId; });
        registerHerdBond(newId, callerId);
        if (prompt) {
          const d = await dispatchToChild(newId, prompt, callerId, selfCorrelation());
          if (!d.ok) return ok(`Created child ${newId.slice(0, 8)} but its first prompt failed to send: ${d.error}. Use caco_herd resume to retry.`);
        }
        return ok(`Created herd child ${newId}. It will work independently; you'll be re-woken when it needs attention (caco_herd_state to collect results).`);
      }

      const targetId = rawTarget ? stripPrefix(rawTarget) : undefined;
      if (!targetId) return err(`${action} requires a sessionId.`);
      const targetMeta = getSessionMeta(targetId);

      if (action === 'acquire') {
        const g1 = herdParentActionError(callerMeta?.orchestratedBy);
        if (g1) return err(g1);
        const ae = herdAcquireError({ callerId, targetId, targetExists: !!targetMeta, targetOrchestratedBy: targetMeta?.orchestratedBy });
        if (ae) return err(ae);
        if (sessionManager.isUnderMaintenance(targetId)) return err(`${targetId.slice(0, 8)} is being archived; try again shortly.`);
        // Re-parenting un-parks a session: clear the auto-archive tag so a reacquired
        // child is never left scheduled for archival (spec-soft-archive-folder).
        updateSessionMeta(targetId, meta => {
          meta.orchestratedBy = callerId;
          if (meta.folder === AUTO_ARCHIVE_FOLDER) { meta.folder = undefined; meta.autoArchiveTaggedAt = undefined; }
        });
        registerHerdBond(targetId, callerId);
        // Apply plugin dirs BEFORE any prompt so the child's first turn already has them.
        // Omitted => leave an already-configured session untouched; [] => explicit clear.
        if (pluginDirectories !== undefined) {
          const p = await applyPluginDirectories(SERVER_URL, targetId, pluginDirectories);
          if (!p.ok) return ok(`Acquired ${targetId.slice(0, 8)}, but setting plugin directories failed: ${p.error}. The session keeps its previous plugin configuration.`);
        }
        if (prompt) {
          const d = await dispatchToChild(targetId, prompt, callerId, selfCorrelation());
          if (!d.ok) return ok(`Acquired ${targetId.slice(0, 8)} but the prompt failed to send: ${d.error}.`);
        }
        return ok(`Acquired ${targetId.slice(0, 8)} into your herd.`);
      }

      if (action === 'resume') {
        const me = herdMemberError({ action: 'resume', callerId, targetOrchestratedBy: targetMeta?.orchestratedBy });
        if (me) return err(me);
        if (!prompt) return err('resume requires a prompt.');
        // Resuming a child IS an observation by the supervising parent: clear its
        // unobserved badge (durable lastObservedAt + broadcast), independent of
        // whether the dispatch below succeeds (spec-herd-observe-clear).
        unobservedTracker.markObserved(targetId);
        const d = await dispatchToChild(targetId, prompt, callerId, selfCorrelation());
        if (!d.ok) return err(`Failed to resume ${targetId.slice(0, 8)}: ${d.error}`);
        return ok(`Resumed child ${targetId.slice(0, 8)}.`);
      }

      // disown
      const me = herdMemberError({ action: 'disown', callerId, targetOrchestratedBy: targetMeta?.orchestratedBy });
      if (me) return err(me);
      if (sessionManager.isUnderMaintenance(targetId)) return err(`${targetId.slice(0, 8)} is being archived; try again shortly.`);
      // Park ONLY a child this herd created, in the auto-archive folder with a fresh
      // schedule anchor, so a large herd's leftovers drain themselves after the grace
      // window (spec-soft-archive-folder). The child stays a normal, fully-usable
      // session — move it out or re-acquire it to cancel; nothing is deleted for ≥24h.
      // An ACQUIRED session pre-existed the herd, so releasing it clears the bond and
      // nothing else: scheduling someone else's session for removal is not ours to do.
      // One predicate drives both the mutation and the message, so the reported
      // outcome can never disagree with what happened.
      const park = shouldParkOnDisown(targetMeta?.herdOriginParent);
      updateSessionMeta(targetId, meta => {
        meta.orchestratedBy = undefined;
        if (park) {
          meta.folder = AUTO_ARCHIVE_FOLDER;
          meta.autoArchiveTaggedAt = Date.now();
        }
      });
      clearHerdBond(targetId);
      // Retiring a child IS an observation by the parent: clear its unobserved badge
      // (durable lastObservedAt + broadcast) so a disowned child doesn't linger
      // badged in the list (spec-herd-observe-clear).
      unobservedTracker.markObserved(targetId);
      return ok(park
        ? `Disowned ${targetId.slice(0, 8)} — moved to the "${AUTO_ARCHIVE_FOLDER}" folder; it will be auto-archived after ~24h idle unless you move it out or re-acquire it.`
        // Phrased as the observable outcome, not as a claim about origin: this branch
        // is also reached for a bond with no recorded provenance, where asserting
        // "it was acquired" would be a guess stated as fact.
        : `Disowned ${targetId.slice(0, 8)} — released as-is: it keeps its folder and is not scheduled for archival.`);
    },
  });

  return [cacoHerdState, cacoHerd];
}
