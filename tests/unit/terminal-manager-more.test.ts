import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

type DataHandler = (data: string) => void;
type ExitHandler = (exit: { exitCode: number; signal?: number }) => void;

class FakePty {
  readonly writes: Array<string | Buffer> = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly dataHandlers: DataHandler[] = [];
  readonly exitHandlers: ExitHandler[] = [];
  killed = false;

  onData(handler: DataHandler): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: ExitHandler): void {
    this.exitHandlers.push(handler);
  }

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const handler of this.exitHandlers) handler({ exitCode, signal });
  }
}

const terminalMocks = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  spawn: vi.fn((_file: string, _args: string[]) => {
    const pty = new FakePty();
    terminalMocks.ptys.push(pty);
    return pty;
  }),
  sessionManager: { getSessionCwd: vi.fn() },
  sessionState: { onSessionEnd: vi.fn() },
  eventBus: { broadcastEvent: vi.fn() },
}));

vi.mock('node-pty', () => ({ spawn: terminalMocks.spawn }));
vi.mock('../../src/session-manager.js', () => ({ sessionManager: terminalMocks.sessionManager }));
vi.mock('../../src/session-state.js', () => ({ sessionState: terminalMocks.sessionState }));
vi.mock('../../src/event-bus.js', () => terminalMocks.eventBus);

const scratchRoots: string[] = [];

function scratchDir(name: string): string {
  const dir = join(process.cwd(), '.caco', 'test-work', `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  scratchRoots.push(dir);
  return dir;
}

async function importTerminalManager(): Promise<typeof import('../../src/terminal-manager.js')> {
  vi.resetModules();
  terminalMocks.ptys.length = 0;
  terminalMocks.spawn.mockClear();
  terminalMocks.sessionManager.getSessionCwd.mockReset();
  terminalMocks.sessionState.onSessionEnd.mockClear();
  terminalMocks.eventBus.broadcastEvent.mockClear();
  return import('../../src/terminal-manager.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const pty of terminalMocks.ptys) {
    pty.kill();
  }
  terminalMocks.ptys.length = 0;
  for (const dir of scratchRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureTerminal lifecycle', () => {
  it('does not spawn for passive attaches and reports missing cwd on active attaches', async () => {
    const manager = await importTerminalManager();
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(undefined);

    expect(manager.ensureTerminal('s1', 80, 24, false)).toEqual({ idle: true });
    expect(manager.ensureTerminal('s1', 80, 24, true)).toEqual({ error: 'no working directory for session' });
    expect(terminalMocks.spawn).not.toHaveBeenCalled();
    expect(manager.terminalCount()).toBe(0);
  });

  it('spawns a clamped pty in the session cwd and reuses it on later attaches', async () => {
    const manager = await importTerminalManager();
    const cwd = scratchDir('terminal-spawn');
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(cwd);

    expect(manager.ensureTerminal('s1', 2000, 0, true)).toEqual({ ring: '' });
    expect(terminalMocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      cols: 1000,
      rows: 1,
      cwd,
      name: 'xterm-256color',
    }));
    expect(manager.terminalCount()).toBe(1);

    terminalMocks.ptys[0].emitData('hello');
    await vi.waitFor(() => expect(terminalMocks.eventBus.broadcastEvent).toHaveBeenCalledWith(
      's1',
      { type: 'caco.term.output', data: { data: 'hello' } },
    ));

    expect(manager.ensureTerminal('s1', 120, 40, true)).toEqual({ ring: 'hello' });
    expect(terminalMocks.ptys[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
    expect(terminalMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('writes, resizes, detaches, and kills the tracked pty', async () => {
    const manager = await importTerminalManager();
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(scratchDir('terminal-io'));
    manager.ensureTerminal('s1', 80, 24, true);
    const pty = terminalMocks.ptys[0];

    manager.writeTerminalInput('s1', 'ls\r');
    manager.writeTerminalInput('s1', '\x1b[?1;2c', true);
    manager.resizeTerminal('s1', Number.NaN, Number.POSITIVE_INFINITY);
    manager.detachTerminal('s1');

    expect(pty.writes[0]).toBe('ls\r');
    expect(Buffer.isBuffer(pty.writes[1])).toBe(true);
    expect((pty.writes[1] as Buffer).toString('binary')).toBe('\x1b[?1;2c');
    expect(pty.resizes.at(-1)).toEqual({ cols: 80, rows: 24 });
    expect(pty.killed).toBe(false);

    manager.killTerminal('s1');
    expect(pty.killed).toBe(true);
    expect(manager.terminalCount()).toBe(0);
  });

  it('flushes pending output and removes terminals on pty exit', async () => {
    const manager = await importTerminalManager();
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(scratchDir('terminal-exit'));
    manager.ensureTerminal('s1', 80, 24, true);

    terminalMocks.ptys[0].emitData('bye');
    terminalMocks.ptys[0].emitExit(7, 15);

    expect(manager.terminalCount()).toBe(0);
    expect(terminalMocks.eventBus.broadcastEvent).toHaveBeenCalledWith('s1', {
      type: 'caco.term.output',
      data: { data: 'bye' },
    });
    expect(terminalMocks.eventBus.broadcastEvent).toHaveBeenCalledWith('s1', {
      type: 'caco.term.exit',
      data: { exitCode: 7, signal: 15 },
    });
  });

  it('evicts least-recently-active terminals above the cap', async () => {
    const manager = await importTerminalManager();
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(scratchDir('terminal-cap'));

    for (let i = 0; i < 17; i++) {
      manager.ensureTerminal(`s${i}`, 80, 24, true);
    }

    expect(manager.terminalCount()).toBe(16);
    expect(terminalMocks.ptys[0].killed).toBe(true);
    expect(terminalMocks.ptys.slice(1).every(pty => !pty.killed)).toBe(true);
  });
});

describe('initTerminalManager', () => {
  it('registers session-end cleanup once', async () => {
    const manager = await importTerminalManager();
    const processOnce = vi.spyOn(process, 'once').mockReturnValue(process);
    terminalMocks.sessionManager.getSessionCwd.mockReturnValue(scratchDir('terminal-init'));
    manager.ensureTerminal('s1', 80, 24, true);

    manager.initTerminalManager();
    manager.initTerminalManager();
    const sessionEnd = terminalMocks.sessionState.onSessionEnd.mock.calls[0][0] as (sessionId: string) => void;
    sessionEnd('s1');

    expect(terminalMocks.sessionState.onSessionEnd).toHaveBeenCalledTimes(1);
    expect(processOnce).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(terminalMocks.ptys[0].killed).toBe(true);
    expect(manager.terminalCount()).toBe(0);
  });
});
