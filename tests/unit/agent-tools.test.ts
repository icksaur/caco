import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({ getModels: vi.fn() }));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: manager }));

import { SERVER_URL } from '../../src/config.js';
import { createAgentTools, type GetCorrelationId } from '../../src/agent-tools.js';

interface ToolWithHandler<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  handler: (args: TArgs) => Promise<Record<string, unknown>>;
}

type FetchCall = [string | URL | Request, RequestInit | undefined];

let originalFetch: typeof fetch;
let fetchMock: ReturnType<typeof vi.fn>;
let getCorrelationId: GetCorrelationId;
let getCorrelationIdMock: ReturnType<typeof vi.fn>;

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function createTools(): ToolWithHandler[] {
  return createAgentTools({ id: 'parent-1' }, getCorrelationId) as unknown as ToolWithHandler[];
}

function getTool(tools: ToolWithHandler[], name: string): ToolWithHandler {
  const tool = tools.find(t => t.name === name);
  expect(tool).toBeDefined();
  return tool as ToolWithHandler;
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call[1]?.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  manager.getModels.mockReset();
  manager.getModels.mockReturnValue([{ id: 'auto' }, { id: 'claude-sonnet-4.6' }]);
  getCorrelationIdMock = vi.fn(() => 'corr-1');
  getCorrelationId = getCorrelationIdMock as unknown as GetCorrelationId;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('agent tool handlers', () => {
  it('gets session state after stripping caco-session prefix', async () => {
    fetchMock.mockResolvedValue(response({ state: 'idle', sessionId: 'child-1' }));

    const out = await getTool(createTools(), 'get_session_state').handler({
      sessionId: 'caco-session:child-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(`${SERVER_URL}/api/sessions/child-1/state`);
    expect(out).toEqual({
      textResultForLlm: JSON.stringify({ state: 'idle', sessionId: 'child-1' }, null, 2),
      resultType: 'text',
    });
  });

  it('reports missing and failed session state responses', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'missing' }, { status: 404, statusText: 'Not Found' }));
    const missing = await getTool(createTools(), 'get_session_state').handler({ sessionId: 'missing' });
    expect(missing).toEqual({ textResultForLlm: 'Session missing not found', resultType: 'error' });

    fetchMock.mockResolvedValueOnce(response({ error: 'nope' }, { status: 500, statusText: 'Server Error' }));
    const failed = await getTool(createTools(), 'get_session_state').handler({ sessionId: 'broken' });
    expect(failed).toEqual({ textResultForLlm: 'Failed to get session state: Server Error', resultType: 'error' });
  });

  it('reports fetch errors while getting session state', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const out = await getTool(createTools(), 'get_session_state').handler({ sessionId: 'child-1' });

    expect(out).toEqual({ textResultForLlm: 'Error getting session state: network down', resultType: 'error' });

    fetchMock.mockRejectedValue('socket closed');
    const nonError = await getTool(createTools(), 'get_session_state').handler({ sessionId: 'child-1' });
    expect(nonError).toEqual({ textResultForLlm: 'Error getting session state: socket closed', resultType: 'error' });
  });

  it('rejects unknown models before posting a create request', async () => {
    const out = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'missing-model',
    });

    expect(out).toEqual({
      textResultForLlm: 'Unknown model "missing-model". Available: auto, claude-sonnet-4.6.',
      resultType: 'error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a session without an initial message', async () => {
    fetchMock.mockResolvedValue(response({ sessionId: 'child-1' }));

    const out = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
      description: 'Research task',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER_URL}/api/sessions`, expect.objectContaining({ method: 'POST' }));
    expect(jsonBody(fetchMock.mock.calls[0] as FetchCall)).toEqual({
      cwd: '/workspace/project',
      model: 'auto',
      parentSessionId: 'parent-1',
      description: 'Research task',
      kind: 'agent',
    });
    expect(out).toEqual({
      textResultForLlm: 'Created Caco session child-1 in /workspace/project. Use caco_session_delegate to send it work and await its reply.',
      resultType: 'text',
    });
  });

  it('creates a session and sends an initial message with correlation id', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ sessionId: 'child-1' }))
      .mockResolvedValueOnce(response({ ok: true }));

    const out = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'claude-sonnet-4.6',
      initialMessage: 'Start work',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${SERVER_URL}/api/sessions/child-1/messages`);
    expect(jsonBody(fetchMock.mock.calls[1] as FetchCall)).toEqual({
      prompt: 'Start work',
      source: 'agent',
      fromSession: 'parent-1',
      correlationId: 'corr-1',
    });
    expect(getCorrelationIdMock).toHaveBeenCalledWith('parent-1');
    expect(out).toEqual({
      textResultForLlm: 'Created Caco session child-1 in /workspace/project. It will work independently — the user can watch its progress in the session list.',
      resultType: 'text',
    });
  });

  it('reports create and initial-message failures', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'bad cwd' }, { status: 400, statusText: 'Bad Request' }));
    const createFailed = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
    });
    expect(createFailed).toEqual({ textResultForLlm: 'Failed to create session: bad cwd', resultType: 'error' });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Service Unavailable',
      json: vi.fn().mockRejectedValue(new Error('not json')),
    });
    const statusTextFailed = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
    });
    expect(statusTextFailed).toEqual({
      textResultForLlm: 'Failed to create session: Service Unavailable',
      resultType: 'error',
    });

    fetchMock
      .mockResolvedValueOnce(response({ sessionId: 'child-2' }))
      .mockResolvedValueOnce(response({ error: 'busy' }, { status: 409, statusText: 'Conflict' }));
    const messageFailed = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
      initialMessage: 'Start work',
    });
    expect(messageFailed).toEqual({
      textResultForLlm: 'Session created (child-2) but failed to send initial message: Conflict',
      resultType: 'text',
    });
  });

  it('reports fetch errors while creating a session', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    const out = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
    });

    expect(out).toEqual({ textResultForLlm: 'Error creating session: connection refused', resultType: 'error' });

    fetchMock.mockRejectedValue('offline');
    const nonError = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '/workspace/project',
      model: 'auto',
    });
    expect(nonError).toEqual({ textResultForLlm: 'Error creating session: offline', resultType: 'error' });
  });
});

describe('create_caco_session incomplete arguments', () => {
  it('names a dropped required argument instead of failing opaquely', async () => {
    // Same exposure as the delegate incident: initialMessage is long free text and
    // the required identifiers can be lost when the argument stream is truncated.
    const out = await getTool(createTools(), 'create_caco_session').handler({
      model: 'auto',
      initialMessage: 'a very long instruction',
    });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('cwd');
    expect(out.textResultForLlm).toMatch(/re-send/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names every missing argument at once', async () => {
    const out = await getTool(createTools(), 'create_caco_session').handler({});

    expect(out.textResultForLlm).toContain('cwd');
    expect(out.textResultForLlm).toContain('model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a blank argument as missing, before the unknown-model check', async () => {
    const out = await getTool(createTools(), 'create_caco_session').handler({
      cwd: '   ',
      model: 'auto',
    });

    expect(out.textResultForLlm).toContain('cwd');
    expect(out.textResultForLlm).not.toMatch(/unknown model/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
