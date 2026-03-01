/**
 * UI utility functions
 */

/**
 * Scroll chat to bottom
 */
export function scrollToBottom(): void {
  const chatScroll = document.getElementById('chatScroll');
  if (!chatScroll) return;
  
  chatScroll.scrollTop = chatScroll.scrollHeight;
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
 * Format file paths as display names (just the filename).
 * Returns array of {name, path} for rendering.
 */
export function formatContextFiles(files: string[], limit = 3): { name: string; path: string }[] {
  return files.slice(0, limit).map(path => ({
    name: path.split(/[\\/]/).pop() || path,
    path
  }));
}

/**
 * Format model + CWD as display parts.
 * Shared between context footer and session items.
 */
export function formatStatusParts(modelName: string, cwd: string): { model?: string; dirName?: string; fullCwd?: string } {
  const result: { model?: string; dirName?: string; fullCwd?: string } = {};
  if (modelName) result.model = modelName;
  if (cwd) {
    result.dirName = (cwd.split(/[\\/]/).pop() || cwd) + '/';
    result.fullCwd = cwd;
  }
  return result;
}
export function formatAge(dateStr: string | undefined, compact = false): string {
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
  
  if (compact) {
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }
  
  if (years >= 1) return `${years} year${years > 1 ? 's' : ''}`;
  if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
  if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes >= 1) return `${minutes} min`;
  return 'just now';
}

export function fuzzyScore(target: string, query: string): number {
  if (query.length === 0) return 0;
  if (target.length === 0) return -1;
  
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;
  
  for (let i = 0; i < target.length && queryIdx < query.length; i++) {
    if (target[i] === query[queryIdx]) {
      score += 1;
      
      if (i === prevMatchIdx + 1) {
        score += 10;
      }
      
      if (i === 0 || '-_/ '.includes(target[i - 1])) {
        score += 5;
      }
      
      prevMatchIdx = i;
      queryIdx++;
    }
  }
  
  return queryIdx === query.length ? score : -1;
}
