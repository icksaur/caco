import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import {
  acquireServerLock,
  markServerReady,
  releaseServerLock,
  formatLockRefusal,
  ServerLockHeldError,
  LOCK_PARSE_GRACE_MS,
  RECLAIM_SUFFIX,
  type LockDeps,
} from '../../src/server-lock.js';

/**
 * One Caco process may own the shared SDK session state. A second instance
 * running discovery's file repair, the scheduler, or the rotation sweeper
 * against sessions the first one owns corrupts them, so a process that cannot
 * take the lock must not initialize at all.
 *
 * Process facts (liveness, command line) are injected, so each classification
 * is driven explicitly. One Linux test uses a real unrelated process to pin the
 * pid-reuse rule against the real /proc reader.
 */

const SELF = 4242;
const OTHER = 5151;

let dir: string;
let path: string;

function deps(over: Partial<LockDeps> = {}): Partial<LockDeps> {
  return {
    path,
    pid: SELF,
    isAlive: () => false,
    commandLine: () => null,
    sleep: async () => {},
    now: () => Date.now(),
    ...over,
  };
}

function holder(record: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(record));
}

function readLock(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'server-lock-'));
  path = join(dir, 'caco-server.lock');
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('acquireServerLock', () => {
  it('takes a free lock as starting, naming this process', async () => {
    await acquireServerLock({}, deps());
    expect(readLock()).toMatchObject({ pid: SELF, state: 'starting', url: null });
  });

  it('refuses while another live Caco holds it, and reports where it runs', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: 'http://127.0.0.1:53000', port: 53000 });

    const error = await acquireServerLock({}, deps({
      isAlive: pid => pid === OTHER,
      commandLine: () => 'node --import tsx server.ts',
    })).catch(e => e);

    expect(error).toBeInstanceOf(ServerLockHeldError);
    expect(error.holder).toMatchObject({ pid: OTHER, url: 'http://127.0.0.1:53000' });
    expect(error.lockPath).toBe(path);
    // The holder's lock is left exactly as it was.
    expect(readLock()).toMatchObject({ pid: OTHER });
  });

  it('treats a live holder as running when its command line is unknown', async () => {
    // Windows offers no cheap command line, so a live pid must count as held:
    // reclaiming a busy Caco would start a second writer.
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });

    await expect(acquireServerLock({}, deps({ isAlive: () => true, commandLine: () => null })))
      .rejects.toBeInstanceOf(ServerLockHeldError);
  });

  it('reclaims a lock whose holder has exited', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: 'http://127.0.0.1:53000' });

    await acquireServerLock({}, deps({ isAlive: () => false }));

    expect(readLock()).toMatchObject({ pid: SELF, state: 'starting' });
  });

  it('reclaims a lock whose live pid is no longer a Caco server', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });

    await acquireServerLock({}, deps({ isAlive: () => true, commandLine: () => '/usr/bin/sleep 30' }));

    expect(readLock()).toMatchObject({ pid: SELF });
  });

  it('treats a young unreadable lock as a holder mid-write', async () => {
    writeFileSync(path, '{"pid":');

    await expect(acquireServerLock({}, deps())).rejects.toBeInstanceOf(ServerLockHeldError);
    expect(readFileSync(path, 'utf8')).toBe('{"pid":');
  });

  it('reclaims an old unreadable lock', async () => {
    writeFileSync(path, '{"pid":');
    const old = (Date.now() - LOCK_PARSE_GRACE_MS * 2) / 1000;
    utimesSync(path, old, old);

    await acquireServerLock({}, deps());

    expect(readLock()).toMatchObject({ pid: SELF });
  });

  it('waits for a restarting parent to exit, then takes over', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: 'http://127.0.0.1:53000' });
    let checks = 0;
    // The parent is alive for the first few checks, then gone.
    const isAlive = (pid: number) => pid === OTHER && checks++ < 3;

    await acquireServerLock({ handoffParentPid: OTHER }, deps({
      isAlive,
      commandLine: () => 'node server.ts',
    }));

    expect(readLock()).toMatchObject({ pid: SELF });
    expect(checks).toBeGreaterThan(1);
  });

  it('refuses when a restarting parent never exits', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: 'http://127.0.0.1:53000' });
    let clock = Date.now();

    await expect(acquireServerLock({ handoffParentPid: OTHER }, deps({
      isAlive: () => true,
      commandLine: () => 'node server.ts',
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    }))).rejects.toBeInstanceOf(ServerLockHeldError);
  });

  it('does not wait on a live holder that is not the restarting parent', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });
    let slept = false;

    await expect(acquireServerLock({ handoffParentPid: 9999 }, deps({
      isAlive: () => true,
      commandLine: () => 'node server.ts',
      sleep: async () => { slept = true; },
    }))).rejects.toBeInstanceOf(ServerLockHeldError);
    expect(slept).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('liveness of a process owned by another user', () => {
  it('counts a process it may not signal as alive, not as gone', async () => {
    // pid 1 belongs to root, so signalling it as an ordinary user fails with
    // EPERM. That means "exists", and a lock naming it must not be reclaimed.
    // With the command line unknown, liveness alone decides.
    let code: string | undefined;
    try { process.kill(1, 0); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
    expect(code, 'precondition: signalling pid 1 must fail with EPERM here').toBe('EPERM');

    holder({ pid: 1, startedAt: new Date().toISOString(), state: 'ready', url: null });

    await expect(acquireServerLock({}, { path, pid: SELF, commandLine: () => null }))
      .rejects.toBeInstanceOf(ServerLockHeldError);
  });
});

describe('reclaiming a stale lock', () => {
  // Deleting a stale lock is serialized through a second exclusive file. Without
  // it, two starters can both judge the lock stale, one replaces it with its own
  // live lock, and the other then deletes that, so both believe they own it.

  it('leaves a stale lock alone while another process is reclaiming it', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });
    writeFileSync(path + RECLAIM_SUFFIX, JSON.stringify({ pid: 6262 }));

    await expect(acquireServerLock({}, deps({ isAlive: pid => pid === 6262 })))
      .rejects.toBeInstanceOf(ServerLockHeldError);
    expect(readLock()).toMatchObject({ pid: OTHER });
    // The other reclaimer's claim is not this process's to remove.
    expect(existsSync(path + RECLAIM_SUFFIX)).toBe(true);
  });

  it('clears a reclaim left by a process that died mid-reclaim, then takes the lock', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });
    writeFileSync(path + RECLAIM_SUFFIX, JSON.stringify({ pid: 6262 }));

    await acquireServerLock({}, deps({ isAlive: () => false }));

    expect(readLock()).toMatchObject({ pid: SELF });
    expect(existsSync(path + RECLAIM_SUFFIX)).toBe(false);
  });

  it('releases its reclaim claim after taking a stale lock', async () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'ready', url: null });

    await acquireServerLock({}, deps({ isAlive: () => false }));

    expect(readLock()).toMatchObject({ pid: SELF });
    expect(existsSync(path + RECLAIM_SUFFIX)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('pid reuse on Linux, against the real /proc', () => {
  let child: ChildProcess;

  afterEach(() => { child?.kill(); });

  it('reclaims a lock whose pid now belongs to an unrelated live process', async () => {
    child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise(r => child.once('spawn', r));
    holder({ pid: child.pid, startedAt: new Date().toISOString(), state: 'ready', url: null });

    // Real liveness and real command line: only the path and our pid are faked.
    await acquireServerLock({}, { path, pid: SELF });

    expect(readLock()).toMatchObject({ pid: SELF });
  });
});

describe('formatLockRefusal', () => {
  it('sends the user to the running instance, and says how to clear a stale lock', () => {
    const text = formatLockRefusal(new ServerLockHeldError(
      { pid: OTHER, startedAt: '', state: 'ready', url: 'http://127.0.0.1:53000', port: 53000 }, '/home/u/.copilot/caco-server.lock'));

    expect(text).toContain('http://127.0.0.1:53000');
    expect(text).toContain(String(OTHER));
    expect(text).toContain('/home/u/.copilot/caco-server.lock');
  });

  it('describes a holder that is still starting', () => {
    const text = formatLockRefusal(new ServerLockHeldError(
      { pid: OTHER, startedAt: '', state: 'starting', url: null }, '/l'));
    expect(text).toMatch(/starting/i);
  });
});

describe('markServerReady and releaseServerLock', () => {
  it('records the bound url and port', async () => {
    await acquireServerLock({}, deps());
    markServerReady('http://127.0.0.1:53001', 53001, deps());

    expect(readLock()).toMatchObject({ pid: SELF, state: 'ready', url: 'http://127.0.0.1:53001', port: 53001 });
  });

  it('releases its own lock', async () => {
    await acquireServerLock({}, deps());
    releaseServerLock(deps());
    expect(existsSync(path)).toBe(false);
  });

  it('never removes or rewrites a lock another process now holds', () => {
    holder({ pid: OTHER, startedAt: new Date().toISOString(), state: 'starting', url: null });

    releaseServerLock(deps());
    markServerReady('http://127.0.0.1:53001', 53001, deps());

    expect(readLock()).toMatchObject({ pid: OTHER, state: 'starting', url: null });
  });
});
