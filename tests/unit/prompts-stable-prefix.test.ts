import { describe, it, expect, vi } from 'vitest';

// Memory is host-wide; stub it empty so the ordering assertions are about the template,
// not the tester's real ~/.caco/memory.json.
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: () => '\n\n## User Memory\n- **k**: v' }));
vi.mock('../../src/applet-store.js', () => ({ listApplets: async () => [] }));

import { buildSystemMessage, resolveSystemMessage } from '../../src/prompts.js';

describe('system prompt — stable-prefix ordering (spec-prompt-stable-prefix)', () => {
  it('places the per-session cwd LAST, after the memory block and the guidelines body', async () => {
    const msg = await buildSystemMessage();
    const resolved = resolveSystemMessage(msg, '/workspace/proj');
    const c = resolved.content;
    // cwd replaced exactly once, and only in the trailing Session Context block.
    expect(c.match(/\/workspace\/proj/g)?.length).toBe(1);
    expect(c).toContain('## Session Context');
    // The cwd must come AFTER the memory block and the Behavior Guidelines body, so
    // per-session content never precedes the stable, cross-session-shareable prefix.
    expect(c.indexOf('## User Memory')).toBeLessThan(c.indexOf('## Session Context'));
    expect(c.indexOf('## Behavior Guidelines')).toBeLessThan(c.indexOf('## Session Context'));
    expect(c.indexOf('/workspace/proj')).toBeGreaterThan(c.indexOf('## User Memory'));
    // cwd is LITERALLY LAST: the message ends with the Session Context cwd line, so no
    // stable content trails the per-session token (which would reintroduce the bust).
    expect(c.endsWith('## Session Context\n- **Current directory**: /workspace/proj (but not limited to this)')).toBe(true);
    expect(c).not.toContain('{{SESSION_CWD}}'); // placeholder fully resolved
  });

  it('does not leave the per-session cwd in the early Environment block', async () => {
    const msg = await buildSystemMessage();
    const envStart = msg.content.indexOf('## Environment');
    const envEnd = msg.content.indexOf('## Work Economy');
    const envBlock = msg.content.slice(envStart, envEnd);
    expect(envBlock).not.toContain('{{SESSION_CWD}}');
    expect(envBlock).toContain('Home directory'); // host-constant line stays
  });

  it('the template body up to Session Context is cwd-invariant (identical across cwds)', async () => {
    const msg = await buildSystemMessage();
    const a = resolveSystemMessage(msg, '/dir/one').content;
    const b = resolveSystemMessage(msg, '/dir/two').content;
    const prefixA = a.slice(0, a.indexOf('## Session Context'));
    const prefixB = b.slice(0, b.indexOf('## Session Context'));
    expect(prefixA).toBe(prefixB); // the whole shareable prefix is byte-identical
  });
});

describe('system prompt — Tool Availability (spec-enable-tools-discovery)', () => {
  it('explains deferral + the caco_enable_tools discover/enable loop, in the stable prefix', async () => {
    const c = (await buildSystemMessage()).content;
    expect(c).toContain('## Tool Availability');
    expect(c).toContain('caco_enable_tools({ names:');
    expect(c).toContain('caco_enable_tools()'); // the no-args discovery pull
    expect(c).toContain('<deferred_tools>');    // the change-triggered push
    // Static — carries no per-session data, so it stays before the cwd token.
    expect(c.indexOf('## Tool Availability')).toBeLessThan(c.indexOf('## Session Context'));
  });

  it('drops the dead unconditional first-turn get_applet_state directive', async () => {
    const c = (await buildSystemMessage()).content;
    expect(c).not.toContain('on your first turn');
    expect(c).not.toContain('Call `get_applet_state`');
  });
});
