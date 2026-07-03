import { describe, it, expect } from 'vitest';
import { classifyTool, validateEnable, computeColdResumeExclusions } from '../../src/session-tool-state.js';
import { toolKey, type ToolKey } from '../../src/tool-key.js';
import type { CatalogTool, ToolCatalog } from '../../src/tool-catalog.js';

const k = {
  bash: toolKey({ origin: 'builtin', name: 'bash' }),
  view: toolKey({ origin: 'builtin', name: 'view' }),
  oauth: toolKey({ origin: 'caco', name: 'register_mcp_server' }),
  issues: toolKey({ origin: 'mcp', serverName: 'github', toolName: 'list_issues' }),
};

function cat(entries: Array<Partial<CatalogTool> & { key: ToolKey }>): ToolCatalog {
  const m = new Map<ToolKey, CatalogTool>();
  for (const e of entries) {
    m.set(e.key, { key: e.key, name: e.name ?? 'n', description: e.description ?? '', origin: e.origin ?? 'builtin', hardDisabled: e.hardDisabled ?? false, parameters: e.parameters });
  }
  return m;
}

describe('classifyTool — the one 3-axis definition', () => {
  it('hardDisabled → off (takes precedence even if somehow excluded)', () => {
    expect(classifyTool(k.oauth, { excluded: new Set([k.oauth]), hardDisabled: true })).toBe('off');
  });
  it('in excluded set → deferred', () => {
    expect(classifyTool(k.bash, { excluded: new Set([k.bash]), hardDisabled: false })).toBe('deferred');
  });
  it('otherwise → enabled', () => {
    expect(classifyTool(k.view, { excluded: new Set([k.bash]), hardDisabled: false })).toBe('enabled');
  });
});

describe('validateEnable — atomic, reveal-only', () => {
  const catalog = cat([
    { key: k.bash, origin: 'builtin' },
    { key: k.view, origin: 'builtin' },
    { key: k.oauth, origin: 'caco', hardDisabled: true },
    { key: k.issues, origin: 'mcp' },
  ]);

  it('valid: removes the named keys from the exclusion set', () => {
    const r = validateEnable([k.bash], catalog, new Set([k.bash, k.issues]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextExcluded.has(k.bash)).toBe(false);
      expect(r.nextExcluded.has(k.issues)).toBe(true);
    }
  });

  it('valid batch: enables multiple in one call (one mutation)', () => {
    const r = validateEnable([k.bash, k.issues], catalog, new Set([k.bash, k.issues]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextExcluded.size).toBe(0);
  });

  it('rejects an unknown name atomically (no partial mutation)', () => {
    const bogus = 'nope/nope' as ToolKey;
    const r = validateEnable([k.bash, bogus], catalog, new Set([k.bash]));
    expect(r.ok).toBe(false);
  });

  it('rejects a hard-disabled name (not revealable)', () => {
    const r = validateEnable([k.oauth], catalog, new Set([k.bash]));
    expect(r.ok).toBe(false);
  });

  it('rejects an already-enabled name (not currently excluded)', () => {
    const r = validateEnable([k.view], catalog, new Set([k.bash]));
    expect(r.ok).toBe(false);
  });
});

describe('computeColdResumeExclusions — cold-only defer math', () => {
  const tools = [k.bash, k.view, k.issues];

  it('returns [] when not cold (warm session is never auto-mutated)', () => {
    expect(computeColdResumeExclusions({ isCold: false, tools, lastUsed: new Map(), nowActiveSeconds: 1e9, threshold: 3600 }))
      .toEqual([]);
  });

  it('cold: defers tools unused past the threshold, keeps recently-used', () => {
    const lastUsed = new Map<ToolKey, number>([[k.view, 9500]]); // used recently
    const out = computeColdResumeExclusions({ isCold: true, tools, lastUsed, nowActiveSeconds: 10000, threshold: 1000 });
    expect(out).toContain(k.bash);   // never used → stale
    expect(out).toContain(k.issues); // never used → stale
    expect(out).not.toContain(k.view); // used 500s ago < 1000 threshold → kept
  });

  it('cold: a never-used tool (no stamp) is ALWAYS stale, even when nowActiveSeconds <= threshold', () => {
    // Early cold resume: the active clock has barely advanced. A never-used tool must
    // still be deferred (maximally stale), not kept just because now-0 <= threshold.
    const out = computeColdResumeExclusions({ isCold: true, tools: [k.bash], lastUsed: new Map(), nowActiveSeconds: 5, threshold: 3600 });
    expect(out).toContain(k.bash);
  });

  it('cold: a tool used exactly at the threshold boundary is kept (age must EXCEED threshold)', () => {
    const lastUsed = new Map<ToolKey, number>([[k.bash, 9000]]);
    const out = computeColdResumeExclusions({ isCold: true, tools: [k.bash], lastUsed, nowActiveSeconds: 10000, threshold: 1000 });
    expect(out).not.toContain(k.bash);
  });
});
