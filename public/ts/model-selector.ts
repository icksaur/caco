/**
 * Model selection
 */

import type { ModelInfo, Preferences } from './types.js';
import { getSelectedModel, setSelectedModel as stateSetSelectedModel, getAvailableModels, setAvailableModels as stateSetAvailableModels } from './app-state.js';
import { renderNewChatStatus } from './context-footer.js';
import { getViewState } from './view-controller.js';
import { InputPopup } from './input-popup.js';

/**
 * Fallback model list (used if SDK doesn't return models)
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', cost: 1 },
  { id: 'claude-opus-4.6-1m', name: 'Claude Opus 4.6 (1M)', cost: 3 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', cost: 0.33 },
  { id: 'gpt-4.1', name: 'GPT-4.1', cost: 0 },
];

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

/**
 * Set available models from server response
 */
export function setAvailableModels(models: ModelInfo[]): void {
  stateSetAvailableModels(models);
  console.log('[MODEL] Available models from SDK:', models.map(m => m.id));
}

/**
 * Get models to display (server models or fallback)
 */
function getModels(): ModelInfo[] {
  const available = getAvailableModels();
  return available.length > 0 ? [...available] : FALLBACK_MODELS;
}

/**
 * Show error in new chat form
 */
export function showNewChatError(message: string): void {
  const errorDiv = document.getElementById('newChatError');
  if (errorDiv) errorDiv.textContent = message;
}

/**
 * Load and render model list
 */
export function loadModels(): void {
  const container = document.getElementById('modelList');
  if (!container) return;
  
  container.innerHTML = '';
  const currentModel = getSelectedModel();
  const models = getModels();
  
  for (const model of models) {
    const item = document.createElement('div');
    item.className = 'model-item';
    if (model.id === currentModel) {
      item.classList.add('active');
    }
    item.dataset.modelId = model.id;
    item.onclick = () => selectModel(model.id);
    
    // Model name + context window (separate spans so ctx isn't clipped by ellipsis)
    const nameSpan = document.createElement('span');
    nameSpan.className = 'model-name';
    nameSpan.textContent = model.name;
    item.appendChild(nameSpan);
    if (model.contextWindow) {
      const ctxSpan = document.createElement('span');
      ctxSpan.className = 'model-context';
      ctxSpan.textContent = formatContextWindow(model.contextWindow);
      item.appendChild(ctxSpan);
    }
    
    // Cost breakdown: in / out / cache per MTOK
    const costSpan = document.createElement('span');
    costSpan.className = 'model-cost';
    const hasPrices = model.inputPerMtok !== null && model.inputPerMtok !== undefined
      && model.outputPerMtok !== null && model.outputPerMtok !== undefined;
    if (hasPrices) {
      const fmt = (n: number) => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.?0+$/, '');
      const parts: string[] = [
        `<span class="cost-in">${fmt(model.inputPerMtok!)}</span> <span class="cost-label">in</span>`,
        `<span class="cost-out">${fmt(model.outputPerMtok!)}</span> <span class="cost-label">out</span>`,
      ];
      if (model.cachePerMtok !== null && model.cachePerMtok !== undefined) {
        parts.push(`<span class="cost-cache">${fmt(model.cachePerMtok)}</span> <span class="cost-label">cache</span>`);
      }
      costSpan.innerHTML = parts.join(' ');
      costSpan.title = 'price per million tokens';
      if (model.priceCategory) costSpan.classList.add(`tier-${model.priceCategory.replace('_', '-')}`);
    } else if (model.cost === 0) {
      costSpan.textContent = 'free';
      costSpan.classList.add('free');
    } else {
      costSpan.hidden = true;
    }
    item.appendChild(costSpan);
    
    container.appendChild(item);
  }
  
  // Update footer with model + CWD as user types
  setupCwdFooterSync();
}

let cwdSyncInstalled = false;

const MAX_SUGGESTIONS = 20;

function splitPath(input: string): { parent: string; prefix: string } {
  const lastSlash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
  if (lastSlash === -1) return { parent: '', prefix: input };
  return {
    parent: input.slice(0, lastSlash + 1),
    prefix: input.slice(lastSlash + 1).toLowerCase()
  };
}

function setupCwdFooterSync(): void {
  if (cwdSyncInstalled) return;
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  if (!cwdInput) return;
  
  cwdSyncInstalled = true;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let cwdPopup: InputPopup | null = null;
  let cachedParent = '';
  let cachedDirs: string[] = [];
  
  function updateFooter(cwd: string): void {
    const modelId = getSelectedModel();
    const models = getAvailableModels();
    const model = models.find(m => m.id === modelId);
    renderNewChatStatus(model?.name || modelId?.split('/').pop() || '', cwd);
  }
  
  function showSuggestions(dirs: string[], prefix: string): void {
    const filtered = prefix
      ? dirs.filter(d => d.toLowerCase().startsWith(prefix))
      : dirs;
    
    if (filtered.length === 0) {
      cwdPopup?.hide();
      return;
    }
    
    if (!cwdPopup) {
      cwdPopup = new InputPopup({
        anchor: cwdInput,
        direction: 'down',
        onSelect: (item) => {
          cwdPopup!.hide();
          const { parent } = splitPath(cwdInput.value);
          cwdInput.value = parent + item.id;
          cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
          cwdInput.focus();
        },
        onDismiss: () => cwdPopup?.hide()
      });
    }
    
    const items = filtered.slice(0, MAX_SUGGESTIONS).map(d => ({
      id: d,
      label: d
    }));
    cwdPopup.show(items);
  }
  
  cwdInput.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (getViewState() !== 'newChat') return;
      const cwd = cwdInput.value.trim();
      
      updateFooter(cwd);
      
      if (!cwd) {
        cwdInput.classList.remove('cwd-valid', 'cwd-invalid');
        cwdPopup?.hide();
        return;
      }
      
      const { parent, prefix } = splitPath(cwd);
      
      if (!parent) {
        cwdPopup?.hide();
        return;
      }
      
      // If parent hasn't changed, filter cached entries (no fetch)
      if (parent === cachedParent) {
        showSuggestions(cachedDirs, prefix);
        // Validate: exact path exists if it ends with / and matches a cached entry,
        // or just check the parent is valid (it was fetched successfully)
        const exactMatch = !prefix || cachedDirs.some(d => d.toLowerCase() === prefix || d.toLowerCase() === prefix + '/');
        cwdInput.classList.toggle('cwd-valid', !!exactMatch || !prefix);
        cwdInput.classList.toggle('cwd-invalid', !!prefix && !exactMatch);
        return;
      }
      
      // Parent changed — fetch new listing
      const parentToFetch = parent;
      void fetch(`/api/files?path=${encodeURIComponent(parentToFetch)}`)
        .then(async res => {
          if (cwdInput.value.trim() !== cwd) return; // stale
          if (!res.ok) {
            cachedParent = '';
            cachedDirs = [];
            cwdInput.classList.add('cwd-invalid');
            cwdInput.classList.remove('cwd-valid');
            cwdPopup?.hide();
            return;
          }
          const data = await res.json();
          const dirs: string[] = (data.files || [])
            .filter((f: { type: string }) => f.type === 'directory')
            .map((f: { name: string }) => f.name + '/');
          
          cachedParent = parentToFetch;
          cachedDirs = dirs;
          
          if (cwdInput.value.trim() !== cwd) return; // stale
          showSuggestions(dirs, prefix);
          
          // Validation based on fetched data
          if (!prefix) {
            cwdInput.classList.add('cwd-valid');
            cwdInput.classList.remove('cwd-invalid');
          } else {
            const match = dirs.some(d => d.toLowerCase().startsWith(prefix));
            cwdInput.classList.toggle('cwd-valid', match);
            cwdInput.classList.toggle('cwd-invalid', !match);
          }
        })
        .catch(() => {
          if (cwdInput.value.trim() !== cwd) return;
          cwdInput.classList.remove('cwd-valid', 'cwd-invalid');
          cwdPopup?.hide();
        });
    }, 250);
  });
  
  // Keyboard navigation for popup
  cwdInput.addEventListener('keydown', (e) => {
    if (cwdPopup?.isVisible() && cwdPopup.handleKey(e)) {
      e.preventDefault();
    }
  });
  
  // Initial render if value exists
  if (getViewState() === 'newChat') {
    const cwd = cwdInput.value.trim();
    if (cwd) {
      updateFooter(cwd);
    }
  }
}

/**
 * Select a model (just updates state and UI highlight)
 */
export function selectModel(modelId: string): void {
  // Update state (also syncs hidden input)
  stateSetSelectedModel(modelId);
  
  // Update placeholder to show selected model
  const models = getModels();
  const modelInfo = models.find(m => m.id === modelId);
  if (modelInfo) {
    const input = document.querySelector('input[name="message"]') as HTMLInputElement;
    if (input) {
      input.placeholder = `Ask ${modelInfo.name}...`;
    }
  }
  
  // Update active state in list
  const items = document.querySelectorAll('.model-item');
  items.forEach(item => {
    if ((item as HTMLElement).dataset.modelId === modelId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  // Save preference to server (best-effort, don't block UI)
  fetch('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastModel: modelId })
  }).catch(err => console.error('Failed to save model preference:', err));
  
  // Update footer status with new model name
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  const cwd = cwdInput?.value.trim() || '';
  if (cwd && modelInfo && getViewState() === 'newChat') {
    renderNewChatStatus(modelInfo.name, cwd);
  }
}

/**
 * Apply model from preferences
 */
export function applyModelPreference(prefs: Preferences): void {
  const models = getModels();
  if (prefs.lastModel && models.find(m => m.id === prefs.lastModel)) {
    // Update state (also syncs hidden input)
    stateSetSelectedModel(prefs.lastModel);
    
    // Update placeholder
    const modelInfo = models.find(m => m.id === prefs.lastModel);
    if (modelInfo) {
      const input = document.querySelector('input[name="message"]') as HTMLInputElement;
      if (input) {
        input.placeholder = `Ask ${modelInfo.name}...`;
      }
    }
  }
}
