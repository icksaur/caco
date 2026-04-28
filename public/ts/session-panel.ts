/**
 * Session panel management
 */

import type { SessionsResponse, SessionData } from './types.js';
import { formatAge, formatStatusParts } from './ui-utils.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { setAvailableModels } from './model-selector.js';
import { showSessionPanel } from './view-controller.js';
import { sessionClick, newSessionClick } from './router.js';
import { onGlobalEvent } from './websocket.js';
import { sessionTracker } from './session-state-tracker.js';
import { showToast } from './toast.js';
import { buildSessionListModel } from './session-list-model.js';
import type { SessionListModel, FolderGroup } from './session-list-model.js';

// Module state
let allSessions: SessionData[] = [];
let currentSessionOrder: string[] = [];
const collapsedFolders = new Set<string>(
  (() => { try { return JSON.parse(localStorage.getItem('caco:collapsed-folders') || '[]'); } catch { return []; } })()
);

// Track active session drags (iframe may restrict dataTransfer.types during dragover)
let sessionDragActive = false;

export function getCachedSessions(): SessionData[] {
  return allSessions;
}

/**
 * Initialize session panel - subscribe to global events for session list changes
 */
export function initSessionPanel(): void {

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
  let badgeUpdatePending = false;
  sessionTracker.onChange((sessionId, state) => {
    updateSessionItemState(sessionId, state.busy);
    if (!badgeUpdatePending) {
      badgeUpdatePending = true;
      requestAnimationFrame(() => { badgeUpdatePending = false; updateFolderBadges(); });
    }
    updateMenuIndicators();
  });

  // Drag-drop .tar.gz import (guarded against session drags)
  const panel = document.getElementById('sessionView');
  if (panel) {
    let dragDepth = 0;
    const isSessionDrag = (e: DragEvent) => sessionDragActive || (e.dataTransfer?.types.includes('text/x-caco-session') ?? false);
    panel.addEventListener('dragenter', (e) => {
      if (isSessionDrag(e)) return;
      e.preventDefault();
      if (dragDepth === 0) panel.classList.add('drop-active');
      dragDepth++;
    });
    panel.addEventListener('dragover', (e) => {
      if (isSessionDrag(e)) return;
      e.preventDefault();
    });
    panel.addEventListener('dragleave', (e) => {
      if (isSessionDrag(e)) return;
      dragDepth--;
      if (dragDepth === 0) panel.classList.remove('drop-active');
    });
    panel.addEventListener('drop', (e) => {
      if (isSessionDrag(e)) return;
      e.preventDefault();
      dragDepth = 0;
      panel.classList.remove('drop-active');
      const file = e.dataTransfer?.files[0];
      if (!file || !file.name.endsWith('.tar.gz')) {
        showToast('Drop a .tar.gz session archive');
        return;
      }
      void importSessionFile(file);
    });
  }
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

function updateSessionItemState(sessionId: string, isBusy: boolean): void {
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (!item) return;
  
  const indicator = item.querySelector('.session-indicator');
  
  if (isBusy) {
    item.classList.add('busy');
    indicator?.classList.add('busy');
    indicator?.classList.remove('unobserved');
  } else {
    item.classList.remove('busy');
    indicator?.classList.remove('busy');
  }
}

function updateFolderBadges(): void {
  const folderState = new Map<string, { hasBusy: boolean; hasUnobserved: boolean }>();
  for (const s of allSessions) {
    if (!s.folder) continue;
    let state = folderState.get(s.folder);
    if (!state) { state = { hasBusy: false, hasUnobserved: false }; folderState.set(s.folder, state); }
    const tracked = sessionTracker.get(s.sessionId);
    if (tracked?.busy ?? s.isBusy) state.hasBusy = true;
    if (tracked?.unobserved ?? s.isUnobserved) state.hasUnobserved = true;
  }
  document.querySelectorAll<HTMLElement>('.folder-header[data-folder]').forEach(header => {
    const folderName = header.dataset.folder;
    if (!folderName) return;
    const state = folderState.get(folderName);
    const badge = header.querySelector('.session-indicator');
    if (!badge) return;
    const hasBusy = state?.hasBusy ?? false;
    const hasUnobserved = state?.hasUnobserved ?? false;
    badge.classList.toggle('busy', hasBusy);
    badge.classList.toggle('unobserved', hasUnobserved && !hasBusy);
  });
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
  const activeId = getActiveSessionId();
  
  // Update active session highlight in session list
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-session-id') === activeId);
  });
  
  if (badge) {
    if (unobservedCount > 0) {
      badge.textContent = String(unobservedCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  
  if (busyIndicator) {
    if (unobservedCount === 0 && busyCount > 0) {
      busyIndicator.classList.remove('hidden');
    } else {
      busyIndicator.classList.add('hidden');
    }
  }
  
  if (window.parent !== window) {
    window.parent.postMessage({
      type: 'caco:status',
      origin: window.location.origin,
      hostname: (window as unknown as { SERVER_HOSTNAME?: string }).SERVER_HOSTNAME || window.location.hostname,
      busyCount: sessionTracker.getBusyCount(),
      unobservedCount
    }, '*');
  }
}

/**
 * Show session manager as the main view (landing page)
 */
export function showSessionManager(): void {
  showSessionPanel();
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
export async function loadSchedules(): Promise<void> {
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
    const { sessions: sessionList, models, sessionOrder } = data;
    
    // Flat session list from API (filter unknown CWDs)
    const flatSessions: SessionData[] = (sessionList || []).filter(
      (s: SessionData) => s.cwd && s.cwd !== '(unknown)'
    );
    
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
    
    allSessions = flatSessions.filter(s => s.kind !== 'swarm' || s.isBusy);
    currentSessionOrder = sessionOrder || [];
    
    renderFromModel(buildSessionListModel(allSessions, currentSessionOrder, collapsedFolders));
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

/**
 * Render sessions filtered by current search query
 */
function saveCollapsedFolders(): void {
  localStorage.setItem('caco:collapsed-folders', JSON.stringify([...collapsedFolders]));
}

function toggleFolder(name: string): void {
  if (collapsedFolders.has(name)) {
    collapsedFolders.delete(name);
  } else {
    collapsedFolders.add(name);
  }
  saveCollapsedFolders();
  renderFromModel(buildSessionListModel(allSessions, currentSessionOrder, collapsedFolders));
}

const movingSessionIds = new Set<string>();

function setupZoneDragHandlers(zone: HTMLElement, folderName: string): void {
  let dragDepth = 0;
  const isSessionDrag = (e: DragEvent) => sessionDragActive || (e.dataTransfer?.types.includes('text/x-caco-session') ?? false);

  zone.addEventListener('dragover', (e) => {
    if (!isSessionDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
  });
  zone.addEventListener('dragenter', (e) => {
    if (!isSessionDrag(e)) return;
    dragDepth++;
    if (dragDepth === 1) zone.classList.add('drop-highlight');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!isSessionDrag(e)) return;
    dragDepth--;
    if (dragDepth === 0) zone.classList.remove('drop-highlight');
  });
  zone.addEventListener('drop', (e) => {
    if (!isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    zone.classList.remove('drop-highlight');
    const sessionId = e.dataTransfer!.getData('text/x-caco-session');
    if (!sessionId || movingSessionIds.has(sessionId)) return;
    const current = allSessions.find(s => s.sessionId === sessionId)?.folder ?? '';
    if (current === folderName) return;
    const session = allSessions.find(s => s.sessionId === sessionId);
    if (session) session.folder = folderName || undefined;
    movingSessionIds.add(sessionId);
    const patchFolder = folderName || '/';
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: patchFolder })
        });
        if (res.ok) {
          const dest = folderName ? `/${folderName}` : 'root';
          showToast(`Session moved to ${dest}`, { type: 'success', autoHideMs: 3000 });
          void loadSessions();
        } else {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          showToast(data.error || 'Failed to move session');
        }
      } catch {
        showToast('Failed to move session');
      } finally {
        movingSessionIds.delete(sessionId);
      }
    })();
  });
}

function renderFromModel(model: SessionListModel): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  
  const activeSessionId = getActiveSessionId();
  
  container.innerHTML = '';
  
  const heading = document.createElement('div');
  heading.className = 'section-header';
  heading.textContent = 'sessions';
  
  const addBtn = document.createElement('button');
  addBtn.className = 'session-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'New session';
  addBtn.onclick = (e) => { e.stopPropagation(); newSessionClick(); };
  heading.appendChild(addBtn);
  
  container.appendChild(heading);
  
  if (model.root.length === 0 && model.folders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'schedules-empty';
    empty.textContent = 'no sessions';
    container.appendChild(empty);
    return;
  }
  
  const rootZone = document.createElement('div');
  rootZone.className = 'folder-zone';
  rootZone.dataset.folder = '';
  if (model.root.length === 0 && model.folders.length > 0) {
    const indicator = document.createElement('div');
    indicator.className = 'root-drop-indicator';
    rootZone.appendChild(indicator);
  }
  for (const session of model.root) {
    rootZone.appendChild(createSessionItem(session, activeSessionId ?? undefined));
  }
  setupZoneDragHandlers(rootZone, '');
  container.appendChild(rootZone);
  
  for (const folder of model.folders) {
    const zone = document.createElement('div');
    zone.className = 'folder-zone';
    zone.dataset.folder = folder.name;
    zone.appendChild(createFolderHeader(folder));
    const content = document.createElement('div');
    content.className = 'folder-content';
    if (folder.collapsed) content.style.display = 'none';
    for (const session of folder.sessions) {
      content.appendChild(createSessionItem(session, activeSessionId ?? undefined));
    }
    zone.appendChild(content);
    setupZoneDragHandlers(zone, folder.name);
    container.appendChild(zone);
  }
}

function createFolderHeader(folder: FolderGroup): HTMLElement {
  const header = document.createElement('div');
  header.className = 'folder-header';
  header.dataset.folder = folder.name;
  header.onclick = () => toggleFolder(folder.name);
  
  const indicator = document.createElement('span');
  indicator.className = 'session-indicator';
  if (folder.hasBusy) indicator.classList.add('busy');
  else if (folder.hasUnobserved) indicator.classList.add('unobserved');
  header.appendChild(indicator);
  
  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.textContent = '📁';
  header.appendChild(icon);
  
  const chevron = document.createElement('span');
  chevron.className = 'folder-chevron';
  chevron.textContent = folder.collapsed ? '▸' : '▾';
  header.appendChild(chevron);
  
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.name;
  header.appendChild(name);
  
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = `${folder.sessions.length}`;
  header.appendChild(count);
  
  return header;
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
  
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('text/x-caco-session', session.sessionId);
    e.dataTransfer!.effectAllowed = 'copyMove';
    e.dataTransfer!.setDragImage(item, 0, 0);
    item.classList.add('dragging');
    sessionDragActive = true;
    if (window.parent !== window) {
      const dragName = session.name || session.summary || 'No summary';
      window.parent.postMessage({
        type: 'caco:transfer:dragstart',
        sessionId: session.sessionId,
        sessionName: dragName,
        origin: window.location.origin
      }, '*');
    }
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    sessionDragActive = false;
    document.querySelectorAll('.folder-zone.drop-highlight').forEach(z => z.classList.remove('drop-highlight'));
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'caco:transfer:dragend' }, '*');
    }
  });
  
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
  titleSpan.title = displayName;
  
  const nameText = document.createTextNode(displayName);
  titleSpan.appendChild(nameText);
  
  const intent = tracked?.intent || session.currentIntent;
  if (intent) {
    const intentSpan = document.createElement('span');
    intentSpan.className = 'session-intent';
    intentSpan.textContent = intent;
    titleSpan.appendChild(intentSpan);
  }
  row1.appendChild(titleSpan);
  
  if (session.updatedAt) {
    const ageSpan = document.createElement('span');
    ageSpan.className = 'session-age';
    ageSpan.textContent = formatAge(session.updatedAt);
    row1.appendChild(ageSpan);
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
  
  return item;
}

/**
 * Rename a session (custom name)
 */
export async function renameSession(sessionId: string, newName: string): Promise<void> {
  
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
export async function archiveSession(sessionId: string, displayName?: string): Promise<void> {
  const name = displayName || sessionId.slice(0, 8);
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (response.ok) {
      const data = await response.json();
      showToast(`Archived "${name}" → ${data.archivePath}`, { type: 'success', autoHideMs: 5000 });
      void loadSessions();
      if (data.wasActive) {
        newSessionClick();
      }
    } else {
      const err = await response.json();
      showToast(err.error || 'Archive failed');
    }
  } catch (error) {
    showToast('Archive failed: ' + (error as Error).message);
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

/**
 * Import a session from a dropped .tar.gz file
 */
let isImporting = false;
async function importSessionFile(file: File): Promise<void> {
  if (isImporting) {
    showToast('Import already in progress');
    return;
  }
  isImporting = true;
  showToast('Importing session...', { type: 'info', autoHideMs: 5000 });
  try {
    const res = await fetch('/api/sessions/import?force=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Imported session ${(data.sessionId as string).slice(0, 8)}`, { type: 'success', autoHideMs: 3000 });
      void loadSessions();
    } else {
      showToast(data.error || 'Import failed');
    }
  } catch {
    showToast('Import failed');
  } finally {
    isImporting = false;
  }
}
