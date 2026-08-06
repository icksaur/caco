import { describe, it, expect } from 'vitest';
import { buildSystemMessage } from '../../src/prompts.js';
import { createDocsTool } from '../../src/dev-docs-tool.js';

/**
 * Falsifiable checks for the trimmed system message (spec-prompt-trim).
 *
 * These are deliberately literal rather than semantic: a "does it still read
 * well" assertion is unfalsifiable, so the suite pins only properties that a
 * regression would actually violate — schema-owned mechanics creeping back in,
 * a rule being stated twice, a must-keep being cut, or a docs pointer rotting.
 */

/** The body only: memory and the per-session cwd are appended after it. */
async function body(): Promise<string> {
  const msg = await buildSystemMessage();
  return msg.content.split('\n## User Memory')[0].split('\n## Session Context')[0];
}

describe('the prompt does not restate tool mechanics', () => {
  it('carries no literals owned by a tool schema', async () => {
    // Each of these appears in the description of a tool the model receives in
    // the SAME request, so repeating it here is paid twice for one fact.
    const schemaOwned = [
      'timeoutMs',      // caco_run_workflow
      'caco.reads',     // caco_run_workflow
      'caco.peek',      // caco_run_workflow
      'emit(',          // caco_run_workflow
      'out_',           // retrieve_output
    ];
    const text = await body();
    for (const literal of schemaOwned) expect(text).not.toContain(literal);
  });

  it('names no tool that does not exist', async () => {
    // Both were referenced by the prompt while absent from the tool list.
    const text = await body();
    for (const ghost of ['report_intent', 'list_applets']) expect(text).not.toContain(ghost);
  });

  it('drops the sections whose content moved to tool descriptions', async () => {
    const text = await body();
    expect(text).not.toContain('## Remember');
    expect(text).not.toContain('## Reading Code Efficiently');
  });
});

describe('each rule is stated once', () => {
  // Concept-level, not phrase-level: a rephrasing that restates the idea still
  // trips these, which a literal phrase match would not.
  const rules: Array<[string, RegExp]> = [
    ['stop searching once you can name the change', /name the (exact )?change/gi],
    ['do not narrate in its own turn', /narrat/gi],
    ['do not re-read what is already in context', /re-?read/gi],
    ['edit matches unique text, not line numbers', /not line numbers/gi],
  ];

  for (const [label, re] of rules) {
    it(`states "${label}" at most once`, async () => {
      const matches = (await body()).match(re) ?? [];
      expect(matches.length).toBeLessThanOrEqual(1);
    });
  }
});

describe('the things only the prompt can say survive', () => {
  it('keeps the four must-keeps', async () => {
    const text = await body();
    // 1. it renders rich HTML in a browser
    expect(text).toContain('SVG');
    // 2. how to learn about itself
    expect(text).toContain('caco_docs');
    // 3. the response-action contract
    expect(text).toContain('caco-actions');
    // 4. the work-economy rules
    expect(text).toContain('Work Economy');
  });

  it('keeps the runtime-note explanation, which no tool description carries', async () => {
    // caco_enable_tools documents listing and enabling but never mentions this
    // block, so the prompt is its only explanation.
    expect(await body()).toContain('<deferred_tools>');
  });

  it('keeps the destructive-action guard in the prompt itself', async () => {
    // Deliberately NOT relocated: AGENTS.md is not eagerly loaded (probed), and
    // running stop.sh kills the user's live session.
    expect(await body()).toContain('stop.sh');
  });

  it('states no personal rule that copilot-instructions.md already owns', async () => {
    const text = await body();
    expect(text).not.toContain('Co-authored-by');
  });
});

describe('every docs pointer resolves', () => {
  it('names only caco_docs sections that return content', async () => {
    const text = await body();
    const sections = [...text.matchAll(/caco_docs section="([^"]+)"/g)].map(m => m[1]);
    expect(sections.length).toBeGreaterThan(0);

    const [tool] = createDocsTool(process.cwd()) as unknown as Array<{
      handler: (a: { section: string }) => Promise<{ textResultForLlm: string }>;
    }>;
    for (const section of sections) {
      const out = await tool.handler({ section });
      expect(out.textResultForLlm, `caco_docs section="${section}"`).not.toContain('not found');
      expect(out.textResultForLlm.length).toBeGreaterThan(200);
    }
  });
});
