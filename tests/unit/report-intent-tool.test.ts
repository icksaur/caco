/**
 * report_intent tool oracles (spec-report-intent-tool).
 *
 * Covers the tool contract: validation, latch, write-once, replay-safety,
 * missing-session guard, character cap. Latch mechanics themselves are already
 * covered by session-auto-name.test.ts — these tests focus on the tool wrapper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testStorageRoot = mkdtempSync(join(tmpdir(), 'caco-report-intent-'));
process.env.CACO_HOME = testStorageRoot;

const { createReportIntentTool } = await import('../../src/report-intent-tool.js');
const { getSessionMeta } = await import('../../src/session-meta-store.js');

const SESSION_DIR = join(testStorageRoot, 'sessions');

function makeSession(id: string): void {
  const dir = join(SESSION_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: '' }, null, 2));
}

function readMeta(id: string): Record<string, unknown> {
  const m = getSessionMeta(id);
  if (!m) throw new Error(`no meta for ${id}`);
  return m as unknown as Record<string, unknown>;
}

interface Handler {
  (args: { intent: string }): Promise<{ textResultForLlm: string; resultType?: string }>;
}

function makeHandler(sessionId: string | undefined): Handler {
  const tools = createReportIntentTool(sessionId ? { id: sessionId } : undefined);
  return (tools[0] as unknown as { handler: Handler }).handler;
}

beforeEach(() => {
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* first run */ }
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('report_intent tool', () => {
  it('latches autoName on first valid call', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    const result = await handler({ intent: 'fix routing bug' });

    expect(result.resultType).toBeUndefined();
    expect(result.textResultForLlm).toContain('fix routing bug');
    expect(result.textResultForLlm).toContain('session title');

    const meta = readMeta('s1');
    expect(meta.autoName).toBe('fix routing bug');
    expect(meta.currentIntent).toBe('fix routing bug');
    expect(meta.intentHistory).toHaveLength(1);
  });

  it('is write-once: second call updates currentIntent but not autoName', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    await handler({ intent: 'fix routing bug' });
    const result = await handler({ intent: 'actually, refactor auth' });

    expect(result.textResultForLlm).toContain('stays');
    expect(result.textResultForLlm).toContain('fix routing bug');

    const meta = readMeta('s1');
    expect(meta.autoName).toBe('fix routing bug');
    expect(meta.currentIntent).toBe('actually, refactor auth');
    expect(meta.intentHistory).toHaveLength(2);
  });

  it('rejects empty string at the tool boundary', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    const result = await handler({ intent: '' });

    expect(result.resultType).toBe('error');
    const meta = readMeta('s1');
    expect(meta.autoName).toBeUndefined();
    expect(meta.currentIntent).toBeUndefined();
    expect(meta.intentHistory ?? []).toHaveLength(0);
  });

  it('rejects whitespace-only string at the tool boundary', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    const result = await handler({ intent: '   \t\n  ' });

    expect(result.resultType).toBe('error');
    const meta = readMeta('s1');
    expect(meta.autoName).toBeUndefined();
  });

  it('trims surrounding whitespace before storing', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    await handler({ intent: '   fix routing bug\n' });

    const meta = readMeta('s1');
    expect(meta.autoName).toBe('fix routing bug');
  });

  it('rejects strings over the character cap', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    const oversized = 'x'.repeat(201);
    const result = await handler({ intent: oversized });

    expect(result.resultType).toBe('error');
    expect(result.textResultForLlm).toMatch(/<=\s*200/);
    const meta = readMeta('s1');
    expect(meta.autoName).toBeUndefined();
  });

  it('accepts strings at the character cap boundary', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    const atCap = 'x'.repeat(200);
    const result = await handler({ intent: atCap });

    expect(result.resultType).toBeUndefined();
    const meta = readMeta('s1');
    expect(meta.autoName).toBe(atCap);
  });

  it('is idempotent under duplicate fire within a turn', async () => {
    makeSession('s1');
    const handler = makeHandler('s1');
    await handler({ intent: 'fix routing bug' });
    await handler({ intent: 'fix routing bug' });

    const meta = readMeta('s1');
    expect(meta.autoName).toBe('fix routing bug');
    expect(meta.intentHistory).toHaveLength(2);
  });

  it('returns an actionable error when no session ref is available', async () => {
    const handler = makeHandler(undefined);
    const result = await handler({ intent: 'fix routing bug' });

    expect(result.resultType).toBe('error');
    expect(result.textResultForLlm).toContain('no active session');
  });

  it('exposes exactly one tool named report_intent', async () => {
    const tools = createReportIntentTool({ id: 's1' });
    expect(tools).toHaveLength(1);
    expect((tools[0] as unknown as { name: string }).name).toBe('report_intent');
  });

  it('tool description makes user-vs-agent framing explicit', async () => {
    const tools = createReportIntentTool({ id: 's1' });
    const desc = (tools[0] as unknown as { description: string }).description;
    // Load-bearing: the model must understand this is USER intent. If someone
    // rewrites the description without those cues, session titles will drift
    // back to agent activity like "reading dispatch-events.ts".
    expect(desc).toMatch(/USER/);
    expect(desc).toMatch(/not.*(current activity|agent intent)/i);
  });

  it('is not eligible for auto-defer', async () => {
    // The prompt's Behavior section names report_intent and tells the model to
    // call it on the first turn. If auto-defer strands the tool exactly then,
    // the whole feature is invisible on the turn where it needs to fire.
    const { isDeferEligibleCacoTool, NEVER_DEFER_CACO_TOOLS } = await import('../../src/tool-registry.js');
    expect(NEVER_DEFER_CACO_TOOLS).toContain('report_intent');
    expect(isDeferEligibleCacoTool('report_intent')).toBe(false);
  });
});
