import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * spec-memory-frozen-in-startup-prompt.
 *
 * The system prompt used to be built ONCE at server startup and reused for every session
 * created by that process. `formatMemoryForPrompt()` sits inside that string, so a memory
 * edit did not reach a new session until a restart — the operator deleted a memory, made a
 * fresh session, and it still carried the deleted entry.
 *
 * These tests exercise the REAL `buildSystemMessage` and the REAL memory store (redirected
 * at a temp dir), because the bug lived precisely in the seam between "read memory fresh"
 * and "capture the assembled prompt once". A test against a mocked prompts module cannot
 * see it.
 */

import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// vi.mock is hoisted above module-level consts, so the temp home must be created inside
// vi.hoisted or the factory closes over an uninitialized binding.
const env = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  const home = mkdtempSync(join(tmpdir(), 'caco-prompt-home-'));
  mkdirSync(join(home, '.caco'), { recursive: true });
  return { home };
});
const HOME = env.home;

// MEMORY_FILE is resolved from homedir() at module load, so `os` must be mocked BEFORE
// memory-tool is imported. This is why these oracles cannot live in session-state.test.ts.
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, homedir: () => env.home, default: { ...actual, homedir: () => env.home } };
});

const applets = vi.hoisted(() => ({ list: [] as Array<{ slug: string; updatedAt: string; deprecated?: boolean }> }));
vi.mock('../../src/applet-store.js', () => ({
  listApplets: async () => applets.list,
}));

import { buildSystemMessage } from '../../src/prompts.js';

function writeMemory(store: Record<string, string>): void {
  writeFileSync(join(HOME, '.caco', 'memory.json'), JSON.stringify(store), 'utf-8');
}

beforeEach(() => {
  writeMemory({});
  applets.list = [];
});
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('memory reaches a newly built prompt without a restart', () => {
  it('reflects a memory WRITE made after the first build', async () => {
    const before = (await buildSystemMessage()).content;
    expect(before).not.toContain('## User Memory');

    writeMemory({ 'scope-rule': 'Only work on project X.' });
    const after = (await buildSystemMessage()).content;

    expect(after).toContain('## User Memory');
    expect(after).toContain('Only work on project X.');
  });

  it('reflects a memory DELETE made after the first build', async () => {
    // The reported bug: the operator cleared memory in the applet, then every new session
    // still carried the deleted entry until the server was restarted.
    writeMemory({ 'scope-rule': 'Only work on project X.' });
    expect((await buildSystemMessage()).content).toContain('Only work on project X.');

    writeMemory({});
    const after = (await buildSystemMessage()).content;

    expect(after).not.toContain('Only work on project X.');
    expect(after).not.toContain('## User Memory');
  });
});

describe('the prompt prefix stays byte-stable so rebuilding does not cost cache', () => {
  it('lists applets by SLUG, not by the recency order listApplets returns', async () => {
    // listApplets sorts by updatedAt DESC for the applet UI. Inheriting that here would
    // reshuffle the prompt whenever an applet was edited.
    applets.list = [
      { slug: 'zebra', updatedAt: '2026-01-02T00:00:00Z' },
      { slug: 'alpha', updatedAt: '2026-01-01T00:00:00Z' },
    ];

    expect((await buildSystemMessage()).content).toContain('Available: alpha, zebra.');
  });

  it('is byte-identical across builds when an applet is merely EDITED', async () => {
    applets.list = [
      { slug: 'zebra', updatedAt: '2026-01-02T00:00:00Z' },
      { slug: 'alpha', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    const first = (await buildSystemMessage()).content;

    // `alpha` is edited: same applet set, new updatedAt, so listApplets now returns it
    // first. The prompt must not notice.
    applets.list = [
      { slug: 'alpha', updatedAt: '2026-06-01T00:00:00Z' },
      { slug: 'zebra', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    const second = (await buildSystemMessage()).content;

    expect(second).toBe(first);
  });

  it('is byte-identical across repeated builds with everything unchanged', async () => {
    // Guards against any nondeterminism (Date, unsorted keys) entering prompt assembly:
    // rebuilding per session would otherwise bust the shared prefix on every creation.
    applets.list = [{ slug: 'files', updatedAt: '2026-01-01T00:00:00Z' }];
    writeMemory({ beta: 'second', alpha: 'first' });

    const a = (await buildSystemMessage()).content;
    const b = (await buildSystemMessage()).content;

    expect(b).toBe(a);
    // Memory keys sorted, so insertion order cannot leak into the prefix.
    expect(a.indexOf('**alpha**')).toBeLessThan(a.indexOf('**beta**'));
  });

  it('DOES change when the installed applet set changes', async () => {
    applets.list = [{ slug: 'files', updatedAt: '2026-01-01T00:00:00Z' }];
    const before = (await buildSystemMessage()).content;

    applets.list = [
      { slug: 'files', updatedAt: '2026-01-01T00:00:00Z' },
      { slug: 'git-status', updatedAt: '2026-01-01T00:00:00Z' },
    ];

    expect((await buildSystemMessage()).content).not.toBe(before);
  });
});
