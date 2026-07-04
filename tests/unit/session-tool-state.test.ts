import { describe, it, expect } from 'vitest';
import { classifyTool, validateEnable, computeColdResumeExclusions, resolveEnableTargets } from '../../src/session-tool-state.js';
import { builtinKey, cacoKey, mcpKey, type ToolKey } from '../../src/tool-key.js';
import type { CatalogTool, ToolCatalog } from '../../src/tool-catalog.js';

const k = {
  bash: builtinKey('bash'),
  view: builtinKey('view'),
  oauth: cacoKey('register_mcp_server'),
  issues: mcpKey('github-list_issues'),
};

function cat(entries: Array<Partial<CatalogTool> & { key: ToolKey }>): ToolCatalog {
  const m = new Map<ToolKey, CatalogTool>();
  for (const e of entries) {
    m.set(e.key, { key: e.key, name: e.name ?? 'n', description: e.description ?? '', origin: e.origin ?? 'builtin', excludable: e.excludable ?? true, hardDisabled: e.hardDisabled ?? false, parameters: e.parameters });
  }
  return m;
}

describe('classifyTool — the one presentation-axis definition', () => {
  it('hardDisabled → disabled (takes precedence even if somehow excluded)', () => {
    expect(classifyTool(k.oauth, { excluded: new Set([k.oauth]), hardDisabled: true })).toBe('disabled');
  });
  it('policy-disabled builtin → disabled, not deferred (even though it is in the excluded set)', () => {
    expect(classifyTool(k.bash, { excluded: new Set([k.bash]), hardDisabled: false, policyDisabled: new Set([k.bash]) })).toBe('disabled');
  });
  it('in excluded set but NOT policy → deferred (dynamic defer)', () => {
    expect(classifyTool(k.issues, { excluded: new Set([k.issues]), hardDisabled: false, policyDisabled: new Set([k.bash]) })).toBe('deferred');
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
    const r = validateEnable([k.issues], catalog, new Set([k.bash, k.issues]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextExcluded.has(k.issues)).toBe(false);
      expect(r.nextExcluded.has(k.bash)).toBe(true);
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

  it('rejects a hard-disabled name (not re-enableable)', () => {
    const r = validateEnable([k.oauth], catalog, new Set([k.bash]));
    expect(r.ok).toBe(false);
  });

  it('rejects a policy-disabled builtin (not re-enableable), even though it is excluded', () => {
    const r = validateEnable([k.bash], catalog, new Set([k.bash, k.issues]), new Set([k.bash]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disabled and not re-enableable/);
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

describe('resolveEnableTargets — agent-typed name/key → ToolKey', () => {
  const catalog = cat([
    { key: k.bash, name: 'bash', origin: 'builtin' },
    { key: k.view, name: 'view', origin: 'builtin' },
    { key: k.issues, name: 'list_issues', origin: 'mcp' },
    { key: k.oauth, name: 'register_mcp_server', origin: 'caco', hardDisabled: true },
  ]);

  it('resolves a bare display name to its key', () => {
    const r = resolveEnableTargets(['bash'], catalog);
    expect(r).toEqual({ ok: true, keys: [k.bash] });
  });

  it('resolves a full ToolKey verbatim', () => {
    const r = resolveEnableTargets(['github-list_issues'], catalog);
    expect(r).toEqual({ ok: true, keys: [k.issues] });
  });

  it('resolves a batch (display + key mixed)', () => {
    const r = resolveEnableTargets(['bash', 'github-list_issues'], catalog);
    expect(r).toEqual({ ok: true, keys: [k.bash, k.issues] });
  });

  it('errors on an unknown name (atomic — reports the offender)', () => {
    const r = resolveEnableTargets(['bash', 'nope'], catalog);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nope');
  });

  it('errors on an ambiguous display name shared across origins (asks for the full key)', () => {
    const dup = cat([
      { key: builtinKey('search'), name: 'search', origin: 'builtin' },
      { key: mcpKey('gh-search'), name: 'search', origin: 'mcp' },
    ]);
    const r = resolveEnableTargets(['search'], dup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ambiguous/i);
  });
});

