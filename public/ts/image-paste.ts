/**
 * Multi-image paste handling (max 3 images)
 *
 * Registers images as an ad-hoc bar widget for the active session.
 * Still owns the images array and hidden input sync.
 */

import { setHasImage, getActiveSessionId } from './app-state.js';
import { adHocBar } from './adhoc-bar.js';
import type { AdHocWidgetHandle } from './adhoc-bar.js';

const MAX_IMAGES = 3;
const images: string[] = [];
let widgetHandle: AdHocWidgetHandle | null = null;
let widgetSessionId: string | null = null;

export function setupImagePaste(): void {
  document.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (images.length >= MAX_IMAGES) break;
      const item = items[i];
      if (item.type.indexOf('image') === -1) continue;

      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        if (images.length >= MAX_IMAGES) return;
        images.push(base64);
        syncWidget();
      };
      reader.onerror = (error) => console.error('FileReader error:', error);
      reader.readAsDataURL(blob);
    }
  });
}

function renderThumbnails(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'image-thumbnails';
  container.style.display = 'flex';
  container.style.gap = '8px';

  for (let i = 0; i < images.length; i++) {
    const thumb = document.createElement('div');
    thumb.className = 'image-thumb';

    const img = document.createElement('img');
    img.src = images[i];
    img.alt = `Image ${i + 1}`;
    thumb.appendChild(img);

    const btn = document.createElement('button');
    btn.className = 'image-remove-btn';
    btn.textContent = '×';
    btn.type = 'button';
    const idx = i;
    btn.onclick = () => removeImageAt(idx);
    thumb.appendChild(btn);

    container.appendChild(thumb);
  }

  return container;
}

function syncWidget(): void {
  const sessionId = getActiveSessionId();
  syncHiddenInput();
  setHasImage(images.length > 0);

  if (images.length === 0) {
    if (widgetHandle) {
      widgetHandle.remove();
      widgetHandle = null;
      widgetSessionId = null;
    }
    // Also clear direct render if no session
    if (!sessionId) {
      const container = document.getElementById('adHocBar');
      if (container) {
        container.innerHTML = '';
        container.classList.remove('visible');
      }
    }
    return;
  }

  // No active session (new chat) — render directly to container
  if (!sessionId) {
    const container = document.getElementById('adHocBar');
    if (container) {
      container.innerHTML = '';
      container.appendChild(renderThumbnails());
      container.classList.add('visible');
    }
    return;
  }

  if (widgetHandle && widgetSessionId === sessionId) {
    widgetHandle.update();
  } else {
    if (widgetHandle) widgetHandle.remove();
    widgetSessionId = sessionId;
    widgetHandle = adHocBar.addWidget(sessionId, {
      id: 'images',
      priority: 0,
      render: renderThumbnails,
    });
  }
}

function syncHiddenInput(): void {
  const input = document.getElementById('imageData') as HTMLInputElement;
  if (input) input.value = images.join('\n');
}

function removeImageAt(index: number): void {
  images.splice(index, 1);
  syncWidget();
}

export function removeImage(): void {
  images.length = 0;
  syncWidget();
}
