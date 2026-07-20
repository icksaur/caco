// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../../public/ts/types.js';

type SessionPanelModule = typeof import('../../public/ts/session-panel.js');
type GlobalEvent = { type: string; data?: unknown };
type TrackerState = { busy?: boolean; unobserved?: boolean; intent?: string };
type TrackerCallback = (sessionId: string, state: { busy: boolean; unobserved?: boolean; intent?: string }) => void;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

let fetchMock: ReturnType<typeof vi.fn>;
let getActiveSessionIdMock: ReturnType<typeof vi.fn>;
let getAvailableModelsMock: ReturnType<typeof vi.fn>;
let notifySessionArchivedMock: ReturnType<typeof vi.fn>;
let setAvailableModelsMock: ReturnType<typeof vi.fn>;
let showSessionPanelMock: ReturnType<typeof vi.fn>;
let sessionClickMock: ReturnType<typeof vi.fn>;
let newSessionClickMock: ReturnType<typeof vi.fn>;
let onGlobalEventMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;
let refreshUsageDisplaysMock: ReturnType<typeof vi.fn>;
let repaintUsageDisplaysMock: ReturnType<typeof vi.fn>;
let sessionTrackerMock: {
  get: ReturnType<typeof vi.fn>;
  syncFromList: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  setBusy: ReturnType<typeof vi.fn>;
  getBusyCount: ReturnType<typeof vi.fn>;
  getUnobservedCount: ReturnType<typeof vi.fn>;
};
let globalEventCallbacks: Array<(event: GlobalEvent) => void>;
let trackerCallbacks: TrackerCallback[];
let trackerState: Map<string, TrackerState>;
let activeSessionId: string | null;
let busyCount: number;
let unobservedCount: number;

function jsonResponse(data: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(data) } as unknown as Response;
}

function fixture(): void {
  document.body.innerHTML = [
    '<div id="sessionView"></div>',
    '<div id="sessionList"></div>',
    '<div id="schedulesList"></div>',
    '<span id="unobservedBadge" class="hidden"></span>',
    '<span id="menuBusyIndicator" class="hidden"></span>',
    '<input id="sessionSearchInput" />'
  ].join('');
}

function cannedSessions(): SessionData[] {
  return [
    {
      sessionId: 'root-new',
      cwd: '/repo/root',
      model: 'sonnet',
      name: 'Root session',
      updatedAt: '2026-07-11T15:00:00.000Z',
      currentIntent: 'editing tests',
      isHerdParent: true
    },
    {
      sessionId: 'active-root',
      cwd: '/repo/active',
      model: 'opus',
      summary: 'Active summary',
      isUnobserved: true,
      updatedAt: '2026-07-11T14:00:00.000Z'
    },
    {
      sessionId: 'work-busy',
      cwd: '/repo/work',
      model: 'sonnet',
      name: 'Busy worker',
      folder: 'work',
      isBusy: true,
      hasIcon: true,
      updatedAt: '2026-07-11T13:00:00.000Z'
    },
    {
      sessionId: 'alpha-child',
      cwd: '/repo/alpha',
      model: 'mini',
      summary: 'Alpha child',
      folder: 'alpha',
      orchestratedBy: 'root-new',
      currentIntent: 'checking child'
    },
    {
      sessionId: 'unknown-cwd',
      cwd: '(unknown)',
      summary: 'Filtered unknown'
    },
    {
      sessionId: 'idle-swarm',
      cwd: '/repo/swarm',
      kind: 'swarm',
      summary: 'Idle swarm',
      isBusy: false
    }
  ];
}

function fetchCall(path: string, method?: string): [FetchInput, FetchInit | undefined] | undefined {
  const call = fetchMock.mock.calls.find((args: unknown[]) => {
    const [input, init] = args as [FetchInput, FetchInit | undefined];
    const inputPath = String(input);
    const requestMethod = init?.method ?? 'GET';
    return inputPath === path && (!method || requestMethod === method);
  });
  return call as [FetchInput, FetchInit | undefined] | undefined;
}

function mockFetch(implementation: (input: FetchInput, init?: FetchInit) => Promise<Response>): void {
  fetchMock.mockImplementation(implementation as (...args: unknown[]) => unknown);
}

function dragEvent(type: string, dataTransfer: Partial<DataTransfer>): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value))
  };
}

async function importPanel(collapsedFolders: string[] = []): Promise<SessionPanelModule> {
  vi.resetModules();
  fixture();
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  if (collapsedFolders.length > 0) {
    localStorage.setItem('caco:collapsed-folders', JSON.stringify(collapsedFolders));
  }

  globalEventCallbacks = [];
  trackerCallbacks = [];
  trackerState = new Map();
  activeSessionId = 'active-root';
  busyCount = 0;
  unobservedCount = 0;

  fetchMock = vi.fn(async () => {
    throw new Error('unexpected fetch call');
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));

  getActiveSessionIdMock = vi.fn(() => activeSessionId);
  getAvailableModelsMock = vi.fn(() => [
    { id: 'sonnet', name: 'Claude Sonnet', cost: 1 },
    { id: 'opus', name: 'Claude Opus', cost: 2 },
    { id: 'mini', name: 'GPT Mini', cost: 0.5 }
  ]);
  notifySessionArchivedMock = vi.fn();
  setAvailableModelsMock = vi.fn();
  showSessionPanelMock = vi.fn();
  sessionClickMock = vi.fn();
  newSessionClickMock = vi.fn();
  onGlobalEventMock = vi.fn((callback: (event: GlobalEvent) => void) => {
    globalEventCallbacks.push(callback);
    return vi.fn();
  });
  showToastMock = vi.fn();
  refreshUsageDisplaysMock = vi.fn(async () => undefined);
  repaintUsageDisplaysMock = vi.fn();
  sessionTrackerMock = {
    get: vi.fn((sessionId: string) => trackerState.get(sessionId)),
    syncFromList: vi.fn(),
    onChange: vi.fn((callback: TrackerCallback) => {
      trackerCallbacks.push(callback);
      return vi.fn();
    }),
    setBusy: vi.fn((sessionId: string, isBusy: boolean) => {
      trackerState.set(sessionId, { ...trackerState.get(sessionId), busy: isBusy });
    }),
    getBusyCount: vi.fn(() => busyCount),
    getUnobservedCount: vi.fn(() => unobservedCount)
  };

  vi.doMock('../../public/ts/debug.js', () => ({ debug: vi.fn() }));
  vi.doMock('../../public/ts/app-state.js', () => ({
    getActiveSessionId: getActiveSessionIdMock,
    getAvailableModels: getAvailableModelsMock,
    notifySessionArchived: notifySessionArchivedMock
  }));
  vi.doMock('../../public/ts/model-selector.js', () => ({ setAvailableModels: setAvailableModelsMock }));
  vi.doMock('../../public/ts/view-controller.js', () => ({ showSessionPanel: showSessionPanelMock }));
  vi.doMock('../../public/ts/router.js', () => ({
    sessionClick: sessionClickMock,
    newSessionClick: newSessionClickMock
  }));
  vi.doMock('../../public/ts/websocket.js', () => ({ onGlobalEvent: onGlobalEventMock }));
  vi.doMock('../../public/ts/session-state-tracker.js', () => ({ sessionTracker: sessionTrackerMock }));
  vi.doMock('../../public/ts/toast.js', () => ({ showToast: showToastMock }));
  vi.doMock('../../public/ts/usage-display.js', () => ({
    refreshUsageDisplays: refreshUsageDisplaysMock,
    repaintUsageDisplays: repaintUsageDisplaysMock
  }));

  return import('../../public/ts/session-panel.js');
}

async function loadRenderedPanel(sessions = cannedSessions(), sessionOrder = ['active-root', 'root-new', 'work-busy', 'alpha-child']): Promise<SessionPanelModule> {
  const panel = await importPanel();
  fetchMock.mockResolvedValueOnce(jsonResponse({
    activeSessionId: 'active-root',
    currentCwd: '/repo/active',
    sessions,
    sessionOrder,
    models: [{ id: 'sonnet', name: 'Claude Sonnet', cost: 1 }]
  }));
  await panel.loadSessions();
  return panel;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  globalThis.localStorage?.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('session-panel rendering', () => {
  it('renders filtered sessions with folder headers, active state, labels, and metadata', async () => {
    const panel = await importPanel();
    trackerState.set('alpha-child', { intent: 'tracked child intent' });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      activeSessionId: 'active-root',
      currentCwd: '/repo/active',
      sessions: cannedSessions(),
      sessionOrder: ['active-root', 'root-new', 'work-busy', 'alpha-child'],
      models: [{ id: 'sonnet', name: 'Claude Sonnet', cost: 1 }]
    }));
    await panel.loadSessions();

    const items = [...document.querySelectorAll<HTMLElement>('.session-item')];
    expect(items.map(item => item.dataset.sessionId)).toEqual(['active-root', 'root-new', 'alpha-child', 'work-busy']);
    expect(document.querySelectorAll('.session-row-main')).toHaveLength(4);
    expect(document.querySelectorAll('.session-row-meta')).toHaveLength(4);

    const active = document.querySelector<HTMLElement>('.session-item[data-session-id="active-root"]');
    expect(active?.classList.contains('active')).toBe(true);
    expect(active?.classList.contains('unobserved')).toBe(true);
    expect(active?.querySelector('.session-title')?.textContent).toContain('Active summary');
    expect(active?.querySelector('.context-model')?.textContent).toBe('Claude Opus');
    expect(active?.querySelector('.session-row-meta')?.textContent).toContain('active');

    const rootNew = document.querySelector<HTMLElement>('.session-item[data-session-id="root-new"]');
    expect(rootNew?.querySelector('.session-title')?.getAttribute('title')).toBe('Root session');
    expect(rootNew?.querySelector('.session-intent')?.textContent).toBe('editing tests');
    expect(rootNew?.querySelector('.session-herd-badge')?.textContent).toBe('herd');
    expect(rootNew?.querySelector('.session-age')?.textContent).toMatch(/ago|now|m|h|d|w|mo|y/);

    const child = document.querySelector<HTMLElement>('.session-item[data-session-id="alpha-child"]');
    expect(child?.querySelector('.session-intent')?.textContent).toBe('tracked child intent');
    expect(child?.querySelector('.session-herd-badge')?.textContent).toBe('child');

    const busy = document.querySelector<HTMLElement>('.session-item[data-session-id="work-busy"]');
    expect(busy?.classList.contains('busy')).toBe(true);
    expect(busy?.querySelector('.session-indicator')?.classList.contains('busy')).toBe(true);
    expect(busy?.querySelector<HTMLImageElement>('.session-icon')?.src).toContain('/api/sessions/work-busy/icon');

    const folders = [...document.querySelectorAll<HTMLElement>('.folder-header')];
    expect(folders.map(folder => folder.dataset.folder)).toEqual(['alpha', 'work']);
    expect(folders.map(folder => folder.querySelector('.folder-count')?.textContent)).toEqual(['1', '1']);
    expect(document.querySelector('.root-drop-indicator')).toBeNull();
    expect(setAvailableModelsMock).toHaveBeenCalledWith([{ id: 'sonnet', name: 'Claude Sonnet', cost: 1 }]);
    expect(sessionTrackerMock.syncFromList).toHaveBeenCalledWith(cannedSessions().filter(session => session.cwd && session.cwd !== '(unknown)'));
    expect(repaintUsageDisplaysMock).toHaveBeenCalledTimes(1);
    expect(panel.getCachedSessions().map(session => session.sessionId)).toEqual(['root-new', 'active-root', 'work-busy', 'alpha-child']);
  });

  it('activates sessions and starts new sessions through router seams', async () => {
    await loadRenderedPanel();

    document.querySelector<HTMLElement>('.session-item[data-session-id="work-busy"]')?.click();
    expect(sessionClickMock).toHaveBeenCalledWith('work-busy');

    document.querySelector<HTMLButtonElement>('.session-add-btn')?.click();
    expect(newSessionClickMock).toHaveBeenCalledTimes(1);
    expect(sessionClickMock).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state with the heading and add button', async () => {
    await loadRenderedPanel([], []);

    expect(document.querySelectorAll('.session-item')).toHaveLength(0);
    expect(document.querySelector('.section-header')?.textContent).toContain('sessions');
    expect(document.querySelector('.session-add-btn')?.textContent).toBe('+');
    expect(document.querySelector('.schedules-empty')?.textContent).toBe('no sessions');
  });

  it('renders a root drop indicator when all sessions are foldered', async () => {
    const folderOnly = cannedSessions().filter(session => ['alpha-child', 'work-busy'].includes(session.sessionId));
    await loadRenderedPanel(folderOnly, ['work-busy', 'alpha-child']);

    expect(document.querySelector('.root-drop-indicator')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('.session-item')].map(item => item.dataset.sessionId)).toEqual(['alpha-child', 'work-busy']);
  });

  it('persists folder collapse state and re-renders folder content', async () => {
    const panel = await importPanel();
    fetchMock.mockResolvedValue(jsonResponse({
      activeSessionId: 'active-root',
      currentCwd: '/repo/active',
      sessions: cannedSessions(),
      sessionOrder: ['active-root', 'root-new', 'work-busy', 'alpha-child'],
      models: []
    }));
    await panel.loadSessions();

    const workHeader = document.querySelector<HTMLElement>('.folder-header[data-folder="work"]');
    expect(workHeader?.querySelector('.folder-chevron')?.textContent).toBe('▾');
    workHeader?.click();

    expect(JSON.parse(localStorage.getItem('caco:collapsed-folders') ?? '[]')).toEqual(['work']);
    expect(document.querySelector<HTMLElement>('.folder-zone[data-folder="work"] .folder-content')?.style.display).toBe('none');
    expect(document.querySelector('.folder-header[data-folder="work"] .folder-chevron')?.textContent).toBe('▸');

    document.querySelector<HTMLElement>('.folder-header[data-folder="work"]')?.click();
    expect(JSON.parse(localStorage.getItem('caco:collapsed-folders') ?? '[]')).toEqual([]);
    expect(document.querySelector<HTMLElement>('.folder-zone[data-folder="work"] .folder-content')?.style.display).toBe('');
  });

  it('honors collapsed folders loaded before module import', async () => {
    const panel = await importPanel(['alpha']);
    fetchMock.mockResolvedValue(jsonResponse({
      activeSessionId: 'active-root',
      currentCwd: '/repo/active',
      sessions: cannedSessions(),
      sessionOrder: ['active-root', 'root-new', 'work-busy', 'alpha-child']
    }));
    await panel.loadSessions();

    expect(document.querySelector<HTMLElement>('.folder-zone[data-folder="alpha"] .folder-content')?.style.display).toBe('none');
    expect(document.querySelector('.folder-header[data-folder="alpha"] .folder-chevron')?.textContent).toBe('▸');
    expect(setAvailableModelsMock).not.toHaveBeenCalled();
  });
});

describe('session-panel indicators and lifecycle', () => {
  it('updates menu indicators and loading state from tracker and active-session seams', async () => {
    const panel = await loadRenderedPanel();
    unobservedCount = 2;
    busyCount = 3;

    panel.updateMenuIndicators();
    expect(document.getElementById('unobservedBadge')?.textContent).toBe('2');
    expect(document.getElementById('unobservedBadge')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('menuBusyIndicator')?.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('.session-item[data-session-id="active-root"]')?.classList.contains('active')).toBe(true);

    unobservedCount = 0;
    activeSessionId = 'work-busy';
    panel.updateMenuIndicators();
    expect(document.getElementById('unobservedBadge')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('menuBusyIndicator')?.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.session-item[data-session-id="work-busy"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.session-item[data-session-id="active-root"]')?.classList.contains('active')).toBe(false);

    panel.setSessionLoading('work-busy', true);
    expect(document.querySelector('.session-item[data-session-id="work-busy"]')?.classList.contains('loading')).toBe(true);
    panel.setSessionLoading('work-busy', false);
    expect(document.querySelector('.session-item[data-session-id="work-busy"]')?.classList.contains('loading')).toBe(false);
    panel.setSessionLoading('missing', true);
    expect(document.querySelectorAll('.session-item.loading')).toHaveLength(0);
  });

  it('initializes once, handles global events, tracker changes, drops, and disposes listeners', async () => {
    vi.useFakeTimers();
    const panel = await loadRenderedPanel();
    fetchMock.mockResolvedValue(jsonResponse({ sessions: [], sessionOrder: [] }));

    panel.initSessionPanel();
    panel.initSessionPanel();
    expect(onGlobalEventMock).toHaveBeenCalledTimes(1);
    expect(sessionTrackerMock.onChange).toHaveBeenCalledTimes(1);

    globalEventCallbacks[0]({ type: 'session.busy', data: { sessionId: 'work-busy', isBusy: false } });
    expect(sessionTrackerMock.setBusy).toHaveBeenCalledWith('work-busy', false);

    trackerState.set('work-busy', { busy: true });
    trackerCallbacks[0]('work-busy', { busy: true });
    expect(document.querySelector('.session-item[data-session-id="work-busy"]')?.classList.contains('busy')).toBe(true);
    await vi.runAllTimersAsync();
    expect(document.querySelector('.folder-header[data-folder="work"] .session-indicator')?.classList.contains('busy')).toBe(true);

    globalEventCallbacks[0]({ type: 'session.listChanged', data: { reason: 'test' } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions');

    const invalidDrop = dragEvent('drop', { types: [], files: [new File(['x'], 'session.zip')] as unknown as FileList });
    document.getElementById('sessionView')?.dispatchEvent(invalidDrop);
    expect(showToastMock).toHaveBeenCalledWith('Drop a .tar.gz session archive');

    fetchMock.mockResolvedValueOnce(jsonResponse({ sessionId: 'imported-session' }));
    const validDrop = dragEvent('drop', { types: [], files: [new File(['x'], 'session.tar.gz')] as unknown as FileList });
    document.getElementById('sessionView')?.dispatchEvent(validDrop);
    await flushPromises();
    expect(fetchCall('/api/sessions/import?force=true', 'POST')?.[1]?.headers).toEqual({ 'Content-Type': 'application/gzip' });
    expect(showToastMock).toHaveBeenCalledWith('Imported session imported', { type: 'success', autoHideMs: 3000 });

    panel.disposeSessionPanel();
    expect(onGlobalEventMock).toHaveBeenCalledTimes(1);
  });

  it('moves sessions between folders through folder drop zones', async () => {
    await loadRenderedPanel();
    mockFetch((input: FetchInput, init?: FetchInit) => {
      if (String(input) === '/api/sessions/root-new' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === '/api/sessions') {
        return Promise.resolve(jsonResponse({ sessions: [], sessionOrder: [] }));
      }
      return Promise.reject(new Error('unexpected fetch call'));
    });

    const dataTransfer = {
      types: ['text/x-caco-session'],
      getData: vi.fn(() => 'root-new'),
      dropEffect: 'copy'
    } as Partial<DataTransfer>;
    const workZone = document.querySelector<HTMLElement>('.folder-zone[data-folder="work"]');
    workZone?.dispatchEvent(dragEvent('dragenter', dataTransfer));
    expect(workZone?.classList.contains('drop-highlight')).toBe(true);
    workZone?.dispatchEvent(dragEvent('drop', dataTransfer));
    await flushPromises();

    const patch = fetchCall('/api/sessions/root-new', 'PATCH');
    expect(patch?.[1]?.body).toBe(JSON.stringify({ folder: 'work' }));
    expect(showToastMock).toHaveBeenCalledWith('Session moved to /work', { type: 'success', autoHideMs: 3000 });
  });

  it('marks session drag start and clears drag highlights on drag end', async () => {
    await loadRenderedPanel();
    const item = document.querySelector<HTMLElement>('.session-item[data-session-id="root-new"]');
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: 'none'
    } as Partial<DataTransfer>;
    document.querySelector('.folder-zone')?.classList.add('drop-highlight');

    item?.dispatchEvent(dragEvent('dragstart', dataTransfer));
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/x-caco-session', 'root-new');
    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(item?.classList.contains('dragging')).toBe(true);

    item?.dispatchEvent(new Event('dragend'));
    expect(item?.classList.contains('dragging')).toBe(false);
    expect(document.querySelector('.folder-zone.drop-highlight')).toBeNull();
  });

  it('shows the session manager and focuses the search box', async () => {
    vi.useFakeTimers();
    const panel = await importPanel();
    mockFetch((input: FetchInput) => {
      if (String(input) === '/api/sessions') return Promise.resolve(jsonResponse({ sessions: [], sessionOrder: [] }));
      if (String(input) === '/api/schedule') return Promise.resolve(jsonResponse({ schedules: [] }));
      return Promise.reject(new Error('unexpected fetch call'));
    });

    panel.showSessionManager();
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(showSessionPanelMock).toHaveBeenCalledTimes(1);
    expect(refreshUsageDisplaysMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('sessionSearchInput'));
  });
});

describe('session-panel schedules', () => {
  it('renders schedule states and calls run and toggle APIs from buttons', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const panel = await importPanel();
    mockFetch((input: FetchInput, init?: FetchInit) => {
      if (String(input) === '/api/schedule' && !init?.method) {
        return Promise.resolve(jsonResponse({
          schedules: [
            { slug: 'overdue', enabled: true, nextRun: '2025-12-31T23:59:00.000Z' },
            { slug: 'soon', enabled: false, nextRun: '2026-01-01T00:30:00.000Z' },
            { slug: 'later', enabled: true, nextRun: '2026-01-01T02:00:00.000Z' },
            { slug: 'future', enabled: true, nextRun: '2026-01-03T00:00:00.000Z' }
          ]
        }));
      }
      if (String(input) === '/api/schedule/overdue/run' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ started: true }));
      }
      if (String(input) === '/api/schedule/soon' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ enabled: true }));
      }
      return Promise.reject(new Error('unexpected fetch call'));
    });

    await panel.loadSchedules();
    const rows = [...document.querySelectorAll<HTMLElement>('.schedule-item')];
    expect(rows.map(row => row.dataset.slug)).toEqual(['overdue', 'soon', 'later', 'future']);
    expect(rows[0].textContent).toContain('next: overdue');
    expect(rows[1].textContent).toContain('next: 30m');
    expect(rows[1].classList.contains('disabled')).toBe(true);
    expect(rows[2].textContent).toContain('next: 2h');
    expect(rows[3].querySelector('.schedule-next')?.textContent).toContain('next:');
    expect(rows[1].querySelector<HTMLButtonElement>('.schedule-toggle')?.title).toBe('Enable');

    rows[0].querySelector<HTMLButtonElement>('.schedule-run')?.click();
    await flushPromises();
    expect(fetchCall('/api/schedule/overdue/run', 'POST')).toBeDefined();

    rows[1].querySelector<HTMLButtonElement>('.schedule-toggle')?.click();
    await flushPromises();
    const patch = fetchCall('/api/schedule/soon', 'PATCH');
    expect(patch?.[1]?.body).toBe(JSON.stringify({ enabled: true }));
  });

  it('renders schedule empty and failure states', async () => {
    const panel = await importPanel();
    fetchMock.mockResolvedValueOnce(jsonResponse({ schedules: [] }));
    await panel.loadSchedules();
    expect(document.querySelector('.schedules-empty')?.textContent).toBe('no scheduled sessions');

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 500));
    await panel.loadSchedules();
    expect(document.querySelector('.schedules-empty')?.textContent).toBe('failed to load schedules');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await panel.loadSchedules();
    expect(document.querySelector('.schedules-empty')?.textContent).toBe('failed to load schedules');
  });
});

describe('session-panel API actions', () => {
  it('archives sessions and starts a new one when the archived session was active', async () => {
    const panel = await importPanel();
    mockFetch((input: FetchInput, init?: FetchInit) => {
      if (String(input) === '/api/sessions/archive-me' && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ archivePath: 'archive/archive-me.tar.gz', wasActive: true }));
      }
      if (String(input) === '/api/sessions') {
        return Promise.resolve(jsonResponse({ sessions: [], sessionOrder: [] }));
      }
      return Promise.reject(new Error('unexpected fetch call'));
    });

    await panel.archiveSession('archive-me', 'Readable name');
    expect(fetchCall('/api/sessions/archive-me', 'DELETE')).toBeDefined();
    expect(showToastMock).toHaveBeenCalledWith('Archived "Readable name" → archive/archive-me.tar.gz', { type: 'success', autoHideMs: 5000 });
    expect(notifySessionArchivedMock).toHaveBeenCalledWith('archive-me');
    expect(newSessionClickMock).toHaveBeenCalledTimes(1);
  });

  it('reports archive failures from API and thrown fetches', async () => {
    const panel = await importPanel();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'cannot archive' }, false, 409));
    await panel.archiveSession('failed-archive');
    expect(showToastMock).toHaveBeenCalledWith('cannot archive');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await panel.archiveSession('throwing-archive');
    expect(showToastMock).toHaveBeenCalledWith('Archive failed: offline');
  });

  it('renames sessions and reports rename failures', async () => {
    const panel = await importPanel();
    const alertMock = vi.mocked(window.alert);
    mockFetch((input: FetchInput, init?: FetchInit) => {
      if (String(input) === '/api/sessions/rename-me' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === '/api/sessions') {
        return Promise.resolve(jsonResponse({ sessions: [], sessionOrder: [] }));
      }
      return Promise.reject(new Error('unexpected fetch call'));
    });

    await panel.renameSession('rename-me', 'Better name');
    expect(fetchCall('/api/sessions/rename-me', 'PATCH')?.[1]?.body).toBe(JSON.stringify({ name: 'Better name' }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad name' }, false, 400));
    await panel.renameSession('bad-rename', 'Bad');
    expect(alertMock).toHaveBeenCalledWith('Failed to rename: bad name');

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await panel.renameSession('throw-rename', 'Nope');
    expect(alertMock).toHaveBeenCalledWith('Failed to rename session');
  });

  it('leaves the session list untouched when loading sessions fails', async () => {
    const panel = await importPanel();
    const container = document.getElementById('sessionList');
    if (container) container.textContent = 'existing';

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'down' }, false, 503));
    await panel.loadSessions();
    expect(container?.textContent).toBe('existing');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await panel.loadSessions();
    expect(container?.textContent).toBe('existing');
  });
});
