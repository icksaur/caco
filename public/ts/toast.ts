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
 * - Supports different types: error (default), success, info
 */

let toastTimeout: number | null = null;

export type ToastType = 'error' | 'success' | 'info';

export interface ToastOptions {
  type?: ToastType;
  autoHideMs?: number;
}

/**
 * Show a toast notification
 */
export function showToast(message: string, options: ToastOptions | number = {}): void {
  const toast = document.getElementById('toast');
  const messageSpan = toast?.querySelector('.toast-message');
  
  if (!toast || !messageSpan) return;
  
  // Support legacy call with just autoHideMs number
  const opts: ToastOptions = typeof options === 'number' 
    ? { autoHideMs: options } 
    : options;
  const { type = 'error', autoHideMs = 0 } = opts;
  
  // Clear any pending auto-hide
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  
  // Set type class
  toast.classList.remove('toast-error', 'toast-success', 'toast-info');
  toast.classList.add(`toast-${type}`);
  
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
