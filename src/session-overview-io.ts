/**
 * Read-only collector for the session overview (spec-session-overview, Layer 1).
 *
 * Gathers meta, workspace, dispatch/busy state, pending retries, schedules and
 * the bounded transcript tail for every known session. It performs NO writes:
 * no meta write, no activityVersion bump, no unobserved change, no SDK call,
 * no dispatch, no resume, no history rotation. An ESLint rule on this file and
 * the route enforces the import side of that (O10); the route test snapshots
 * state around a call (O4).
 */

import type { SessionMeta } from './session-meta-store.js';
import { readSessionMeta } from './session-meta-store.js';
import { readSessionWorkspace } from './sdk-session-store.js';
import { readSessionTails, type TailResult } from './sdk-session-tail.js';
import { dispatchState } from './dispatch-state.js';
import { sessionManager } from './session-manager.js';
import { getCurrentIntent } from './intent-runtime.js';
import { pendingTransientRetryAttempt } from './transient-retry.js';
import { listSchedules, loadDefinition, loadLastRun } from './schedule-store.js';
import { disabledToolNames } from './tool-registry.js';
import { getInstanceIdentity } from './instance-identity.js';
import { AUTO_ARCHIVE_FOLDER, WAKE_EXPIRE_MS } from './config.js';
import type { OverviewInputs, OverviewSessionInput } from './session-overview.js';

export type OverviewContextMode = 'brief' | 'full' | 'none';

/** Everything the collector reads, injectable for tests. Every member is a read. */
export interface OverviewSources {
  instance(): { id: string; name: string };
  archiveFolder: string;
  /** The wake expiry window, for `wake.nextIsFinal`. */
  wakeExpireMs?: number;
  listSessions(): Array<{ sessionId: string; cwd: string | null }>;
  readMeta(sessionId: string): SessionMeta | null;
  readWorkspace(sessionId: string): { summary?: string; updatedAt?: string } | null;
  /** Epoch ms the active turn started, or null when idle. */
  busySince(sessionId: string): number | null;
  pendingTools(sessionId: string): number;
  currentIntent(sessionId: string, meta: SessionMeta | null): string | undefined;
  retryAttempt(sessionId: string): number | undefined;
  schedulesBySession(): Promise<Map<string, NonNullable<OverviewSessionInput['schedule']>>>;
  readTails(items: Array<{ sessionId: string; busy: boolean }>): Promise<Map<string, TailResult>>;
  wakeLoopEnabled(): boolean;
}

async function schedulesBySession(): Promise<Map<string, NonNullable<OverviewSessionInput['schedule']>>> {
  const out = new Map<string, NonNullable<OverviewSessionInput['schedule']>>();
  for (const slug of await listSchedules()) {
    const [def, last] = await Promise.all([loadDefinition(slug), loadLastRun(slug)]);
    if (!def || !last?.sessionId) continue;
    const s: NonNullable<OverviewSessionInput['schedule']> = { slug, enabled: def.enabled, nextRun: last.nextRun || null };
    if (last.lastResult) s.lastResult = last.lastResult;
    out.set(last.sessionId, s);
  }
  return out;
}

/** The production sources. */
export function realOverviewSources(): OverviewSources {
  return {
    instance: () => getInstanceIdentity(),
    archiveFolder: AUTO_ARCHIVE_FOLDER,
    wakeExpireMs: WAKE_EXPIRE_MS,
    listSessions: () => sessionManager.listForPager().map(p => ({ sessionId: p.sessionId, cwd: p.cwd })),
    readMeta: id => {
      const r = readSessionMeta(id);
      return r.ok ? r.value : null;
    },
    readWorkspace: id => readSessionWorkspace(id),
    busySince: id => (sessionManager.isBusy(id) ? (dispatchState.getDispatch(id)?.startedAt ?? Date.now()) : null),
    pendingTools: id => sessionManager.getPendingTools(id).length,
    currentIntent: (id, meta) => getCurrentIntent(id, meta ?? undefined) || undefined,
    retryAttempt: id => pendingTransientRetryAttempt(id),
    schedulesBySession,
    readTails: items => readSessionTails(items),
    wakeLoopEnabled: () => !disabledToolNames().has('caco_wake'),
  };
}

/** Gather the classifier's inputs. Archived sessions are listed (for counts and
 *  herd parent state) but their tails are not read. */
export async function collectOverviewInputs(src: OverviewSources, opts: { context?: OverviewContextMode } = {}): Promise<OverviewInputs> {
  const context = opts.context ?? 'brief';
  const sessions: OverviewSessionInput[] = [];
  for (const { sessionId, cwd } of src.listSessions()) {
    const meta = src.readMeta(sessionId);
    const busySince = src.busySince(sessionId);
    const s: OverviewSessionInput = { sessionId, cwd, meta, workspace: src.readWorkspace(sessionId), busySince };
    if (busySince !== null) {
      s.pendingTools = src.pendingTools(sessionId);
      const intent = src.currentIntent(sessionId, meta);
      if (intent) s.currentIntent = intent;
    }
    const attempt = src.retryAttempt(sessionId);
    if (attempt !== undefined) s.retryAttempt = attempt;
    sessions.push(s);
  }
  const schedules = await src.schedulesBySession();
  for (const s of sessions) {
    const sch = schedules.get(s.sessionId);
    if (sch) s.schedule = sch;
  }
  if (context !== 'none') {
    const live = sessions.filter(s => s.meta?.folder !== src.archiveFolder);
    const tails = await src.readTails(live.map(s => ({ sessionId: s.sessionId, busy: s.busySince !== null })));
    for (const s of live) {
      const t = tails.get(s.sessionId);
      if (t) s.tail = t;
    }
  }
  const inputs: OverviewInputs = {
    instance: src.instance(),
    sessions,
    archiveFolder: src.archiveFolder,
    wakeLoopEnabled: src.wakeLoopEnabled(),
    contextRead: context !== 'none',
  };
  if (src.wakeExpireMs !== undefined) inputs.wakeExpireMs = src.wakeExpireMs;
  return inputs;
}
