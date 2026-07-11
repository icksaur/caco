// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  debug: vi.fn(),
  renderNewChatStatus: vi.fn(),
  getViewState: vi.fn(() => 'newChat' as const),
}));

vi.mock('../../public/ts/debug.js', () => ({ debug: seams.debug }));
vi.mock('../../public/ts/context-footer.js', () => ({
  renderNewChatStatus: seams.renderNewChatStatus,
}));
vi.mock('../../public/ts/view-controller.js', () => ({
  getViewState: seams.getViewState,
}));

import { getSelectedModel } from '../../public/ts/app-state.js';
import type { ModelInfo } from '../../public/ts/types.js';
import {
  applyModelPreference,
  loadModels,
  selectModel,
  setAvailableModels,
  showNewChatError,
} from '../../public/ts/model-selector.js';

const models: ModelInfo[] = [
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    cost: 1,
    contextWindow: 200_000,
    inputPerMtok: 3,
    outputPerMtok: 15,
    cachePerMtok: 0.3,
    priceCategory: 'high',
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    cost: 0,
    contextWindow: 1_000_000,
  },
  {
    id: 'openai:gpt-5.5',
    name: 'GPT-5.5 BYOK',
    cost: 2,
    contextWindow: 2_000_000,
    inputPerMtok: 125,
    outputPerMtok: 250,
    priceCategory: 'very_high',
  },
];

function installModelDom(withCwd = false): HTMLElement {
  document.body.innerHTML = `
    <div id="modelList"></div>
    <input name="message">
    <div id="newChatError"></div>
    ${withCwd ? '<input id="newChatCwd">' : ''}
  `;
  return must(document.getElementById('modelList'), 'model list');
}

function must<T>(value: T | null | undefined, label: string): T {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ files: [] }) })));
  seams.getViewState.mockReturnValue('newChat');
  seams.renderNewChatStatus.mockClear();
  seams.debug.mockClear();
  setAvailableModels([]);
  selectModel('claude-sonnet-4');
  vi.mocked(fetch).mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('model-selector', () => {
  it('renders server models with active state, provider groups, context, and prices', () => {
    installModelDom();
    setAvailableModels(models);
    selectModel('gpt-4.1');
    vi.mocked(fetch).mockClear();

    loadModels();

    const rows = [...document.querySelectorAll<HTMLElement>('.model-item')];
    expect(rows.map(row => row.dataset.modelId)).toEqual([
      'claude-sonnet-4.6',
      'gpt-4.1',
      'openai:gpt-5.5',
    ]);
    expect(must(document.querySelector('.model-group-header'), 'provider header').textContent).toBe('openai');
    expect(must(rows[1], 'active row').classList.contains('active')).toBe(true);
    expect(must(rows[0].querySelector('.model-context'), '200k context').textContent).toBe('200k');
    expect(must(rows[1].querySelector('.model-context'), '1m context').textContent).toBe('1M');
    expect(must(rows[2].querySelector('.model-context'), '2m context').textContent).toBe('2M');
    expect(must(rows[0].querySelector('.cost-in'), 'input price').textContent).toBe('3');
    expect(must(rows[0].querySelector('.cost-out'), 'output price').textContent).toBe('15');
    expect(must(rows[0].querySelector('.cost-cache'), 'cache price').textContent).toBe('0.3');
    expect(must(rows[1].querySelector('.model-cost'), 'free cost').textContent).toBe('free');
    expect(must(rows[2].querySelector('.model-cost'), 'byok price').classList.contains('tier-very-high')).toBe(true);
  });

  it('selects a clicked model and saves the preference without hiding other choices', () => {
    installModelDom();
    setAvailableModels(models);
    loadModels();

    const byokRow = must(document.querySelector<HTMLElement>('[data-model-id="openai:gpt-5.5"]'), 'byok model row');
    byokRow.click();

    expect(getSelectedModel()).toBe('openai:gpt-5.5');
    expect(must(document.querySelector<HTMLElement>('[data-model-id="openai:gpt-5.5"]'), 'selected row').classList.contains('active')).toBe(true);
    expect(must(document.querySelector<HTMLElement>('[data-model-id="claude-sonnet-4.6"]'), 'unselected row').classList.contains('active')).toBe(false);
    expect(must(document.querySelector<HTMLInputElement>('input[name="message"]'), 'message input').placeholder).toBe('Ask GPT-5.5 BYOK...');
    expect(fetch).toHaveBeenCalledWith('/api/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastModel: 'openai:gpt-5.5' }),
    });
  });

  it('applies saved model preferences only when the model is available', () => {
    installModelDom();
    setAvailableModels(models);

    applyModelPreference({ lastModel: 'claude-sonnet-4.6' });
    expect(getSelectedModel()).toBe('claude-sonnet-4.6');
    expect(must(document.querySelector<HTMLInputElement>('input[name="message"]'), 'message input').placeholder).toBe('Ask Claude Sonnet 4.6...');

    applyModelPreference({ lastModel: 'missing-model' });
    expect(getSelectedModel()).toBe('claude-sonnet-4.6');
  });

  it('updates the new chat error element when present', () => {
    installModelDom();

    showNewChatError('Model load failed');

    expect(must(document.getElementById('newChatError'), 'error div').textContent).toBe('Model load failed');
  });

  it('falls back to built-in models when the server model list is empty', () => {
    installModelDom();
    setAvailableModels([]);

    loadModels();

    const labels = [...document.querySelectorAll('.model-name')].map(el => el.textContent);
    expect(labels).toContain('Claude Sonnet 4');
    expect(labels).toContain('GPT-4.1');
    expect(document.querySelectorAll('.model-item')).toHaveLength(5);
  });

  it('fetches cwd directory suggestions, inserts a selection, and handles lookup failure', async () => {
    installModelDom(true);
    setAvailableModels(models);
    selectModel('claude-sonnet-4.6');
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        files: [
          { type: 'directory', name: 'repo' },
          { type: 'directory', name: 'reports' },
          { type: 'file', name: 'readme.md' },
        ],
      }),
    } as Response);
    loadModels();

    const cwdInput = must(document.getElementById('newChatCwd') as HTMLInputElement | null, 'cwd input');
    cwdInput.value = '/workspace/r';
    cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledWith('/api/files?path=%2Fworkspace%2F');
    expect(seams.renderNewChatStatus).toHaveBeenCalledWith('Claude Sonnet 4.6', '/workspace/r');
    expect([...document.querySelectorAll('.input-popup-item')].map(el => el.textContent)).toEqual(['repo/', 'reports/']);
    expect(cwdInput.classList.contains('cwd-valid')).toBe(true);
    expect(cwdInput.classList.contains('cwd-invalid')).toBe(false);

    must(document.querySelector<HTMLElement>('.input-popup-item'), 'first suggestion')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(cwdInput.value).toBe('/workspace/repo/');
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    cwdInput.value = '/missing/x';
    cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(cwdInput.classList.contains('cwd-invalid')).toBe(true);
    expect(cwdInput.classList.contains('cwd-valid')).toBe(false);
    expect(must(document.querySelector<HTMLElement>('.input-popup'), 'cwd popup').style.display).toBe('none');
  });
});
