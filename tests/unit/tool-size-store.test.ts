import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolKey } from '../../src/tool-key.js';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn((): string => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('fs', () => fsMock);

import {
  recordToolSize, getToolSize, getToolSizes, recordObservedSizes, _resetToolSizeStoreForTest,
} from '../../src/tool-size-store.js';
import { estimateToolTokens } from '../../src/tool-size.js';

const KEY = 'github-mcp-server-list_issues' as ToolKey;

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.readFileSync.mockImplementation(() => { throw new Error('no file'); });
  _resetToolSizeStoreForTest();
});

describe('tool-size-store — observed MCP definition sizes', () => {
  it('records and reads back a size', () => {
    recordToolSize(KEY, 200);
    expect(getToolSize(KEY)).toBe(200);
  });

  it('last valid value wins on change', () => {
    recordToolSize(KEY, 200);
    recordToolSize(KEY, 260);
    expect(getToolSize(KEY)).toBe(260);
  });

  it('rejects non-finite / ≤0 / absurd values (no poisoning)', () => {
    recordToolSize(KEY, 0);
    recordToolSize(KEY, -5);
    recordToolSize(KEY, Number.NaN);
    recordToolSize(KEY, 10_000_000); // over the cap
    expect(getToolSize(KEY)).toBeUndefined();
  });

  it('unknown key reads undefined (never 0)', () => {
    expect(getToolSize('never-seen' as ToolKey)).toBeUndefined();
  });

  it('persists on change', () => {
    recordToolSize(KEY, 200);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    const written = JSON.parse((fsMock.writeFileSync.mock.calls.at(-1) as unknown[])[1] as string);
    expect(written[KEY]).toBe(200);
  });

  it('does not throw when persistence fails', () => {
    fsMock.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => recordToolSize(KEY, 200)).not.toThrow();
    expect(getToolSize(KEY)).toBe(200); // still in memory
  });

  it('reloads persisted state, filtering invalid entries', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ [KEY]: 200, bad: -1, huge: 10_000_000 }));
    _resetToolSizeStoreForTest();
    expect(getToolSize(KEY)).toBe(200);
    expect(getToolSize('bad' as ToolKey)).toBeUndefined();
    expect(getToolSize('huge' as ToolKey)).toBeUndefined();
  });
});

describe('recordObservedSizes — the capture seam (MCP-only, schema-gated)', () => {
  it('records an MCP entry with a schema, keyed by model-facing name', () => {
    const schema = { properties: { state: { type: 'string' } } };
    recordObservedSizes([
      { name: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues', input_schema: schema, description: 'List issues' },
    ]);
    expect(getToolSize(KEY)).toBe(estimateToolTokens({ name: 'github-mcp-server-list_issues', description: 'List issues', parameters: schema }));
  });

  it('skips a non-MCP entry (no server/tool identity)', () => {
    recordObservedSizes([{ name: 'view', input_schema: { properties: {} } }]);
    expect(getToolSizes().size).toBe(0);
  });

  it('skips an MCP entry with no schema', () => {
    recordObservedSizes([{ name: 'x', mcpServerName: 's', mcpToolName: 't' }]);
    expect(getToolSizes().size).toBe(0);
  });

  it('persists ONCE per snapshot, not once per entry (no write amplification)', () => {
    recordObservedSizes([
      { name: 'github-mcp-server-a', mcpServerName: 'github-mcp-server', mcpToolName: 'a', input_schema: { properties: { x: { type: 'string' } } } },
      { name: 'github-mcp-server-b', mcpServerName: 'github-mcp-server', mcpToolName: 'b', input_schema: { properties: { y: { type: 'number' } } } },
      { name: 'github-mcp-server-c', mcpServerName: 'github-mcp-server', mcpToolName: 'c', input_schema: { properties: { z: { type: 'boolean' } } } },
    ]);
    expect(getToolSizes().size).toBe(3);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1); // 3 new entries, 1 write
  });

  it('does not persist when a snapshot changes nothing (all sizes already known)', () => {
    const entry = { name: 'github-mcp-server-a', mcpServerName: 'github-mcp-server', mcpToolName: 'a', input_schema: { properties: { x: { type: 'string' } } } };
    recordObservedSizes([entry]);
    fsMock.writeFileSync.mockClear();
    recordObservedSizes([entry]); // identical → no change → no write
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });
});
