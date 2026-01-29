/**
 * Image paste handling
 */

import { setHasImage } from './app-state.js';

/**
 * Set up paste handler for image attachments
 */
export function setupImagePaste(): void {
  document.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        
        const reader = new FileReader();
        
        reader.onload = (event) => {
          const base64 = event.target?.result as string;
          const imageData = document.getElementById('imageData') as HTMLInputElement;
          const previewImg = document.getElementById('previewImg') as HTMLImageElement;
          const imagePreview = document.getElementById('imagePreview');
          
          if (imageData) imageData.value = base64;
          if (previewImg) previewImg.src = base64;
          if (imagePreview) imagePreview.classList.add('visible');
          setHasImage(true);
        };
        
        reader.onerror = (error) => console.error('FileReader error:', error);
        reader.readAsDataURL(blob);
        break;
      }
    }
  });
}

/**
 * Remove attached image
 */
export function removeImage(): void {
  const imageData = document.getElementById('imageData') as HTMLInputElement;
  const previewImg = document.getElementById('previewImg') as HTMLImageElement;
  const imagePreview = document.getElementById('imagePreview');
  
  if (imageData) imageData.value = '';
  if (previewImg) previewImg.src = '';
  if (imagePreview) imagePreview.classList.remove('visible');
  setHasImage(false);
}
