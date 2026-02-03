/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge } from './ui-utils.js';
import { getActiveSessionId, getCurrentCwd } from './app-state.js';
import { setAvailableModels } from './model-selector.js';
import { setViewState } from './view-controller.js';
import { sessionClick } from './router.js';
import { onGlobalEvent } from './websocket.js';

/**
 * Initialize session panel - subscribe to global events
 */
export function initSessionPanel(): void {
  onGlobalEvent((event) => {
    if (event.type === 'session.busy' && event.data) {
      const { sessionId, isBusy } = event.data as { sessionId: string; isBusy: boolean };
      updateSessionItemState(sessionId, isBusy);
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
        deleteSession(sessionId, summary);
      };
      item.appendChild(deleteBtn);
    }
  }
}

/**
 * Show session manager as the main view (landing page)
 */
export function showSessionManager(): void {
  setViewState('sessions');
  loadSessions();
  loadUsage();
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
    
    // Use client state as source of truth (not server response)
    const activeSessionId = getActiveSessionId();
    const currentCwd = getCurrentCwd();
    
    // Store available models from SDK
    if (models && models.length > 0) {
      setAvailableModels(models);
    }
    
    const container = document.getElementById('sessionList');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Sort cwds: current first, then alphabetically
    const cwds = Object.keys(grouped).sort((a, b) => {
      if (a === currentCwd) return -1;
      if (b === currentCwd) return 1;
      return a.localeCompare(b);
    });
    
    for (const cwd of cwds) {
      const sessions = grouped[cwd];
      
      // Handle unknown cwd sessions - just show a summary
      if (cwd === '(unknown)' || !cwd) {
        const summary = document.createElement('div');
        summary.className = 'cwd-header omitted';
        summary.textContent = `no cwd (${sessions.length} omitted)`;
        container.appendChild(summary);
        continue;
      }
      
      // CWD header
      const cwdHeader = document.createElement('div');
      cwdHeader.className = 'cwd-header';
      cwdHeader.textContent = cwd === currentCwd ? `${cwd} (current)` : cwd;
      container.appendChild(cwdHeader);
      
      // Session items
      for (const session of sessions) {
        const item = createSessionItem(session, activeSessionId);
        container.appendChild(item);
      }
    }
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

/**
 * Create a session item element
 */
function createSessionItem(session: SessionData, activeSessionId: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';
  if (session.sessionId === activeSessionId) {
    item.classList.add('active');
  }
  if (session.isBusy) {
    item.classList.add('busy');
  }
  item.dataset.sessionId = session.sessionId;
  
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
  
  // Age (fixed on right)
  if (session.updatedAt) {
    const ageSpan = document.createElement('span');
    ageSpan.className = 'session-age';
    ageSpan.textContent = formatAge(session.updatedAt);
    content.appendChild(ageSpan);
  }
  
  item.appendChild(content);
  
  // Edit button (rename session)
  if (!session.isBusy) {
    const editBtn = document.createElement('button');
    editBtn.className = 'session-edit';
    editBtn.textContent = '✏️';
    editBtn.title = 'Rename session';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      renameSession(session.sessionId, displayName);
    };
    item.appendChild(editBtn);
  }
  
  // Delete button (hidden when busy)
  if (!session.isBusy) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'session-delete';
    deleteBtn.textContent = '×';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(session.sessionId, displayName);
    };
    item.appendChild(deleteBtn);
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
      const data = await response.json();
      
      // If we deleted the active session, show new chat form
      if (data.wasActive) {
        const chat = document.getElementById('chat');
        if (chat) chat.innerHTML = '';
        showNewChat(getCurrentCwd());
      }
      
      // If no sessions left, stay in session manager with just "new chat" button
      // The loadSessions call will show empty list
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
