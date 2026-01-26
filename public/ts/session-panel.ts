/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge, scrollToBottom } from './ui-utils.js';
import { getActiveSessionId, getCurrentCwd, setActiveSession } from './state.js';
import { setAvailableModels, showNewChat, hideNewChat } from './model-selector.js';
import { loadHistory } from './history.js';

/**
 * Show session manager as the main view (landing page)
 * Different from toggleSessionPanel - this is for initial page load
 */
export function showSessionManager(): void {
  const chatView = document.getElementById('chatView');
  const sessionView = document.getElementById('sessionView');
  const footer = document.getElementById('chatFooter');
  const menuBtn = document.getElementById('menuBtn');
  
  if (!chatView || !sessionView) return;
  
  // Switch to session view
  chatView.classList.remove('active');
  sessionView.classList.add('active');
  footer?.classList.add('hidden');
  menuBtn?.classList.add('active');
  
  // Load sessions
  loadSessions();
}

/**
 * Toggle session panel visibility
 */
export function toggleSessionPanel(): void {
  const chatView = document.getElementById('chatView');
  const sessionView = document.getElementById('sessionView');
  const footer = document.getElementById('chatFooter');
  const menuBtn = document.getElementById('menuBtn');
  
  if (!chatView || !sessionView) return;
  
  const isSessionView = sessionView.classList.contains('active');
  
  if (isSessionView) {
    // Switch to chat view
    sessionView.classList.remove('active');
    chatView.classList.add('active');
    footer?.classList.remove('hidden');
    menuBtn?.classList.remove('active');
    
    // Check if we have chat messages - if not, show new chat form with models
    const chat = document.getElementById('chat');
    if (chat && chat.children.length === 0) {
      showNewChat(getCurrentCwd());
    }
  } else {
    // Switch to session view
    chatView.classList.remove('active');
    sessionView.classList.add('active');
    footer?.classList.add('hidden');
    menuBtn?.classList.add('active');
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
    const { activeSessionId, currentCwd, grouped, models } = data;
    
    // Update state store
    setActiveSession(activeSessionId, currentCwd);
    
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
  if (sessionId === getActiveSessionId()) {
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
      const data = await response.json();
      // Update client state with new session
      setActiveSession(data.sessionId, data.cwd || getCurrentCwd());
      
      // Load history (this calls hideNewChat if there's content)
      await loadHistory();
      
      // Switch to chat view directly (not toggleSessionPanel which has extra logic)
      const chatView = document.getElementById('chatView');
      const sessionView = document.getElementById('sessionView');
      const footer = document.getElementById('chatFooter');
      const menuBtn = document.getElementById('menuBtn');
      
      sessionView?.classList.remove('active');
      chatView?.classList.add('active');
      footer?.classList.remove('hidden');
      menuBtn?.classList.remove('active');
      
      // Scroll after view is visible and content is painted
      requestAnimationFrame(() => scrollToBottom());
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
 * Show new chat UI (switches from session manager to chat view with new chat form)
 */
export function showNewChatUI(): void {
  const chatView = document.getElementById('chatView');
  const sessionView = document.getElementById('sessionView');
  const footer = document.getElementById('chatFooter');
  const chat = document.getElementById('chat');
  const menuBtn = document.getElementById('menuBtn');
  
  if (chatView && sessionView) {
    // Switch to chat view
    sessionView.classList.remove('active');
    chatView.classList.add('active');
    footer?.classList.remove('hidden');
    menuBtn?.classList.remove('active');
    
    // Clear old chat and show new chat form with last cwd
    if (chat) chat.innerHTML = '';
    showNewChat(getCurrentCwd());
    
    // Focus the message input
    const messageInput = document.querySelector('form input[name="message"]') as HTMLInputElement;
    messageInput?.focus();
  }
}
