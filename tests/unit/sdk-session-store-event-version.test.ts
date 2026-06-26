import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getEventVersion } from '../../src/sdk-session-store.js';

const SID = `mru-evver-test-${process.pid}-${Date.now()}`;
function dir(): string { return join(homedir(), '.copilot', 'session-state', SID); }
function eventsPath(): string { return join(dir(), 'events.jsonl'); }

afterEach(() => { rmSync(dir(), { recursive: true, force: true }); });

describe('getEventVersion', () => {
  it('returns null when the session has no events.jsonl', () => {
    expect(getEventVersion(SID)).toBeNull();
  });

  it('returns size+mtimeMs for an existing events file', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(eventsPath(), '{"type":"user.message"}\n');
    const v = getEventVersion(SID);
    expect(v).not.toBeNull();
    expect(v!.size).toBeGreaterThan(0);
    expect(typeof v!.mtimeMs).toBe('number');
  });

  it('changes when the file grows (append / new events)', () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(eventsPath(), '{"type":"user.message"}\n');
    const v1 = getEventVersion(SID)!;
    writeFileSync(eventsPath(), '{"type":"user.message"}\n{"type":"assistant.message"}\n');
    const v2 = getEventVersion(SID)!;
    expect(v2.size).toBeGreaterThan(v1.size);
  });

  it('changes when the file is rewritten smaller (rotation/repair)', () => {
    mkdirSync(dir(), { recursive: true });
    const big = Array.from({ length: 50 }, () => '{"type":"assistant.message_delta"}').join('\n') + '\n';
    writeFileSync(eventsPath(), big);
    const before = getEventVersion(SID)!;
    // Front-truncation: a smaller rewrite, as history rotation produces.
    writeFileSync(eventsPath(), '{"type":"assistant.message"}\n');
    const after = getEventVersion(SID)!;
    expect(after.size).toBeLessThan(before.size);
    expect(after).not.toEqual(before);
  });
});
