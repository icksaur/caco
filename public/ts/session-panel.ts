/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge, scrollToBottom } from './ui-utils.js';

/** Store current cwd and session for new chat form and session switching */
export let currentServerCwd = '';
export let currentActiveSessionId: string | null = null;

export function setCurrentServerCwd(cwd: string): void {
  currentServerCwd = cwd;
}

/**
 * Toggle session panel visibility
 */
export function toggleSessionPanel(): void {
  const chat = document.getElementById('chat');
  const panel = document.getElementById('sessionPanel');
  const modelPanel = document.getElementById('modelPanel');
  const btn = document.querySelector('.hamburger-btn:not(.model-btn)');
  const modelBtn = document.querySelector('.hamburger-btn.model-btn');
  
  if (!panel || !chat) return;
  
  const isOpen = panel.classList.contains('visible');
  
  if (isOpen) {
    // Close panel, show chat
    panel.classList.remove('visible');
    chat.classList.remove('hidden');
    btn?.classList.remove('active');
  } else {
    // Close model panel if open
    modelPanel?.classList.remove('visible');
    modelBtn?.classList.remove('active');
    // Open panel, hide chat
    panel.classList.add('visible');
    chat.classList.add('hidden');
    btn?.classList.add('active');
    // Load sessions when opening
    loadSessions();
  }
}

/**
 * Load and render sessions
 */
export async function loadSessions(): Promise<void> {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;
    
    const data: SessionsResponse = await response.json();
    const { activeSessionId, currentCwd, grouped } = data;
    
    // Store for use in switchSession and new chat form
    currentServerCwd = currentCwd;
    currentActiveSessionId = activeSessionId;
    
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
  summarySpan.onclick = () => switchSession(session.sessionId);
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
 * Switch to a different session
 */
export async function switchSession(sessionId: string): Promise<void> {
  // If already on this session, just close the panel and scroll to bottom
  if (sessionId === currentActiveSessionId) {
    toggleSessionPanel();
    scrollToBottom();
    return;
  }
  
  // Show loading state on clicked item
  const clickedItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (clickedItem) {
    clickedItem.classList.add('loading');
  }
  
  try {
    const response = await fetch(`/api/sessions/${sessionId}/resume`, {
      method: 'POST'
    });
    
    if (response.ok) {
      // Reload the page to get new session's history
      window.location.reload();
    } else {
      const err = await response.json();
      if (clickedItem) clickedItem.classList.remove('loading');
      alert('Failed to switch session: ' + err.error);
    }
  } catch (error) {
    console.error('Failed to switch session:', error);
    if (clickedItem) clickedItem.classList.remove('loading');
  }
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
      
      // If we deleted the active session, clear the chat
      if (data.wasActive) {
        const chat = document.getElementById('chat');
        if (chat) chat.innerHTML = '';
      }
      
      // Refresh session list
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
 * Toggle new chat form expansion
 */
export function toggleNewChatForm(): void {
  const form = document.getElementById('newChatForm');
  const pathInput = document.getElementById('newChatPath') as HTMLInputElement;
  const errorDiv = document.getElementById('newChatError');
  
  if (!form || !pathInput) return;
  
  if (form.classList.contains('expanded')) {
    // Collapse
    form.classList.remove('expanded');
    if (errorDiv) {
      errorDiv.classList.remove('visible');
      errorDiv.textContent = '';
    }
  } else {
    // Expand and pre-fill with current cwd
    form.classList.add('expanded');
    pathInput.value = currentServerCwd;
    pathInput.focus();
    pathInput.select();
  }
}

/**
 * Create a new session with specified cwd
 */
export async function createNewSession(): Promise<void> {
  const pathInput = document.getElementById('newChatPath') as HTMLInputElement;
  const errorDiv = document.getElementById('newChatError');
  const cwd = pathInput?.value.trim();
  
  if (!cwd) {
    if (errorDiv) {
      errorDiv.textContent = 'Please enter a working directory path';
      errorDiv.classList.add('visible');
    }
    return;
  }
  
  try {
    const response = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd })
    });
    
    if (response.ok) {
      // Reload the page to start fresh session
      window.location.reload();
    } else {
      const err = await response.json();
      if (errorDiv) {
        errorDiv.textContent = err.error || 'Failed to create session';
        errorDiv.classList.add('visible');
      }
    }
  } catch (error) {
    console.error('Failed to create session:', error);
    if (errorDiv) {
      errorDiv.textContent = 'Failed to create session: ' + (error as Error).message;
      errorDiv.classList.add('visible');
    }
  }
}
