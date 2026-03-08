/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge, formatStatusParts, fuzzyScore } from './ui-utils.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { setAvailableModels } from './model-selector.js';
import { setViewState } from './view-controller.js';
import { sessionClick, newSessionClick } from './router.js';
import { onGlobalEvent } from './websocket.js';
import { sessionTracker } from './session-state-tracker.js';

// Module state for fuzzy search
let allSessions: SessionData[] = [];
let searchQuery = '';

/**
 * Perform action button click - new session or resume first match
 * Single source of truth for action button behavior
 */
export function actionBtnClick(): void {
  if (!searchQuery) {
    newSessionClick();  // Empty search → new session
  } else {
    const firstSession = document.querySelector('.session-item') as HTMLElement;
    if (firstSession?.dataset.sessionId) {
      void sessionClick(firstSession.dataset.sessionId);  // Has matches → resume
    }
    // No matches → do nothing (button is disabled anyway)
  }
}

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
      if (e.key === 'Enter') {
        actionBtnClick();
      }
    });
  }

  // Subscribe to unified session list change event
  onGlobalEvent((event) => {
    if (event.type === 'session.listChanged') {
      console.log('[SESSION-PANEL] Session list changed, refreshing...', event.data);
      void loadSessions();
      return;
    }
    
    // Feed busy state into tracker (tracker notifies subscribers)
    if (event.type === 'session.busy' && event.data) {
      const { sessionId, isBusy } = event.data as { sessionId: string; isBusy: boolean };
      sessionTracker.setBusy(sessionId, isBusy);
    }
  });
  
  // Tracker drives DOM updates for session items and menu badges
  sessionTracker.onChange((sessionId, state) => {
    updateSessionItemState(sessionId, state.busy);
    updateMenuIndicators();
  });
}

/**
 * Show/hide loading indicator on session item while resume is pending
 * Uses a pseudo-element on .session-indicator for the spinner
 */
export function setSessionLoading(sessionId: string, loading: boolean): void {
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`) as HTMLElement;
  if (!item) return;
  
  if (loading) {
    item.classList.add('loading');
  } else {
    item.classList.remove('loading');
  }
}

/**
 * Update a single session item's busy state in the DOM
 */
function updateSessionItemState(sessionId: string, isBusy: boolean): void {
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (!item) return;
  
  const indicator = item.querySelector('.session-indicator');
  
  if (isBusy) {
    item.classList.add('busy');
    indicator?.classList.add('busy');
    indicator?.classList.remove('unobserved');
    // Remove action buttons when busy
    item.querySelector('.session-edit')?.remove();
    item.querySelector('.session-delete')?.remove();
  } else {
    item.classList.remove('busy');
    indicator?.classList.remove('busy');
    // Add action buttons if not present
    if (!item.querySelector('.session-delete')) {
      const editBtn = document.createElement('button');
      editBtn.className = 'session-edit';
      editBtn.textContent = '/';
      editBtn.title = 'Rename session';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        const title = item.querySelector('.session-title')?.textContent || 'Untitled';
        void renameSession(sessionId, title);
      };
      item.appendChild(editBtn);
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.textContent = '×';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        const title = item.querySelector('.session-title')?.textContent || 'Untitled';
        void deleteSession(sessionId, title);
      };
      item.appendChild(deleteBtn);
    }
  }
}

/**
 * Update all menu indicators (unobserved badge + busy indicator).
 * Uses tracker as source of truth instead of querying DOM.
 */
export function updateMenuIndicators(): void {
  const badge = document.getElementById('unobservedBadge');
  const busyIndicator = document.getElementById('menuBusyIndicator');
  
  const unobservedCount = sessionTracker.getUnobservedCount();
  const busyCount = sessionTracker.getBusyCount(getActiveSessionId() ?? undefined);
  
  if (badge) {
    if (unobservedCount > 0) {
      badge.textContent = String(unobservedCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  
  if (busyIndicator) {
    // Show busy indicator only when no unobserved badge and other sessions are busy
    if (unobservedCount === 0 && busyCount > 0) {
      busyIndicator.classList.remove('hidden');
    } else {
      busyIndicator.classList.add('hidden');
    }
  }
}

/**
 * Show session manager as the main view (landing page)
 */
export function showSessionManager(): void {
  setViewState('sessions');
  void loadSessions();
  void loadSchedules();
  void loadUsage();
  
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
      runBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        void runSchedule(schedule.slug);
      });
      
      // Toggle enabled state on button click
      const toggleBtn = item.querySelector('.schedule-toggle');
      toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        void toggleSchedule(schedule.slug, !schedule.enabled).then(() => loadSchedules());
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
    const { grouped, models } = data;
    
    // Flatten sessions for tracker sync
    const flatSessions: SessionData[] = [];
    for (const [cwd, sessions] of Object.entries(grouped)) {
      if (cwd === '(unknown)') continue;
      for (const session of sessions) {
        flatSessions.push({ ...session, cwd });
      }
    }
    
    // Sync tracker with server state (drives menu indicators via onChange)
    sessionTracker.syncFromList(flatSessions);
    updateMenuIndicators();
    
    console.log(`[SESSION-PANEL] Loaded sessions: ${flatSessions.length} total, ${sessionTracker.getUnobservedCount()} unobserved`);
    
    // Store available models from SDK
    if (models && models.length > 0) {
      setAvailableModels(models);
    }
    
    const container = document.getElementById('sessionList');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Use already-flattened list for rendering
    allSessions = flatSessions.filter(s => s.kind !== 'swarm');
    
    allSessions.sort((a, b) => {
      if (a.isUnobserved !== b.isUnobserved) return a.isUnobserved ? -1 : 1;
      const kindOrder: Record<string, number> = { interactive: 0, scheduled: 1, agent: 2, swarm: 3 };
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
    
    renderFilteredSessions();
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

/**
 * Render sessions filtered by current search query
 */
function renderFilteredSessions(): void {
  // Compute filtered FIRST (needed for button state)
  const filtered = searchQuery
    ? allSessions.filter(s => matchesSearch(s, searchQuery))
    : allSessions;
  
  // Update action button state (single source of truth)
  const btn = document.getElementById('actionBtn') as HTMLButtonElement | null;
  if (btn) {
    if (!searchQuery) {
      btn.textContent = '+ New session';
      btn.disabled = false;
    } else {
      btn.textContent = 'Resume session';
      btn.disabled = filtered.length === 0;
    }
  }
  
  const container = document.getElementById('sessionList');
  if (!container) return;
  
  const activeSessionId = getActiveSessionId();
  
  container.innerHTML = '';
  
  // Add sessions heading
  const heading = document.createElement('div');
  heading.className = 'section-header';
  heading.textContent = 'sessions';
  container.appendChild(heading);
  
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
 * Check if a session matches the search query (fuzzy match)
 */
function matchesSearch(session: SessionData, query: string): boolean {
  const name = (session.name || session.summary || '').toLowerCase();
  const cwd = (session.cwd || '').toLowerCase();
  return fuzzyScore(name, query) >= 0 || fuzzyScore(cwd, query) >= 0;
}

/**
 * Create a session item element
 * Layout: [ indicator | title... | cwd | age | actions ]
 */
function createSessionItem(session: SessionData, activeSessionId?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';
  if (activeSessionId && session.sessionId === activeSessionId) {
    item.classList.add('active');
  }
  const tracked = sessionTracker.get(session.sessionId);
  const isBusy = tracked?.busy ?? session.isBusy ?? false;
  const isUnobserved = tracked?.unobserved ?? session.isUnobserved ?? false;
  
  if (isBusy) {
    item.classList.add('busy');
  }
  if (isUnobserved) {
    item.classList.add('unobserved');
  }
  item.dataset.sessionId = session.sessionId;
  item.onclick = () => sessionClick(session.sessionId);
  
  // Row 1: indicator + title + age + action buttons
  const row1 = document.createElement('div');
  row1.className = 'session-row session-row-main';
  
  const indicator = document.createElement('span');
  indicator.className = 'session-indicator';
  if (isBusy) {
    indicator.classList.add('busy');
  } else if (isUnobserved) {
    indicator.classList.add('unobserved');
  }
  row1.appendChild(indicator);
  
  if (session.hasIcon) {
    const icon = document.createElement('img');
    icon.className = 'session-icon';
    icon.src = `/api/sessions/${session.sessionId}/icon`;
    icon.alt = '';
    row1.appendChild(icon);
  }
  
  const displayName = session.name || session.summary || 'No summary';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'session-title';
  titleSpan.textContent = displayName;
  titleSpan.title = displayName;
  row1.appendChild(titleSpan);
  
  if (session.updatedAt) {
    const ageSpan = document.createElement('span');
    ageSpan.className = 'session-age';
    ageSpan.textContent = formatAge(session.updatedAt);
    row1.appendChild(ageSpan);
  }
  
  if (!isBusy) {
    const editBtn = document.createElement('button');
    editBtn.className = 'session-edit';
    editBtn.textContent = '/';
    editBtn.title = 'Rename session';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      void renameSession(session.sessionId, displayName);
    };
    row1.appendChild(editBtn);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'session-delete';
    deleteBtn.textContent = '×';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      void deleteSession(session.sessionId, displayName);
    };
    row1.appendChild(deleteBtn);
  }
  
  item.appendChild(row1);
  
  // Row 2: model·cwd
  const sep = '<span class="context-sep">·</span>';
  
  const models = getAvailableModels();
  const modelName = models.find(m => m.id === session.model)?.name || '';
  const { model, dirName, fullCwd } = formatStatusParts(modelName, session.cwd || '');
  
  if (model || dirName) {
    const row2 = document.createElement('div');
    row2.className = 'session-row session-row-meta';
    const statusParts: string[] = [];
    if (model) statusParts.push(`<span class="context-model">${escapeHtml(model)}</span>`);
    if (dirName) statusParts.push(`<span title="${escapeHtml(fullCwd || '')}">${escapeHtml(dirName)}</span>`);
    row2.innerHTML = statusParts.join(sep);
    item.appendChild(row2);
  }
  
  const intent = tracked?.intent || session.currentIntent;
  if (intent) {
    const row3 = document.createElement('div');
    row3.className = 'session-row session-row-intent';
    row3.textContent = intent;
    item.appendChild(row3);
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
      void loadSessions(); // Refresh list
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
      void loadSessions();
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
