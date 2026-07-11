/**
 * quota-poller tests — deps (usage-state, event-bus) are mocked so the poller's
 * own control flow is the unit under test; modules are reset per test to clear
 * the module-level `inFlight` / `lastPolledAt` singletons.
 *
 * Oracles (properties): single-flight (concurrent triggers share ONE RPC),
 * broadcast-iff-changed, error is swallowed AND clears in-flight, and
 * maybePollQuota honors the safety interval.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateUsage: vi.fn(),
  getUsage: vi.fn(),
  broadcastGlobalEvent: vi.fn(),
}));

vi.mock('../../src/usage-state.js', () => ({
  updateUsage: mocks.updateUsage,
  getUsage: mocks.getUsage,
}));
vi.mock('../../src/event-bus.js', () => ({
  broadcastGlobalEvent: mocks.broadcastGlobalEvent,
}));

const snapResult = { quotaSnapshots: { main: { remainingPercentage: 90 } } };

type TestClient = { rpc: { account: { getQuota: ReturnType<typeof vi.fn> } } };

function makeClient(getQuota: () => Promise<unknown>): TestClient {
  return { rpc: { account: { getQuota: vi.fn(getQuota) } } };
}

async function load(): Promise<{
  pollQuota: (client: TestClient) => Promise<void>;
  maybePollQuota: (client: TestClient) => void;
}> {
  vi.resetModules();
  return import('../../src/quota-poller.js') as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateUsage.mockReturnValue({ changed: true });
  mocks.getUsage.mockReturnValue({ remainingPercentage: 90 });
});

describe('pollQuota', () => {
  it('fetches, feeds updateUsage, and broadcasts when usage changed', async () => {
    const { pollQuota } = await load();
    const client = makeClient(async () => snapResult);
    await pollQuota(client);
    expect(mocks.updateUsage).toHaveBeenCalledWith(snapResult.quotaSnapshots);
    expect(mocks.broadcastGlobalEvent).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastGlobalEvent.mock.calls[0][0]).toMatchObject({ type: 'caco.usage' });
  });

  it('does not broadcast when usage is unchanged', async () => {
    mocks.updateUsage.mockReturnValue({ changed: false });
    const { pollQuota } = await load();
    await pollQuota(makeClient(async () => snapResult));
    expect(mocks.broadcastGlobalEvent).not.toHaveBeenCalled();
  });

  it('is single-flight: concurrent triggers share one RPC', async () => {
    const { pollQuota } = await load();
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    const client = makeClient(async () => { await gate; return snapResult; });

    const a = pollQuota(client);
    const b = pollQuota(client);
    release(null);
    await Promise.all([a, b]);

    expect(client.rpc.account.getQuota).toHaveBeenCalledTimes(1);
    expect(mocks.updateUsage).toHaveBeenCalledTimes(1);
  });

  it('swallows RPC errors and clears in-flight so the next poll retries', async () => {
    const { pollQuota } = await load();
    const failing = makeClient(async () => { throw new Error('boom'); });
    await expect(pollQuota(failing)).resolves.toBeUndefined();
    expect(mocks.broadcastGlobalEvent).not.toHaveBeenCalled();

    const ok = makeClient(async () => snapResult);
    await pollQuota(ok);
    expect(ok.rpc.account.getQuota).toHaveBeenCalledTimes(1);
  });
});

describe('maybePollQuota', () => {
  it('polls when cold, then skips within the safety interval', async () => {
    const { maybePollQuota } = await load();
    const client = makeClient(async () => snapResult);

    maybePollQuota(client);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.rpc.account.getQuota).toHaveBeenCalledTimes(1);

    maybePollQuota(client);
    await new Promise((r) => setTimeout(r, 0));
    expect(client.rpc.account.getQuota).toHaveBeenCalledTimes(1);
  });
});
