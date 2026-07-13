import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const eventBus = vi.hoisted(() => ({ broadcastEvent: vi.fn() }));

vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: eventBus.broadcastEvent }));

interface ToolWithHandler<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  handler: (args: TArgs) => Promise<Record<string, unknown>>;
}

let home: string;
let previousCacoHome: string | undefined;
let tools: ToolWithHandler[];
let store: typeof import('../../src/surface-store.js');

function getTool(name: string): ToolWithHandler {
  const tool = tools.find(t => t.name === name);
  expect(tool).toBeDefined();
  return tool as ToolWithHandler;
}

async function createTools(): Promise<ToolWithHandler[]> {
  const { createSurfaceTools } = await import('../../src/surface-tools.js');
  return createSurfaceTools({ id: 'sess-1' }) as unknown as ToolWithHandler[];
}

beforeEach(async () => {
  vi.resetModules();
  eventBus.broadcastEvent.mockReset();
  previousCacoHome = process.env.CACO_HOME;
  home = mkdtempSync(join(tmpdir(), 'test-caco-surface-'));
  process.env.CACO_HOME = home;
  store = await import('../../src/surface-store.js');
  tools = await createTools();
});

afterEach(() => {
  if (previousCacoHome === undefined) {
    delete process.env.CACO_HOME;
  } else {
    process.env.CACO_HOME = previousCacoHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('surface tool handlers', () => {
  it('returns initial empty surface and changes when no document exists', async () => {
    const surface = await getTool('caco_get_surface').handler({});
    const changes = await getTool('caco_get_surface_changes').handler({});

    expect(surface).toEqual({
      exists: false,
      dataToken: store.INITIAL_DATA_TOKEN,
      style: 'roadmap',
      items: [],
      changes: {},
      customScript: null,
      customStyle: null,
    });
    expect(changes).toEqual({
      exists: false,
      dataToken: store.INITIAL_DATA_TOKEN,
      changes: {},
    });
  });

  it('creates items, persists the document, and broadcasts successful updates', async () => {
    const created = await getTool('caco_mutate_surface').handler({
      dataToken: store.INITIAL_DATA_TOKEN,
      create: [{ id: 'a', type: 'note', title: 'Alpha' }],
    });

    expect(created.ok).toBe(true);
    expect(eventBus.broadcastEvent).toHaveBeenCalledWith('sess-1', {
      type: store.SURFACE_UPDATED_EVENT,
      data: { dataToken: created.dataToken, origin: 'agent' },
    });

    const surface = await getTool('caco_get_surface').handler({});
    expect(surface).toMatchObject({
      exists: true,
      dataToken: created.dataToken,
      items: [{ id: 'a', type: 'note', title: 'Alpha' }],
      changes: {},
    });

    const changes = await getTool('caco_get_surface_changes').handler({});
    expect(changes).toEqual({ exists: true, dataToken: created.dataToken, changes: {} });
  });

  it('returns stale failures without broadcasting', async () => {
    const stale = await getTool('caco_mutate_surface').handler({
      dataToken: 'stale-token',
      create: [{ id: 'a', type: 'note' }],
    });

    expect(stale).toEqual({
      ok: false,
      reason: 'stale',
      currentDataToken: store.INITIAL_DATA_TOKEN,
    });
    expect(eventBus.broadcastEvent).not.toHaveBeenCalled();
  });

  it('ack-only clears human changes and broadcasts the new token', async () => {
    const created = await getTool('caco_mutate_surface').handler({
      dataToken: store.INITIAL_DATA_TOKEN,
      create: [{ id: 'a', type: 'note', title: 'Alpha' }],
    });
    expect(created.ok).toBe(true);

    const changed = store.putChange(
      'sess-1',
      created.dataToken as string,
      'a',
      { id: 'a', type: 'note', title: 'Edited' }
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error('putChange failed');

    const pending = await getTool('caco_get_surface_changes').handler({});
    expect(pending).toEqual({
      exists: true,
      dataToken: changed.dataToken,
      changes: { a: { id: 'a', type: 'note', title: 'Edited' } },
    });

    eventBus.broadcastEvent.mockClear();
    const ack = await getTool('caco_mutate_surface').handler({ dataToken: changed.dataToken });
    expect(ack.ok).toBe(true);
    expect(eventBus.broadcastEvent).toHaveBeenCalledWith('sess-1', {
      type: store.SURFACE_UPDATED_EVENT,
      data: { dataToken: ack.dataToken, origin: 'agent' },
    });

    const cleared = await getTool('caco_get_surface_changes').handler({});
    expect(cleared).toEqual({ exists: true, dataToken: ack.dataToken, changes: {} });
  });

  it('patches style and custom renderer fields', async () => {
    const styled = await getTool('caco_set_surface_style').handler({
      dataToken: store.INITIAL_DATA_TOKEN,
      style: 'custom',
      customScript: 'function render() { return null; }',
      customStyle: '.surface { color: red; }',
    });

    expect(styled.ok).toBe(true);
    expect(eventBus.broadcastEvent).toHaveBeenCalledWith('sess-1', {
      type: store.SURFACE_UPDATED_EVENT,
      data: { dataToken: styled.dataToken, origin: 'agent' },
    });

    const surface = await getTool('caco_get_surface').handler({});
    expect(surface).toMatchObject({
      exists: true,
      dataToken: styled.dataToken,
      style: 'custom',
      customScript: 'function render() { return null; }',
      customStyle: '.surface { color: red; }',
    });
  });
});
