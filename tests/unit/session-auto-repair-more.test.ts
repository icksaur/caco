import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn((path: string) => files.has(path)),
  readFileSync: vi.fn((path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error('missing file');
    return value;
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    files.set(path, content);
  }),
}));
const uuidMock = vi.hoisted(() => vi.fn(() => 'synthetic-id'));

vi.mock('fs', () => fsMock);
vi.mock('os', () => ({ homedir: () => '/virtual-caco-home' }));
vi.mock('crypto', () => ({ randomUUID: uuidMock }));

import { repairSessionEvents, shouldAutoRepairSessionError } from '../../src/session-auto-repair.js';

function eventPath(sessionId: string): string {
  return `/virtual-caco-home/.copilot/session-state/${sessionId}/events.jsonl`;
}

function writeEvents(sessionId: string, lines: unknown[]): void {
  files.set(eventPath(sessionId), lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
}

function writesTo(path: string): string[] {
  return fsMock.writeFileSync.mock.calls.filter(call => call[0] === path).map(call => call[1]);
}

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  uuidMock.mockReturnValue('synthetic-id');
});

describe('shouldAutoRepairSessionError', () => {
  it('recognizes only known recoverable SDK corruption shapes', () => {
    expect(shouldAutoRepairSessionError()).toBe(false);
    expect(shouldAutoRepairSessionError('Session file is corrupted near line 7')).toBe(true);
    expect(shouldAutoRepairSessionError('missing displayName in attachments')).toBe(true);
    expect(shouldAutoRepairSessionError('invalid_request_error: tool_use ids do not match tool_result ids')).toBe(true);
    expect(shouldAutoRepairSessionError('rate limit exceeded')).toBe(false);
  });
});

describe('repairSessionEvents more branches', () => {
  it('returns null without reading when the event file is absent', () => {
    expect(repairSessionEvents('missing-session', 'displayName')).toBeNull();

    expect(fsMock.readFileSync).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('adds displayName values from attachment paths and backs up the original file', () => {
    writeEvents('attachments', [
      { type: 'user.message', data: { attachments: [{ path: '/workspace/report.txt' }, { path: '' }] } },
    ]);

    const result = repairSessionEvents('attachments', 'displayName required at line 1');

    expect(result).toBe('Fixed 2 attachment(s) missing displayName');
    const repaired = JSON.parse(files.get(eventPath('attachments')) ?? '{}');
    expect(repaired.data.attachments).toEqual([
      { path: '/workspace/report.txt', displayName: 'report.txt' },
      { path: '', displayName: 'attachment' },
    ]);
    expect(fsMock.writeFileSync.mock.calls[0][0]).toMatch(/events\.jsonl\.bak-/);
  });

  it('injects synthetic completions for orphaned tool executions before the next user boundary', () => {
    writeEvents('tool-orphan', [
      { type: 'assistant.message', data: {} },
      { type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'read_file' } },
      { type: 'abort', data: {} },
      { type: 'user.message', data: { text: 'next turn' } },
    ]);

    const result = repairSessionEvents('tool-orphan', 'invalid_request_error: missing tool_result for tool_use');

    expect(result).toBe('Injected 1 synthetic tool completion(s) for orphaned tool calls');
    const repairedLines = (files.get(eventPath('tool-orphan')) ?? '').trim().split('\n').map(line => JSON.parse(line));
    expect(repairedLines.map(line => line.type)).toEqual(['assistant.message', 'tool.execution_start', 'abort', 'tool.execution_complete', 'user.message']);
    expect(repairedLines[3]).toMatchObject({
      id: 'synthetic-id',
      data: { toolCallId: 'call-1', toolName: 'read_file', success: false, result: { content: 'Tool execution was cancelled.' } },
    });
  });

  it('falls back to truncation when every tool execution already completed', () => {
    writeEvents('tool-complete', [
      { type: 'session.idle', data: {} },
      { type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'read_file' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true } },
      { type: 'user.message', data: {} },
    ]);

    expect(repairSessionEvents('tool-complete', 'invalid_request_error: missing tool_result for tool_use')).toBe('Truncated session history to last stable point (removed 3 lines). Recent conversation may be lost.');
    expect((files.get(eventPath('tool-complete')) ?? '').trim()).toBe(JSON.stringify({ type: 'session.idle', data: {} }));
  });

  it('truncates to the stable boundary before an explicitly bad line', () => {
    writeEvents('truncate-line', [
      { type: 'session.start', data: {} },
      { type: 'session.idle', data: {} },
      { type: 'assistant.message', data: { text: 'bad' } },
      { type: 'user.message', data: { text: 'later' } },
    ]);

    const result = repairSessionEvents('truncate-line', 'Session file is corrupted at line 3');

    expect(result).toBe('Truncated session history to last stable point (removed 2 lines). Recent conversation may be lost.');
    expect((files.get(eventPath('truncate-line')) ?? '').trim().split('\n')).toHaveLength(2);
  });

  it('returns null when no stable boundary exists for recoverable corruption', () => {
    writeEvents('no-boundary', [
      { type: 'session.start', data: {} },
      { type: 'assistant.message', data: { text: 'bad' } },
    ]);

    expect(repairSessionEvents('no-boundary', 'Session file is corrupted at line 2')).toBeNull();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('does not write a repair when the backup write fails', () => {
    writeEvents('backup-fails', [
      { type: 'session.shutdown', data: { reason: 'done' } },
    ]);
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(repairSessionEvents('backup-fails', 'missing ephemeral on session.shutdown')).toBeNull();
    expect(writesTo(eventPath('backup-fails'))).toHaveLength(0);
  });

  it('catches read failures and reports no repair', () => {
    files.set(eventPath('throws'), 'anything');
    fsMock.readFileSync.mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    expect(repairSessionEvents('throws', 'displayName')).toBeNull();
  });
});
