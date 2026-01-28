/**
 * UI utility functions
 */

/** Threshold in pixels for considering "at bottom" */
const SCROLL_THRESHOLD = 100;

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
 * Scroll chat to bottom, but only if already at bottom (or forced)
 * @param force - If true, always scroll regardless of current position
 */
export function scrollToBottom(force = false): void {
  const chatView = document.getElementById('chatView');
  if (!chatView) return;
  
  // Only scroll if user is already at bottom or force is true
  if (!force && !isAtBottom()) return;
  
  chatView.scrollTop = chatView.scrollHeight;
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
