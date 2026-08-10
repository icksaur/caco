/**
 * UI utility functions
 */

/**
 * Scroll chat to bottom.
 *
 * The chat can have no layout at the moment this is called. On mobile the
 * session list owns the screen, so `.chat-panel` is `display: none` while it is
 * open. A hidden element reports `scrollHeight` 0 and discards writes to
 * `scrollTop`, so the scroll silently did nothing and the user landed at the top
 * of the conversation.
 *
 * So a scroll that cannot happen yet is retried until the element is laid out,
 * rather than reported as done. Three bounds on that retry:
 *
 *  - a deadline, so a chat that is never shown cannot leave a timer running for
 *    the life of the page;
 *  - the retry is abandoned the moment the user has scrolled themselves, because
 *    a delayed jump to the bottom under someone reading is worse than the
 *    staleness it fixes;
 *  - it is keyed to the element it was armed for, so a retry for one scroller
 *    cannot be cancelled by, or fight with, a call about another.
 */
const RETRY_INTERVAL_MS = 50;
const RETRY_LIMIT_MS = 2000;
const pendingRetries = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function cancelRetry(el: Element): void {
  const t = pendingRetries.get(el);
  if (t !== undefined) { clearTimeout(t); pendingRetries.delete(el); }
}

export function scrollToBottom(): void {
  const chatScroll = document.getElementById('chatScroll');
  if (!chatScroll) return;
  cancelRetry(chatScroll);

  const deadline = Date.now() + RETRY_LIMIT_MS;
  const attempt = (isRetry: boolean): void => {
    pendingRetries.delete(chatScroll);

    // A hidden scroller is pinned at 0, so a non-zero position means the user
    // moved it once it appeared. That only disqualifies a DELAYED scroll: the
    // caller's own call is an explicit request for now, and callers such as new
    // streamed content are entitled to it. A retry is an obligation the user has
    // since superseded by reading.
    if (isRetry && chatScroll.scrollTop !== 0) return;

    // Zero means "no layout yet", not "empty": an element with content but no
    // box reports 0 for both. Either way there is nothing to scroll, so treat it
    // as not-yet rather than done.
    if (chatScroll.scrollHeight > 0) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
      return;
    }
    if (Date.now() >= deadline) return;
    pendingRetries.set(chatScroll, setTimeout(() => attempt(true), RETRY_INTERVAL_MS));
  };

  attempt(false);
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

interface Sortable {
  isUnobserved?: boolean;
  kind?: string;
  updatedAt?: string;
}

export function sortSessions<T extends Sortable>(sessions: T[]): T[] {
  const kindOrder: Record<string, number> = { interactive: 0, scheduled: 1, agent: 2, swarm: 3 };
  return sessions.sort((a, b) => {
    if (a.isUnobserved !== b.isUnobserved) return a.isUnobserved ? -1 : 1;
    const aKind = kindOrder[a.kind ?? 'interactive'] ?? 0;
    const bKind = kindOrder[b.kind ?? 'interactive'] ?? 0;
    if (aKind !== bKind) return aKind - bKind;
    if (a.updatedAt && b.updatedAt) {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
    if (a.updatedAt) return -1;
    if (b.updatedAt) return 1;
    return 0;
  });
}
