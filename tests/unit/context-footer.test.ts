// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRegions } from '../../public/ts/dom-regions.js';
import {
  clearContextFooter,
  clearContextUsage,
  clearStatus,
  clearThroughput,
  handleContextEvent,
  isFooterOwner,
  renderContextFooter,
  renderNewChatStatus,
  renderSessionStatus,
  restoreContextUsage,
  restoreThroughput,
  seedThroughput,
  setActiveContextBudget,
  setActiveReasoningEffort,
  setActiveThroughputModel,
  setFooterOwner,
  updateContextUsage,
  updateThroughput,
  type ThroughputData,
} from '../../public/ts/context-footer.js';

const appState = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  getActiveSessionId: vi.fn(() => appState.activeSessionId),
  getAvailableModels: vi.fn(() => [
    {
      id: 'model-1',
      name: 'Claude Test',
      contextWindow: 400_000,
      inputPerMtok: 2,
      cachePerMtok: 0.5,
      outputPerMtok: 10,
    },
    { id: 'auto', name: 'Auto', contextWindow: 0 },
  ]),
}));

vi.mock('../../public/ts/app-state.js', () => ({
  getActiveSessionId: appState.getActiveSessionId,
  getAvailableModels: appState.getAvailableModels,
}));

function installDom(): void {
  document.body.innerHTML = `
    <main id="chatScroll">
      <section id="chat"></section>
    </main>
    <aside data-applet-view></aside>
    <footer data-context-footer>
      <div class="context-links"></div>
      <div class="context-session"></div>
      <div class="context-usage"></div>
      <div class="context-saved"></div>
      <div class="context-throughput"></div>
      <div class="context-model"></div>
      <div class="context-description"></div>
    </footer>
  `;
  initRegions();
}

function footer(): HTMLElement {
  return document.querySelector('[data-context-footer]') as HTMLElement;
}

function text(sel: string): string {
  return footer().querySelector(sel)?.textContent ?? '';
}

function title(sel: string): string {
  return (footer().querySelector(sel) as HTMLElement | null)?.title ?? '';
}

function throughput(overrides: Partial<ThroughputData> = {}): ThroughputData {
  return {
    requestIn: 11_000,
    requestCache: 22_000,
    requestOut: 3_000,
    totalIn: 2_000_000,
    totalCache: 1_000_000,
    totalOut: 500_000,
    rateLimitCount: 2,
    lastRateLimitAt: '2026-01-02T03:04:05Z',
    totalTurns: 4,
    totalReasoning: 12_345,
    totalToolCalls: 9,
    totalToolFailures: 1,
    totalWallMs: 12_300,
    coldMissInputTokens: 100_000,
    coldMissTurns: 1,
    workflowSavedTokens: 200_000,
    workflowCacheReplaySaved: 400_000,
    workflowCacheCompoundSaved: 100_000,
    workflowVirtualCallsAvoided: 8,
    workflowRoundTripsSaved: 3,
    workflowOutputDelta: 20_000,
    workflowTimeSavedMs: 65_000,
    shapingSavedTokens: 100_000,
    deferredDefsTokens: 7_000,
    deferredDefsCount: 2,
    deferredDefsUnknown: 1,
    deferredDefsTokensAccrued: 50_000,
    updatedAt: '2026-01-02T03:04:05Z',
    known: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  appState.activeSessionId = null;
  appState.getActiveSessionId.mockClear();
  appState.getAvailableModels.mockClear();
  installDom();
  setFooterOwner(null);
  setActiveContextBudget(null);
  setActiveReasoningEffort(null);
  setActiveThroughputModel(null);
  clearContextUsage();
  clearThroughput();
  clearStatus();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('context footer status rendering', () => {
  it('renders new-chat model and cwd without session links', () => {
    setActiveThroughputModel('model-1');

    renderNewChatStatus('Claude Test', 'workspace/project');

    const model = footer().querySelector('.context-model span') as HTMLElement;
    const cwd = footer().querySelector('.context-description span') as HTMLElement;

    expect(model.textContent).toBe('Claude Test');
    expect(model.title).toBe('Claude Test · 400K context window');
    expect(cwd.textContent).toBe('project/');
    expect(cwd.title).toBe('workspace/project');
    expect(text('.context-session')).toBe('');
    expect(footer().classList.contains('has-context')).toBe(true);
  });

  it('renders active session icon, name, git link, cwd files link, owner, and model tooltip effort', () => {
    setActiveThroughputModel('model-1');
    setActiveReasoningEffort('high');

    renderSessionStatus({
      modelName: 'Claude Test',
      cwd: 'repo/caco',
      hasGit: true,
      gitBranch: 'feature/<safe>',
      sessionName: 'Build <tests>',
      sessionId: 'session a/b',
      hasIcon: true,
    });

    const icon = footer().querySelector<HTMLImageElement>('.context-icon');
    const name = footer().querySelector('.context-session-name');
    const model = footer().querySelector('.context-model span') as HTMLElement;
    const links = [...footer().querySelectorAll<HTMLAnchorElement>('.footer-applet-link')];

    expect(isFooterOwner('session a/b')).toBe(true);
    expect(icon?.src).toContain('/api/sessions/session%20a%2Fb/icon');
    expect(name?.innerHTML).toBe('Build &lt;tests&gt;');
    expect(model.title).toBe('Claude Test · 400K context window · High effort');
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('⎇ feature/<safe>');
    expect(links[0].getAttribute('href')).toBe('/?session=session%20a%2Fb&applet=git-status&path=repo%2Fcaco');
    expect(links[1].textContent).toBe('caco/');
    expect(links[1].title).toBe('repo/caco');
  });

  it('clears status and context links independently', () => {
    appState.activeSessionId = 'active-session';
    renderSessionStatus({ modelName: 'Claude Test', cwd: 'repo/caco', sessionId: 'active-session' });
    renderContextFooter({ files: ['src/one.ts'] });

    clearStatus();

    expect(text('.context-model')).toBe('');
    expect(text('.context-description')).toBe('');
    expect(text('.context-links')).toBe('one.ts');
    expect(footer().classList.contains('has-context')).toBe(true);

    clearContextFooter();

    expect(text('.context-links')).toBe('');
    expect(footer().classList.contains('has-context')).toBe(false);
  });
});

describe('context footer file links and usage', () => {
  it('renders only the three most recent context file links for the active session', () => {
    appState.activeSessionId = 'active session';

    handleContextEvent({ context: { files: ['a/old.ts', 'b/one.ts', 'c/two.ts', 'd/three.ts'] } });

    const links = [...footer().querySelectorAll<HTMLAnchorElement>('.context-links a')];
    expect(links.map(link => link.textContent)).toEqual(['one.ts', 'two.ts', 'three.ts']);
    expect(links[0].getAttribute('href')).toBe('/?session=active%20session&applet=files&openPath=b%2Fone.ts');
    expect(footer().querySelectorAll('.context-sep')).toHaveLength(2);
  });

  it('updates usage text and tooltip, then refreshes against a smaller active budget', () => {
    setFooterOwner('budget-session');

    updateContextUsage({ tokenLimit: 100_000, currentTokens: 20_000 }, 'budget-session');

    const usage = footer().querySelector('.context-usage') as HTMLElement;
    expect(usage.textContent).toBe('◔ 25%');
    expect(usage.title).toContain('20,000 / 80,000 before compaction (25%)');
    expect(usage.title).toContain('full window: 100,000 tokens');

    setActiveContextBudget(40_000);

    expect(usage.textContent).toBe('◑ 50%');
    expect(usage.title).toContain('20,000 / 40,000 before compaction (50%)');
  });

  it('restores cached usage for one session and clears missing usage for another', () => {
    updateContextUsage({ tokenLimit: 100_000, currentTokens: 90_000 }, 'cached-usage');
    clearContextUsage();

    restoreContextUsage('cached-usage');

    expect(text('.context-usage')).toBe('● 100%');

    restoreContextUsage('missing-usage');

    expect(text('.context-usage')).toBe('');
  });
});

describe('context footer throughput rendering', () => {
  it('renders throughput tokens, estimated spend, cache misses, rate limits, turns, and savings', () => {
    setActiveThroughputModel('model-1');

    updateThroughput(throughput(), 'throughput-session');

    const tp = footer().querySelector('.context-throughput span') as HTMLElement;
    const cost = footer().querySelector('.tp-cost');
    const miss = footer().querySelector('.tp-cache-miss');
    const turns = footer().querySelector('.tp-turns');
    const rateLimit = footer().querySelector('.ratelimit') as HTMLElement;
    const saved = footer().querySelector('.context-saved') as HTMLElement;

    expect(cost?.textContent).toBe('≈9.50cr');
    expect(miss?.textContent).toBe('×≈0.20cr');
    expect(turns?.textContent).toBe('⟲4');
    // Token counts are tooltip-only; the visible strip carries credits, not tokens.
    expect(tp.textContent).not.toContain('in');
    expect(tp.textContent).not.toContain('cache');
    expect(tp.title).toContain('session: 2,000,000 in · 1,000,000 cache · 500,000 out');
    expect(tp.title).toContain('last request: 11,000 in · 22,000 cache · 3,000 out');
    expect(tp.title).toContain('cache misses: 1 turn · 100,000 tok re-encoded (≈0.20cr)');
    expect(rateLimit.textContent).toBe('⚠2');
    expect(rateLimit.title).toContain('2 rate-limited calls');
    expect(saved.textContent).toBe('↯≈0.68cr');
    expect(saved.title).toContain('8 virtual tool calls → 3 round trips saved');
    expect(saved.title).toContain('deferred defs (est): ~7,000 tok/turn omitted (2 tools · 1 unknown)');
    expect(saved.title).toContain('550,000×0.5/1000000 + 300,000×2/1000000 − 20,000×10/1000000');
  });

  it('restores cached throughput, fetches fresh data for the active session, and clears missing sessions', async () => {
    setActiveThroughputModel('model-1');
    appState.activeSessionId = 'fresh-session';
    const fetched = throughput({ totalIn: 3_000, totalCache: 4_000, totalOut: 5_000, rateLimitCount: 0 });
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(fetched) }));
    vi.stubGlobal('fetch', fetchMock);

    seedThroughput('fresh-session', throughput({ totalIn: 1_000, totalCache: 2_000, totalOut: 3_000, rateLimitCount: 0 }));
    clearThroughput();
    restoreThroughput('fresh-session');

    // Which session's numbers rendered is now only observable in the tooltip.
    expect(title('.context-throughput span')).toContain('session: 1,000 in · 2,000 cache · 3,000 out');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/fresh-session/throughput');
    expect(title('.context-throughput span')).toContain('session: 3,000 in · 4,000 cache · 5,000 out');

    restoreThroughput('missing-session');

    expect(text('.context-throughput')).toBe('');
    expect(text('.context-saved')).toBe('↯≈0.00cr');
  });

  it('falls back to fetching when seeded without bundled throughput and ignores stale fetches', async () => {
    appState.activeSessionId = 'other-session';
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(throughput({ totalIn: 9_999 })) }));
    vi.stubGlobal('fetch', fetchMock);

    seedThroughput('stale-session', null);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/stale-session/throughput');
    expect(text('.context-throughput')).toBe('');
  });
});
