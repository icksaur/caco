/**
 * Model selection
 */

import type { ModelInfo, Preferences } from './types.js';
import { getSelectedModel, setSelectedModel as stateSetSelectedModel } from './state.js';

/**
 * Curated model list with display names and costs
 */
export const CURATED_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', cost: 1 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', cost: 1 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', cost: 3 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', cost: 0.33 },
  { id: 'gpt-4.1', name: 'GPT-4.1', cost: 0 },
  { id: 'gpt-4o', name: 'GPT-4o', cost: 0 },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', cost: 0 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', cost: 1 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', cost: 0.33 }
];

/**
 * Toggle model dropdown visibility
 */
export function toggleModelDropdown(): void {
  const dropdown = document.getElementById('modelDropdown');
  const modelBtn = document.querySelector('.hamburger-btn.model-btn');
  
  if (!dropdown) return;
  
  const isOpen = dropdown.classList.contains('visible');
  
  if (isOpen) {
    dropdown.classList.remove('visible');
    modelBtn?.classList.remove('active');
  } else {
    dropdown.classList.add('visible');
    modelBtn?.classList.add('active');
    // Load models when opening
    loadModels();
  }
}

/**
 * Set up click-outside handler to close dropdown
 */
export function setupModelDropdownClose(): void {
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('modelDropdown');
    const modelBtn = document.querySelector('.hamburger-btn.model-btn');
    if (dropdown && modelBtn && 
        !dropdown.contains(e.target as Node) && 
        !modelBtn.contains(e.target as Node)) {
      dropdown.classList.remove('visible');
      modelBtn.classList.remove('active');
    }
  });
}

/**
 * Load and render model list
 */
export function loadModels(): void {
  const container = document.getElementById('modelList');
  if (!container) return;
  
  container.innerHTML = '';
  const currentModel = getSelectedModel();
  
  for (const model of CURATED_MODELS) {
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
    } else if (model.cost > 1) {
      costSpan.textContent = `${model.cost}x`;
      costSpan.classList.add('expensive');
    } else {
      costSpan.textContent = '1x';
    }
    item.appendChild(costSpan);
    
    container.appendChild(item);
  }
}

/**
 * Select a model
 */
export function selectModel(modelId: string): void {
  // Update state (also syncs hidden input)
  stateSetSelectedModel(modelId);
  
  // Update placeholder to show selected model
  const modelInfo = CURATED_MODELS.find(m => m.id === modelId);
  const input = document.querySelector('input[name="message"]') as HTMLInputElement;
  if (input && modelInfo) {
    input.placeholder = `Ask ${modelInfo.name}...`;
  }
  
  // Save preference to server
  fetch('/api/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastModel: modelId })
  }).catch(() => {}); // Ignore errors
  
  // Close dropdown
  toggleModelDropdown();
}

/**
 * Apply model from preferences
 */
export function applyModelPreference(prefs: Preferences): void {
  if (prefs.lastModel && CURATED_MODELS.find(m => m.id === prefs.lastModel)) {
    // Update state (also syncs hidden input)
    stateSetSelectedModel(prefs.lastModel);
    
    // Update placeholder
    const modelInfo = CURATED_MODELS.find(m => m.id === prefs.lastModel);
    const input = document.querySelector('input[name="message"]') as HTMLInputElement;
    if (input && modelInfo) {
      input.placeholder = `Ask ${modelInfo.name}...`;
    }
  }
}
