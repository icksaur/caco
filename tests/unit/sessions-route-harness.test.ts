/**
 * sessions route harness (Mechanism B, docs/spec-backend-coverage-80.md). Mounts
 * the real sessions router on a bare Express app with imported singletons mocked,
 * then drives real HTTP so tractable handler bodies execute without SDK access.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

type SessionRecord = { sessionId: string; name?: string; cwd: string | null; kind?: string };
type SessionMeta = {
  name?: string;
  model?: string;
  kind?: string;
  currentIntent?: string | null;
  responseOptions?: unknown;
  contextBudgetTokens?: number | null;
  reasoningEffort?: string | null;
  folder?: string;
  envHint?: string;
  context?: Record<string, string[]>;
  lastUsedAt?: string;
  parentSessionId?: string;
  isSwarmSession?: boolean;
  activeApplet?: string;
  appletParams?: Record<string, string>;
  appletPanelVisible?: boolean;
};
type CommandResult = { kind: string; text?: string; prompt?: string };
type AgentResolution = { ok: boolean; agentId?: string; status?: number; error?: string };
type RotateResult = { ok: boolean; reason?: string };

type MutableTestState = {
  activeSessionId: string | null;
  peers: Array<{ url: string; hostname: string }>;
  sessions: SessionRecord[];
  cwdById: Map<string, string>;
  metaById: Map<string, SessionMeta>;
  dataBySession: Map<string, Map<string, unknown>>;
  drafts: Map<string, string>;
  busyIds: Set<string>;
  activeIds: Set<string>;
  setDataReserved: Set<string>;
  updateMetaResult: boolean;
  archiveReject?: Error;
  iconPath: string | null;
};

const knownId = 'known';
const inactiveId = 'inactive';
const busyId = 'busy';

const state: MutableTestState = {
  activeSessionId: knownId,
  peers: [],
  sessions: [],
  cwdById: new Map(),
  metaById: new Map(),
  dataBySession: new Map(),
  drafts: new Map(),
  busyIds: new Set(),
  activeIds: new Set(),
  setDataReserved: new Set(),
  updateMetaResult: true,
  iconPath: null,
};

const resetState = () => {
  state.activeSessionId = knownId;
  state.peers = [];
  state.sessions = [
    { sessionId: knownId, name: 'Known Session', cwd: process.cwd(), kind: 'interactive' },
    { sessionId: inactiveId, name: 'Inactive Session', cwd: process.cwd(), kind: 'interactive' },
    { sessionId: busyId, name: 'Busy Session', cwd: process.cwd(), kind: 'interactive' },
    { sessionId: 'swarm', name: 'Swarm Session', cwd: process.cwd(), kind: 'swarm' },
  ];
  state.cwdById = new Map([
    [knownId, process.cwd()],
    [inactiveId, process.cwd()],
    [busyId, process.cwd()],
    ['created-id', process.cwd()],
    ['fork-id', process.cwd()],
  ]);
  state.metaById = new Map([
    [knownId, { name: 'Known Session', model: 'model-a', kind: 'interactive', lastUsedAt: '2026-01-02T00:00:00.000Z' }],
    [inactiveId, { name: 'Inactive Session', model: 'model-b', kind: 'interactive', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
    [busyId, { name: 'Busy Session', model: 'model-c', kind: 'interactive' }],
  ]);
  state.dataBySession = new Map([[knownId, new Map([['note', { value: 1 }]])]]);
  state.drafts = new Map([[knownId, 'draft text']]);
  state.busyIds = new Set([busyId]);
  state.activeIds = new Set([knownId, busyId]);
  state.setDataReserved = new Set(['reserved']);
  state.updateMetaResult = true;
  state.archiveReject = undefined;
  state.iconPath = null;
};

resetState();

const getPeers = vi.fn(() => state.peers);
const setPeers = vi.fn((peers: Array<{ url: string; hostname: string }>) => { state.peers = peers; });
const getSessionOrder = vi.fn(() => [knownId, inactiveId]);
const getSessionMeta = vi.fn((id: string) => state.metaById.get(id) ?? null);
const setSessionMeta = vi.fn((id: string, meta: SessionMeta) => { state.metaById.set(id, meta); });
const updateSessionMeta = vi.fn((id: string, updater: (meta: SessionMeta) => void, options?: { createIfMissing?: boolean }) => {
  if (!state.updateMetaResult) return false;
  const existing = state.metaById.get(id);
  if (!existing && options?.createIfMissing === false) return false;
  const meta = existing ?? {};
  updater(meta);
  state.metaById.set(id, meta);
  return true;
});
const getSessionIconPath = vi.fn(() => state.iconPath);
const listSessionData = vi.fn((id: string) => Array.from(state.dataBySession.get(id)?.keys() ?? []));
const isValidDataName = vi.fn((name: string) => /^[a-z0-9_-]+$/i.test(name));
const getSessionData = vi.fn((id: string, name: string) => state.dataBySession.get(id)?.get(name) ?? null);
const setSessionData = vi.fn((id: string, name: string, data: unknown) => {
  if (state.setDataReserved.has(name)) return false;
  const sessionData = state.dataBySession.get(id) ?? new Map<string, unknown>();
  sessionData.set(name, data);
  state.dataBySession.set(id, sessionData);
  return true;
});

const sessionManager = {
  list: vi.fn(() => state.sessions.map(s => ({ ...s }))),
  getModels: vi.fn(() => [{ id: 'model-a', name: 'Model A', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' }]),
  isActive: vi.fn((id: string) => state.activeIds.has(id)),
  isBusy: vi.fn((id: string) => state.busyIds.has(id)),
  hasMessages: vi.fn((id: string) => id === knownId),
  getSessionCwd: vi.fn((id: string) => state.cwdById.get(id) ?? null),
  getSessionModel: vi.fn((id: string) => state.metaById.get(id)?.model ?? null),
  ensureSession: vi.fn(async () => 'created-id'),
  archive: vi.fn(async (id: string) => {
    if (state.archiveReject) throw state.archiveReject;
    return { archivePath: '/archive/' + id + '.tar.gz' };
  }),
  changeCwd: vi.fn(async (id: string, cwd: string) => { state.cwdById.set(id, cwd); }),
  setSessionModel: vi.fn(async (id: string, model: string) => {
    const meta = state.metaById.get(id) ?? {};
    meta.model = model;
    state.metaById.set(id, meta);
  }),
  modelTokenLimits: vi.fn(() => ({ maxPromptTokens: 1000, maxContextWindowTokens: 1200 })),
  setSessionContextBudget: vi.fn(async (id: string, tokens: number | null) => {
    const meta = state.metaById.get(id) ?? {};
    meta.contextBudgetTokens = tokens;
    state.metaById.set(id, meta);
  }),
  setSessionReasoningEffort: vi.fn(async (id: string, effort: string | null) => {
    const meta = state.metaById.get(id) ?? {};
    meta.reasoningEffort = effort;
    state.metaById.set(id, meta);
  }),
  compactSession: vi.fn(async (id: string, customInstructions?: string) => ({ ok: true, sessionId: id, customInstructions: customInstructions ?? null })),
  resume: vi.fn(async (id: string) => { state.activeIds.add(id); return { sessionId: id }; }),
  listAgents: vi.fn(async () => [{ id: 'agent-a', name: 'agent-a', displayName: 'Agent A' }]),
  listCommands: vi.fn(async () => [{ name: 'skill-a', description: 'Skill A' }, { name: 'plain', description: 'Plain' }]),
  selectAgent: vi.fn(async (_id: string, agentId: string) => ({ id: agentId, displayName: 'Agent A' })),
  invokeCommand: vi.fn(async (): Promise<CommandResult> => ({ kind: 'text', text: 'skill ran' })),
  forkSession: vi.fn(async () => ({ sessionId: 'fork-id', cwd: process.cwd() })),
  refreshCache: vi.fn(),
};

const sessionState = {
  get activeSessionId() { return state.activeSessionId; },
  preferences: { lastCwd: process.cwd() },
  ensureSession: vi.fn(async (_model?: string, _forceNew?: boolean, cwd?: string) => {
    state.cwdById.set('created-id', cwd ?? process.cwd());
    return 'created-id';
  }),
  getActiveSessionId: vi.fn(() => state.activeSessionId),
  prepareNewChat: vi.fn(async () => undefined),
  getSessionConfig: vi.fn(() => ({ model: 'model-a' })),
  switchSession: vi.fn(async (id: string) => ({ sessionId: id, usedFallbackCwd: false })),
  deleteSession: vi.fn(async () => undefined),
};

const getScheduleForSession = vi.fn(async (id: string) => (id === knownId ? { slug: 'daily', nextRun: 'tomorrow' } : null));
const readSessionWorkspace = vi.fn((id: string) => ({ cwd: state.cwdById.get(id) ?? process.cwd() }));
const searchSessionEvents = vi.fn((id: string, query: string) => ({
  totalMatches: id === knownId && query === 'needle' ? 1 : 0,
  matches: id === knownId && query === 'needle'
    ? [{ snippet: 'hay needle stack', matchStart: 4, matchEnd: 10, eventType: 'assistant.message', timestamp: '2026-01-02T00:00:00.000Z' }]
    : [],
}));
const getEventVersion = vi.fn(() => 7);
const rotateSessionHistory = vi.fn(async (): Promise<RotateResult> => ({ ok: true }));
const normalizeFolder = vi.fn((folder: string) => (folder === '/' || folder.toLowerCase() === 'root' ? undefined : folder.trim()));
const isValidFolder = vi.fn((folder: string) => /^[\w -]+$/.test(folder));
const unobservedTracker = { getCount: vi.fn(() => 3), markObserved: vi.fn(() => true) };
const broadcastGlobalEvent = vi.fn();
const broadcastEvent = vi.fn();
const mergeContextSet = vi.fn((current: string[], items: string[], mode: string) => (mode === 'merge' ? [...current, ...items] : items));
const dispatchMessage = vi.fn(async () => undefined);
class DispatchHttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const prefixMessageSource = vi.fn((_source: string, _name: string, message: string) => message);
const getSessionDraft = vi.fn((id: string) => state.drafts.get(id) ?? null);
const setSessionDraft = vi.fn((id: string, text: string) => {
  if (!state.cwdById.has(id)) return 'missing-session';
  state.drafts.set(id, text);
  return 'ok';
});
const deleteSessionDraft = vi.fn((id: string) => {
  if (!state.cwdById.has(id)) return 'missing-session';
  state.drafts.delete(id);
  return 'ok';
});
const modelCostSummary = vi.fn(() => ({ multiplier: 1, priceCategory: 'standard', category: 'standard', inputPerMtok: 1, outputPerMtok: 2, cachePerMtok: 0.1, contextWindow: 1000 }));
const throughputSnapshot = vi.fn((id: string) => ({ sessionId: id, inputTokensPerSecond: 1, outputTokensPerSecond: 2 }));
const visibleAgents = vi.fn((agents: unknown[]) => agents);
const resolveAgentSelection = vi.fn((): AgentResolution => ({ ok: true, agentId: 'agent-a' }));
const filterSkillCommands = vi.fn((commands: Array<{ name: string; description?: string }>) => commands.filter(c => c.name.startsWith('skill-')));
const skillToolEnabled = vi.fn(() => true);

vi.mock('../../src/session-manager.js', () => ({ sessionManager }));
vi.mock('../../src/session-state.js', () => ({ sessionState }));
vi.mock('../../src/schedule-store.js', () => ({ getScheduleForSession }));
vi.mock('../../src/storage.js', () => ({
  getSessionMeta,
  setSessionMeta,
  updateSessionMeta,
  getSessionIconPath,
  getSessionData,
  setSessionData,
  listSessionData,
  isValidDataName,
  getPeers,
  setPeers,
  getSessionOrder,
}));
vi.mock('../../src/sdk-session-store.js', () => ({ readSessionWorkspace, searchSessionEvents, getEventVersion }));
vi.mock('../../src/session-history-rotation.js', () => ({ rotateSessionHistory }));
vi.mock('../../src/folder.js', () => ({ normalizeFolder, isValidFolder }));
vi.mock('../../src/unobserved-tracker.js', () => ({ unobservedTracker }));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastGlobalEvent, broadcastEvent }));
vi.mock('../../src/context-tools.js', () => ({ mergeContextSet, KNOWN_SET_NAMES: new Set(['files', 'symbols']) }));
vi.mock('../../src/routes/session-messages.js', () => ({ dispatchMessage, DispatchHttpError }));
vi.mock('../../src/message-source.js', () => ({ prefixMessageSource }));
vi.mock('../../src/chat-draft-store.js', () => ({ getSessionDraft, setSessionDraft, deleteSessionDraft }));
vi.mock('../../src/model-billing.js', () => ({ modelCostSummary }));
vi.mock('../../src/session-throughput.js', () => ({ snapshot: throughputSnapshot }));
vi.mock('../../src/agent-command.js', () => ({ resolveAgentSelection, visibleAgents, filterSkillCommands }));
vi.mock('../../src/tool-registry.js', () => ({ skillToolEnabled }));

let server: Server;
let base: string;

beforeAll(async () => {
  const { router } = await import('../../src/routes/sessions.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

const request = (path: string, init?: RequestInit) => fetch(base + path, init);
const jsonRequest = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => request(path, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const postJson = (path: string, body: unknown, headers?: Record<string, string>) => jsonRequest('POST', path, body, headers);
const putJson = (path: string, body: unknown) => jsonRequest('PUT', path, body);
const patchJson = (path: string, body: unknown) => jsonRequest('PATCH', path, body);
const deleteRequest = (path: string, headers: Record<string, string> = {}) => request(path, { method: 'DELETE', headers });

describe('sessions route harness', () => {
  it('gets peers and stores only remote peers', async () => {
    state.peers = [{ url: 'http://remote:53000', hostname: 'remote' }];
    expect(await (await request('/peers')).json()).toEqual([{ url: 'http://remote:53000', hostname: 'remote' }]);
    expect((await postJson('/peers', { url: 'nope' })).status).toBe(400);
    const saved = await postJson('/peers', [
      { url: 'http://localhost:53000', hostname: 'self' },
      { url: 'http://other:53000', hostname: 'other' },
      { url: '', hostname: 'bad' },
    ]);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, count: 1 });
    expect(setPeers).toHaveBeenCalledWith([{ url: 'http://other:53000', hostname: 'other' }]);
  });

  it('returns current session fallback and active session details', async () => {
    state.activeSessionId = null;
    expect(await (await request('/session')).json()).toMatchObject({ sessionId: null, isActive: false, hasMessages: false });
    state.activeSessionId = knownId;
    expect(await (await request('/session')).json()).toMatchObject({ sessionId: knownId, cwd: process.cwd(), isActive: true, hasMessages: true });
    expect(await (await request('/session?sessionId=inactive')).json()).toMatchObject({ sessionId: inactiveId, isActive: false, hasMessages: false });
  });

  it('lists sessions with schedules, order, unobserved count, and model costs', async () => {
    const body = await (await request('/sessions')).json();
    expect(body.activeSessionId).toBe(knownId);
    expect(body.sessionOrder).toEqual([knownId, inactiveId]);
    expect(body.unobservedCount).toBe(3);
    expect(body.sessions[0]).toMatchObject({ sessionId: knownId, scheduleSlug: 'daily', scheduleNextRun: 'tomorrow' });
    expect(body.models[0]).toMatchObject({ id: 'model-a', cost: 1, supportsReasoningEffort: true });
  });

  it('searches session events and ignores empty queries and swarm sessions', async () => {
    expect(await (await request('/sessions/search?q=')).json()).toEqual({ results: [] });
    const body = await (await request('/sessions/search?q=needle')).json();
    expect(body.query).toBe('needle');
    expect(body.results[0]).toMatchObject({ sessionId: knownId, name: 'Known Session', matchCount: 1 });
    expect(searchSessionEvents).not.toHaveBeenCalledWith('swarm', 'needle');
  });

  it('creates a session after validating cwd and stores metadata', async () => {
    const bad = await postJson('/sessions', { cwd: process.cwd() + '/definitely-not-here' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/does not exist/);
    const res = await postJson('/sessions', { cwd: process.cwd(), model: 'model-a', description: 'New name', parentSessionId: knownId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'created-id', cwd: process.cwd(), model: 'model-a' });
    expect(sessionState.ensureSession).toHaveBeenCalledWith('model-a', true, process.cwd(), undefined);
    expect(state.metaById.get('created-id')).toMatchObject({ kind: 'agent', name: 'New name', parentSessionId: knownId });
    expect(broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.listChanged', data: { reason: 'created', sessionId: 'created-id' } });
  });

  it('returns state for existing sessions and 404s missing sessions', async () => {
    expect((await request('/sessions/missing/state')).status).toBe(404);
    expect(await (await request('/sessions/known/state')).json()).toMatchObject({ sessionId: knownId, status: 'idle', cwd: process.cwd(), model: 'model-a', isActive: true, isBusy: false });
    expect((await (await request('/sessions/busy/state')).json()).status).toBe('busy');
    expect((await (await request('/sessions/inactive/state')).json()).status).toBe('inactive');
  });

  it('returns throughput snapshots', async () => {
    expect(await (await request('/sessions/known/throughput')).json()).toEqual({ sessionId: knownId, inputTokensPerSecond: 1, outputTokensPerSecond: 2 });
    expect(throughputSnapshot).toHaveBeenCalledWith(knownId);
  });

  it('lists, reads, validates, and writes session data', async () => {
    expect(await (await request('/sessions/known/data')).json()).toEqual(['note']);
    expect(await (await request('/sessions/known/data/note')).json()).toEqual({ value: 1 });
    expect(await (await request('/sessions/known/data/missing')).json()).toEqual({});
    expect((await request('/sessions/known/data/bad.name')).status).toBe(400);
    expect((await putJson('/sessions/known/data/reserved', { no: true })).status).toBe(403);
    const written = await putJson('/sessions/known/data/new_name', { ok: true });
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ ok: true });
    expect(state.dataBySession.get(knownId)?.get('new_name')).toEqual({ ok: true });
  });

  it('gets, writes, deletes, and 404s session drafts', async () => {
    expect(await (await request('/sessions/known/draft')).text()).toBe('draft text');
    expect((await request('/sessions/missing/draft')).status).toBe(404);
    expect((await request('/sessions/known/draft', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'new draft' })).status).toBe(204);
    expect(state.drafts.get(knownId)).toBe('new draft');
    expect((await request('/sessions/missing/draft', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(404);
    expect((await deleteRequest('/sessions/known/draft')).status).toBe(204);
    expect(state.drafts.has(knownId)).toBe(false);
    expect((await deleteRequest('/sessions/missing/draft')).status).toBe(404);
  });

  it('404s a missing icon and streams an existing icon path', async () => {
    expect((await request('/sessions/known/icon')).status).toBe(404);
    state.iconPath = 'package.json';
    const res = await request('/sessions/known/icon');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(await res.text()).toContain('"name": "caco"');
  });

  it('patches metadata and rejects missing sessions, invalid folders, busy model changes, and bad budgets', async () => {
    expect((await patchJson('/sessions/missing', { name: 'Nope' })).status).toBe(404);
    expect((await patchJson('/sessions/known', { folder: 'bad/path' })).status).toBe(400);
    expect((await patchJson('/sessions/busy', { model: 'new-model' })).status).toBe(409);
    expect((await patchJson('/sessions/known', { contextBudgetTokens: -1 })).status).toBe(400);
    state.updateMetaResult = false;
    expect((await patchJson('/sessions/known', { name: 'Unreadable' })).status).toBe(409);
    resetState();
    const res = await patchJson('/sessions/known', { name: 'Renamed', envHint: 'linux', folder: 'Work', setContext: { setName: 'files', items: ['a.ts'], mode: 'replace' }, contextBudgetTokens: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(state.metaById.get(knownId)).toMatchObject({ name: 'Renamed', envHint: 'linux', folder: 'Work', contextBudgetTokens: 50, context: { files: ['a.ts'] } });
    expect(broadcastEvent).toHaveBeenCalledWith(knownId, { type: 'caco.context', data: { reason: 'changed', context: { files: ['a.ts'] }, setName: 'files' } });
    expect(broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.listChanged', data: { reason: 'updated', sessionId: knownId } });
  });

  it('patches cwd and reasoning effort with validation', async () => {
    expect((await patchJson('/sessions/known', { cwd: process.cwd() + '/definitely-not-here' })).status).toBe(400);
    const cwdRes = await patchJson('/sessions/known', { cwd: process.cwd() });
    expect(cwdRes.status).toBe(200);
    expect(await cwdRes.json()).toMatchObject({ success: true, cwd: process.cwd(), hasGit: true });
    expect(sessionManager.changeCwd).toHaveBeenCalledWith(knownId, process.cwd());
    expect((await patchJson('/sessions/inactive', { reasoningEffort: 'low' })).status).toBe(404);
    expect((await patchJson('/sessions/known', { reasoningEffort: 'low' })).status).toBe(200);
    expect(sessionManager.setSessionReasoningEffort).toHaveBeenCalledWith(knownId, 'low');
  });

  it('archives sessions with busy and error branches', async () => {
    const busy = await deleteRequest('/sessions/busy');
    expect(busy.status).toBe(400);
    expect(await busy.json()).toMatchObject({ code: 'SESSION_BUSY' });
    state.archiveReject = new Error('archive failed');
    const failed = await deleteRequest('/sessions/known');
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toBe('archive failed');
    resetState();
    const res = await deleteRequest('/sessions/known', { 'x-client-id': 'client-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, wasActive: true, archivePath: '/archive/known.tar.gz' });
    expect(sessionState.prepareNewChat).toHaveBeenCalledWith(process.cwd(), 'client-1');
    expect(broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.listChanged', data: { reason: 'deleted', sessionId: knownId } });
  });

  it('observes sessions and 404s missing sessions', async () => {
    expect((await postJson('/sessions/missing/observe', {})).status).toBe(404);
    const res = await postJson('/sessions/known/observe', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, wasUnobserved: true, unobservedCount: 3 });
    expect(unobservedTracker.markObserved).toHaveBeenCalledWith(knownId);
  });

  it('compacts active sessions and 404s inactive sessions', async () => {
    expect((await postJson('/sessions/inactive/compact', {})).status).toBe(404);
    const res = await postJson('/sessions/known/compact', { customInstructions: 'shorten' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: knownId, customInstructions: 'shorten' });
    expect(sessionManager.compactSession).toHaveBeenCalledWith(knownId, 'shorten');
  });

  it('lists agents for active and inactive sessions and 404s missing sessions', async () => {
    expect((await request('/sessions/missing/agents')).status).toBe(404);
    const inactive = await request('/sessions/inactive/agents');
    expect(inactive.status).toBe(200);
    expect(sessionManager.resume).toHaveBeenCalledWith(inactiveId, { model: 'model-a' });
    expect(await inactive.json()).toEqual({ agents: [{ id: 'agent-a', name: 'agent-a', displayName: 'Agent A' }] });
    vi.clearAllMocks();
    expect((await request('/sessions/known/agents')).status).toBe(200);
    expect(sessionManager.resume).not.toHaveBeenCalled();
  });

  it('lists skills for active and inactive sessions and 404s missing sessions', async () => {
    expect((await request('/sessions/missing/skills')).status).toBe(404);
    const inactive = await request('/sessions/inactive/skills');
    expect(inactive.status).toBe(200);
    expect(sessionManager.resume).toHaveBeenCalledWith(inactiveId, { model: 'model-a' });
    expect(await inactive.json()).toEqual({ skills: [{ name: 'skill-a', description: 'Skill A' }] });
    vi.clearAllMocks();
    expect((await request('/sessions/known/skills')).status).toBe(200);
    expect(sessionManager.resume).not.toHaveBeenCalled();
  });

  it('rotates session history with 404, conflict, error, and success branches', async () => {
    expect((await postJson('/sessions/missing/rotate', {})).status).toBe(404);
    rotateSessionHistory.mockResolvedValueOnce({ ok: false, reason: 'busy' });
    const conflict = await postJson('/sessions/known/rotate', {});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ success: false, ok: false, reason: 'busy' });
    rotateSessionHistory.mockRejectedValueOnce(new Error('refused now'));
    const error = await postJson('/sessions/known/rotate', {});
    expect(error.status).toBe(409);
    expect(await error.json()).toMatchObject({ success: false, reason: 'refused', error: 'refused now' });
    const success = await postJson('/sessions/known/rotate', {});
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ success: true, ok: true });
  });

  it('patches applet params only when metadata and an active applet exist', async () => {
    expect((await patchJson('/sessions/missing/applet', { appletParams: { a: 'b' } })).status).toBe(404);
    const ignored = await patchJson('/sessions/known/applet', { appletParams: { a: 'b' } });
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ok: true, ignored: 'no active applet' });
    const meta = state.metaById.get(knownId);
    expect(meta).toBeTruthy();
    meta!.activeApplet = 'files';
    const updated = await patchJson('/sessions/known/applet', { appletParams: { openPath: 'README.md' }, panelVisible: false });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ ok: true });
    expect(state.metaById.get(knownId)).toMatchObject({ appletParams: { openPath: 'README.md' }, appletPanelVisible: false });
  });

  it('selects agents with validation, busy, resolution, and success branches', async () => {
    expect((await postJson('/sessions/known/agent-select', {})).status).toBe(400);
    expect((await postJson('/sessions/missing/agent-select', { input: 'agent' })).status).toBe(404);
    expect((await postJson('/sessions/busy/agent-select', { input: 'agent' })).status).toBe(409);
    resolveAgentSelection.mockReturnValueOnce({ ok: false, status: 404, error: 'no agent' });
    const unresolved = await postJson('/sessions/known/agent-select', { input: 'nope' });
    expect(unresolved.status).toBe(404);
    expect(await unresolved.json()).toEqual({ error: 'no agent' });
    const selected = await postJson('/sessions/known/agent-select', { input: 'agent-a' });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ ok: true, sessionId: knownId, agentId: 'agent-a' });
    expect(sessionManager.selectAgent).toHaveBeenCalledWith(knownId, 'agent-a');
    expect(broadcastEvent).toHaveBeenCalledWith(knownId, { type: 'caco.agent_selected', data: { agentId: 'agent-a', displayName: 'Agent A' } });
  });

  it('invokes skills through text and dispatch prompt results with validation branches', async () => {
    expect((await postJson('/sessions/known/skill-invoke', {})).status).toBe(400);
    skillToolEnabled.mockReturnValueOnce(false);
    expect((await postJson('/sessions/known/skill-invoke', { name: 'skill-a' })).status).toBe(400);
    expect((await postJson('/sessions/missing/skill-invoke', { name: 'skill-a' })).status).toBe(404);
    expect((await postJson('/sessions/busy/skill-invoke', { name: 'skill-a' })).status).toBe(409);
    expect((await postJson('/sessions/known/skill-invoke', { name: 'missing-skill' })).status).toBe(404);
    const text = await postJson('/sessions/known/skill-invoke', { name: 'skill-a', input: 'go' });
    expect(text.status).toBe(200);
    expect(await text.json()).toEqual({ ok: true, sessionId: knownId });
    expect(broadcastEvent).toHaveBeenCalledWith(knownId, { type: 'session.info', data: { message: 'skill ran' } });
    sessionManager.invokeCommand.mockResolvedValueOnce({ kind: 'agent-prompt', prompt: '' });
    const prompt = await postJson('/sessions/known/skill-invoke', { name: 'skill-a', input: 'do it' }, { 'x-request-id': 'req-1' });
    expect(prompt.status).toBe(200);
    expect(dispatchMessage).toHaveBeenCalledWith(
      knownId,
      'Use the skill tool to invoke the "skill-a" skill, then follow the skill\'s instructions to help with: do it',
      expect.objectContaining({ requestId: 'req-1', needsObservation: true }),
      expect.any(Object)
    );
  });

  it('forks sessions through manager and caco metadata setup', async () => {
    expect((await postJson('/sessions/missing/fork', {})).status).toBe(404);
    const parentMeta = state.metaById.get(knownId);
    expect(parentMeta).toBeTruthy();
    parentMeta!.name = 'Parent';
    parentMeta!.folder = 'Work';
    const res = await postJson('/sessions/known/fork', { toEventId: 'evt-1', initialMessage: 'hello child' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: 'fork-id', cwd: process.cwd(), name: '[fork] Parent', model: 'model-a' });
    expect(sessionManager.forkSession).toHaveBeenCalledWith(knownId, 'evt-1');
    expect(setSessionMeta).toHaveBeenCalledWith('fork-id', expect.objectContaining({ name: '[fork] Parent', folder: 'Work', parentSessionId: knownId, kind: 'interactive' }));
    expect(broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.listChanged', data: { reason: 'forked', sessionId: 'fork-id', parentId: knownId } });
  });
});
