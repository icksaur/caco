/**
 * Tests for the dispatch-teardown owner in src/routes/session-messages.ts.
 *
 * Focus: the `!session` early-return path must route through completeDispatch
 * so temp attachments are unlinked and busy=false is broadcast — the leak this
 * refactor fixes. Heavy collaborators are module-mocked; fs is real so we can
 * assert the temp files were actually deleted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const sm = vi.hoisted(() => ({
  isBusy: vi.fn(() => false),
  startDispatch: vi.fn(),
  endDispatch: vi.fn(),
  isActive: vi.fn(() => true),
  ensureClientHealthy: vi.fn(async () => {}),
  getSession: vi.fn((): unknown => null),
  resume: vi.fn(async () => {}),
  pollQuota: vi.fn(async () => {}),
  getModels: vi.fn((): unknown[] => []),
  // Idle authority (spec-idle-authority): no reveal in these tests ⇒ real idle.
  getPendingTools: vi.fn(() => [] as string[]),
  hasPendingAutoContinue: vi.fn(() => false),
  resetAutoContinue: vi.fn(),
  getCacoToolCatalog: vi.fn(() => [] as { name: string }[]),
}));

const broadcastGlobalEvent = vi.hoisted(() => vi.fn());
const broadcastEvent = vi.hoisted(() => vi.fn());

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm, setAutoContinuePrefProvider: vi.fn() }));
vi.mock('../../src/session-state.js', () => ({
  sessionState: { getSessionConfig: vi.fn(() => ({})) },
}));
vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: (...args: unknown[]) => broadcastGlobalEvent(...(args as [never])),
  broadcastEvent: (...args: unknown[]) => broadcastEvent(...(args as [never])),
}));
vi.mock('../../src/session-throughput.js', () => ({
  resetRequest: vi.fn(),
  snapshot: vi.fn(() => ({})),
  markRequestComplete: vi.fn(() => null),
}));

import { dispatchMessage } from '../../src/routes/session-messages.js';

const SID = 'session-1';

async function makeTempFile(): Promise<string> {
  const p = join(tmpdir(), `caco-test-${randomUUID()}.png`);
  await writeFile(p, 'x');
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  sm.isBusy.mockReturnValue(false);
  sm.isActive.mockReturnValue(true);
  sm.getSession.mockReturnValue(null);
});

describe('dispatchMessage !session teardown owner', () => {
  it('unlinks temp attachments and broadcasts busy=false when no session', async () => {
    const tempFilePaths = [await makeTempFile(), await makeTempFile()];
    const onEvent = vi.fn();

    await dispatchMessage(SID, 'hi', { tempFilePaths }, { onEvent });

    for (const p of tempFilePaths) {
      expect(await exists(p)).toBe(false);
    }

    const busyEvents = broadcastGlobalEvent.mock.calls
      .map(c => c[0] as { type: string; data?: { isBusy?: boolean } })
      .filter(e => e.type === 'session.busy');
    expect(busyEvents.some(e => e.data?.isBusy === false)).toBe(true);
    expect(busyEvents.some(e => e.data?.isBusy === true)).toBe(false);

    expect(sm.endDispatch).toHaveBeenCalledTimes(1);
    expect(sm.endDispatch).toHaveBeenCalledWith(SID);

    const errorEvents = onEvent.mock.calls
      .map(c => c[0] as { type: string; data?: { message?: string } })
      .filter(e => e.type === 'session.error');
    expect(errorEvents.some(e => e.data?.message === 'No active session')).toBe(true);
  });
});
