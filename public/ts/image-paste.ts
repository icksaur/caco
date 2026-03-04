/**
 * Multi-image paste handling (max 3 images)
 */

import { setHasImage } from './app-state.js';

const MAX_IMAGES = 3;
const images: string[] = [];

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
        renderPreviews();
      };
      reader.onerror = (error) => console.error('FileReader error:', error);
      reader.readAsDataURL(blob);
    }
  });
}

function renderPreviews(): void {
  const container = document.getElementById('imagePreview');
  if (!container) return;

  container.innerHTML = '';

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

  container.classList.toggle('visible', images.length > 0);
  syncHiddenInput();
  setHasImage(images.length > 0);
}

function syncHiddenInput(): void {
  const input = document.getElementById('imageData') as HTMLInputElement;
  if (input) input.value = images.join('\n');
}

function removeImageAt(index: number): void {
  images.splice(index, 1);
  renderPreviews();
}

export function removeImage(): void {
  images.length = 0;
  renderPreviews();
}
