import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * forkSession's liveness policy around the fork guard. The runtime's fork RPC
 * replaces the parent's events.jsonl with one marker, so the parent must be
 * stopped, snapshotted, forked, and restored, all under its maintenance claim.
 *
 * The fake RPC below reproduces the observed runtime: it rewrites the parent's
 * file in place to a single fork marker. Expected bytes come from the fixture.
 */

const paths = vi.hoisted(() => ({ stateDir: '' }));

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    getState: vi.fn(() => 'connected'),
    createSession: vi.fn(async () => ({ sessionId: 'parent', disconnect: vi.fn(async () => {}) })),
    resumeSession: vi.fn(async () => ({ sessionId: 'parent', disconnect: vi.fn(async () => {}) })),
    deleteSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    rpc: {
      account: { getQuota: vi.fn(async () => ({ quotaSnapshots: {} })) },
      models: { list: vi.fn(async () => ({ models: [] })) },
      tools: { list: vi.fn(async () => ({ tools: [] })) },
      sessions: { fork: vi.fn(async (_: { sessionId: string; toEventId?: string }) => ({ sessionId: 'child' })) },
    },
  };
  return {
    fakeClient,
    CopilotClient: vi.fn(function CopilotClient() { return fakeClient; }),
    approveAll: vi.fn(),
  };
});

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    ensureSessionMeta: vi.fn((sessionId: string) => { if (!meta.has(sessionId)) meta.set(sessionId, { name: '' }); }),
    getSessionMeta: vi.fn((sessionId: string) => meta.get(sessionId)),
    setSessionMeta: vi.fn((sessionId: string, value: Record<string, unknown>) => meta.set(sessionId, value)),
    updateSessionMeta: vi.fn((sessionId: string, mutate: (m: Record<string, unknown>) => void) => {
      const value = meta.get(sessionId) ?? { name: '' };
      mutate(value);
      meta.set(sessionId, value);
      return true;
    }),
    getSessionIconPath: vi.fn(() => null),
    setSessionOrder: vi.fn(),
  };
});

const store = vi.hoisted(() => ({
  listSessionIds: vi.fn((): string[] => []),
}));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null),
  readSessionEvents: vi.fn(() => []),
  readSessionHeadResult: vi.fn(() => ({ ok: true, value: { start: { type: 'session.start' }, hasMore: true } })),
  parseSessionModel: vi.fn(() => null),
  listSessionIds: store.listSessionIds,
  get STATE_DIR() { return paths.stateDir; },
}));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => ({ sdkModel: model, cacoId: model })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));

const PARENT = 'parent';

type Internals = {
  sessionCache: Map<string, { cwd: string | null; summary: string | null }>;
  activeSessions: Map<string, unknown>;
  resumeInProgress: Map<string, Promise<unknown>>;
};

let original: Buffer;
let lastId: string;
let eventsPath: string;

function writeParentHistory(count = 12): void {
  const dir = join(paths.stateDir, PARENT);
  mkdirSync(dir, { recursive: true });
  eventsPath = join(dir, 'events.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ type: i === 0 ? 'session.start' : 'assistant.message', data: {}, id: `e${i}`, parentId: i ? `e${i - 1}` : null }));
  }
  writeFileSync(eventsPath, lines.join('\n') + '\n');
  original = readFileSync(eventsPath);
  lastId = `e${count - 1}`;
}

function marker(parentId: string): string {
  return JSON.stringify({ type: 'session.info', id: 'marker', parentId, data: { infoType: 'fork' } });
}

/** The observed runtime: rewrite the parent to its fork marker alone. */
function truncateParentOnFork(): void {
  sdk.fakeClient.rpc.sessions.fork.mockImplementation(async () => {
    writeFileSync(eventsPath, marker(lastId) + '\n');
    return { sessionId: 'child' };
  });
}

async function newManager() {
  const { SessionManager } = await import('../../src/session-manager.js');
  return new SessionManager();
}

/** A known, not-loaded parent with history on disk. */
async function idleParent() {
  const manager = await newManager();
  (manager as unknown as Internals).sessionCache.set(PARENT, { cwd: process.cwd(), summary: null });
  writeParentHistory();
  return manager;
}

/** A parent loaded in the runtime, whose disconnect runs `onDisconnect`. */
async function loadedParent(onDisconnect: () => Promise<void> = async () => {}) {
  const manager = await newManager();
  sdk.fakeClient.createSession.mockResolvedValueOnce({ sessionId: PARENT, disconnect: vi.fn(onDisconnect) });
  const id = await (manager as unknown as { create: (cwd: string, o: unknown) => Promise<string> })
    .create(process.cwd(), { model: 'test-model', toolFactory: () => [] });
  expect(id).toBe(PARENT);
  writeParentHistory();
  return manager;
}

async function refusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  const { ForkRefusedError } = await import('../../src/session-manager.js');
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForkRefusedError) return error.reason;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.meta.clear();
  paths.stateDir = mkdtempSync(join(tmpdir(), 'fork-guard-sm-'));
  sdk.fakeClient.ping.mockResolvedValue({ message: 'ok', timestamp: new Date(0).toISOString() });
  sdk.fakeClient.rpc.sessions.fork.mockImplementation(async () => ({ sessionId: 'child' }));
  store.listSessionIds.mockReturnValue([]);
});

afterEach(async () => {
  const { dispatchState } = await import('../../src/dispatch-state.js');
  dispatchState.end(PARENT);
  rmSync(paths.stateDir, { recursive: true, force: true });
});

describe('forkSession refuses what it cannot fork safely', () => {
  it('refuses a busy parent', async () => {
    const manager = await idleParent();
    const { dispatchState } = await import('../../src/dispatch-state.js');
    dispatchState.start(PARENT, 'corr');

    expect(await refusalOf(manager.forkSession(PARENT))).toBe('busy');
    expect(sdk.fakeClient.rpc.sessions.fork).not.toHaveBeenCalled();
  });

  it('refuses while a resume of the parent is in flight', async () => {
    const manager = await idleParent();
    (manager as unknown as Internals).resumeInProgress.set(PARENT, new Promise(() => {}));

    expect(await refusalOf(manager.forkSession(PARENT))).toBe('resuming');
    expect(sdk.fakeClient.rpc.sessions.fork).not.toHaveBeenCalled();
  });

  it('refuses a parent already under maintenance', async () => {
    const manager = await idleParent();
    let release!: () => void;
    const held = manager.runExclusiveMaintenance(PARENT, () => new Promise<void>(r => { release = r; }));

    expect(await refusalOf(manager.forkSession(PARENT))).toBe('maintenance');
    expect(sdk.fakeClient.rpc.sessions.fork).not.toHaveBeenCalled();
    release();
    await held;
  });

  it('refuses a never-messaged parent', async () => {
    // With no events.jsonl there is nothing to inherit, and the runtime would
    // leave a marker-only file that can no longer be recreated as empty.
    const manager = await newManager();
    (manager as unknown as Internals).sessionCache.set(PARENT, { cwd: process.cwd(), summary: null });

    expect(await refusalOf(manager.forkSession(PARENT))).toBe('empty');
    expect(sdk.fakeClient.rpc.sessions.fork).not.toHaveBeenCalled();
  });

  it('refuses when the parent cannot be torn down', async () => {
    const manager = await loadedParent(async () => { throw new Error('destroy failed'); });

    expect(await refusalOf(manager.forkSession(PARENT))).toBe('teardown-failed');
    expect(sdk.fakeClient.rpc.sessions.fork).not.toHaveBeenCalled();
  });
});

describe('forkSession guards the parent', () => {
  it('restores an idle parent the runtime truncated', async () => {
    const manager = await idleParent();
    truncateParentOnFork();

    const result = await manager.forkSession(PARENT);

    expect(result.sessionId).toBe('child');
    expect(readFileSync(eventsPath).equals(original)).toBe(true);
  });

  it('passes toEventId through unchanged', async () => {
    const manager = await idleParent();
    await manager.forkSession(PARENT, 'e5');
    expect(sdk.fakeClient.rpc.sessions.fork).toHaveBeenCalledWith({ sessionId: PARENT, toEventId: 'e5' });
  });

  it('disconnects a loaded parent before the fork runs', async () => {
    const order: string[] = [];
    const manager = await loadedParent(async () => { order.push('disconnect'); });
    sdk.fakeClient.rpc.sessions.fork.mockImplementation(async () => {
      order.push('fork');
      return { sessionId: 'child' };
    });

    await manager.forkSession(PARENT);

    expect(order).toEqual(['disconnect', 'fork']);
    expect((manager as unknown as Internals).activeSessions.has(PARENT)).toBe(false);
  });

  it('snapshots after the stop, so an event its disconnect writes survives', async () => {
    // A snapshot taken before the stop would miss this line, and a restore
    // would silently drop it.
    const shutdown = JSON.stringify({ type: 'session.shutdown', id: 'shutdown', parentId: 'e11', data: {} });
    const manager = await loadedParent(async () => { appendFileSync(eventsPath, shutdown + '\n'); });
    sdk.fakeClient.rpc.sessions.fork.mockImplementation(async () => {
      writeFileSync(eventsPath, marker('shutdown') + '\n');
      return { sessionId: 'child' };
    });

    await manager.forkSession(PARENT);

    const expected = Buffer.concat([original, Buffer.from(shutdown + '\n')]);
    expect(readFileSync(eventsPath).equals(expected)).toBe(true);
  });

  it('lets the parent resume after a guarded fork', async () => {
    const manager = await loadedParent();
    truncateParentOnFork();
    await manager.forkSession(PARENT);

    await (manager as unknown as { resume: (id: string, o: unknown) => Promise<unknown> })
      .resume(PARENT, { toolFactory: () => [] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalled();
    expect((manager as unknown as Internals).activeSessions.has(PARENT)).toBe(true);
  });
});

describe('maintenance teardown ends only a dispatch it owned', () => {
  it('leaves a dispatch that started during the disconnect busy', async () => {
    let finishDisconnect!: () => void;
    const manager = await loadedParent(() => new Promise<void>(r => { finishDisconnect = r; }));
    const { dispatchState } = await import('../../src/dispatch-state.js');

    const stopping = manager.stopIfIdle(PARENT);
    // A dispatch arrives while the disconnect is in flight. It must survive the
    // teardown: it is the one now waiting to resume the parent.
    dispatchState.start(PARENT, 'late-dispatch');
    finishDisconnect();
    await stopping;

    expect(dispatchState.isBusy(PARENT)).toBe(true);
  });
});

describe('crash recovery runs at discovery and resume', () => {
  function leaveCrashedFork(): void {
    writeParentHistory();
    copyFileSync(eventsPath, eventsPath + '.prefork');
    writeFileSync(eventsPath, marker(lastId) + '\n');
  }

  it('restores a parent a crash left truncated, on discovery', async () => {
    leaveCrashedFork();
    store.listSessionIds.mockReturnValue([PARENT]);
    const manager = await newManager();

    manager.refreshCache();

    expect(readFileSync(eventsPath).equals(original)).toBe(true);
    expect(existsSync(eventsPath + '.prefork')).toBe(false);
  });

  it('restores a parent a crash left truncated, before resuming it', async () => {
    leaveCrashedFork();
    const manager = await newManager();
    (manager as unknown as Internals).sessionCache.set(PARENT, { cwd: process.cwd(), summary: null });
    let seenAtResume: Buffer | undefined;
    sdk.fakeClient.resumeSession.mockImplementationOnce(async () => {
      seenAtResume = readFileSync(eventsPath);
      return { sessionId: PARENT, disconnect: vi.fn(async () => {}) };
    });

    await (manager as unknown as { resume: (id: string, o: unknown) => Promise<unknown> })
      .resume(PARENT, { toolFactory: () => [] });

    expect(seenAtResume?.equals(original)).toBe(true);
  });

  it('keeps a session whose recovery failed resumable, so the resume can retry it', async () => {
    // Force the restore to fail: a directory where events.jsonl should be.
    writeParentHistory();
    copyFileSync(eventsPath, eventsPath + '.prefork');
    rmSync(eventsPath);
    mkdirSync(join(eventsPath, 'blocker'), { recursive: true });
    store.listSessionIds.mockReturnValue([PARENT]);
    const { readSessionWorkspace } = await import('../../src/sdk-session-store.js');
    vi.mocked(readSessionWorkspace).mockImplementation(() => ({ cwd: process.cwd() }));
    try {
      const manager = await newManager();
      manager.refreshCache();

      // Registered from the workspace, not dropped for having no usable head.
      expect((manager as unknown as Internals).sessionCache.get(PARENT)?.cwd).toBe(process.cwd());
      expect(existsSync(eventsPath + '.prefork')).toBe(true);

      // Once the obstruction is gone, resuming completes the recovery.
      rmSync(eventsPath, { recursive: true, force: true });
      let seenAtResume: Buffer | undefined;
      sdk.fakeClient.resumeSession.mockImplementationOnce(async () => {
        seenAtResume = readFileSync(eventsPath);
        return { sessionId: PARENT, disconnect: vi.fn(async () => {}) };
      });
      await (manager as unknown as { resume: (id: string, o: unknown) => Promise<unknown> })
        .resume(PARENT, { toolFactory: () => [] });
      expect(seenAtResume?.equals(original)).toBe(true);
    } finally {
      vi.mocked(readSessionWorkspace).mockImplementation(() => null);
    }
  });
});

describe('discovery leaves a session under maintenance to its claim holder', () => {
  it('does not disturb a fork in flight', async () => {
    // An import re-scans discovery while the fork RPC is in flight. If
    // discovery reconciled the parent, it would find it still intact, delete
    // the snapshot, and the truncation that follows would go unrestored.
    const manager = await idleParent();
    store.listSessionIds.mockReturnValue([PARENT]);
    sdk.fakeClient.rpc.sessions.fork.mockImplementation(async () => {
      manager.refreshCache();
      writeFileSync(eventsPath, marker(lastId) + '\n');
      return { sessionId: 'child' };
    });

    await manager.forkSession(PARENT);

    expect(readFileSync(eventsPath).equals(original)).toBe(true);
    // Nor did it rebuild the parent's record from a file mid-change.
    expect((manager as unknown as Internals).sessionCache.get(PARENT)?.cwd).toBe(process.cwd());
  });
});
