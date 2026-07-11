import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';

const appletToolsFake = vi.hoisted(() => ({
  APPLET_HOWTO: '# Applet Create Guide\nUse HTML, JS, and CSS.',
  buildAppletUsage: vi.fn<(slug?: string) => Promise<string>>(),
}));

const extensionsToolFake = vi.hoisted(() => ({
  buildExtensionsGuide: vi.fn<() => string>(),
}));

vi.mock('../../src/applet-tools.js', () => appletToolsFake);
vi.mock('../../src/extensions-tool.js', () => extensionsToolFake);

import { createDocsTool } from '../../src/dev-docs-tool.js';

interface DocsArgs {
  section?: string;
  slug?: string;
  viewRange?: [number, number];
}

interface ToolWithHandler {
  handler: (args: DocsArgs) => Promise<{ textResultForLlm: string }>;
}

function tool(projectRoot = process.cwd()): ToolWithHandler {
  const [docsTool] = createDocsTool(projectRoot) as unknown as ToolWithHandler[];
  return docsTool;
}

describe('caco_docs default guide and virtual sections', () => {
  it('returns the assembled default development guide with key sections and paths', async () => {
    const out = await tool().handler({});

    expect(out.textResultForLlm).toContain('# Caco Documentation');
    expect(out.textResultForLlm).toContain('## Build & Test');
    expect(out.textResultForLlm).toContain('src/session-manager.ts');
    expect(out.textResultForLlm).toContain('public/ts/message-streaming.ts');
    expect(out.textResultForLlm).toContain('caco_docs section="extensions"');
  });

  it('returns applet creation docs from the applet helper', async () => {
    const out = await tool().handler({ section: 'applets:create' });

    expect(out.textResultForLlm).toBe('# Applet Create Guide\nUse HTML, JS, and CSS.');
  });

  it('returns applet usage docs with the requested slug', async () => {
    appletToolsFake.buildAppletUsage.mockResolvedValue('usage for clock');

    const out = await tool().handler({ section: 'applets:usage', slug: 'clock' });

    expect(out.textResultForLlm).toBe('usage for clock');
    expect(appletToolsFake.buildAppletUsage).toHaveBeenCalledWith('clock');
  });

  it('returns extension docs and the tools redirect message', async () => {
    extensionsToolFake.buildExtensionsGuide.mockReturnValue('# Extensions Guide');

    const extensions = await tool().handler({ section: 'extensions' });
    const tools = await tool().handler({ section: 'tools' });

    expect(extensions.textResultForLlm).toBe('# Extensions Guide');
    expect(tools.textResultForLlm).toContain('Call `caco_enable_tools` with no arguments');
  });
});

describe('caco_docs filesystem-backed sections', () => {
  it('lists root docs and recursive docs in the index', async () => {
    const out = await tool().handler({ section: 'index' });

    expect(out.textResultForLlm).toContain('# Documentation Index');
    expect(out.textResultForLlm).toContain(join(process.cwd(), 'README.md'));
    expect(out.textResultForLlm).toContain('docs/spec-backend-coverage-80.md');
  });

  it('keeps section=docs as a backward-compatible index alias', async () => {
    const out = await tool().handler({ section: 'docs' });

    expect(out.textResultForLlm).toContain('## Root docs');
    expect(out.textResultForLlm).toContain('## docs/ directory');
  });

  it('reads a root markdown file by short name and prepends heading line numbers', async () => {
    const out = await tool().handler({ section: 'README' });

    expect(out.textResultForLlm).toContain(`# ${join(process.cwd(), 'README.md')}`);
    expect(out.textResultForLlm).toContain('## Headings (line numbers)');
    expect(out.textResultForLlm).toContain('## Body');
    expect(out.textResultForLlm).toContain('# Caco');
  });

  it('reads a viewRange with normalized bounds', async () => {
    const out = await tool().handler({ section: 'README.md', viewRange: [1.8, 3.2] });

    expect(out.textResultForLlm).toContain('## Lines 1–3 of');
    expect(out.textResultForLlm).toContain('# Caco');
    expect(out.textResultForLlm).not.toContain('A self-extensible web-based wrapper');
  });

  it('finds docs by recursive basename fallback', async () => {
    const out = await tool().handler({ section: 'spec-backend-coverage-80' });

    expect(out.textResultForLlm).toContain('docs/spec-backend-coverage-80.md');
    expect(out.textResultForLlm).toContain('# spec-backend-coverage-80');
  });

  it('reports tried paths and available docs for a missing section', async () => {
    const out = await tool().handler({ section: 'definitely-not-a-real-doc' });

    expect(out.textResultForLlm).toContain('Doc "definitely-not-a-real-doc" not found');
    expect(out.textResultForLlm).toContain('Tried:');
    expect(out.textResultForLlm).toContain('README.md');
  });
});
