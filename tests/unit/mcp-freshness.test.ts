import { describe, it, expect } from 'vitest';
import {
  classifyUnavailable,
  reasonSaysRelist,
  messageForReason,
  refineEnableableKeys,
  type ServerInventory,
  type KeyOrigin,
  type ServerConnState,
} from '../../src/mcp-freshness.js';
import type { ToolKey } from '../../src/tool-key.js';

const k = (s: string) => s as ToolKey;

function inv(
  state: Record<string, ServerConnState>,
  live: Record<string, string[]> = {},
  discoverOk = true,
): ServerInventory {
  return {
    state: new Map(Object.entries(state)),
    liveKeysByServer: new Map(Object.entries(live).map(([s, keys]) => [s, new Set(keys.map(k))])),
    discoverOk,
  };
}
const origin = (servers: string[], uncorrelated = false): KeyOrigin => ({ servers, uncorrelated });

describe('classifyUnavailable — 6-state, never mislabels stale as unknown', () => {
  const base = inv({ ADO: 'enumerated', icm: 'down', teams: 'disabled' }, { ADO: ['ADO-x'] });

  it('no origin at all → unknown (the only re-list case)', () => {
    expect(classifyUnavailable(undefined, base)).toBe('unknown');
  });

  it('registry-known but uncorrelated with NO correlated server → stale-unverified', () => {
    expect(classifyUnavailable(origin([], true), base)).toBe('stale-unverified');
  });

  it('correlated server absent from inventory → not-configured', () => {
    expect(classifyUnavailable(origin(['removed-server']), base)).toBe('not-configured');
  });

  it('server disabled → server-disabled', () => {
    expect(classifyUnavailable(origin(['teams']), base)).toBe('server-disabled');
  });

  it('server down → temporarily-unavailable', () => {
    expect(classifyUnavailable(origin(['icm']), base)).toBe('temporarily-unavailable');
  });

  it('enumerated server not exposing the tool → not-available', () => {
    expect(classifyUnavailable(origin(['ADO']), base)).toBe('not-available');
  });

  it('multi-server precedence picks the most-available state', () => {
    expect(classifyUnavailable(origin(['icm', 'ADO']), base)).toBe('not-available');
    expect(classifyUnavailable(origin(['removed-server', 'teams']), base)).toBe('server-disabled');
  });

  it('a correlated verdict beats an uncorrelated flag (uncorrelated does not dominate)', () => {
    // one correlated down server + uncorrelated flag → temporarily-unavailable (more available than stale)
    expect(classifyUnavailable(origin(['icm'], true), base)).toBe('temporarily-unavailable');
    // one correlated removed server + uncorrelated flag → not-configured (rank 3 < stale 4)
    expect(classifyUnavailable(origin(['removed-server'], true), base)).toBe('not-configured');
  });

  it('discover failure preserves uncertainty → temporarily-unavailable for any known key', () => {
    const down = inv({ ADO: 'enumerated' }, { ADO: ['ADO-x'] }, false);
    expect(classifyUnavailable(origin(['removed-server']), down)).toBe('temporarily-unavailable');
    expect(classifyUnavailable(origin(['ADO']), down)).toBe('temporarily-unavailable');
    // still unknown for a truly-unassociated name even on discover failure
    expect(classifyUnavailable(undefined, down)).toBe('unknown');
  });

  it('empty inventory: a correlated server is not-configured; no origin is unknown', () => {
    const empty = inv({});
    expect(classifyUnavailable(origin(['ADO']), empty)).toBe('not-configured');
    expect(classifyUnavailable(undefined, empty)).toBe('unknown');
  });
});

describe('reasonSaysRelist — only unknown loops', () => {
  it('unknown → true, everything else → false', () => {
    expect(reasonSaysRelist('unknown')).toBe(true);
    for (const r of ['not-available', 'not-configured', 'server-disabled', 'temporarily-unavailable', 'stale-unverified'] as const) {
      expect(reasonSaysRelist(r)).toBe(false);
    }
  });
});

describe('messageForReason — non-looping wording, no re-list except unknown', () => {
  it('stale-unverified never says re-list and mentions purge', () => {
    const m = messageForReason('stale-unverified', 'ADO-repo_get_file_content');
    expect(m).not.toMatch(/re-?list/i);
    expect(m).toMatch(/purge/i);
  });
  it('only unknown mentions listing', () => {
    expect(messageForReason('unknown', 'nope')).toMatch(/list/i);
    expect(messageForReason('not-configured', 'x', 'ADO')).not.toMatch(/no arguments to list/i);
  });
  it('never leaks a user path — only name, server, and the fixed config filename', () => {
    const m = messageForReason('not-configured', 'x', 'ADO');
    expect(m).toContain('ADO');
    // The fixed, well-known config path is allowed (it's guidance, not PII);
    // no OTHER path should appear. Strip the known config path, then assert none remain.
    const stripped = m.replace('~/.copilot/mcp-config.json', '');
    expect(stripped).not.toMatch(/[/\\]/);
  });
});

describe('refineEnableableKeys — refcount-safe, authoritative, never over-hides', () => {
  const seed = new Set([k('ADO-a'), k('ADO-b'), k('shared'), k('icm-x')]);
  const orig = (m: Record<string, { servers: string[]; uncorrelated?: boolean }>): Map<ToolKey, KeyOrigin> =>
    new Map(Object.entries(m).map(([key, o]) => [k(key), origin(o.servers, o.uncorrelated ?? false)]));

  it('discover failure gate: narrows nothing (but still adds live keys)', () => {
    const out = refineEnableableKeys({
      seed,
      keyOrigin: orig({ 'ADO-a': { servers: ['ADO'] } }),
      inv: inv({ ADO: 'enumerated' }, { ADO: ['ADO-a', 'ADO-new'] }, false),
    });
    expect([...seed].every(x => out.has(x))).toBe(true); // nothing dropped
    expect(out.has(k('ADO-new'))).toBe(true);            // live additions still applied
  });

  it('drops a key only when its ONLY supplier is enumerated and no longer exposes it', () => {
    const out = refineEnableableKeys({
      seed,
      keyOrigin: orig({ 'ADO-a': { servers: ['ADO'] }, 'ADO-b': { servers: ['ADO'] }, 'shared': { servers: ['ADO', 'icm'] }, 'icm-x': { servers: ['icm'] } }),
      inv: inv({ ADO: 'enumerated', icm: 'down' }, { ADO: ['ADO-a'] }), // ADO exposes a not b; icm down
    });
    expect(out.has(k('ADO-a'))).toBe(true);   // still exposed
    expect(out.has(k('ADO-b'))).toBe(false);  // ADO enumerated + dropped it → removed
    expect(out.has(k('shared'))).toBe(true);  // icm is down (unproven) → keep (refcount)
    expect(out.has(k('icm-x'))).toBe(true);   // icm down → keep
  });

  it('drops keys of a REMOVED server (absent from inventory)', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('gone-1')]),
      keyOrigin: orig({ 'gone-1': { servers: ['gone-server'] } }),
      inv: inv({ ADO: 'enumerated' }, { ADO: [] }), // gone-server not in inventory
    });
    expect(out.has(k('gone-1'))).toBe(false); // correlated + removed → authoritative drop
  });

  it('drops keys of a DISABLED server', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('t-1')]),
      keyOrigin: orig({ 't-1': { servers: ['teams'] } }),
      inv: inv({ teams: 'disabled' }),
    });
    expect(out.has(k('t-1'))).toBe(false);
  });

  it('KEEPS keys of a DOWN server (unproven, temporarily unavailable)', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('d-1')]),
      keyOrigin: orig({ 'd-1': { servers: ['icm'] } }),
      inv: inv({ icm: 'down' }),
    });
    expect(out.has(k('d-1'))).toBe(true);
  });

  it('ADDS newly-exposed live keys (freshly-configured tool appears)', () => {
    const out = refineEnableableKeys({
      seed: new Set<ToolKey>(),
      keyOrigin: new Map(),
      inv: inv({ ADO: 'enumerated' }, { ADO: ['ADO-brand-new'] }),
    });
    expect(out.has(k('ADO-brand-new'))).toBe(true);
  });

  it('keeps an uncorrelated key (stale-unverified, retained not dropped)', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('ADO-legacy')]),
      keyOrigin: orig({ 'ADO-legacy': { servers: [], uncorrelated: true } }),
      inv: inv({ ADO: 'enumerated' }, { ADO: [] }),
    });
    expect(out.has(k('ADO-legacy'))).toBe(true); // never over-hide the legacy phantom
  });

  it('keeps a key with no known origin (over-advertise)', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('mystery')]),
      keyOrigin: new Map(),
      inv: inv({ ADO: 'enumerated' }, { ADO: [] }),
    });
    expect(out.has(k('mystery'))).toBe(true);
  });

  it('drops a multi-server key only when EVERY supplier is enumerated and none exposes it', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('shared')]),
      keyOrigin: orig({ 'shared': { servers: ['ADO', 'icm'] } }),
      inv: inv({ ADO: 'enumerated', icm: 'enumerated' }, { ADO: [], icm: [] }),
    });
    expect(out.has(k('shared'))).toBe(false);
  });

  it('keeps a multi-server key when one enumerated supplier still exposes it', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('shared')]),
      keyOrigin: orig({ 'shared': { servers: ['ADO', 'icm'] } }),
      inv: inv({ ADO: 'enumerated', icm: 'enumerated' }, { ADO: ['shared'], icm: [] }),
    });
    expect(out.has(k('shared'))).toBe(true);
  });

  it('keeps an enumerated-not-exposing + down combo (down supplier is unproven)', () => {
    const out = refineEnableableKeys({
      seed: new Set([k('combo')]),
      keyOrigin: orig({ 'combo': { servers: ['ADO', 'icm'] } }),
      inv: inv({ ADO: 'enumerated', icm: 'down' }, { ADO: [] }), // ADO up-but-not-exposing, icm down
    });
    expect(out.has(k('combo'))).toBe(true); // icm down might still supply it → keep
  });
});
