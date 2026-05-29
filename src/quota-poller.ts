/**
 * Quota Poller
 *
 * In SDK 1.0+, assistant.usage no longer carries `quotaSnapshots`. We pull
 * the same data via the `account.getQuota` RPC and feed it into updateUsage,
 * which broadcasts caco.usage to the front-end (transparent-usage spec).
 *
 * Poll triggers:
 *   - on session.idle (after every turn, between LLM calls)
 *   - on session create/resume (so usage display is fresh on first open)
 *   - on a coarse interval as a safety net (10 min)
 *
 * The poll is single-flight: concurrent triggers coalesce onto the same
 * in-flight RPC promise. RPC failures are logged but not surfaced; usage
 * display tolerates stale data.
 */

import { updateUsage, getUsage, type QuotaSnapshot } from './usage-state.js';
import { broadcastGlobalEvent } from './routes/websocket.js';
import type { SessionEvent } from './routes/websocket.js';

interface QuotaClient {
  rpc: {
    account: {
      getQuota: (params: { gitHubToken?: string }) => Promise<{
        quotaSnapshots: Record<string, QuotaSnapshot | undefined>;
      }>;
    };
  };
}

let inFlight: Promise<void> | null = null;
let lastPolledAt = 0;
const SAFETY_INTERVAL_MS = 10 * 60_000;

export async function pollQuota(client: QuotaClient): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await client.rpc.account.getQuota({});
      const snapshots = result.quotaSnapshots as Record<string, QuotaSnapshot> | undefined;
      const { changed } = updateUsage(snapshots);
      lastPolledAt = Date.now();
      if (changed) {
        const usage = getUsage();
        if (usage) {
          broadcastGlobalEvent({ type: 'caco.usage', data: { ...usage } } as SessionEvent);
        }
      }
    } catch (err) {
      console.warn('[QUOTA] Poll failed:', (err as Error).message);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Poll only if the safety interval has elapsed since the last successful poll.
 * Cheap to call on every event; the rate-limit check stays in-process.
 */
export function maybePollQuota(client: QuotaClient): void {
  if (Date.now() - lastPolledAt < SAFETY_INTERVAL_MS) return;
  void pollQuota(client);
}
