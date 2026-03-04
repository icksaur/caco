/**
 * Model selection
 */

import type { ModelInfo, Preferences } from './types.js';
import { getSelectedModel, setSelectedModel as stateSetSelectedModel, getAvailableModels, setAvailableModels as stateSetAvailableModels } from './app-state.js';
import { renderStatus } from './context-footer.js';

/**
 * Fallback model list (used if SDK doesn't return models)
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', cost: 1 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', cost: 3 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', cost: 0.33 },
  { id: 'gpt-4.1', name: 'GPT-4.1', cost: 0 },
  { id: 'gpt-4o', name: 'GPT-4o', cost: 0 }
];

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
 * Get the cwd from the new chat form
 */
export function getNewChatCwd(): string {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  return cwdInput?.value.trim() || '';
}

/**
 * Set the CWD in the new chat form (e.g. from file-browser applet)
 */
export function setNewChatCwd(cwd: string): void {
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  if (cwdInput) {
    cwdInput.value = cwd;
    cwdInput.dispatchEvent(new Event('input'));
  }
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
    
    // Model name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'model-name';
    nameSpan.textContent = model.name;
    item.appendChild(nameSpan);
    
    // Cost indicator
    const costSpan = document.createElement('span');
    costSpan.className = 'model-cost';
    if (model.cost === 0) {
      costSpan.textContent = 'free';
      costSpan.classList.add('free');
    } else if (model.cost < 1) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('cheap');
    } else if (model.cost > 10) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('ultra');
    } else if (model.cost > 5) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('premium');
    } else if (model.cost > 1) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('expensive');
    } else {
      costSpan.textContent = '1x';
    }
    item.appendChild(costSpan);
    
    container.appendChild(item);
  }
  
  // Update footer with model + CWD as user types
  setupCwdFooterSync();
}

let cwdSyncInstalled = false;

function setupCwdFooterSync(): void {
  if (cwdSyncInstalled) return;
  const cwdInput = document.getElementById('newChatCwd') as HTMLInputElement;
  if (!cwdInput) return;
  
  cwdSyncInstalled = true;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  
  cwdInput.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const cwd = cwdInput.value.trim();
      const modelId = getSelectedModel();
      const models = getAvailableModels();
      const model = models.find(m => m.id === modelId);
      renderStatus(model?.name || modelId?.split('/').pop() || '', cwd);
    }, 300);
  });
  
  // Render initial state
  const cwd = cwdInput.value.trim();
  if (cwd) {
    const modelId = getSelectedModel();
    const models = getAvailableModels();
    const model = models.find(m => m.id === modelId);
    renderStatus(model?.name || modelId?.split('/').pop() || '', cwd);
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
  if (cwd && modelInfo) {
    renderStatus(modelInfo.name, cwd);
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
