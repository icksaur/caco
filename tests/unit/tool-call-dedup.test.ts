import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotSession } from '@github/copilot-sdk';
import {
  dedupeToolCalls,
  TOOL_CALL_MEMO_CAPACITY,
  _resetToolCallMemoForTests,
} from '../../src/tool-call-dedup.js';

/**
 * A sub-agent's Caco tool call ran twice. The runtime emits
 * `external_tool.requested` twice for one sub-agent call — same requestId, same
 * toolCallId, on two separate event chains — and the SDK client's
 * `_handleBroadcastEvent` runs the tool handler once per such event with no
 * dedup. Every workflow, build, and file append a sub-agent issued executed
 * twice, concurrently.
 *
 * These drive the REAL SDK dispatch path (CopilotSession._dispatchEvent), so the
 * oracle proves the fix against the code that actually double-runs, not a
 * stand-in for it.
 */

type Handler = (args: unknown, inv: { sessionId: string; toolCallId: string; toolName: string; arguments: unknown }) => unknown;

/**
 * The members of the SDK session this drives are `@internal` and absent from its
 * typings, so they are named here. They are the exact dispatch path that
 * double-runs, which is why the oracle uses them rather than a stand-in.
 */
interface SdkSessionInternals {
  registerTools(tools: unknown[]): void;
  _dispatchEvent(event: unknown): void;
  _rpc: unknown;
}
type SdkSessionCtor = new (sessionId: string, connection: unknown, workspacePath: unknown) => SdkSessionInternals;

function makeSession(sessionId = 'sess-1') {
  const session = new (CopilotSession as unknown as SdkSessionCtor)(sessionId, {}, undefined);
  const handlePendingToolCall = vi.fn().mockResolvedValue(undefined);
  session._rpc = { tools: { handlePendingToolCall } };
  return { session, handlePendingToolCall };
}

function requested(requestId: string, toolCallId: string, toolName = 'probe', eventId = 'e') {
  return {
    type: 'external_tool.requested',
    id: eventId,
    timestamp: new Date().toISOString(),
    parentId: null,
    data: { requestId, sessionId: 'sess-1', toolCallId, toolName, arguments: { n: 1 } },
  };
}

/** Let fire-and-forget handler promises and their RPC replies settle. */
const flush = () => new Promise(r => setTimeout(r, 0));

function dispatch(session: SdkSessionInternals, event: unknown): void {
  session._dispatchEvent(event);
}

beforeEach(() => { _resetToolCallMemoForTests(); });

describe('the upstream premise', () => {
  it('the SDK runs a raw handler once per duplicated request event', async () => {
    // Pins the fact the fix exists for. If a future SDK dedups on its own this
    // fails, which is the signal to re-evaluate the wrapper rather than keep it
    // on faith.
    const { session } = makeSession();
    const handler = vi.fn(async () => 'ok');
    session.registerTools([{ name: 'probe', handler }]);

    dispatch(session, requested('req-1', 'call-1', 'probe', 'a'));
    dispatch(session, requested('req-1', 'call-1', 'probe', 'b'));
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('dedupeToolCalls through the real SDK dispatch', () => {
  it('runs a tool once when its request is broadcast twice', async () => {
    const { session, handlePendingToolCall } = makeSession();
    const handler = vi.fn(async () => 'ran');
    session.registerTools(dedupeToolCalls([{ name: 'probe', handler }]));

    dispatch(session, requested('req-1', 'call-1', 'probe', 'a'));
    dispatch(session, requested('req-1', 'call-1', 'probe', 'b'));
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    // Both deliveries still get answered with the one result, so the runtime's
    // pending call resolves exactly as it would have.
    expect(handlePendingToolCall).toHaveBeenCalledTimes(2);
    for (const [arg] of handlePendingToolCall.mock.calls) {
      expect(arg).toEqual({ requestId: 'req-1', result: 'ran' });
    }
  });

  it('still runs distinct tool calls independently', async () => {
    const { session } = makeSession();
    const handler = vi.fn(async () => 'ran');
    session.registerTools(dedupeToolCalls([{ name: 'probe', handler }]));

    dispatch(session, requested('req-1', 'call-1'));
    dispatch(session, requested('req-2', 'call-2'));
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('dedupeToolCalls', () => {
  const inv = (toolCallId: string, sessionId = 'sess-1') =>
    ({ sessionId, toolCallId, toolName: 'probe', arguments: {} });

  function wrap(handler: Handler): Handler {
    const [tool] = dedupeToolCalls([{ name: 'probe', handler }] as never) as unknown as Array<{ handler: Handler }>;
    return tool.handler;
  }

  it('shares one execution between overlapping duplicates', async () => {
    let release!: (v: string) => void;
    const handler = vi.fn(() => new Promise<string>(r => { release = r; }));
    const h = wrap(handler);

    const a = h({}, inv('call-1'));
    const b = h({}, inv('call-1'));
    release('done');

    expect(await a).toBe('done');
    expect(await b).toBe('done');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not re-run a duplicate that arrives after the first settled', async () => {
    // A fast tool can finish before its duplicate is even dispatched; an
    // in-flight-only guard would run it again.
    const handler = vi.fn(async () => 'first');
    const h = wrap(handler);

    expect(await h({}, inv('call-1'))).toBe('first');
    expect(await h({}, inv('call-1'))).toBe('first');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hands a duplicate the same rejection rather than running again', async () => {
    const handler = vi.fn(async () => { throw new Error('boom'); });
    const h = wrap(handler);

    await expect(h({}, inv('call-1'))).rejects.toThrow('boom');
    await expect(h({}, inv('call-1'))).rejects.toThrow('boom');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('turns a synchronous throw into the shared rejection', async () => {
    const handler = vi.fn(() => { throw new Error('sync'); });
    const h = wrap(handler);

    await expect(h({}, inv('call-1'))).rejects.toThrow('sync');
    await expect(h({}, inv('call-1'))).rejects.toThrow('sync');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keys by session as well as tool call', async () => {
    const handler = vi.fn(async () => 'x');
    const h = wrap(handler);

    await h({}, inv('call-1', 'sess-A'));
    await h({}, inv('call-1', 'sess-B'));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('runs every call when the invocation carries no tool call id', async () => {
    const handler = vi.fn(async () => 'x');
    const h = wrap(handler);

    await h({}, inv(''));
    await h({}, inv(''));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('shares the memo across tool sets, so a resume mid-call cannot re-run it', async () => {
    // create() and resume() each build a fresh tool set; a duplicate landing on
    // the second set must still see the first set's execution.
    const handler = vi.fn(async () => 'x');
    const first = wrap(handler);
    const second = wrap(handler);

    await first({}, inv('call-1'));
    await second({}, inv('call-1'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('bounds the memo, evicting the oldest call', async () => {
    const handler = vi.fn(async () => 'x');
    const h = wrap(handler);

    await h({}, inv('call-0'));
    for (let i = 1; i <= TOOL_CALL_MEMO_CAPACITY; i++) await h({}, inv(`call-${i}`));
    expect(handler).toHaveBeenCalledTimes(TOOL_CALL_MEMO_CAPACITY + 1);

    // call-0 was the oldest entry and has been evicted, so it runs again. Each
    // step is asserted on its own: a sum over both would pass even if the NEWEST
    // entry were the one evicted.
    await h({}, inv('call-0'));
    expect(handler).toHaveBeenCalledTimes(TOOL_CALL_MEMO_CAPACITY + 2);

    // The newest entry must still be remembered.
    await h({}, inv(`call-${TOOL_CALL_MEMO_CAPACITY}`));
    expect(handler).toHaveBeenCalledTimes(TOOL_CALL_MEMO_CAPACITY + 2);
  });

  it('passes through a tool with no handler and preserves other fields', () => {
    const [bare, full] = dedupeToolCalls([
      { name: 'bare' },
      { name: 'full', description: 'd', skipPermission: true, handler: async () => 1 },
    ] as never) as unknown as Array<Record<string, unknown>>;

    expect(bare).toEqual({ name: 'bare' });
    expect(full.name).toBe('full');
    expect(full.description).toBe('d');
    expect(full.skipPermission).toBe(true);
    expect(typeof full.handler).toBe('function');
  });
});
