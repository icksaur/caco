/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge } from './ui-utils.js';
import { getActiveSessionId } from './app-state.js';
import { setAvailableModels } from './model-selector.js';
import { setViewState } from './view-controller.js';
import { sessionClick } from './router.js';
import { onGlobalEvent } from './websocket.js';

// Module state for fuzzy search
let allSessions: SessionData[] = [];
let searchQuery = '';

/**
 * Initialize session panel - subscribe to global events for session list changes
 */
export function initSessionPanel(): void {
  // Set up search input handlers
  const searchInput = document.getElementById('sessionSearchInput') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.toLowerCase().trim();
      renderFilteredSessions();
    });
    
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (searchQuery) {
          // Clear search first
          searchInput.value = '';
          searchQuery = '';
          renderFilteredSessions();
          e.stopPropagation();
        }
        // Otherwise let Escape close the panel (handled by view-controller)
      } else if (e.key === 'Enter') {
        // Select first session in filtered list
        const firstSession = document.querySelector('.session-item') as HTMLElement;
        if (firstSession?.dataset.sessionId) {
          void sessionClick(firstSession.dataset.sessionId);
        }
      }
    });
  }

  // Subscribe to unified session list change event
  onGlobalEvent((event) => {
    // Unified event for any session list mutation (created, deleted, idle, observed, renamed)
    if (event.type === 'session.listChanged') {
      console.log('[SESSION-PANEL] Session list changed, refreshing...', event.data);
      void loadSessions();
      return;
    }
    
    // Keep session.busy for immediate visual feedback (cursor animation)
    if (event.type === 'session.busy' && event.data) {
      const { sessionId, isBusy } = event.data as { sessionId: string; isBusy: boolean };
      updateSessionItemState(sessionId, isBusy);
      updateMenuBusyIndicator();
    }
  });
}

/**
 * Update a single session item's busy state in the DOM
 */
function updateSessionItemState(sessionId: string, isBusy: boolean): void {
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (!item) return;
  
  if (isBusy) {
    item.classList.add('busy');
    // Add throbber if not present
    if (!item.querySelector('.session-busy-indicator')) {
      const throbber = document.createElement('span');
      throbber.className = 'session-busy-indicator';
      throbber.setAttribute('aria-label', 'Session is processing');
      item.insertBefore(throbber, item.firstChild);
    }
    // Remove delete button
    const deleteBtn = item.querySelector('.session-delete');
    if (deleteBtn) deleteBtn.remove();
  } else {
    item.classList.remove('busy');
    // Remove throbber
    const throbber = item.querySelector('.session-busy-indicator');
    if (throbber) throbber.remove();
    // Add delete button if not present
    if (!item.querySelector('.session-delete')) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.textContent = '×';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        const summary = item.querySelector('.session-summary')?.textContent || undefined;
        void deleteSession(sessionId, summary);
      };
      item.appendChild(deleteBtn);
    }
  }
}

/**
 * Update the unobserved count badge on menu button
 * When visible, hides the busy indicator (unobserved takes priority)
 */
function updateUnobservedBadge(count: number): void {
  const badge = document.getElementById('unobservedBadge');
  const busyIndicator = document.getElementById('menuBusyIndicator');
  if (!badge) return;
  
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
    // Hide busy indicator when unobserved badge is shown (priority)
    busyIndicator?.classList.add('hidden');
  } else {
    badge.classList.add('hidden');
    // Show busy indicator if there are busy sessions
    updateMenuBusyIndicator();
  }
}

/**
 * Update the busy indicator on menu button
 * Only visible when:
 * 1. No unobserved sessions (unobserved badge takes priority)
 * 2. There are busy sessions OTHER than the currently viewed session
 * 
 * Rationale: If user is viewing a busy session, they already see the streaming
 * cursor in the chat - no need for redundant badge indicator.
 */
function updateMenuBusyIndicator(): void {
  const busyIndicator = document.getElementById('menuBusyIndicator');
  const unobservedBadge = document.getElementById('unobservedBadge');
  if (!busyIndicator) return;
  
  // Don't show if unobserved badge is visible
  if (unobservedBadge && !unobservedBadge.classList.contains('hidden')) {
    busyIndicator.classList.add('hidden');
    return;
  }
  
  // Check if any session OTHER than the active one is busy
  const activeSessionId = getActiveSessionId();
  const busySessions = document.querySelectorAll('.session-item.busy');
  let hasOtherBusySessions = false;
  
  for (const item of busySessions) {
    const itemSessionId = (item as HTMLElement).dataset.sessionId;
    if (itemSessionId !== activeSessionId) {
      hasOtherBusySessions = true;
      break;
    }
  }
  
  if (hasOtherBusySessions) {
    busyIndicator.classList.remove('hidden');
  } else {
    busyIndicator.classList.add('hidden');
  }
}

/**
 * Show session manager as the main view (landing page)
 */
export function showSessionManager(): void {
  setViewState('sessions');
  loadSessions();
  loadSchedules();
  loadUsage();
  
  // Focus search input for keyboard-first navigation
  // Use setTimeout to ensure DOM is updated after view state change
  setTimeout(() => {
    const searchInput = document.getElementById('sessionSearchInput') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.focus();
    }
  }, 0);
}

/**
 * Load and render schedules
 */
async function loadSchedules(): Promise<void> {
  const container = document.getElementById('schedulesList');
  if (!container) return;
  
  try {
    const response = await fetch('/api/schedule');
    if (!response.ok) {
      container.innerHTML = '<div class="schedules-empty">failed to load schedules</div>';
      return;
    }
    
    const data = await response.json();
    const schedules = data.schedules || [];
    
    if (schedules.length === 0) {
      container.innerHTML = '<div class="schedules-empty">no scheduled sessions</div>';
      return;
    }
    
    container.innerHTML = '';
    
    for (const schedule of schedules) {
      const item = document.createElement('div');
      item.className = `schedule-item${schedule.enabled ? '' : ' disabled'}`;
      item.dataset.slug = schedule.slug;
      
      // Format next run time
      let nextRunText = '';
      if (schedule.nextRun) {
        const nextRun = new Date(schedule.nextRun);
        const now = new Date();
        const diffMs = nextRun.getTime() - now.getTime();
        
        if (diffMs < 0) {
          nextRunText = 'overdue';
        } else if (diffMs < 60 * 60 * 1000) {
          nextRunText = `${Math.round(diffMs / 60000)}m`;
        } else if (diffMs < 24 * 60 * 60 * 1000) {
          nextRunText = `${Math.round(diffMs / 3600000)}h`;
        } else {
          nextRunText = nextRun.toLocaleDateString();
        }
      }
      
      item.innerHTML = `
        <span class="schedule-slug">${escapeHtml(schedule.slug)}</span>
        ${nextRunText ? `<span class="schedule-next">next: ${nextRunText}</span>` : ''}
        <div class="schedule-actions">
          <button class="schedule-run" title="Run now">▶</button>
          <button class="schedule-toggle" title="${schedule.enabled ? 'Disable' : 'Enable'}">
            ${schedule.enabled ? '✓' : '○'}
          </button>
        </div>
      `;
      
      // Run schedule immediately on run button click
      const runBtn = item.querySelector('.schedule-run');
      runBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await runSchedule(schedule.slug);
      });
      
      // Toggle enabled state on button click
      const toggleBtn = item.querySelector('.schedule-toggle');
      toggleBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleSchedule(schedule.slug, !schedule.enabled);
        loadSchedules(); // Reload to update UI
      });
      
      container.appendChild(item);
    }
  } catch (error) {
    console.error('[SCHEDULE] Failed to load schedules:', error);
    container.innerHTML = '<div class="schedules-empty">failed to load schedules</div>';
  }
}

/**
 * Toggle schedule enabled state
 */
async function toggleSchedule(slug: string, enabled: boolean): Promise<void> {
  try {
    const response = await fetch(`/api/schedule/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    
    if (!response.ok) {
      console.error('[SCHEDULE] Failed to toggle schedule:', response.status);
    }
  } catch (error) {
    console.error('[SCHEDULE] Error toggling schedule:', error);
  }
}

/**
 * Run schedule immediately
 */
async function runSchedule(slug: string): Promise<void> {
  try {
    console.log('[SCHEDULE] Running:', slug);
    const response = await fetch(`/api/schedule/${slug}/run`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      console.error('[SCHEDULE] Failed to run schedule:', response.status);
    } else {
      const result = await response.json();
      console.log('[SCHEDULE] Run result:', result);
    }
  } catch (error) {
    console.error('[SCHEDULE] Error running schedule:', error);
  }
}

/**
 * Escape HTML for safe insertion
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Load and render sessions
 */
export async function loadSessions(): Promise<void> {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;
    
    const data: SessionsResponse = await response.json();
    const { grouped, models, unobservedCount } = data;
    
    // Update badge count on menu button
    updateUnobservedBadge(unobservedCount ?? 0);
    
    // DEBUG: Log session data to verify unobserved state is coming from server
    console.log(`[SESSION-PANEL] Loaded sessions: ${Object.values(grouped).flat().length} total, ${unobservedCount} unobserved`);
    for (const [_cwd, sessions] of Object.entries(grouped)) {
      for (const s of sessions) {
        if (s.isUnobserved || s.isBusy) {
          console.log(`[SESSION-PANEL] ${s.sessionId.slice(0, 8)}: isUnobserved=${s.isUnobserved}, isBusy=${s.isBusy}`);
        }
      }
    }
    
    // Store available models from SDK
    if (models && models.length > 0) {
      setAvailableModels(models);
    }
    
    const container = document.getElementById('sessionList');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Flatten all sessions from grouped structure into single MRU list
    // Preserve cwd from the grouping key, omit sessions without CWD
    // Store in module state for fuzzy filtering
    allSessions = [];
    for (const [cwd, sessions] of Object.entries(grouped)) {
      // Skip sessions without a valid CWD (incomplete or corrupted)
      if (cwd === '(unknown)') continue;
      for (const session of sessions) {
        allSessions.push({ ...session, cwd });
      }
    }
    
    // Sort by updatedAt descending (most recently updated first)
    allSessions.sort((a, b) => {
      if (a.updatedAt && b.updatedAt) {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (a.updatedAt) return -1;
      if (b.updatedAt) return 1;
      return 0;
    });
    
    // Render sessions (respecting current search filter)
    renderFilteredSessions();
    
    // Update menu button busy indicator after all sessions rendered
    updateMenuBusyIndicator();
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

/**
 * Render sessions filtered by current search query
 */
function renderFilteredSessions(): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  
  const activeSessionId = getActiveSessionId();
  
  container.innerHTML = '';
  
  // Add sessions heading
  const heading = document.createElement('div');
  heading.className = 'section-header';
  heading.textContent = 'sessions';
  container.appendChild(heading);
  
  // Filter sessions by search query
  const filtered = searchQuery
    ? allSessions.filter(s => matchesSearch(s, searchQuery))
    : allSessions;
  
  // Show empty state if no matches
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'schedules-empty';
    empty.textContent = searchQuery ? 'no matching sessions' : 'no sessions';
    container.appendChild(empty);
    return;
  }
  
  // Render each session with CWD below
  for (const session of filtered) {
    const item = createSessionItem(session, activeSessionId ?? undefined);
    container.appendChild(item);
  }
}

/**
 * Fuzzy match: each character in query must appear in target in order.
 * Returns score (higher = better match), or -1 if no match.
 * 
 * Scoring:
 * - +10 for consecutive character matches
 * - +5 for matching at word boundary (after -, _, /, space, or start)
 * - +1 for any match
 */
function fuzzyScore(target: string, query: string): number {
  if (query.length === 0) return 0;
  if (target.length === 0) return -1;
  
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2; // -2 so first match isn't "consecutive"
  
  for (let i = 0; i < target.length && queryIdx < query.length; i++) {
    if (target[i] === query[queryIdx]) {
      score += 1; // Base score for match
      
      // Bonus for consecutive matches
      if (i === prevMatchIdx + 1) {
        score += 10;
      }
      
      // Bonus for word boundary (start, or after separator)
      if (i === 0 || '-_/ '.includes(target[i - 1])) {
        score += 5;
      }
      
      prevMatchIdx = i;
      queryIdx++;
    }
  }
  
  // All query characters must be found
  return queryIdx === query.length ? score : -1;
}

/**
 * Check if a session matches the search query (fuzzy match)
 */
function matchesSearch(session: SessionData, query: string): boolean {
  const name = (session.name || session.summary || '').toLowerCase();
  const cwd = (session.cwd || '').toLowerCase();
  return fuzzyScore(name, query) >= 0 || fuzzyScore(cwd, query) >= 0;
}

/**
 * Create a session item element
 */
function createSessionItem(session: SessionData, activeSessionId?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';
  if (activeSessionId && session.sessionId === activeSessionId) {
    item.classList.add('active');
  }
  if (session.isBusy) {
    item.classList.add('busy');
  }
  if (session.isUnobserved) {
    item.classList.add('unobserved');
  }
  item.dataset.sessionId = session.sessionId;
  
  // Unobserved badge (new activity indicator)
  if (session.isUnobserved) {
    const badge = document.createElement('span');
    badge.className = 'session-unobserved-badge';
    badge.setAttribute('aria-label', 'New activity');
    badge.title = 'Session has new activity since last viewed';
    item.appendChild(badge);
  }
  
  // Busy indicator (throbber)
  if (session.isBusy) {
    const throbber = document.createElement('span');
    throbber.className = 'session-busy-indicator';
    throbber.setAttribute('aria-label', 'Session is processing');
    item.appendChild(throbber);
  }
  
  // Content wrapper (summary + age) - clickable area
  const content = document.createElement('div');
  content.className = 'session-item-content';
  content.onclick = () => sessionClick(session.sessionId);
  
  // Display name: custom name or SDK summary
  const displayName = session.name || session.summary || 'No summary';
  
  // Summary text (truncated with ellipsis)
  const summarySpan = document.createElement('span');
  summarySpan.className = 'session-summary';
  summarySpan.textContent = displayName;
  content.appendChild(summarySpan);
  
  // Schedule badge (if session was created by a schedule)
  if (session.scheduleSlug) {
    const scheduleBadge = document.createElement('span');
    scheduleBadge.className = 'session-schedule-badge';
    scheduleBadge.textContent = '⏰';
    scheduleBadge.title = session.scheduleNextRun
      ? `Schedule: ${session.scheduleSlug}\nNext run: ${new Date(session.scheduleNextRun).toLocaleString()}`
      : `Schedule: ${session.scheduleSlug}`;
    content.appendChild(scheduleBadge);
  }
  
  // Intent for busy sessions (what the agent is working on)
  if (session.isBusy && session.currentIntent) {
    const intentSpan = document.createElement('span');
    intentSpan.className = 'session-intent';
    intentSpan.textContent = session.currentIntent;
    intentSpan.title = session.currentIntent;
    content.appendChild(intentSpan);
  }
  
  // Age (fixed on right)
  if (session.updatedAt) {
    const ageSpan = document.createElement('span');
    ageSpan.className = 'session-age';
    ageSpan.textContent = formatAge(session.updatedAt);
    content.appendChild(ageSpan);
  }
  
  item.appendChild(content);
  
  // CWD path below (always present - sessions without CWD are filtered out)
  const cwdSpan = document.createElement('div');
  cwdSpan.className = 'session-cwd';
  cwdSpan.textContent = session.cwd!;
  item.appendChild(cwdSpan);
  
  // Action buttons (edit, delete) in a container
  if (!session.isBusy) {
    const actions = document.createElement('div');
    actions.className = 'session-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'session-edit';
    editBtn.textContent = '✏️';
    editBtn.title = 'Rename session';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      renameSession(session.sessionId, displayName);
    };
    actions.appendChild(editBtn);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'session-delete';
    deleteBtn.textContent = '×';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(session.sessionId, displayName);
    };
    actions.appendChild(deleteBtn);
    
    item.appendChild(actions);
  }
  
  return item;
}

/**
 * Rename a session (custom name)
 */
async function renameSession(sessionId: string, currentName: string): Promise<void> {
  const newName = prompt('Session name:', currentName);
  if (newName === null) return; // Cancelled
  
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    
    if (response.ok) {
      loadSessions(); // Refresh list
    } else {
      const data = await response.json();
      alert(`Failed to rename: ${data.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Failed to rename session:', error);
    alert('Failed to rename session');
  }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string, displayName?: string): Promise<void> {
  const name = displayName || sessionId.slice(0, 8);
  if (!confirm(`Delete session "${name}"?\n\nThis cannot be undone.`)) {
    return;
  }
  
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      // Refresh session list - stays in session view
      // If we deleted the active session, user can pick another or start new
      loadSessions();
    } else {
      const err = await response.json();
      alert('Failed to delete session: ' + err.error);
    }
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + (error as Error).message);
  }
}

/**
 * Fetch and display usage/budget info
 */
async function loadUsage(): Promise<void> {
  try {
    const response = await fetch('/api/usage');
    if (!response.ok) return;

    const data = await response.json();
    const usage = data.usage;

    const container = document.getElementById('usageInfo');
    if (!container) return;

    if (!usage) {
      container.textContent = '';
      return;
    }

    if (usage.isUnlimited) {
      let text = 'Unlimited usage';
      if (usage.fromCache) {
        text += ` (last fetched ${formatAge(usage.updatedAt, true)})`;
      }
      container.textContent = text;
      container.className = 'usage-info';
      return;
    }

    const remaining = Math.round(usage.remainingPercentage);
    let text = `${remaining}% of budget remaining`;
    if (usage.fromCache) {
      text += ` (last fetched ${formatAge(usage.updatedAt, true)})`;
    }
    container.textContent = text;

    // Add warning classes for low usage
    container.className = 'usage-info';
    if (remaining <= 10) {
      container.classList.add('usage-critical');
    } else if (remaining <= 25) {
      container.classList.add('usage-low');
    }
  } catch (error) {
    console.error('Failed to load usage:', error);
  }
}
