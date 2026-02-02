/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge } from './ui-utils.js';
import { getActiveSessionId, getCurrentCwd } from './app-state.js';
import { setAvailableModels } from './model-selector.js';
import { setViewState } from './view-controller.js';
import { sessionClick } from './router.js';

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
  item.dataset.sessionId = session.sessionId;
  
  // Summary text (truncated)
  const summarySpan = document.createElement('span');
  summarySpan.className = 'session-summary';
  const summary = session.summary || 'No summary';
  const age = session.updatedAt ? ` (${formatAge(session.updatedAt)})` : '';
  summarySpan.textContent = summary + age;
  summarySpan.onclick = () => sessionClick(session.sessionId);
  item.appendChild(summarySpan);
  
  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'session-delete';
  deleteBtn.textContent = '×';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    deleteSession(session.sessionId, session.summary);
  };
  item.appendChild(deleteBtn);
  
  return item;
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string, summary?: string): Promise<void> {
  const displayName = summary || sessionId.slice(0, 8);
  if (!confirm(`Delete session "${displayName}"?\n\nThis cannot be undone.`)) {
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
