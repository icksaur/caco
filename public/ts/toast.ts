/**
 * Toast notification system
 * 
 * Floating notifications above chat input for errors that shouldn't
 * interrupt the chat flow (e.g., session creation failures).
 * 
 * Features:
 * - Floats above input, doesn't displace chat messages
 * - Auto-hides when WebSocket stream messages arrive
 * - Can be dismissed manually
 */

let toastTimeout: number | null = null;

/**
 * Show a toast notification
 */
export function showToast(message: string, autoHideMs = 0): void {
  const toast = document.getElementById('toast');
  const messageSpan = toast?.querySelector('.toast-message');
  
  if (!toast || !messageSpan) return;
  
  // Clear any pending auto-hide
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  
  messageSpan.textContent = message;
  toast.classList.remove('hidden');
  
  // Auto-hide after delay if specified
  if (autoHideMs > 0) {
    toastTimeout = window.setTimeout(() => hideToast(), autoHideMs);
  }
}

/**
 * Hide the toast notification
 */
export function hideToast(): void {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.classList.add('hidden');
  }
  
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

/**
 * Check if toast is currently visible
 */
export function isToastVisible(): boolean {
  const toast = document.getElementById('toast');
  return toast ? !toast.classList.contains('hidden') : false;
}
