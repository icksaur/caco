/**
 * UI utility functions
 */

/** Threshold in pixels for considering "at bottom" */
const SCROLL_THRESHOLD = 150;

/** Auto-scroll mode - disabled when user actively scrolls up */
let autoScrollEnabled = true;

/**
 * Check if chat is scrolled to bottom (or near it)
 */
export function isAtBottom(): boolean {
  const chatView = document.getElementById('chatView');
  if (!chatView) return true;
  
  const distanceFromBottom = chatView.scrollHeight - chatView.scrollTop - chatView.clientHeight;
  return distanceFromBottom <= SCROLL_THRESHOLD;
}

/**
 * Enable auto-scroll mode (call when sending a message)
 */
export function enableAutoScroll(): void {
  autoScrollEnabled = true;
}

/**
 * Check if auto-scroll is enabled
 */
export function isAutoScrollEnabled(): boolean {
  return autoScrollEnabled;
}

/**
 * Scroll chat to bottom
 * Always scrolls - the caller should check isAutoScrollEnabled() if conditional scroll is needed
 */
export function scrollToBottom(force = false): void {
  const chatView = document.getElementById('chatView');
  if (!chatView) return;
  
  // If not forcing, only scroll if auto-scroll is enabled
  if (!force && !autoScrollEnabled) return;
  
  chatView.scrollTop = chatView.scrollHeight;
}

/**
 * Setup wheel listener to detect user scrolling up
 * Uses wheel event instead of scroll event to avoid detecting programmatic scrolls
 */
export function setupScrollDetection(): void {
  const chatView = document.getElementById('chatView');
  if (!chatView) return;
  
  // Wheel event fires only on user mouse wheel - not programmatic scrolls
  chatView.addEventListener('wheel', (e: WheelEvent) => {
    // Scrolling up (negative deltaY)
    if (e.deltaY < 0) {
      autoScrollEnabled = false;
    }
    // Scrolling down and at bottom - re-enable
    if (e.deltaY > 0 && isAtBottom()) {
      autoScrollEnabled = true;
    }
  }, { passive: true });
  
  // Touch events for mobile
  let touchStartY = 0;
  chatView.addEventListener('touchstart', (e: TouchEvent) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  
  chatView.addEventListener('touchmove', (e: TouchEvent) => {
    const touchY = e.touches[0].clientY;
    const deltaY = touchStartY - touchY; // positive = scroll up
    
    if (deltaY < -10) { // swiping down = scrolling up
      autoScrollEnabled = false;
    }
    if (deltaY > 10 && isAtBottom()) { // swiping up = scrolling down
      autoScrollEnabled = true;
    }
    touchStartY = touchY;
  }, { passive: true });
}

/**
 * HTML escape helper
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Format relative time
 */
export function formatAge(dateStr: string | undefined): string {
  if (!dateStr) return '';
  
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  
  if (years >= 1) return `${years} year${years > 1 ? 's' : ''}`;
  if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
  if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes >= 1) return `${minutes} min`;
  return 'just now';
}
